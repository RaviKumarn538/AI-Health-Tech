const mongoose = require("mongoose");

const { Schema } = mongoose;

// Standard Clinical Field Schema. Clinician edits are stored in a separate
// verification draft/medical record; the AI snapshot never carries a mutable
// verified value.
const extractionFieldSchema = new Schema(
  {
    value: { type: Schema.Types.Mixed, default: null },
    confidence: { type: Number, default: 0, min: 0, max: 1 },
    status: {
      type: String,
      enum: ["ai_extracted", "review_required", "clinician_corrected", "clinician_verified", "unresolved"],
      default: "ai_extracted",
    },
    source: {
      page: { type: Number, default: 1 },
      boundingBox: { type: [Number], default: null }, // [ymin, xmin, ymax, xmax] normalized 0-100 or null
      textSnippet: { type: String, default: "" },
    },
  },
  { _id: true }
);

const medicationItemSchema = new Schema(
  {
    name: { type: extractionFieldSchema, required: true },
    genericName: { type: extractionFieldSchema, default: () => ({ value: null, confidence: 0, status: "ai_extracted" }) },
    dosage: { type: extractionFieldSchema, default: () => ({ value: null, confidence: 0, status: "ai_extracted" }) },
    frequency: { type: extractionFieldSchema, default: () => ({ value: null, confidence: 0, status: "ai_extracted" }) },
    route: { type: extractionFieldSchema, default: () => ({ value: null, confidence: 0, status: "review_required" }) },
    duration: { type: extractionFieldSchema, default: () => ({ value: null, confidence: 0, status: "ai_extracted" }) },
    instructions: { type: extractionFieldSchema, default: () => ({ value: null, confidence: 0, status: "ai_extracted" }) },
    overallStatus: {
      type: String,
      enum: ["ai_extracted", "review_required", "clinician_corrected", "clinician_verified", "unresolved"],
      default: "ai_extracted",
    },
    warning: { type: String, trim: true },
  },
  { _id: true }
);

const investigationItemSchema = new Schema(
  {
    panelName: { type: extractionFieldSchema, default: () => ({ value: null, confidence: 0, status: "ai_extracted" }) },
    testName: { type: extractionFieldSchema, required: true },
    resultValue: { type: extractionFieldSchema, required: true },
    numericValue: Number,
    units: { type: extractionFieldSchema, default: () => ({ value: null, confidence: 0, status: "ai_extracted" }) },
    referenceRange: { type: extractionFieldSchema, default: () => ({ value: null, confidence: 0, status: "ai_extracted" }) },
    status: { type: String, enum: ["NORMAL", "HIGH", "LOW", "CRITICAL", "UNKNOWN"], default: "UNKNOWN" },
    overallStatus: {
      type: String,
      enum: ["ai_extracted", "review_required", "clinician_corrected", "clinician_verified", "unresolved"],
      default: "ai_extracted",
    },
    testDate: { type: Date, default: null },
  },
  { _id: true }
);

const patientSchema = new Schema(
  {
    mrn: { type: String, required: true, unique: true, index: true, trim: true },
    fullName: { type: String, required: true, trim: true },
    dateOfBirth: Date,
    age: Number,
    gender: { type: String, trim: true },
    bloodGroup: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    allergies: { type: String, trim: true },
    chronicConditions: { type: String, trim: true },
    ownerDoctor: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    authorizedDoctors: [{ type: Schema.Types.ObjectId, ref: "User", index: true }],
    clinic: { type: String, default: "CuraClinic AI", index: true },
  },
  { timestamps: true }
);

patientSchema.index({ fullName: 1 });
patientSchema.index({ clinic: 1, fullName: 1 });
patientSchema.index({ createdAt: -1 });
patientSchema.index({ updatedAt: -1 });

patientSchema.pre("save", function (next) {
  if (this.isModified("fullName") && typeof this.fullName === "string") {
    this.fullName = this.fullName.trim().replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
  }
  if (typeof next === "function") next();
});

// Phase 1: Dedicated Clinical Extraction Model
const clinicalExtractionSchema = new Schema(
  {
    document: { type: Schema.Types.ObjectId, ref: "ClinicalDocument", required: true, index: true },
    patient: { type: Schema.Types.ObjectId, ref: "Patient", default: null, index: true },
    aiProvider: { type: String, default: "gemini-2.0-flash" },
    extractionTimestamp: { type: Date, default: Date.now },
    overallConfidence: { type: Number, default: 0, min: 0, max: 1 },
    status: {
      type: String,
      enum: ["AI_EXTRACTED", "NEEDS_VERIFICATION", "CLINICIAN_VERIFIED", "REJECTED"],
      default: "AI_EXTRACTED",
      index: true,
    },
    // Grouped Clinical Fields
    structuredData: {
      patient: {
        name: extractionFieldSchema,
        mrn: extractionFieldSchema,
        age: extractionFieldSchema,
        gender: extractionFieldSchema,
        phone: extractionFieldSchema,
      },
      encounter: {
        date: extractionFieldSchema,
        facility: extractionFieldSchema,
        type: extractionFieldSchema,
      },
      diagnosis: [
        {
          value: { type: String, default: null },
          confidence: { type: Number, default: 0 },
          status: {
            type: String,
            enum: ["ai_extracted", "review_required", "clinician_corrected", "clinician_verified", "unresolved"],
            default: "ai_extracted",
          },
          source: {
            page: { type: Number, default: 1 },
            boundingBox: { type: [Number], default: null },
            textSnippet: { type: String, default: "" },
          },
        },
      ],
      medications: { type: [medicationItemSchema], default: [] },
      investigations: { type: [investigationItemSchema], default: [] },
      observations: [
        {
          observation: extractionFieldSchema,
          value: extractionFieldSchema,
          overallStatus: {
            type: String,
            enum: ["ai_extracted", "review_required", "clinician_corrected", "clinician_verified", "unresolved"],
            default: "ai_extracted",
          },
        },
      ],
      followUp: {
        interval: extractionFieldSchema,
        advice: extractionFieldSchema,
      },
    },
    // The original extraction snapshot MUST NEVER be overwritten when clinician edits the data
    originalSnapshot: { type: Schema.Types.Mixed, required: true },
    clinicalFlags: { type: Schema.Types.Mixed, default: {} },
    aiSummary: { type: String, default: "" },
  },
  { collection: "clinical_extractions", timestamps: true }
);

clinicalExtractionSchema.index({ document: 1, createdAt: -1 });

const immutableExtractionFields = ["structuredData", "originalSnapshot", "clinicalFlags", "aiSummary", "overallConfidence", "aiProvider", "extractionTimestamp"];
clinicalExtractionSchema.pre("save", function protectExtractionSnapshot() {
  if (!this.isNew && immutableExtractionFields.some((field) => this.isModified(field))) {
    throw new Error("ClinicalExtraction AI snapshot is immutable; store clinician changes in VerificationDraft or MedicalRecord.");
  }
});

clinicalExtractionSchema.pre(["updateOne", "findOneAndUpdate"], function protectExtractionQuery() {
  const update = this.getUpdate() || {};
  const changedFields = new Set([
    ...Object.keys(update.$set || {}),
    ...Object.keys(update.$unset || {}),
    ...Object.keys(update.$replaceWith || {}),
  ]);
  if (immutableExtractionFields.some((field) => changedFields.has(field) || [...changedFields].some((path) => path.startsWith(`${field}.`)))) {
    throw new Error("ClinicalExtraction AI snapshot is immutable; store clinician changes in VerificationDraft or MedicalRecord.");
  }
});

// Phase 1 & 8: Clinical Document Model with Private Storage & Extraction Reference
const documentSchema = new Schema(
  {
    patient: { type: Schema.Types.ObjectId, ref: "Patient", default: null, index: true },
    uploadedBy: { type: Schema.Types.ObjectId, ref: "User", default: null, index: true },
    clinic: { type: String, default: "CuraClinic AI", index: true },
    originalFilename: { type: String, required: true },
    storedFilename: { type: String, required: true },
    // Private storage path (isolated from public static web root)
    // New uploads always populate this private path. The empty default keeps
    // legacy records migratable while they are being reviewed.
    storagePath: { type: String, default: "" },
    filePath: { type: String, default: "" }, // Legacy compatibility reference
    cloudinary: {
      assetId: { type: String, default: "", index: true },
      publicId: { type: String, default: "", index: true },
      resourceType: { type: String, default: "" },
      deliveryType: { type: String, default: "authenticated" },
      version: { type: Number, default: null },
      format: { type: String, default: "" },
      bytes: { type: Number, default: 0 },
      uploadedAt: { type: Date, default: null },
    },
    fileType: { type: String, required: true },
    fileSize: Number,
    uploadedAt: { type: Date, default: Date.now, index: true },
    documentType: {
      type: String,
      enum: ["PRESCRIPTION", "OPD_CARD", "CASE_SHEET", "LAB_REPORT", "DISCHARGE_SUMMARY", "CLINICAL_NOTE", "INVESTIGATION_NOTE", "OTHER"],
      default: "CLINICAL_NOTE",
    },
    // Strict Clinical Record Status (Phase 12)
    status: {
      type: String,
      // The first three values are retained so existing prototype documents
      // remain readable after the workflow migration.
      enum: ["DRAFT", "AI_EXTRACTED", "NEEDS_VERIFICATION", "CLINICIAN_VERIFIED", "APPROVED", "AMENDED", "REJECTED", "PENDING_OCR", "EXTRACTED", "DOCTOR_VERIFIED"],
      default: "AI_EXTRACTED",
      index: true,
    },
    extraction: { type: Schema.Types.ObjectId, ref: "ClinicalExtraction", default: null, index: true },
    verificationNotes: String,
    verifiedBy: String,
    verifiedById: { type: Schema.Types.ObjectId, ref: "User", default: null },
    verifiedAt: Date,
    // Cached presentation mirrors for performance (original extraction remains pristine in ClinicalExtraction)
    extractedRecord: {
      rawText: String,
      structuredJson: Schema.Types.Mixed,
      confidenceScore: { type: Number, default: 0.9 },
      modelName: { type: String, default: "gemini-2.0-flash" },
      aiSummary: String,
      clinicalFlags: Schema.Types.Mixed,
      extractedAt: { type: Date, default: Date.now },
    },
    medications: { type: [Schema.Types.Mixed], default: [] },
    labResults: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true }
);

documentSchema.index({ status: 1, createdAt: -1 });
documentSchema.index({ patient: 1, createdAt: -1 });
documentSchema.index({ clinic: 1, status: 1, createdAt: -1 });
documentSchema.index({ originalFilename: "text" });

const soapNoteSchema = new Schema(
  {
    patient: { type: Schema.Types.ObjectId, ref: "Patient", required: true, index: true },
    document: { type: Schema.Types.ObjectId, ref: "ClinicalDocument", default: null },
    subjective: { type: String, required: true },
    objective: { type: String, required: true },
    assessment: { type: String, required: true },
    plan: { type: String, required: true },
    doctorNotes: String,
    isSigned: { type: Boolean, default: false },
    signedBy: String,
  },
  { timestamps: true }
);

soapNoteSchema.index({ patient: 1, createdAt: -1 });

// Phase 10: Extended Audit Trail Schema (Immutable, Non-deletable)
const auditLogSchema = new Schema(
  {
    action: {
      type: String,
      required: true,
      enum: [
        "DOCUMENT_UPLOAD",
        "AI_EXTRACTION",
        "PATIENT_MATCH",
        "FIELD_VERIFIED",
        "FIELD_CORRECTED",
        "FIELD_UNCLEAR",
        "VERIFICATION_DRAFT_SAVED",
        "RECORD_APPROVED",
        "RECORD_AMENDED",
        "FHIR_SYNC",
        "RECORD_ACCESS",
        "PATIENT_CREATED",
        "PATIENT_UPDATED",
        "LOGIN",
        "LOGOUT",
        "OCR_EXTRACT",
        "DOCTOR_VERIFY",
        "DOCUMENT_REJECTED",
        "DRAFT_SAVED",
        "SOAP_DRAFT",
        "ASSISTANT_QUERY",
      ],
      index: true,
    },
    resourceType: { type: String, default: "ClinicalDocument", index: true },
    resourceId: { type: Schema.Types.ObjectId, default: null, index: true },
    document: { type: Schema.Types.ObjectId, ref: "ClinicalDocument", default: null },
    patient: { type: Schema.Types.ObjectId, ref: "Patient", default: null, index: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    actorName: { type: String, default: "Dr. Clinical Verifier" },
    actorRole: { type: String, default: "DOCTOR" },
    clinic: { type: String, default: "CuraClinic AI" },
    details: { type: Schema.Types.Mixed, default: {} },
    ipAddress: { type: String, default: "" },
  },
  { timestamps: { createdAt: "timestamp", updatedAt: false } }
);

auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ patient: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ clinic: 1, timestamp: -1 });

module.exports = {
  Patient: mongoose.models.Patient || mongoose.model("Patient", patientSchema),
  ClinicalDocument: mongoose.models.ClinicalDocument || mongoose.model("ClinicalDocument", documentSchema),
  ClinicalExtraction: mongoose.models.ClinicalExtraction || mongoose.model("ClinicalExtraction", clinicalExtractionSchema),
  SOAPNote: mongoose.models.SOAPNote || mongoose.model("SOAPNote", soapNoteSchema),
  AuditLog: mongoose.models.AuditLog || mongoose.model("AuditLog", auditLogSchema),
};
