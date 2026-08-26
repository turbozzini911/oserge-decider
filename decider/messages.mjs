// O'Serge! — Konfiguration + Meldungstexte (gemeinsame Quelle der Wahrheit)
// Werte hier anpassen, sobald die Cuve kalibriert ist.

export const CONFIG = {
  sensorToBottomMm: 2000,   // Abstand Sensor -> Boden bei leerer Cuve (mm)
  maxFillMm: 1700,          // maximale Fuellhoehe (mm)
  tankLitersAtMax: 4000,    // Liter bei voller Cuve
  lat: 48.581076,           // 11b Rue des Noyers, 67310 Balbronn (exakte Adresse)
  lon: 7.435638,
  tz: "Europe/Paris",
  offlineMin: 30,           // ab wann gilt der Sensor als offline
  // Anomalie-Schwellen (spaeter anpassbar)
  dropLitres: 150,          // "schneller Abfall": Verlust in ...
  dropHours: 3,             // ... dieser Zeitspanne
  leakDays: 3,              // langsames Leck ueber X Tage
  manquePluieDays: 5        // kein Anstieg seit X Tagen
};

export const litersFromWaterMm = (mm) =>
  Math.max(0, Math.min(CONFIG.maxFillMm, mm)) / CONFIG.maxFillMm * CONFIG.tankLitersAtMax;

export const pctFromWaterMm = (mm) =>
  Math.max(0, Math.min(100, Math.max(0, Math.min(CONFIG.maxFillMm, mm)) / CONFIG.maxFillMm * 100));

export const waterMmFromData = (d) => {
  if (!d) return null;
  if (typeof d.water_mm === "number") return d.water_mm;
  if (typeof d.level_mm === "number") return d.level_mm;
  if (typeof d.pct === "number") return d.pct / 100 * CONFIG.maxFillMm;
  if (typeof d.distance_mm === "number") return CONFIG.sensorToBottomMm - d.distance_mm;
  return null;
};

export const frInt = (n) => Math.round(n).toLocaleString("fr-FR");

export const etatOf = (pct) =>
  pct > 30 ? "tout va bien" : (pct >= 10 ? "à surveiller" : "réserve basse");

// Jede Funktion liefert { category, title, body }. Die category dient der
// Benachrichtigungs-Einstellung in der App: watch.mjs schickt eine Meldung nur
// an Empfaenger, deren gespeicherte Praeferenz fuer diese category nicht
// explizit auf false steht (Standard: alles an).
//
// Kategorien: "niveau" (Fuellstand), "anomalie" (Leck/Abfall/Trockenheit),
// "capteur" (online/offline), "resume" (geplante Zusammenfassungen),
// "meteo" (Wetter).
export const MSG = {
  levelCritique: () => ({ category: "niveau",   title: "Marée haute à la cave.", body: "La cuve approche de sa capacité maximale." }),
  levelFull:     (pct) => ({ category: "niveau", title: "Eau là là, Serge !", body: `La cuve est remplie à ${Math.round(pct)} %.` }),
  levelReserve:  () => ({ category: "niveau",   title: "Eau secours !", body: "Le niveau est passé sous le seuil de réserve." }),
  levelVide:     () => ({ category: "niveau",   title: "Serge est au régime sec.", body: "Il est temps de faire la danse de la pluie." }),

  dropRapide:    (litres, depuis) => ({ category: "anomalie", title: "Qui a retiré le bouchon ?", body: `${frInt(litres)} litres ont disparu depuis ${depuis}.` }),
  fuite:         () => ({ category: "anomalie", title: "Houston, on a peut-être une fuite.", body: "Ou quelqu'un arrose avec beaucoup d'enthousiasme." }),
  manquePluie:   () => ({ category: "anomalie", title: "Mais où est passée l'eau ?", body: "La cuve signale un sérieux manque de pluie." }),

  offline:       () => ({ category: "capteur", title: "Serge a plongé trop profond.", body: "Le capteur ne répond plus." }),
  online:        () => ({ category: "capteur", title: "Bloup, bloup… me revoilà !", body: "La bouée est reconnectée!" }),

  matin:         (litres, pct, etat) => ({ category: "resume", title: "Le point d'eau du matin", body: `${frInt(litres)} litres, ${Math.round(pct)} %, ${etat}.` }),
  bilanJour:     (litres) => ({ category: "resume", title: "Le rapport de Serge", body: `${frInt(litres)} litres récupérés aujourd'hui.` }),
  bilanSemaine:  (litres) => ({ category: "resume", title: "Belle pêche !", body: `O'Serge a collecté ${frInt(litres)} litres cette semaine.` }),

  pluieApproche: (espace) => ({ category: "meteo", title: "Les gouttes sont en approche.", body: `Espace disponible : ${frInt(espace)} L.` }),
  nuages:        () => ({ category: "meteo", title: "Les nuages arrivent.", body: "La cuve se prépare." }),
  pluieEnCours:  () => ({ category: "meteo", title: "Serge sent venir la pluie.", body: "La réserve pourrait bientôt se remplir." })
};

// Fuellstand-Zone (mit einfacher Schwellenlogik)
export function levelZone(pct) {
  if (pct >= 97) return "critique";
  if (pct >= 90) return "full";
  if (pct <= 8)  return "vide";
  if (pct <= 20) return "reserve";
  return "normal";
}
