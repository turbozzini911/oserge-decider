// O'Serge! — Decider
// Laeuft alle ~10-15 min (GitHub Actions). Prueft die Lage und schickt Push-Meldungen.
// Benoetigt ENV:
//   OSERGE_DB_URL              z.B. https://sergiometre-d4e87-default-rtdb.europe-west1.firebasedatabase.app
//   GOOGLE_SERVICE_ACCOUNT     kompletter Service-Account-JSON als String (GitHub-Secret)

import admin from "firebase-admin";
import {
  CONFIG, MSG, levelZone, waterMmFromData, litersFromWaterMm, pctFromWaterMm, etatOf, frInt
} from "./messages.mjs";

const DB_URL = process.env.OSERGE_DB_URL;
const SA = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(SA),
  databaseURL: DB_URL
});
const db = admin.database();
const messaging = admin.messaging();

const now = Date.now();
const HOUR = 3600e3, DAY = 24 * HOUR;

async function get(path, def) {
  const snap = await db.ref(path).get();
  return snap.exists() ? snap.val() : def;
}

// ---- Zeit in Paris ----
function parisParts(ts) {
  const f = new Intl.DateTimeFormat("fr-FR", {
    timeZone: CONFIG.tz, weekday: "short", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
  });
  const p = Object.fromEntries(f.formatToParts(ts).map(x => [x.type, x.value]));
  return {
    dateKey: `${p.year}-${p.month}-${p.day}`,
    hour: parseInt(p.hour, 10),
    weekday: p.weekday,
    isSunday: /dim/i.test(p.weekday)
  };
}
function weekKey(ts) {
  const d = new Date(ts);
  const oneJan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - oneJan) / DAY) + oneJan.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${week}`;
}

// ---- Wetter (Open-Meteo, kostenlos) ----
async function getWeather() {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${CONFIG.lat}&longitude=${CONFIG.lon}` +
      `&current=precipitation,cloud_cover&hourly=precipitation,precipitation_probability,cloud_cover` +
      `&forecast_days=1&timezone=${encodeURIComponent(CONFIG.tz)}`;
    const r = await fetch(url);
    const j = await r.json();
    const curPrecip = j.current?.precipitation ?? 0;
    const hours = j.hourly?.time || [];
    let idx = 0;
    for (let i = 0; i < hours.length; i++) { if (new Date(hours[i]).getTime() <= now) idx = i; }
    const next = (arr) => (arr || []).slice(idx + 1, idx + 4);
    const precipNext = next(j.hourly?.precipitation);
    const probNext = next(j.hourly?.precipitation_probability);
    const probToday = (j.hourly?.precipitation_probability || []).slice(idx + 1);
    return {
      curPrecip,
      precipSoon: precipNext.reduce((a, b) => a + (b || 0), 0),
      probSoon: Math.max(0, ...probNext.map(x => x || 0)),
      probLater: Math.max(0, ...probToday.map(x => x || 0))
    };
  } catch (e) {
    console.log("Wetter-Fehler:", e.message);
    return null;
  }
}

// ---- Push senden ----
// entries: [{ key, token }]
async function push(entries, msg) {
  if (!entries.length) { console.log("(kein Token)", msg.title); return; }
  const tokens = entries.map(e => e.token);
  const res = await messaging.sendEachForMulticast({
    tokens,
    notification: { title: msg.title, body: msg.body },
    webpush: {
      notification: { title: msg.title, body: msg.body, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png" },
      fcmOptions: { link: "/" }
    }
  });
  console.log("Push:", msg.title, "->", res.successCount + "/" + tokens.length);
  // ungueltige Tokens aufraeumen
  res.responses.forEach((r, i) => {
    if (!r.success) {
      const code = r.error?.code || "";
      if (code.includes("registration-token-not-registered") || code.includes("invalid-argument")) {
        db.ref("tokens/" + entries[i].key).remove().catch(() => {});
      }
    }
  });
}

async function main() {
  const [cuve, state0, tokensObj] = await Promise.all([
    get("cuve", null),
    get("state", {}),
    get("tokens", {})
  ]);
  const entries = Object.entries(tokensObj || {}).map(([key, token]) => ({ key, token }));
  const state = state0 || {};
  state.cooldowns = state.cooldowns || {};
  state.sent = state.sent || {};
  const queue = [];
  const cool = (key, ms) => {
    const last = state.cooldowns[key] || 0;
    if (now - last < ms) return false;
    state.cooldowns[key] = now; return true;
  };

  const waterMm = waterMmFromData(cuve);
  const dataTs = cuve?.ts || cuve?.updated || 0;
  const fresh = dataTs && (now - dataTs) < CONFIG.offlineMin * 60e3;
  const pct = waterMm != null ? pctFromWaterMm(waterMm) : null;
  const liters = waterMm != null ? litersFromWaterMm(waterMm) : null;

  // ---- C. Sensor online/offline ----
  const wasOffline = !!state.sensorOffline;
  if (!fresh && dataTs) {
    if (!wasOffline) { queue.push(MSG.offline()); state.sensorOffline = true; }
  } else if (fresh) {
    if (wasOffline) { queue.push(MSG.online()); }
    state.sensorOffline = false;
  }

  // ---- A. Fuellstand-Ereignisse ----
  if (fresh && pct != null) {
    const zone = levelZone(pct);
    if (zone !== "normal" && zone !== state.lastZone) {
      if (zone === "critique") queue.push(MSG.levelCritique());
      else if (zone === "full") queue.push(MSG.levelFull(pct));
      else if (zone === "reserve") queue.push(MSG.levelReserve());
      else if (zone === "vide") queue.push(MSG.levelVide());
    }
    state.lastZone = zone;
  }

  // ---- Verlauf + Tages-/Wochensummen ----
  const parisNow = parisParts(now);
  if (fresh && liters != null) {
    // Verlaufsspeicher (max ~6 Tage, alle >=10 min ein Punkt)
    let samples = Array.isArray(state.samples) ? state.samples : [];
    const lastS = samples[samples.length - 1];
    if (!lastS || now - lastS.t > 10 * 60e3) samples.push({ t: now, l: Math.round(liters) });
    samples = samples.filter(s => now - s.t < 6 * DAY);
    state.samples = samples;

    // Tages-/Wochensumme (Summe positiver Zufluesse)
    const day = state.day && state.day.date === parisNow.dateKey ? state.day : { date: parisNow.dateKey, collected: 0, lastL: liters };
    const wk = state.week && state.week.key === weekKey(now) ? state.week : { key: weekKey(now), collected: 0 };
    const delta = liters - (day.lastL ?? liters);
    if (delta > 0) { day.collected += delta; wk.collected += delta; }
    day.lastL = liters;
    state.day = day; state.week = wk;

    // ---- B. Anomalien ----
    const at = (agoMs) => {
      const target = now - agoMs; let best = null;
      for (const s of samples) if (s.t <= target) best = s;
      return best;
    };
    const ref3h = at(CONFIG.dropHours * HOUR);
    if (ref3h && (ref3h.l - liters) >= CONFIG.dropLitres) {
      const w = await getWeather();
      const rained = w && (w.curPrecip > 0 || w.precipSoon > 0.2);
      if (!rained && cool("drop", 6 * HOUR)) queue.push(MSG.dropRapide(ref3h.l - liters, "ce matin"));
    }
    const refLeak = at(CONFIG.leakDays * DAY);
    if (refLeak && (refLeak.l - liters) > 200 && pct < 95) {
      const rise = samples.some(s => s.t > refLeak.t && s.l > refLeak.l + 50);
      if (!rise && cool("fuite", DAY)) queue.push(MSG.fuite());
    }
    const refManque = at(CONFIG.manquePluieDays * DAY);
    if (refManque && pct < 40) {
      const rise = samples.some(s => s.t > refManque.t && s.l > refManque.l + 100);
      if (!rise && cool("manque", DAY)) queue.push(MSG.manquePluie());
    }
  }

  // ---- D. Zusammenfassungen (geplant, Pariser Zeit) ----
  const sentKey = (name) => `${parisNow.dateKey}:${name}`;
  const markSent = (name) => { state.sent[sentKey(name)] = true; };
  const alreadySent = (name) => !!state.sent[sentKey(name)];
  if (pct != null) {
    if (parisNow.hour === 8 && !alreadySent("matin")) {
      queue.push(MSG.matin(liters, pct, etatOf(pct))); markSent("matin");
    }
    if (parisNow.hour === 20 && !alreadySent("jour")) {
      queue.push(MSG.bilanJour(state.day?.collected || 0)); markSent("jour");
    }
    if (parisNow.isSunday && parisNow.hour === 20 && !alreadySent("semaine")) {
      queue.push(MSG.bilanSemaine(state.week?.collected || 0)); markSent("semaine");
      state.week = { key: weekKey(now), collected: 0 };
    }
  }
  // alte sent-Flags aufraeumen (>3 Tage)
  for (const k of Object.keys(state.sent)) {
    const d = k.split(":")[0];
    if (d && (now - new Date(d).getTime()) > 3 * DAY) delete state.sent[k];
  }

  // ---- E. Wetter ----
  if (liters != null) {
    const w = await getWeather();
    if (w) {
      const espace = Math.max(0, CONFIG.tankLitersAtMax - liters);
      let kind = null;
      if (w.curPrecip > 0) kind = "encours";
      else if (w.precipSoon > 0.3 || w.probSoon >= 60) kind = "approche";
      else if (w.probLater >= 60) kind = "nuages";
      if (kind && kind !== state.lastWeatherKind && cool("weather", 3 * HOUR)) {
        if (kind === "encours") queue.push(MSG.pluieEnCours());
        else if (kind === "approche") queue.push(MSG.pluieApproche(espace));
        else queue.push(MSG.nuages());
      }
      state.lastWeatherKind = kind;
    }
  }

  // ---- Senden ----
  for (const m of queue) await push(entries, m);
  if (!queue.length) console.log("Nichts zu melden.");

  state.lastRun = now;
  await db.ref("state").set(state);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
