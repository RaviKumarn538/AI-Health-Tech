const crypto = require("crypto");
const { ClinicalKnowledgeChunk } = require("../models/rag");

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "has", "have", "how", "in", "is", "it", "of", "on", "or", "patient", "the", "their", "this", "to", "was", "were", "what", "when", "which", "with",
]);

function valueOf(field) {
  return field && typeof field === "object" && Object.prototype.hasOwnProperty.call(field, "value") ? field.value : field;
}

function clean(value) {
  return String(valueOf(value) ?? "").replace(/\s+/g, " ").trim();
}

function tokensFor(value) {
  return [...new Set(clean(value).toLowerCase().replace(/[^a-z0-9.%/+-]+/g, " ").split(/\s+/).filter((token) => token.length > 1 && !STOP_WORDS.has(token)))];
}

function listValues(value) {
  if (!Array.isArray(value)) return clean(value);
  return value.map((item) => clean(item?.value ?? item)).filter(Boolean).join(", ");
}

function medicationText(medication) {
  const name = clean(medication?.name || medication?.genericName);
  if (!name) return "";
  return `${name}${medication?.dosage ? ` ${clean(medication.dosage)}` : ""}${medication?.frequency ? ` ${clean(medication.frequency)}` : ""}${medication?.route ? ` route ${clean(medication.route)}` : ""}${medication?.duration ? ` for ${clean(medication.duration)}` : ""}${medication?.instructions ? `; instructions: ${clean(medication.instructions)}` : ""}`;
}

function investigationText(investigation) {
  const test = clean(investigation?.testName || investigation?.panelName);
  if (!test) return "";
  return `${test}${investigation?.resultValue ? `: ${clean(investigation.resultValue)}` : ""}${investigation?.units ? ` ${clean(investigation.units)}` : ""}${investigation?.status ? ` [${clean(investigation.status)}]` : ""}${investigation?.referenceRange ? `; reference: ${clean(investigation.referenceRange)}` : ""}`;
}

function recordPayload(record, document, patient) {
  const data = record?.extractedData || {};
  const structured = data.structuredData || data.structuredJson || {};
  const medications = Array.isArray(data.medications) ? data.medications : (Array.isArray(structured.medications) ? structured.medications : []);
  const investigations = Array.isArray(data.labResults) ? data.labResults : (Array.isArray(data.investigations) ? data.investigations : []);
  const diagnoses = listValues(data.diagnosis || structured.diagnosis);
  const observations = listValues(data.observations || structured.observations);
  const medicationLines = medications.map(medicationText).filter(Boolean);
  const investigationLines = investigations.map(investigationText).filter(Boolean);
  const sourceDate = record?.verifiedAt || record?.createdAt || document?.verifiedAt || document?.createdAt || null;
  const sourceFilename = document?.originalFilename || record?.title || "Clinical record";
  const header = [
    `Patient: ${patient?.fullName || record?.patient?.fullName || "Patient"}`,
    `MRN: ${patient?.mrn || record?.patient?.mrn || "Not documented in available records."}`,
    `Visit date: ${sourceDate ? new Date(sourceDate).toISOString().slice(0, 10) : "Not documented in available records."}`,
    `Source document: ${sourceFilename}`,
    `Document type: ${document?.documentType || record?.recordType || "CLINICAL_NOTE"}`,
  ];
  const visitText = [
    ...header,
    `Documented diagnoses: ${diagnoses || "Not documented in available records."}`,
    `Documented observations: ${observations || "Not documented in available records."}`,
    `Medications: ${medicationLines.join("; ") || "Not documented in available records."}`,
    `Investigations: ${investigationLines.join("; ") || "Not documented in available records."}`,
    `Clinical summary: ${clean(data.summary || data.aiSummary || document?.extractedRecord?.aiSummary) || "Not documented in available records."}`,
  ].join("\n");
  return { sourceDate, sourceFilename, visitText, medicationLines, investigationLines };
}

function makeChunk({ clinic, patient, document, record, chunkType, text, sourceDate, sourceFilename, documentType }) {
  const normalizedText = String(text || "").trim();
  return {
    clinic,
    patient: patient._id,
    document: document._id,
    record: record._id,
    sourceFilename,
    documentType,
    sourceDate,
    chunkType,
    text: normalizedText,
    tokens: tokensFor(normalizedText),
    verified: Boolean(record.doctorVerified && ["APPROVED", "AMENDED"].includes(record.status)),
    contentHash: crypto.createHash("sha256").update(`${String(record._id)}:${chunkType}:${normalizedText}`).digest("hex"),
  };
}

function chunksForRecord({ clinic, patient, document, record }) {
  const payload = recordPayload(record, document, patient);
  const chunks = [makeChunk({ clinic, patient, document, record, chunkType: "visit", text: payload.visitText, ...payload, documentType: document?.documentType || record.recordType })];
  if (payload.medicationLines.length) chunks.push(makeChunk({ clinic, patient, document, record, chunkType: "medication", text: `${payload.visitText.split("\n").slice(0, 5).join("\n")}\nMedication history for this visit: ${payload.medicationLines.join("; ")}`, ...payload, documentType: document?.documentType || record.recordType }));
  if (payload.investigationLines.length) chunks.push(makeChunk({ clinic, patient, document, record, chunkType: "investigation", text: `${payload.visitText.split("\n").slice(0, 5).join("\n")}\nInvestigation history for this visit: ${payload.investigationLines.join("; ")}`, ...payload, documentType: document?.documentType || record.recordType }));
  return chunks;
}

async function indexClinicalRecord({ clinic, patient, document, record }) {
  if (!clinic || !patient?._id || !document?._id || !record?._id || !record.doctorVerified || !["APPROVED", "AMENDED"].includes(record.status)) return { indexed: 0 };
  const chunks = chunksForRecord({ clinic, patient, document, record });
  await Promise.all(chunks.map((chunk) => ClinicalKnowledgeChunk.updateOne(
    { patient: chunk.patient, contentHash: chunk.contentHash },
    { $set: chunk },
    { upsert: true },
  )));
  await ClinicalKnowledgeChunk.deleteMany({
    record: record._id,
    contentHash: { $nin: chunks.map((chunk) => chunk.contentHash) },
  });
  return { indexed: chunks.length };
}

function scoreChunk(chunk, queryTokens, queryText) {
  const tokenSet = new Set(chunk.tokens || tokensFor(chunk.text));
  const overlap = queryTokens.reduce((score, token) => score + (tokenSet.has(token) ? 1 : 0), 0);
  const phraseBonus = queryText && chunk.text.toLowerCase().includes(queryText.toLowerCase()) ? 3 : 0;
  const recencyBonus = chunk.sourceDate ? Math.max(0, 1 - ((Date.now() - new Date(chunk.sourceDate).getTime()) / (1000 * 60 * 60 * 24 * 3650))) : 0;
  return overlap * 4 + phraseBonus + recencyBonus;
}

async function retrieveClinicalContext({ clinic, patientId, query, limit = 8 }) {
  const queryText = String(query || "").trim();
  const queryTokens = tokensFor(queryText);
  const chunks = await ClinicalKnowledgeChunk.find({ clinic, patient: patientId, verified: true }).sort({ sourceDate: -1 }).limit(500).lean();
  const ranked = chunks
    .map((chunk) => ({ ...chunk, retrievalScore: scoreChunk(chunk, queryTokens, queryText) }))
    .sort((a, b) => b.retrievalScore - a.retrievalScore || new Date(b.sourceDate || 0) - new Date(a.sourceDate || 0))
    .slice(0, limit);
  const selected = ranked.filter((chunk) => !queryTokens.length || chunk.retrievalScore > 0);
  const effective = selected.length ? selected : ranked.slice(0, Math.min(limit, ranked.length));
  const citations = [...new Map(effective.map((chunk) => [String(chunk.document), `${chunk.sourceFilename} · ${chunk.sourceDate ? new Date(chunk.sourceDate).toLocaleDateString("en-IN") : "date not documented"}`])).values()];
  return {
    chunks: effective,
    citations,
    text: effective.length ? effective.map((chunk, index) => `SOURCE ${index + 1}\n${chunk.text}`).join("\n\n") : "No verified source record matched this question.",
    documentIds: [...new Set(effective.map((chunk) => String(chunk.document)))],
  };
}

module.exports = { indexClinicalRecord, retrieveClinicalContext, chunksForRecord };
