const NORMAL_RANGES = {
  glucose: { min: 70, max: 99, units: "mg/dL" },
  hba1c: { min: 4, max: 5.6, units: "%" },
  creatinine: { min: 0.6, max: 1.2, units: "mg/dL" },
  cholesterol: { min: 0, max: 200, units: "mg/dL" },
  ldl: { min: 0, max: 100, units: "mg/dL" },
};

function numericValue(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function rangeFor(testName) {
  const name = String(testName || "").toLowerCase();
  if (name.includes("hba1c")) return NORMAL_RANGES.hba1c;
  if (name.includes("glucose") || name.includes("sugar") || name.includes("fbs")) return NORMAL_RANGES.glucose;
  if (name.includes("creatinine")) return NORMAL_RANGES.creatinine;
  if (name.includes("ldl")) return NORMAL_RANGES.ldl;
  if (name.includes("cholesterol")) return NORMAL_RANGES.cholesterol;
  return null;
}

function evaluateLab(testName, resultValue, referenceRange) {
  const numeric = numericValue(resultValue);
  const range = rangeFor(testName);
  if (numeric === null || !range) {
    return { numericValue: numeric, status: "UNKNOWN", units: range?.units || "", referenceRange: referenceRange || "Not specified" };
  }
  const status = numeric > range.max * 1.5 ? "CRITICAL" : numeric > range.max ? "HIGH" : numeric < range.min ? "LOW" : "NORMAL";
  return {
    numericValue: numeric,
    status,
    units: range.units,
    referenceRange: referenceRange || `${range.min} - ${range.max} ${range.units}`,
  };
}

function analyzeDocumentPayload(medications = [], labResults = [], allergies = "") {
  const abnormalLabs = labResults.filter((lab) => ["HIGH", "LOW", "CRITICAL"].includes(lab.status));
  const allergyText = String(allergies || "").toLowerCase();
  const allergyConflicts = medications.filter((med) => allergyText && allergyText.includes(String(med.name || "").toLowerCase()));
  const interactionPairs = [];
  const names = medications.map((med) => String(med.name || "").toLowerCase());
  if (names.some((name) => name.includes("telmisartan")) && names.some((name) => name.includes("potassium"))) {
    interactionPairs.push("Review potassium monitoring with telmisartan.");
  }
  return {
    totalAlerts: abnormalLabs.length + allergyConflicts.length + interactionPairs.length,
    abnormalLabs: abnormalLabs.map((lab) => ({ testName: lab.testName, resultValue: lab.resultValue, status: lab.status })),
    allergyConflicts: allergyConflicts.map((med) => med.name),
    interactionWarnings: interactionPairs,
  };
}

function screenInteractions(medications = []) {
  const normalized = medications.map((item) => String(item).toLowerCase());
  const interactions = [];
  if (normalized.some((name) => name.includes("telmisartan")) && normalized.some((name) => name.includes("potassium"))) {
    interactions.push("Telmisartan with potassium supplements may increase hyperkalemia risk; review renal function.");
  }
  if (normalized.some((name) => name.includes("warfarin")) && normalized.some((name) => name.includes("aspirin"))) {
    interactions.push("Warfarin and aspirin can increase bleeding risk; confirm the indication and monitoring plan.");
  }
  return interactions;
}

function semanticConfidence(score) {
  const s = Number(score ?? 0.9);
  if (s >= 0.92) return { tier: "HIGH", label: "High confidence", cssClass: "confidence-high", score: Math.round(s * 100) };
  if (s >= 0.80) return { tier: "REVIEW_RECOMMENDED", label: "Review recommended", cssClass: "confidence-review", score: Math.round(s * 100) };
  if (s >= 0.50) return { tier: "NEEDS_VERIFICATION", label: "Needs verification", cssClass: "confidence-verify", score: Math.round(s * 100) };
  return { tier: "UNABLE_TO_DETERMINE", label: "Unable to determine", cssClass: "confidence-unknown", score: Math.round(s * 100) };
}

module.exports = { evaluateLab, analyzeDocumentPayload, screenInteractions, semanticConfidence };
