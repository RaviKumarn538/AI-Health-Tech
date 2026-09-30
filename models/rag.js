const mongoose = require("mongoose");

const { Schema } = mongoose;

// Derived retrieval index only. The approved ClinicalDocument/MedicalRecord
// collections remain the source of truth and are never replaced by chunks.
const clinicalKnowledgeChunkSchema = new Schema(
  {
    clinic: { type: String, required: true, index: true },
    patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    document: { type: Schema.Types.ObjectId, ref: "ClinicalDocument", required: true, index: true },
    record: { type: Schema.Types.ObjectId, ref: "MedicalRecord", required: true, index: true },
    sourceFilename: { type: String, default: "Clinical record" },
    documentType: { type: String, default: "CLINICAL_NOTE" },
    sourceDate: { type: Date, default: null, index: true },
    chunkType: { type: String, enum: ["visit", "medication", "investigation"], default: "visit", index: true },
    text: { type: String, required: true },
    tokens: { type: [String], default: [] },
    verified: { type: Boolean, default: true, index: true },
    contentHash: { type: String, required: true },
  },
  { collection: "clinical_knowledge_chunks", timestamps: true }
);

clinicalKnowledgeChunkSchema.index({ clinic: 1, patient: 1, verified: 1, sourceDate: -1 });
clinicalKnowledgeChunkSchema.index({ patient: 1, contentHash: 1 }, { unique: true });

module.exports = {
  ClinicalKnowledgeChunk: mongoose.models.ClinicalKnowledgeChunk || mongoose.model("ClinicalKnowledgeChunk", clinicalKnowledgeChunkSchema),
};
