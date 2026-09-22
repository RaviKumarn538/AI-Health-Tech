const mongoose = require("mongoose");

const { Schema } = mongoose;

const verificationDraftSchema = new Schema(
  {
    document: { type: Schema.Types.ObjectId, ref: "ClinicalDocument", required: true, unique: true, index: true },
    extraction: { type: Schema.Types.ObjectId, ref: "ClinicalExtraction", default: null, index: true },
    patient: { type: Schema.Types.ObjectId, ref: "Patient", default: null, index: true },
    clinician: { type: Schema.Types.ObjectId, ref: "User", default: null },
    clinicianName: { type: String, trim: true },
    clinicName: { type: String, default: "CuraClinic AI", index: true },
    // This is the clinician's working copy. It is never written back into
    // ClinicalExtraction.originalSnapshot.
    payload: { type: Schema.Types.Mixed, default: {} },
    fieldStates: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ["DRAFT", "SUBMITTED"], default: "DRAFT", index: true },
  },
  { collection: "verification_drafts", timestamps: true }
);

verificationDraftSchema.index({ patient: 1, updatedAt: -1 });

const medicalRecordSchema = new Schema(
  {
    patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    document: { type: Schema.Types.ObjectId, ref: "ClinicalDocument", required: true, unique: true, index: true },
    extraction: { type: Schema.Types.ObjectId, ref: "ClinicalExtraction", default: null },
    recordType: {
      type: String,
      enum: ["PRESCRIPTION", "OPD_CARD", "CASE_SHEET", "LAB_REPORT", "DISCHARGE_SUMMARY", "CLINICAL_NOTE", "INVESTIGATION_NOTE", "OTHER"],
      default: "CLINICAL_NOTE",
    },
    title: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["DRAFT", "APPROVED", "AMENDED", "REJECTED"],
      default: "APPROVED",
      index: true,
    },
    // Current clinical data (clinician-approved)
    extractedData: { type: Schema.Types.Mixed, default: {} },
    // Version 1 snapshot: permanently immutable
    originalVersionSnapshot: { type: Schema.Types.Mixed, default: null },
    doctorVerified: { type: Boolean, default: true, index: true },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    verifiedByName: { type: String, trim: true },
    verifiedAt: Date,
    verificationNotes: String,
    version: { type: Number, default: 1, min: 1 },
    amendmentReason: { type: String, default: "" },
    // Full versioning audit trail with field-level diffs
    history: [
      {
        version: Number,
        extractedData: Schema.Types.Mixed,
        changedFields: [
          {
            field: String,
            oldValue: Schema.Types.Mixed,
            newValue: Schema.Types.Mixed,
          },
        ],
        modifiedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
        modifiedByName: String,
        modifiedAt: { type: Date, default: Date.now },
        reason: String,
      },
    ],
    // Retained separately from the current version so an amendment cannot
    // overwrite the clinician-approved first version.
    approvedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
    approvedByName: { type: String, trim: true },
    approvedAt: Date,
    clinicName: { type: String, default: "CuraClinic AI", index: true },
  },
  { collection: "medical_records", timestamps: true }
);

medicalRecordSchema.index({ patient: 1, createdAt: -1 });
medicalRecordSchema.index({ patient: 1, doctorVerified: 1, createdAt: -1 });
medicalRecordSchema.index({ clinicName: 1, createdAt: -1 });

const conversationSchema = new Schema(
  {
    patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    doctor: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    doctorName: { type: String, trim: true },
    title: { type: String, required: true, trim: true, maxlength: 180 },
  },
  { collection: "conversations", timestamps: true }
);

conversationSchema.index({ patient: 1, updatedAt: -1 });

const messageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: "Conversation", required: true, index: true },
    role: { type: String, enum: ["USER", "ASSISTANT", "SYSTEM"], required: true },
    content: { type: String, required: true, trim: true },
  },
  { collection: "messages", timestamps: { createdAt: "createdAt", updatedAt: false } }
);

messageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = {
  MedicalRecord: mongoose.models.MedicalRecord || mongoose.model("MedicalRecord", medicalRecordSchema),
  VerificationDraft: mongoose.models.VerificationDraft || mongoose.model("VerificationDraft", verificationDraftSchema),
  Conversation: mongoose.models.Conversation || mongoose.model("Conversation", conversationSchema),
  Message: mongoose.models.Message || mongoose.model("Message", messageSchema),
};
