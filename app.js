// Environment variables supplied by the host must win over a local .env file.
// Overriding them makes a stale .env silently replace production settings.
require("dotenv").config({ quiet: true });

const compression = require("compression");
const crypto = require("crypto");
const express = require("express");
const ejsMate = require("ejs-mate");
const fs = require("fs");
const fsPromises = require("fs/promises");
const methodOverride = require("method-override");
const mongoose = require("mongoose");
const multer = require("multer");
const path = require("path");
const session = require("express-session");
const { MongoStore } = require("connect-mongo");
const { OAuth2Client } = require("google-auth-library");

const { Patient, ClinicalDocument, ClinicalExtraction, SOAPNote, AuditLog } = require("./models/clinical");
const User = require("./models/user");
const { MedicalRecord, VerificationDraft, Conversation, Message } = require("./models/history");
const { analyzeDocumentPayload, evaluateLab, screenInteractions, semanticConfidence } = require("./utils/clinicalAnalyzer");
const { answerClinicalQuestion, extractDocument, generateSoap } = require("./utils/aiClinical");
const { uploadClinicalDocument, destroyClinicalDocument, generateSignedDeliveryUrl } = require("./utils/cloudinaryStorage");
const { clinicalSearchEngine } = require("./utils/dsaSearchEngine");
const { getPipelineMetrics, cachedAnalyzeDocumentPayload } = require("./utils/dsaExtraction");

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason);
});

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 8080);
const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/curaclinic_documentation";
const SESSION_SECRET = process.env.SESSION_SECRET || "curaclinic-development-session-secret";
const CLINIC_NAME = process.env.CLINIC_NAME || "AI Clinical Records";
const TAGLINE = "Turn handwritten clinical documents into verified digital records.";
const DEFAULT_CLINICIAN = process.env.CLINICIAN_NAME || "Dr. Sharma, MD";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const PRODUCTION_APP_URL = process.env.APP_ORIGIN || "https://ai-health-tech.onrender.com";
// A production build may still be run on localhost for a final smoke test.
// Secure cookies cannot be returned over plain HTTP, so base this on the
// actual configured public origin rather than NODE_ENV alone.
const sessionCookieSecure = isProduction && /^https:\/\//i.test(PRODUCTION_APP_URL);
const DEFAULT_REDIRECT_URI = isProduction ? `${PRODUCTION_APP_URL}/auth/google/callback` : `http://localhost:${PORT}/auth/google/callback`;
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI;
const hasCredentialPlaceholder = (value) => /^(your-|replace-|change-me|example)/i.test(String(value || "").trim());
const googleConfigured = Boolean(
  GOOGLE_CLIENT_ID
  && GOOGLE_CLIENT_SECRET
  && !hasCredentialPlaceholder(GOOGLE_CLIENT_ID)
  && !hasCredentialPlaceholder(GOOGLE_CLIENT_SECRET)
);
const googleAuthRequired = String(process.env.GOOGLE_AUTH_REQUIRED || (isProduction ? "true" : "false")).toLowerCase() === "true";
// Local bypass is opt-in only. Development must exercise the same authorization
// boundaries as production unless LOCAL_DEMO_MODE=true is explicitly set.
const localDemoMode = String(process.env.LOCAL_DEMO_MODE || "false").toLowerCase() === "true";
const authenticationRequired = isProduction || googleAuthRequired || !localDemoMode;
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;

function getGoogleRedirectUri(req = null) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  if (req && !isProduction) {
    const proto = req.headers["x-forwarded-proto"] || req.protocol || (isProduction ? "https" : "http");
    const host = req.get("host");
    if (host) {
      return `${proto}://${host}/auth/google/callback`;
    }
  }
  return GOOGLE_REDIRECT_URI;
}

function getOAuthClient(req = null) {
  if (!googleConfigured) return null;
  return new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, getGoogleRedirectUri(req));
}

function safeNextPath(value) {
  const candidate = String(value || "").trim();
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || candidate.includes("\\")) return "/dashboard";
  return candidate;
}

function regenerateAuthenticatedSession(req, { userId, doctorName, currentClinic } = {}) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.userId = String(userId);
      req.session.doctorName = doctorName;
      req.session.currentClinic = currentClinic || CLINIC_NAME;
      resolve();
    });
  });
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => error ? reject(error) : resolve());
  });
}
const STORAGE_DIR = path.join(__dirname, "storage", "documents");
const SAMPLE_DIR = path.join(__dirname, "sample_files");
const MAX_UPLOAD_SIZE = 15 * 1024 * 1024;
const allowedExtensions = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp"]);
const allowedDocumentTypes = new Set(["PRESCRIPTION", "OPD_CARD", "CASE_SHEET", "LAB_REPORT", "DISCHARGE_SUMMARY", "CLINICAL_NOTE", "INVESTIGATION_NOTE", "OTHER"]);

fs.mkdirSync(STORAGE_DIR, { recursive: true });
fs.mkdirSync(SAMPLE_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, STORAGE_DIR),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    callback(null, `${crypto.randomUUID()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_SIZE, files: 1 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname || "").toLowerCase();
    if (!allowedExtensions.has(extension)) return callback(new Error("Upload a PDF, PNG, JPG, JPEG, or WEBP clinical record."));
    callback(null, true);
  },
});

async function validateUploadedFile(file) {
  if (!file?.path) throw new Error("The uploaded clinical record could not be read.");
  if (!allowedExtensions.has(path.extname(file.originalname || "").toLowerCase())) {
    throw new Error("Upload a PDF, PNG, JPG, JPEG, or WEBP clinical record.");
  }
  if (Number(file.size || 0) > MAX_UPLOAD_SIZE) {
    throw new Error("This record is larger than the 15 MB upload limit.");
  }

  const extension = path.extname(file.originalname || "").toLowerCase();
  const handle = await fsPromises.open(file.path, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const startsWith = (bytes) => bytes.every((value, index) => header[index] === value);
    const validSignature = extension === ".pdf"
      ? header.subarray(0, 5).toString("ascii") === "%PDF-"
      : extension === ".png"
        ? startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        : extension === ".jpg" || extension === ".jpeg"
          ? startsWith([0xff, 0xd8, 0xff])
          : extension === ".webp"
            ? bytesRead >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP"
            : false;
    if (!validSignature) throw new Error("The uploaded file does not match its selected PDF or image format.");
  } finally {
    await handle.close();
  }
}

function resolvePrivateDocumentPath(document) {
  const rawKey = String(document?.storagePath || document?.filePath || document?.storedFilename || "").trim();
  if (!rawKey) return "";
  const privateRoot = path.resolve(STORAGE_DIR);
  const sampleRoot = path.resolve(SAMPLE_DIR);

  if (path.isAbsolute(rawKey)) {
    const candidate = path.resolve(rawKey);
    if (candidate === privateRoot || candidate.startsWith(`${privateRoot}${path.sep}`) ||
        candidate === sampleRoot || candidate.startsWith(`${sampleRoot}${path.sep}`)) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  const storageCandidate = path.resolve(STORAGE_DIR, rawKey.replace(/^(?:documents|storage[\\/]documents)[\\/]/i, ""));
  if ((storageCandidate === privateRoot || storageCandidate.startsWith(`${privateRoot}${path.sep}`)) && fs.existsSync(storageCandidate)) {
    return storageCandidate;
  }

  const sampleCandidate = path.resolve(SAMPLE_DIR, rawKey.replace(/^sample_files[\\/]/i, ""));
  if ((sampleCandidate === sampleRoot || sampleCandidate.startsWith(`${sampleRoot}${path.sep}`)) && fs.existsSync(sampleCandidate)) {
    return sampleCandidate;
  }

  const baseName = path.basename(rawKey);
  const baseInStorage = path.join(STORAGE_DIR, baseName);
  if (fs.existsSync(baseInStorage)) return baseInStorage;
  const baseInSample = path.join(SAMPLE_DIR, baseName);
  if (fs.existsSync(baseInSample)) return baseInSample;

  return "";
}

app.engine("ejs", ejsMate);
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.set("trust proxy", 1);
app.use(compression());
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));
app.use(methodOverride("_method"));
// Clinical source files are private. A legacy /uploads URL must never expose
// anything even though the public folder is served for UI assets.
app.use("/uploads", (_req, res) => res.sendStatus(404));
app.use(express.static(path.join(__dirname, "public"), { maxAge: isProduction ? "1d" : 0 }));
app.use("/vendor/bootstrap", express.static(path.join(__dirname, "node_modules", "bootstrap", "dist", "css")));
app.use("/vendor/bulma", express.static(path.join(__dirname, "node_modules", "bulma", "css")));
app.use("/vendor/foundation", express.static(path.join(__dirname, "node_modules", "foundation-sites", "dist", "css")));
app.use(
  session({
    name: "curaclinic.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: new MongoStore({ mongoUrl: MONGO_URL, collectionName: "sessions", ttl: 60 * 60 * 24 * 7 }),
    cookie: { httpOnly: true, sameSite: "lax", secure: sessionCookieSecure, maxAge: 1000 * 60 * 60 * 24 * 7 },
  })
);

app.locals.clinicName = CLINIC_NAME;
app.locals.tagline = TAGLINE;
app.locals.clinicianName = DEFAULT_CLINICIAN;
app.locals.activeClinics = [CLINIC_NAME, "Sunrise Hospital", "Private Practice"];
app.locals.clinicDisplayName = (clinic) => clinic || CLINIC_NAME;
app.locals.semanticConfidence = semanticConfidence;
app.locals.googleConfigured = googleConfigured;
app.locals.formatDate = (value, includeTime = false) => {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not recorded";
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", ...(includeTime ? { timeStyle: "short" } : {}) }).format(date);
};
app.locals.safeIsoDate = (value) => {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};
app.locals.selectedPatientId = "";
app.locals.currentUser = null;
app.locals.isAuthenticated = false;
app.locals.prettyType = (value) => String(value || "").replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
app.locals.toTitleCase = (str) => {
  if (!str || typeof str !== "string") return "";
  return str.trim().replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.slice(1).toLowerCase());
};
app.locals.statusClass = (value) => String(value || "").toLowerCase().replaceAll("_", "-");
app.locals.isDocumentApproved = (document) => Boolean(document && ["APPROVED", "CLINICIAN_VERIFIED", "AMENDED", "DOCTOR_VERIFIED"].includes(document.status));
app.locals.isDocumentPendingReview = (document) => Boolean(document && ["DRAFT", "AI_EXTRACTED", "NEEDS_VERIFICATION", "PENDING_OCR", "EXTRACTED"].includes(document.status));

app.use(async (req, res, next) => {
  res.locals.currentPath = req.path;
  res.locals.loginMode = req.query.mode === "signup";
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  req.session.currentClinic = req.session.currentClinic || CLINIC_NAME;
  res.locals.currentClinic = req.session.currentClinic;
  let currentUser = null;
  if (req.session.userId) {
    try {
      currentUser = await User.findById(req.session.userId).lean();
    } catch (error) {
      console.error("Could not load signed-in clinician:", error.message);
    }
  }
  const isAuth = Boolean(req.session.userId && currentUser);
  req.currentUser = currentUser;
  res.locals.isAuthenticated = isAuth;
  res.locals.currentUser = currentUser || (localAccessAllowed() ? { name: req.session.doctorName || DEFAULT_CLINICIAN, role: "DOCTOR", email: "dr.sharma@curaclinic.health" } : null);
  next();
});

app.use((req, res, next) => {
  const publicPaths = new Set(["/", "/login", "/auth/google", "/auth/google/callback", "/health"]);
  if (authenticationRequired && !req.session.userId && !publicPaths.has(req.path)) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sign in as an authorized clinician to continue." });
    return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
});

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function redirectWithFlash(req, res, location, type, message) {
  setFlash(req, type, message);
  res.redirect(location);
}

async function recordAudit(action, details = {}) {
  try {
    await AuditLog.create({
      action,
      resourceType: details.resourceType || "ClinicalDocument",
      resourceId: details.resourceId || details.document || details.patient || null,
      document: details.document || null,
      patient: details.patient || null,
      actorId: details.actorId || null,
      actorName: details.actorName || DEFAULT_CLINICIAN,
      actorRole: details.actorRole || "DOCTOR",
      clinic: details.clinic || CLINIC_NAME,
      details: details.data || {},
      ipAddress: details.ipAddress || "",
    });
  } catch (error) {
    console.error("Audit log failed:", error.message);
  }
}

function normalizeMedication(input) {
  const confidence = Number(input.confidence ?? 0);
  const semantic = semanticConfidence(confidence);
  const sourceRegion = input.sourceRegion && typeof input.sourceRegion === "object"
    ? input.sourceRegion
    : { page: null, boundingBox: null, textSnippet: String(input.textSnippet || "").trim() };
  return {
    name: String(input.name || "").trim(),
    genericName: String(input.genericName || input.generic_name || "").trim(),
    dosage: String(input.dosage || "").trim(),
    frequency: String(input.frequency || "").trim(),
    route: String(input.route || "").trim(),
    duration: String(input.duration || "").trim(),
    instructions: String(input.instructions || "").trim(),
    confidence,
    confidenceTier: input.confidenceTier || semantic.tier,
    sourceRegion,
    isVerified: Boolean(input.isVerified ?? input.is_verified ?? false),
    warning: String(input.warning || "").trim(),
  };
}

function normalizeLab(input) {
  const testName = input.testName ?? input.test_name;
  const resultValue = input.resultValue ?? input.result_value;
  const referenceRange = input.referenceRange ?? input.reference_range;
  const evaluated = evaluateLab(testName, resultValue, referenceRange);
  const confidence = Number(input.confidence ?? 0);
  const semantic = semanticConfidence(confidence);
  return {
    panelName: String(input.panelName ?? input.panel_name ?? "").trim(),
    testName: String(testName ?? "").trim(),
    resultValue: String(resultValue ?? "").trim(),
    numericValue: input.numericValue ?? input.numeric_value ?? evaluated.numericValue,
    units: String(input.units || evaluated.units || "").trim(),
    referenceRange: String(referenceRange || evaluated.referenceRange || "").trim(),
    status: ["NORMAL", "HIGH", "LOW", "CRITICAL", "UNKNOWN"].includes(input.status) ? input.status : evaluated.status,
    confidence,
    confidenceTier: input.confidenceTier || semantic.tier,
    sourceRegion: input.sourceRegion && typeof input.sourceRegion === "object"
      ? input.sourceRegion
      : { page: null, boundingBox: null, textSnippet: String(input.textSnippet || "").trim() },
    isVerified: Boolean(input.isVerified ?? input.is_verified ?? false),
    testDate: input.testDate || input.test_date || null,
  };
}

function safeJson(value, fallback) {
  try {
    if (typeof value !== "string" || !value.trim()) return fallback;
    const parsed = JSON.parse(value);
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function safeJsonArray(value, fallback = []) {
  const parsed = safeJson(value, fallback);
  return Array.isArray(parsed) ? parsed : (Array.isArray(fallback) ? fallback : []);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function localAccessAllowed() {
  return localDemoMode && !googleAuthRequired && !isProduction;
}

function patientAccessQuery(req) {
  const clinic = req.session?.currentClinic || CLINIC_NAME;
  const clinicScope = { clinic };
  if (req.currentUser?._id) {
    if (req.currentUser.role === "ADMIN") return clinicScope;
    return {
      $and: [
        clinicScope,
        {
          $or: [
            { ownerDoctor: req.currentUser._id },
            { authorizedDoctors: req.currentUser._id },
            { ownerDoctor: null },
            { ownerDoctor: { $exists: false } },
            { authorizedDoctors: { $size: 0 } },
          ],
        },
      ],
    };
  }
  return localAccessAllowed() ? clinicScope : { _id: null };
}

function documentAccessQuery(req, patientIds = []) {
  const clinic = req.session?.currentClinic || CLINIC_NAME;
  const unassignedScope = {
    patient: null,
    clinic,
    ...(req.currentUser?.role === "ADMIN" || localAccessAllowed()
      ? {}
      : req.currentUser?._id
        ? { uploadedBy: req.currentUser._id }
        : {}),
  };
  if (Array.isArray(patientIds) && patientIds.length > 0) {
    return {
      $or: [
        { patient: { $in: patientIds } },
        unassignedScope
      ]
    };
  }
  return unassignedScope;
}

async function findAccessiblePatient(req, patientId, options = {}) {
  if (!mongoose.isValidObjectId(patientId)) return null;
  return Patient.findOne({ _id: patientId, ...patientAccessQuery(req) }, options);
}

async function findAccessibleDocument(req, documentId, options = {}) {
  if (!mongoose.isValidObjectId(documentId)) return null;
  const document = await ClinicalDocument.findById(documentId, null, options);
  if (!document) return null;
  if (document.patient) {
    const patient = await findAccessiblePatient(req, document.patient, { _id: 1 });
    return patient ? document : null;
  }
  // Unmatched uploads are visible only to their uploader inside the active
  // clinic until a patient is explicitly selected.
  const clinicMatches = !document.clinic || document.clinic === (req.session?.currentClinic || CLINIC_NAME);
  const uploaderMatches = !document.uploadedBy || (req.currentUser?._id && String(document.uploadedBy) === String(req.currentUser._id)) || req.currentUser?.role === "ADMIN" || localAccessAllowed();
  return clinicMatches && uploaderMatches ? document : null;
}

function currentDoctorName(req) {
  return req.currentUser?.name || req.session.doctorName || DEFAULT_CLINICIAN;
}

function isDocumentApproved(document) {
  return Boolean(document && ["APPROVED", "CLINICIAN_VERIFIED", "AMENDED", "DOCTOR_VERIFIED"].includes(document.status));
}

function isDocumentPendingReview(document) {
  return Boolean(document && ["DRAFT", "AI_EXTRACTED", "NEEDS_VERIFICATION", "PENDING_OCR", "EXTRACTED"].includes(document.status));
}

function documentSnapshot(document) {
  const structuredData = document.extractedRecord?.structuredJson || {};
  const diagnosis = Array.isArray(structuredData.diagnosis)
    ? structuredData.diagnosis
      .map((item) => fieldValue(item?.value ?? item))
      .filter((value) => value !== null && value !== undefined && String(value).trim())
      .map((value) => String(value).trim())
      .join("; ")
    : String(fieldValue(structuredData.diagnosis) || "").trim();
  return {
    sourceFilename: document.originalFilename,
    documentType: document.documentType,
    fileType: document.fileType,
    uploadedAt: document.uploadedAt || document.createdAt,
    summary: document.extractedRecord?.aiSummary || "",
    confidenceScore: document.extractedRecord?.confidenceScore ?? null,
    modelName: document.extractedRecord?.modelName || "deterministic-clinical-fallback",
    clinicalFlags: document.extractedRecord?.clinicalFlags || {},
    diagnosis,
    structuredData,
    medications: JSON.parse(JSON.stringify(document.medications || [])),
    labResults: JSON.parse(JSON.stringify(document.labResults || [])),
  };
}

async function ensureMedicalRecordForDocument(document, req = null) {
  if (!document?.patient || !isDocumentApproved(document)) return null;
  const existing = await MedicalRecord.findOne({ document: document._id });
  if (existing) return existing;
  try {
    return await MedicalRecord.create({
      patient: document.patient,
      document: document._id,
      extraction: document.extraction || null,
      recordType: document.documentType,
      title: document.originalFilename,
      extractedData: documentSnapshot(document),
      originalVersionSnapshot: documentSnapshot(document),
      status: "APPROVED",
      doctorVerified: true,
      verifiedBy: req?.currentUser?._id || null,
      verifiedByName: document.verifiedBy || currentDoctorName(req || { session: {} }),
      verifiedAt: document.verifiedAt || document.updatedAt || document.createdAt,
      approvedBy: req?.currentUser?._id || null,
      approvedByName: document.verifiedBy || currentDoctorName(req || { session: {} }),
      approvedAt: document.verifiedAt || document.updatedAt || document.createdAt,
      verificationNotes: document.verificationNotes || "",
      version: 1,
      clinicName: req?.session?.currentClinic || CLINIC_NAME,
    });
  } catch (error) {
    if (error?.code === 11000) return MedicalRecord.findOne({ document: document._id });
    throw error;
  }
}

async function attachMessageCounts(conversationRows) {
  if (!Array.isArray(conversationRows) || conversationRows.length === 0) return [];
  const conversationIds = conversationRows.map((c) => c._id);
  const counts = await Message.aggregate([
    { $match: { conversation: { $in: conversationIds } } },
    { $group: { _id: "$conversation", count: { $sum: 1 } } },
  ]);
  const countMap = new Map(counts.map((item) => [String(item._id), item.count]));
  return conversationRows.map((conversation) => ({
    ...conversation,
    messageCount: countMap.get(String(conversation._id)) || 0,
  }));
}

async function loadPatientContext(req, id) {
  const patientDocument = await findAccessiblePatient(req, id);
  if (!patientDocument) return null;
  const patient = patientDocument.toObject();
  const documents = await ClinicalDocument.find({ patient: patient._id }).sort({ createdAt: -1 }).lean();
  await Promise.all(documents.filter(isDocumentApproved).map((document) => ensureMedicalRecordForDocument(document, req)));
  const [soapNotes, medicalRecords, conversationRows, auditLogs] = await Promise.all([
    SOAPNote.find({ patient: patient._id }).sort({ createdAt: -1 }).lean(),
    MedicalRecord.find({ patient: patient._id, doctorVerified: true }).populate("document", "originalFilename documentType createdAt").sort({ createdAt: -1 }).lean(),
    Conversation.find({ patient: patient._id }).sort({ updatedAt: -1 }).lean(),
    AuditLog.find({ patient: patient._id }).sort({ timestamp: -1 }).limit(50).lean(),
  ]);
  const conversations = await attachMessageCounts(conversationRows);
  return { patient, documents, soapNotes, medicalRecords, conversations, auditLogs };
}

function fieldValue(field) {
  return field && typeof field === "object" && Object.prototype.hasOwnProperty.call(field, "value") ? field.value : field;
}

function compactMatchValue(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function findPatientMatchCandidates(req, structuredData) {
  const extractedPatient = structuredData?.patient || {};
  const extractedName = String(fieldValue(extractedPatient.name) || "").trim();
  const extractedMrn = String(fieldValue(extractedPatient.mrn) || "").trim();
  const extractedPhone = String(fieldValue(extractedPatient.phone) || "").trim();
  if (!extractedName && !extractedMrn && !extractedPhone) return [];

  const patients = await Patient.find(patientAccessQuery(req)).sort({ updatedAt: -1 }).limit(250).lean();
  const normalizedName = compactMatchValue(extractedName);
  const normalizedMrn = compactMatchValue(extractedMrn);
  const normalizedPhone = compactMatchValue(extractedPhone);
  return patients.map((patient) => {
    const patientName = compactMatchValue(patient.fullName);
    const patientMrn = compactMatchValue(patient.mrn);
    const patientPhone = compactMatchValue(patient.phone);
    let score = 0;
    const reasons = [];
    if (normalizedMrn && patientMrn === normalizedMrn) { score += 100; reasons.push("MRN exact match"); }
    if (normalizedPhone && patientPhone && patientPhone === normalizedPhone) { score += 80; reasons.push("phone exact match"); }
    if (normalizedName && patientName === normalizedName) { score += 70; reasons.push("name exact match"); }
    else if (normalizedName && (patientName.includes(normalizedName) || normalizedName.includes(patientName))) { score += 35; reasons.push("name partial match"); }
    return { ...patient, matchScore: score, matchReasons: reasons };
  }).filter((patient) => patient.matchScore > 0).sort((a, b) => b.matchScore - a.matchScore).slice(0, 10);
}

async function processDocumentUpload(req, patientId, file) {
  await validateUploadedFile(file);
  const patient = patientId ? await findAccessiblePatient(req, patientId) : null;
  if (patientId && !patient) throw new Error("The selected patient was not found or you are not authorized to access this patient.");
  const requestedType = String(req.body.documentType || "CLINICAL_NOTE");
  const documentType = requestedType === "AUTO" ? "CLINICAL_NOTE" : allowedDocumentTypes.has(requestedType) ? requestedType : "CLINICAL_NOTE";
  const clinic = req.session.currentClinic || CLINIC_NAME;
  let cloudAsset = null;
  try {
    cloudAsset = await uploadClinicalDocument(file, { clinic, doctorId: req.currentUser?._id ? String(req.currentUser._id) : "local-doctor" });
  } catch (cloudErr) {
    console.warn("Cloudinary upload skipped or failed, persisting locally in private storage:", cloudErr.message);
  }
  let document = null;
  try {
    document = await ClinicalDocument.create({
      patient: patient?._id || null,
      uploadedBy: req.currentUser?._id || null,
      clinic,
      originalFilename: path.basename(file.originalname),
      storedFilename: file.filename,
      storagePath: file.filename,
      cloudinary: cloudAsset,
      fileType: file.mimetype,
      fileSize: file.size,
      documentType,
      status: "DRAFT",
    });
    await recordAudit("DOCUMENT_UPLOAD", { document: document._id, patient: patient?._id || null, actorName: currentDoctorName(req), data: { filename: document.originalFilename, size: document.fileSize, cloudinaryAssetId: cloudAsset?.assetId || null } });
    const extracted = await extractDocument({ filePath: file.path, mimeType: file.mimetype }, document.originalFilename, documentType, patient?.allergies || "");
  document.documentType = extracted.documentType || documentType;
  document.status = "NEEDS_VERIFICATION";
  document.extractedRecord = { rawText: JSON.stringify(extracted.originalSnapshot || extracted), structuredJson: extracted.structuredData, confidenceScore: extracted.overallConfidence || 0, modelName: extracted.modelName, aiSummary: extracted.aiSummary, clinicalFlags: extracted.clinicalFlags, extractedAt: new Date() };
  document.medications = (extracted.medications || []).map(normalizeMedication);
  document.labResults = (extracted.labResults || []).map(normalizeLab);
  const extraction = await ClinicalExtraction.create({
    document: document._id,
    patient: patient?._id || null,
    aiProvider: extracted.modelName || "manual-clinical-review",
    overallConfidence: extracted.overallConfidence || 0,
    status: extracted.status || "NEEDS_VERIFICATION",
    structuredData: extracted.structuredData,
    originalSnapshot: extracted.originalSnapshot || {},
    clinicalFlags: extracted.clinicalFlags || {},
    aiSummary: extracted.aiSummary || "",
  });
  document.extraction = extraction._id;
  await document.save();
  await recordAudit("AI_EXTRACTION", { document: document._id, patient: patient?._id || null, actorName: currentDoctorName(req), data: { model: extracted.modelName, status: document.status, overallConfidence: extracted.overallConfidence || 0, alertsFound: extracted.clinicalFlags?.totalAlerts || 0 } });
  // DSA perf: incremental index update — O(document) instead of a full rebuild.
  clinicalSearchEngine.indexSingleDocument({
    ...document.toObject(),
    patient: patient ? { fullName: patient.fullName, mrn: patient.mrn } : null,
  });
  const patientCandidates = patient ? [] : await findPatientMatchCandidates(req, extracted.structuredData);
    return { document, patient, extracted, extraction, patientCandidates };
  } catch (error) {
    if (document?._id) {
      await ClinicalExtraction.deleteMany({ document: document._id }).catch(() => {});
      await ClinicalDocument.deleteOne({ _id: document._id }).catch(() => {});
    }
    await destroyClinicalDocument(cloudAsset);
    throw error;
  }
}

function timelineFor(patient, documents) {
  const events = [];
  for (const doc of documents) {
    events.push({ type: "DOCUMENT", title: `Uploaded ${app.locals.prettyType(doc.documentType)}`, description: `${doc.originalFilename} · ${app.locals.prettyType(doc.status)}`, date: doc.createdAt, documentId: doc._id });
    for (const med of doc.medications || []) events.push({ type: "PRESCRIPTION", title: `Rx: ${med.name} ${med.dosage || ""}`, description: `${med.frequency || "As instructed"} · ${med.isVerified ? "Verified" : "Extracted"}`, date: doc.createdAt, documentId: doc._id });
    for (const lab of doc.labResults || []) events.push({ type: "LAB_TEST", title: `${lab.testName}: ${lab.resultValue} ${lab.units || ""}`, description: `${lab.status} · Ref ${lab.referenceRange || "not recorded"}`, date: lab.testDate || doc.createdAt, documentId: doc._id, status: lab.status });
  }
  return events.sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function refreshSearchIndex() {
  try {
    const [patients, documents, records] = await Promise.all([
      Patient.find({}).lean(),
      ClinicalDocument.find({}).populate("patient", "fullName mrn").lean(),
      MedicalRecord.find({}).populate("patient", "fullName mrn").lean(),
    ]);
    const stats = await clinicalSearchEngine.buildIndex({ patients, documents, records });
    console.log(`DSA Clinical Search Index built: ${stats.totalEntities} entities, ${stats.totalTokens} tokens in ${stats.buildDurationMs}ms`);
  } catch (err) {
    console.error("Failed to build DSA search index:", err.message);
  }
}

// DSA perf: search requests no longer rebuild the whole index on every call.
// A warm index is reused for SEARCH_INDEX_TTL_MS; scope changes (different
// clinician/clinic) always rebuild to preserve access boundaries.
const SEARCH_INDEX_TTL_MS = Math.max(0, Number(process.env.SEARCH_INDEX_TTL_MS ?? 60_000));
let searchIndexRefreshedAt = 0;
let searchIndexScopeKey = "";

function searchIndexScopeKeyFor(req) {
  return `${req.currentUser?._id || (localAccessAllowed() ? "local" : "anonymous")}::${req.session?.currentClinic || ""}`;
}

async function refreshScopedSearchIndex(req) {
  const scopeKey = searchIndexScopeKeyFor(req);
  const isWarm = clinicalSearchEngine.isIndexed
    && searchIndexScopeKey === scopeKey
    && Date.now() - searchIndexRefreshedAt < SEARCH_INDEX_TTL_MS;
  if (isWarm) return clinicalSearchEngine.stats;

  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const [patients, documents, records] = await Promise.all([
    Patient.find({ _id: { $in: patientIds } }).lean(),
    ClinicalDocument.find({ patient: { $in: patientIds } }).populate("patient", "fullName mrn").lean(),
    MedicalRecord.find({ patient: { $in: patientIds } }).populate("patient", "fullName mrn").lean(),
  ]);
  const stats = await clinicalSearchEngine.buildIndex({ patients, documents, records });
  searchIndexRefreshedAt = Date.now();
  searchIndexScopeKey = scopeKey;
  return stats;
}

async function seedDemoData() {
  return false;
}

app.get("/", asyncHandler(async (req, res) => {
  if (req.session.userId || localAccessAllowed()) {
    return res.redirect("/dashboard");
  }
  res.render("pages/home", {
    pageTitle: "Turn handwritten clinical documents into verified digital records",
  });
}));

app.get("/health", (_req, res) => {
  res.json({ status: "healthy", service: CLINIC_NAME, database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

app.get("/login", (req, res) => {
  const signedOut = req.query.signed_out === "true";
  res.render("pages/login", {
    pageTitle: "Sign in with Google",
    error: req.query.error || null,
    signedOut,
    googleConfigured,
    nextUrl: req.query.next || "/dashboard",
  });
});

// Google is the only supported authentication method.
app.post("/login", (_req, res) => res.redirect("/login?error=Use+Sign+in+with+Google."));
app.post("/signup", (_req, res) => res.redirect("/login?error=Use+Sign+in+with+Google."));

app.get("/auth/google", asyncHandler(async (req, res) => {
  const googleOAuthClient = getOAuthClient(req);
  if (!googleOAuthClient) return res.redirect("/login?error=Google+authentication+is+not+configured+yet.");
  const state = crypto.randomBytes(24).toString("hex");
  req.session.googleOAuthState = {
    value: state,
    createdAt: Date.now(),
    nextUrl: safeNextPath(req.query.next),
  };
  // Persist the state before leaving this origin. This avoids intermittent
  // callback failures with asynchronous Mongo-backed session stores.
  await saveSession(req);
  res.redirect(googleOAuthClient.generateAuthUrl({ access_type: "offline", scope: ["openid", "email", "profile"], prompt: "select_account", state }));
}));

app.get("/auth/google/callback", asyncHandler(async (req, res) => {
  const googleOAuthClient = getOAuthClient(req);
  if (!googleOAuthClient) return res.redirect("/login?error=Google+authentication+is+not+configured+yet.");
  const oauthState = req.session.googleOAuthState;
  const expectedState = typeof oauthState === "string" ? oauthState : oauthState?.value;
  const stateCreatedAt = typeof oauthState === "string" ? 0 : Number(oauthState?.createdAt || 0);
  if (!req.query.code || !req.query.state || req.query.state !== expectedState || (stateCreatedAt && Date.now() - stateCreatedAt > GOOGLE_STATE_TTL_MS)) {
    delete req.session.googleOAuthState;
    return res.redirect("/login?error=Google+sign-in+expired.+Please+try+again.");
  }
  const redirectTo = safeNextPath(oauthState?.nextUrl);
  delete req.session.googleOAuthState;
  let ticket;
  try {
    const { tokens } = await googleOAuthClient.getToken(String(req.query.code));
    if (!tokens.id_token) throw new Error("Google did not return an ID token");
    ticket = await googleOAuthClient.verifyIdToken({ idToken: tokens.id_token, audience: GOOGLE_CLIENT_ID });
  } catch (error) {
    console.error("Google OAuth verification failed:", error.message);
    return res.redirect("/login?error=Google+sign-in+could+not+be+verified.+Please+try+again.");
  }
  const profile = ticket.getPayload();
  if (!profile?.sub || !profile.email || profile.email_verified === false) return res.redirect("/login?error=Google+did+not+return+a+verified+clinician+profile.");
  let clinician = await User.findOne({ googleId: profile.sub });
  if (!clinician) clinician = await User.findOne({ email: profile.email.toLowerCase() });
  if (clinician) {
    clinician.googleId = profile.sub;
    clinician.name = profile.name || clinician.name;
    clinician.avatar = profile.picture || clinician.avatar;
    clinician.lastLoginAt = new Date();
    await clinician.save();
  } else {
    clinician = await User.create({ googleId: profile.sub, email: profile.email.toLowerCase(), name: profile.name || profile.email, avatar: profile.picture || "", lastLoginAt: new Date() });
  }
  await regenerateAuthenticatedSession(req, {
    userId: clinician._id,
    doctorName: clinician.name,
    currentClinic: clinician.clinic || CLINIC_NAME,
  });
  setFlash(req, "success", `Welcome, ${clinician.name}. Google sign-in verified.`);
  await saveSession(req);
  res.redirect(redirectTo);
}));

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("curaclinic.sid", { path: "/", httpOnly: true, sameSite: "lax", secure: sessionCookieSecure });
    res.redirect("/login?signed_out=true");
  });
});

app.get("/dashboard", asyncHandler(async (req, res) => {
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const documentScope = documentAccessQuery(req, patientIds);

  const [rawPatientsCount, todayDocsCount, pendingDocs, recentRecords] = await Promise.all([
    Patient.countDocuments(patientAccessQuery(req)),
    ClinicalDocument.countDocuments({
      ...documentScope,
      createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    }),
    ClinicalDocument.find({ ...documentScope, status: { $in: ["DRAFT", "AI_EXTRACTED", "NEEDS_VERIFICATION", "EXTRACTED", "PENDING_OCR"] } })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("patient", "fullName mrn")
      .lean(),
    MedicalRecord.find({ patient: { $in: patientIds }, doctorVerified: true })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate("patient", "fullName mrn")
      .populate("document", "originalFilename documentType status createdAt")
      .lean(),
  ]);

  // Transform pending verification docs with humanized review field counts
  const pendingQueue = pendingDocs.map((doc) => {
    const medsNeedReview = (doc.medications || []).filter((m) => !m.isVerified || m.confidence < 0.85 || m.confidenceTier === "NEEDS_VERIFICATION").length;
    const labsNeedReview = (doc.labResults || []).filter((l) => !l.isVerified || l.confidence < 0.85 || l.confidenceTier === "NEEDS_VERIFICATION").length;
    const totalNeedReview = medsNeedReview + labsNeedReview;
    let reviewStatusText = "Ready to approve";
    if (totalNeedReview === 1) reviewStatusText = "1 field needs review";
    else if (totalNeedReview > 1) reviewStatusText = `${totalNeedReview} fields need review`;

    return {
      ...doc,
      patient: doc.patient ? { ...doc.patient, fullName: app.locals.toTitleCase(doc.patient.fullName) } : null,
      reviewStatusText,
      totalNeedReview,
    };
  });

  // Recent clinical records table: Patient | Document | Status | Time
  let recentClinicalRecords = recentRecords.map((rec) => ({
    patientName: app.locals.toTitleCase(rec.patient?.fullName) || "Unknown Patient",
    patientId: rec.patient?._id,
    mrn: rec.patient?.mrn || "Unassigned",
    documentTitle: rec.title || "Prescription",
    documentType: rec.recordType || "PRESCRIPTION",
    status: rec.doctorVerified ? "Approved" : "Processing",
    time: rec.verifiedAt || rec.createdAt,
    version: rec.version || 1,
    recordId: rec._id,
  }));

  if (recentClinicalRecords.length === 0) {
    const fallbackDocs = await ClinicalDocument.find(documentScope)
      .sort({ createdAt: -1 })
      .limit(6)
      .populate("patient", "fullName mrn")
      .lean();
    recentClinicalRecords = fallbackDocs.map((d) => ({
      patientName: app.locals.toTitleCase(d.patient?.fullName) || "Unknown Patient",
      patientId: d.patient?._id,
      mrn: d.patient?.mrn || "Unassigned",
      documentTitle: d.originalFilename,
      documentType: d.documentType,
      status: isDocumentApproved(d) ? "Approved" : isDocumentPendingReview(d) ? "Needs Review" : "Processing",
      time: d.createdAt,
      documentId: d._id,
      recordId: null,
    }));
  }

  const statPatients = rawPatientsCount;
  const statTodayDocs = todayDocsCount;
  const statNeedsReview = pendingQueue.length;

  res.render("pages/dashboard", {
    pageTitle: "Dashboard",
    clinicianGreeting: currentDoctorName(req),
    stats: {
      patients: statPatients,
      todayDocs: statTodayDocs,
      needsReview: statNeedsReview,
    },
    pendingQueue,
    recentClinicalRecords,
  });
}));

app.post("/demo-data", asyncHandler(async (req, res) => {
  redirectWithFlash(req, res, "/dashboard", "info", "Demo data seeding has been disabled.");
}));

app.get("/upload", asyncHandler(async (req, res) => {
  const patients = await Patient.find(patientAccessQuery(req)).sort({ fullName: 1 }).lean();
  const selectedPatientId = mongoose.isValidObjectId(req.query.patient) ? String(req.query.patient) : "";
  res.render("pages/upload", { pageTitle: "Add clinical record", patients, selectedPatientId });
}));

function clinicalUploadPageMiddleware(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (error) return redirectWithFlash(req, res, "/upload", "danger", error.code === "LIMIT_FILE_SIZE" ? "This record is larger than the 15 MB upload limit." : error.message);
    next();
  });
}

function clinicalUploadApiMiddleware(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (error) return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.message });
    next();
  });
}

app.post("/documents/upload", clinicalUploadPageMiddleware, asyncHandler(async (req, res) => {
  if (!req.file) return redirectWithFlash(req, res, "/upload", "danger", "Choose a clinical record before continuing.");
  try {
    const { document, patient } = await processDocumentUpload(req, req.body.patientId, req.file);
    const extractionUnavailable = document.extractedRecord?.modelName === "manual-clinical-review"
      || !document.extraction
      || !document.extractedRecord?.structuredJson;
    const destination = patient ? `/review/${document._id}` : `/documents/${document._id}/match`;
    const message = extractionUnavailable
      ? "Record uploaded, but AI extraction could not run. The source is saved for manual review; see the extraction diagnostic in the review screen."
      : patient
        ? "Record digitized. Review every extracted field before sign-off."
        : "Record digitized. Confirm the patient match before clinical review.";
    redirectWithFlash(req, res, destination, extractionUnavailable ? "danger" : "success", message);
  } catch (error) {
    await fsPromises.unlink(req.file.path).catch(() => {});
    redirectWithFlash(req, res, "/upload", "danger", error.message);
  }
}));

app.get("/documents/:id/match", asyncHandler(async (req, res) => {
  const document = await findAccessibleDocument(req, req.params.id, { lean: true });
  if (!document) return res.status(404).render("pages/error", { pageTitle: "Document not found", message: "This document is unavailable or you are not authorized to access it." });
  if (document.patient) return res.redirect(`/review/${document._id}`);
  const extraction = await ClinicalExtraction.findOne({ document: document._id }).lean();
  const [candidates, authorizedPatients] = await Promise.all([
    findPatientMatchCandidates(req, extraction?.structuredData),
    Patient.find(patientAccessQuery(req)).sort({ fullName: 1 }).lean(),
  ]);
  res.render("pages/patient-match", { pageTitle: "Confirm patient match", document, extraction, candidates, authorizedPatients });
}));

app.post("/documents/:id/match", asyncHandler(async (req, res) => {
  const document = await findAccessibleDocument(req, req.params.id);
  if (!document) return res.status(404).send("Document not found or access denied.");
  if (isDocumentApproved(document)) return redirectWithFlash(req, res, `/review/${document._id}`, "info", "This verified record is locked. Upload a new document for a new history entry.");

  let patient = null;
  if (req.body.action === "create_new" || req.body.patientId === "NEW") {
    const extraction = await ClinicalExtraction.findOne({ document: document._id }).lean();
    const extPatient = extraction?.structuredData?.patient || {};
    const fullName = String(req.body.newPatientName || extPatient.name?.value || "New Patient").trim();
    const phone = String(req.body.newPatientPhone || extPatient.phone?.value || "").trim();
    const gender = String(req.body.newPatientGender || extPatient.gender?.value || "").trim();
    const age = Number(req.body.newPatientAge || extPatient.age?.value) || null;
    let mrn = String(req.body.newPatientMrn || extPatient.mrn?.value || "").trim();
    if (!mrn || await Patient.exists({ mrn })) {
      mrn = `CC-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString("hex")}`;
    }

    try {
      patient = await Patient.create({
        mrn,
        fullName,
        gender,
        phone,
        age,
        clinic: req.session.currentClinic || CLINIC_NAME,
        ownerDoctor: req.currentUser?._id || null,
        authorizedDoctors: req.currentUser?._id ? [req.currentUser._id] : [],
      });
    } catch (createErr) {
      if (createErr?.code === 11000) {
        mrn = `CC-${Date.now().toString().slice(-6)}-${crypto.randomBytes(3).toString("hex")}`;
        patient = await Patient.create({
          mrn,
          fullName,
          gender,
          phone,
          age,
          clinic: req.session.currentClinic || CLINIC_NAME,
          ownerDoctor: req.currentUser?._id || null,
          authorizedDoctors: req.currentUser?._id ? [req.currentUser._id] : [],
        });
      } else {
        throw createErr;
      }
    }
  } else if (req.body.patientId) {
    patient = await findAccessiblePatient(req, req.body.patientId);
  }

  if (!patient) return redirectWithFlash(req, res, `/documents/${document._id}/match`, "danger", "Select an authorized patient or create a new patient profile.");
  document.patient = patient._id;
  await document.save();
  await ClinicalExtraction.updateOne({ document: document._id }, { $set: { patient: patient._id } });
  await recordAudit("PATIENT_MATCH", { document: document._id, patient: patient._id, actorId: req.currentUser?._id || null, actorName: currentDoctorName(req), clinic: req.session.currentClinic, data: { method: "clinician_confirmed" } });

  try {
    clinicalSearchEngine.indexSinglePatient(patient);
    const populatedDoc = await ClinicalDocument.findById(document._id).populate("patient", "fullName mrn").lean();
    if (populatedDoc) clinicalSearchEngine.indexSingleDocument(populatedDoc);
  } catch (err) {
    console.warn("Search index update on patient match failed:", err.message);
  }

  redirectWithFlash(req, res, `/review/${document._id}`, "success", `Patient confirmed (${patient.fullName}). Review the extracted fields before approval.`);
}));

app.post("/api/patients/:patientId/documents", clinicalUploadApiMiddleware, asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a clinical record before continuing." });
  try {
    const { document, patient, extracted } = await processDocumentUpload(req, req.params.patientId, req.file);
    res.status(201).json({ patientId: patient._id, documentId: document._id, status: document.status, documentType: document.documentType, extracted });
  } catch (error) {
    await fsPromises.unlink(req.file.path).catch(() => {});
    res.status(error.message.includes("not found") || error.message.includes("authorized") ? 404 : 400).json({ error: error.message });
  }
}));

app.get("/review", asyncHandler(async (req, res) => {
  const accessiblePatients = await Patient.find(patientAccessQuery(req)).select("_id").lean();
  const patientIds = accessiblePatients.map((patient) => patient._id);
  const docScope = documentAccessQuery(req, patientIds);

  let first = await ClinicalDocument.findOne({
    ...docScope,
    status: { $in: ["DRAFT", "AI_EXTRACTED", "NEEDS_VERIFICATION", "EXTRACTED", "PENDING_OCR"] },
  }).sort({ createdAt: -1 }).select("_id patient");

  if (first) {
    return res.redirect(first.patient ? `/review/${first._id}` : `/documents/${first._id}/match`);
  }
  redirectWithFlash(req, res, "/upload", "info", "No clinical record is waiting for review. Upload a document to begin.");
}));

app.get("/review/:id", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).render("pages/error", { pageTitle: "Record not found", message: "This clinical record is no longer available." });
  const sourceDocument = await ClinicalDocument.findById(req.params.id).populate("patient", "fullName mrn phone age gender allergies chronicConditions").lean();
  if (!sourceDocument) return res.status(404).render("pages/error", { pageTitle: "Record not found", message: "This clinical record is no longer available." });
  
  if (sourceDocument.patient) {
    const accessiblePatient = await findAccessiblePatient(req, sourceDocument.patient._id, { _id: 1 });
    if (!accessiblePatient) return res.status(404).render("pages/error", { pageTitle: "Record not found", message: "This clinical record is no longer available or you are not authorized to access it." });
  } else {
    const accessibleDoc = await findAccessibleDocument(req, sourceDocument._id, { lean: true });
    if (!accessibleDoc) return res.status(404).render("pages/error", { pageTitle: "Record not found", message: "This clinical record is no longer available or you are not authorized to access it." });
  }

  const [draft, extraction, authorizedPatients] = await Promise.all([
    VerificationDraft.findOne({ document: sourceDocument._id }).lean(),
    ClinicalExtraction.findOne({ document: sourceDocument._id }).lean(),
    Patient.find(patientAccessQuery(req)).sort({ fullName: 1 }).lean(),
  ]);

  const candidates = await findPatientMatchCandidates(req, extraction?.structuredData);

  // A verification draft is the clinician's current working copy. The AI
  // extraction remains immutable, but the review screen must render the
  // draft values after a save/reload instead of silently falling back to the
  // original extraction snapshot.
  const draftPayload = draft?.payload && typeof draft.payload === "object" ? draft.payload : {};
  const hasDraftStructuredData = draftPayload.structuredData
    && typeof draftPayload.structuredData === "object"
    && !Array.isArray(draftPayload.structuredData);
  const reviewStructuredData = hasDraftStructuredData
    ? draftPayload.structuredData
    : extraction?.structuredData || sourceDocument.extractedRecord?.structuredJson || {};
  const reviewMedications = Array.isArray(draftPayload.medications)
    ? draftPayload.medications
    : (sourceDocument.medications || []);
  const reviewLabResults = Array.isArray(draftPayload.labResults)
    ? draftPayload.labResults
    : (sourceDocument.labResults || []);
  const reviewExtraction = extraction
    ? {
        ...extraction,
        structuredData: reviewStructuredData,
        aiSummary: draftPayload.summary ?? extraction.aiSummary ?? "",
      }
    : null;

  const document = {
    ...sourceDocument,
    sourceAvailable: Boolean(
      resolvePrivateDocumentPath(sourceDocument)
      || (sourceDocument.cloudinary?.secureUrl && sourceDocument.cloudinary.secureUrl.startsWith('http'))
      || (sourceDocument.cloudinary?.url && sourceDocument.cloudinary.url.startsWith('http'))
    ),
    sourcePreviewType: sourceDocument.fileType === "application/pdf" || /\.pdf$/i.test(sourceDocument.originalFilename || "")
      ? "pdf"
      : "image",
    extractionSnapshot: extraction,
    medications: reviewMedications,
    labResults: reviewLabResults,
    verificationNotes: draftPayload.doctorNotes ?? sourceDocument.verificationNotes ?? "",
    extractedRecord: {
      ...(sourceDocument.extractedRecord || {}),
      aiSummary: draftPayload.summary ?? sourceDocument.extractedRecord?.aiSummary ?? "",
      structuredJson: reviewStructuredData,
    },
  };
  const patientIds = authorizedPatients.map((patient) => patient._id);
  const documents = await ClinicalDocument.find(documentAccessQuery(req, patientIds)).sort({ createdAt: -1 }).select("originalFilename documentType status createdAt").lean();
  res.render("pages/review", { pageTitle: "Review record", document, documents, extraction: reviewExtraction, draft, candidates, authorizedPatients });
}));

app.get("/documents/:id/file", asyncHandler(async (req, res) => {
  const document = await findAccessibleDocument(req, req.params.id, { lean: true });
  if (!document) {
    return res.status(404).send("Clinical source file is not available.");
  }

  // ── Layer 1: Local private storage ───────────────────────────────────────
  const sourcePath = resolvePrivateDocumentPath(document);
  if (sourcePath && fs.existsSync(sourcePath)) {
    const ext = path.extname(sourcePath).toLowerCase();
    const mimeMap = { ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
    const mimeType = mimeMap[ext] || document.fileType || "application/octet-stream";
    res.setHeader("Content-Type", mimeType);
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.sendFile(sourcePath, { headers: { "Content-Disposition": `inline; filename="${encodeURIComponent(document.originalFilename || 'clinical-record')}"` } });
  }

  // ── Layer 2: Cloudinary — generate a SHORT-LIVED SIGNED URL ──────────────
  // We never redirect to the raw secureUrl because authenticated Cloudinary
  // assets require a server-side signature. The signed URL expires in 5 minutes,
  // preventing URL sharing across doctors or sessions.
  if (document.cloudinary?.publicId) {
    const signedUrl = generateSignedDeliveryUrl(document.cloudinary);
    if (signedUrl) {
      // Cache-control: private, no-store — don't let proxies cache signed URLs
      res.setHeader("Cache-Control", "private, no-store");
      return res.redirect(302, signedUrl);
    }
  }

  return res.status(404).send("Clinical source file is not available.");
}));

app.post("/documents/:id/verify", asyncHandler(async (req, res) => {
  const document = await findAccessibleDocument(req, req.params.id);
  if (!document) return res.status(404).send("Document not found or access denied");
  if (isDocumentApproved(document)) return redirectWithFlash(req, res, `/review/${document._id}`, "info", "This verified record is locked. A new upload will create a new history entry.");
  
  if (!document.patient) {
    return redirectWithFlash(req, res, `/review/${document._id}`, "danger", "Please confirm or link a patient before approving and locking this clinical record.");
  }
  if (req.body.identityConfirmed !== "yes" || req.body.dosageConfirmed !== "yes" || req.body.flagsConfirmed !== "yes") {
    return redirectWithFlash(req, res, `/review/${document._id}`, "danger", "Complete all three human-verification checks before signing this record.");
  }
  if (!String(req.body.doctorName || currentDoctorName(req)).trim()) {
    return redirectWithFlash(req, res, `/review/${document._id}`, "danger", "A signing healthcare professional is required.");
  }
  const [existingDraft, extraction] = await Promise.all([
    VerificationDraft.findOne({ document: document._id }).lean(),
    ClinicalExtraction.findOne({ document: document._id }).lean(),
  ]);
  const medications = safeJsonArray(req.body.medicationsJson, existingDraft?.payload?.medications || document.medications).filter((med) => String(med.name || "").trim()).map(normalizeMedication);
  const labResults = safeJsonArray(req.body.labResultsJson, existingDraft?.payload?.labResults || document.labResults).filter((lab) => String(lab.testName ?? lab.test_name ?? "").trim()).map(normalizeLab);
  const structuredData = safeJson(
    req.body.structuredDataJson,
    existingDraft?.payload?.structuredData || extraction?.structuredData || document.extractedRecord?.structuredJson || null,
  );
  const correctedFields = safeJson(req.body.correctedFieldsJson, existingDraft?.fieldStates || {});

  const verificationNotes = String(req.body.doctorNotes ?? existingDraft?.payload?.doctorNotes ?? "").trim();
  const summary = String(req.body.summary ?? existingDraft?.payload?.summary ?? document.extractedRecord?.aiSummary ?? "").trim();
  const clinicianName = String(req.body.doctorName || currentDoctorName(req)).trim();
  const approvedData = {
    ...documentSnapshot(document),
    medications: medications.map((med) => ({ ...med, isVerified: true })),
    labResults: labResults.map((lab) => ({ ...lab, isVerified: true })),
    structuredData,
    correctedFields,
    summary,
    verificationNotes,
  };
  approvedData.clinicalFlags = cachedAnalyzeDocumentPayload(approvedData.medications, approvedData.labResults, req.body.allergies || "");

  document.status = "APPROVED";
  document.verificationNotes = verificationNotes;
  document.verifiedBy = clinicianName;
  document.verifiedById = req.currentUser?._id || null;
  document.verifiedAt = new Date();
  document.medications = approvedData.medications;
  document.labResults = approvedData.labResults;
  if (document.extractedRecord) {
    document.extractedRecord.aiSummary = summary;
    document.extractedRecord.clinicalFlags = cachedAnalyzeDocumentPayload(document.medications, document.labResults, req.body.allergies || "");
    if (structuredData) {
      document.extractedRecord.structuredJson = structuredData;
    }
  }
  if (req.body.doctorName) req.session.doctorName = document.verifiedBy;
  await document.save();

  if (document.extraction) {
    await ClinicalExtraction.updateOne(
      { _id: document.extraction },
      { $set: { status: "CLINICIAN_VERIFIED", patient: document.patient } },
    );
  }

  await VerificationDraft.findOneAndUpdate(
    { document: document._id },
    { $set: {
        extraction: document.extraction || null,
        patient: document.patient,
        clinician: req.currentUser?._id || null,
        clinicianName,
        clinicName: req.session.currentClinic || CLINIC_NAME,
        payload: { medications, labResults, structuredData, summary, doctorNotes: verificationNotes },
        fieldStates: correctedFields,
        status: "SUBMITTED"
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  await MedicalRecord.findOneAndUpdate(
    { document: document._id },
    {
      $set: {
        patient: document.patient,
        extraction: document.extraction || null,
        recordType: document.documentType,
        title: document.originalFilename,
        extractedData: approvedData,
        status: "APPROVED",
        doctorVerified: true,
        verifiedBy: req.currentUser?._id || null,
        verifiedByName: clinicianName,
        verifiedAt: document.verifiedAt,
        approvedBy: req.currentUser?._id || null,
        approvedByName: clinicianName,
        approvedAt: document.verifiedAt,
        verificationNotes,
        clinicName: req.session.currentClinic || CLINIC_NAME,
      },
      $setOnInsert: {
        document: document._id,
        // Keep the first sealed version in the same flat shape used by the
        // current record so version comparison and record views remain usable.
        originalVersionSnapshot: JSON.parse(JSON.stringify(approvedData)),
        version: 1,
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  // Log audit events for clinician corrected fields
  if (correctedFields && typeof correctedFields === "object") {
    const correctedEntries = Object.entries(correctedFields).filter(([, value]) => {
      const state = String(value?.status || value || "").toLowerCase();
      return state === "clinician_corrected" || state === "corrected" || state === "clinician_verified" || state === "verified";
    });
    for (const [fieldKey, fieldVal] of correctedEntries) {
      await recordAudit("FIELD_CORRECTED", {
        document: document._id,
        patient: document.patient,
        actorId: req.currentUser?._id || null,
        actorName: clinicianName,
        clinic: req.session.currentClinic,
        data: { field: fieldVal?.field || fieldKey, originalValue: fieldVal?.originalValue || null, correctedValue: fieldVal?.value || null },
      });
    }
  }

  await recordAudit("RECORD_APPROVED", {
    document: document._id,
    patient: document.patient,
    actorId: req.currentUser?._id || null,
    actorName: clinicianName,
    clinic: req.session.currentClinic,
    data: {
      status: document.status,
      medicationCount: medications.length,
      labCount: labResults.length,
      notes: document.verificationNotes,
      version: 1,
    }
  });
  
  // Real-time incremental update of the DSA search index
  try {
    const [populatedDoc, populatedRecord] = await Promise.all([
      ClinicalDocument.findById(document._id).populate("patient", "fullName mrn").lean(),
      MedicalRecord.findOne({ document: document._id }).populate("patient", "fullName mrn").lean(),
    ]);
    if (populatedDoc) clinicalSearchEngine.indexSingleDocument(populatedDoc);
    if (populatedRecord) clinicalSearchEngine.indexSingleRecord(populatedRecord);
  } catch (err) {
    console.warn("Search index update failed:", err.message);
  }

  if (req.xhr || req.headers.accept?.includes("application/json") || req.body.ajax === "true") {
    return res.json({ success: true, redirectUrl: `/review/${document._id}`, message: "Record verified and signed into the patient chart." });
  }
  redirectWithFlash(req, res, `/review/${document._id}`, "success", "Record verified and signed into the patient chart.");
}));

app.post("/documents/:id/reject", asyncHandler(async (req, res) => {
  const document = await findAccessibleDocument(req, req.params.id);
  if (!document) return res.status(404).send("Document not found or access denied");
  if (isDocumentApproved(document)) return redirectWithFlash(req, res, `/review/${document._id}`, "info", "Verified records are immutable. Upload a new document for a new history entry.");
  document.status = "REJECTED";
  document.verificationNotes = `Rejected: ${String(req.body.reason || "Source record requires re-upload.").trim()}`;
  document.verifiedBy = String(req.body.doctorName || currentDoctorName(req)).trim();
  document.verifiedAt = new Date();
  await document.save();
  if (document.extraction) {
    await ClinicalExtraction.updateOne({ _id: document.extraction }, { $set: { status: "REJECTED" } });
  }
  await recordAudit("DOCUMENT_REJECTED", { document: document._id, patient: document.patient, actorName: document.verifiedBy, data: { reason: document.verificationNotes } });
  try {
    const populatedDoc = await ClinicalDocument.findById(document._id).populate("patient", "fullName mrn").lean();
    if (populatedDoc) clinicalSearchEngine.indexSingleDocument(populatedDoc);
  } catch (err) {
    console.warn("Search index update after rejection failed:", err.message);
  }
  redirectWithFlash(req, res, `/review/${document._id}`, "info", "Record marked for re-upload and follow-up.");
}));

app.get("/patients", asyncHandler(async (req, res) => {
  const search = String(req.query.search || req.query.q || "").trim();
  const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const accessQuery = patientAccessQuery(req);
  const query = search ? { $and: [accessQuery, { $or: [{ fullName: new RegExp(safeSearch, "i") }, { mrn: new RegExp(safeSearch, "i") }] }] } : accessQuery;
  const patients = await Patient.find(query).sort({ fullName: 1 }).lean();
  const patientIds = patients.map((patient) => patient._id);
  const counts = await ClinicalDocument.aggregate([{ $match: { patient: { $in: patientIds } } }, { $group: { _id: "$patient", documents: { $sum: 1 }, alerts: { $sum: { $cond: [{ $gt: ["$extractedRecord.clinicalFlags.totalAlerts", 0] }, 1, 0] } } } }]);
  const countMap = new Map(counts.map((item) => [String(item._id), item]));
  res.render("pages/patients", { pageTitle: "Patients", patients: patients.map((patient) => ({ ...patient, counts: countMap.get(String(patient._id)) || { documents: 0, alerts: 0 } })), search });
}));

app.post("/api/patients", asyncHandler(async (req, res) => {
  if (!req.currentUser && !localAccessAllowed()) return res.status(401).json({ error: "Sign in as an authorized clinician before creating a patient." });
  const fullName = String(req.body.fullName || req.body.name || "").trim();
  if (!fullName) return res.status(400).json({ error: "Patient name is required." });
  const mrn = String(req.body.mrn || `CC-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`).trim().slice(0, 40);
  const dateOfBirth = req.body.dateOfBirth ? new Date(req.body.dateOfBirth) : null;
  if (dateOfBirth && Number.isNaN(dateOfBirth.getTime())) return res.status(400).json({ error: "Date of birth is invalid." });
  const ownerDoctor = req.currentUser?._id || null;
  try {
    const patient = await Patient.create({
      mrn,
      fullName,
      dateOfBirth,
      gender: String(req.body.gender || "").trim(),
      phone: String(req.body.phone || "").trim(),
      email: String(req.body.email || "").trim(),
      allergies: String(req.body.allergies || "").trim(),
      chronicConditions: String(req.body.chronicConditions || "").trim(),
      ownerDoctor,
      authorizedDoctors: ownerDoctor ? [ownerDoctor] : [],
      clinic: req.session.currentClinic || CLINIC_NAME,
    });
    try {
      clinicalSearchEngine.indexSinglePatient(patient);
    } catch (err) {
      console.warn("Incremental patient indexing failed:", err.message);
    }
    res.status(201).json({ patient });
  } catch (error) {
    if (error?.code === 11000) return res.status(409).json({ error: "A patient with this medical record number already exists." });
    throw error;
  }
}));

app.get("/patients/:id", asyncHandler(async (req, res) => {
  const context = await loadPatientContext(req, req.params.id);
  if (!context) return res.status(404).render("pages/error", { pageTitle: "Patient not found", message: "This patient profile is no longer available." });
  const verifiedDocuments = context.documents.filter(isDocumentApproved);
  const labs = verifiedDocuments.flatMap((doc) => (doc.labResults || []).map((lab) => ({ ...lab, documentName: doc.originalFilename, recordedAt: lab.testDate || doc.createdAt }))).sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
  const trends = labs.filter((lab) => lab.numericValue !== null && lab.numericValue !== undefined).reduce((groups, lab) => { const key = /glucose|sugar|fbs/i.test(lab.testName) ? "glucose" : /hba1c/i.test(lab.testName) ? "hba1c" : /creatinine/i.test(lab.testName) ? "creatinine" : /cholesterol|ldl/i.test(lab.testName) ? "cholesterol" : null; if (key) (groups[key] ||= []).push(lab); return groups; }, {});
  res.render("pages/patient", { pageTitle: context.patient.fullName, ...context, timeline: timelineFor(context.patient, verifiedDocuments), trends });
}));

app.get("/assistant", asyncHandler(async (req, res) => {
  const patients = await Patient.find(patientAccessQuery(req)).sort({ fullName: 1 }).lean();
  res.render("pages/assistant", { pageTitle: "Clinical assistant", patients, selectedPatientId: req.query.patient || patients[0]?._id || "" });
}));

app.get("/api/patients/:patientId/history", asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.params.patientId, { _id: 1 });
  if (!patient) return res.status(404).json({ error: "Patient not found or access denied." });
  const documents = await ClinicalDocument.find({ patient: patient._id }).lean();
  const verifiedDocuments = documents.filter(isDocumentApproved);
  await Promise.all(verifiedDocuments.map((document) => ensureMedicalRecordForDocument(document, req)));
  const records = await MedicalRecord.find({ patient: patient._id, doctorVerified: true }).populate("document", "originalFilename documentType createdAt").sort({ createdAt: -1 }).lean();
  res.json({ patientId: patient._id, records });
}));

app.get("/api/patients/:patientId/documents", asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.params.patientId, { _id: 1 });
  if (!patient) return res.status(404).json({ error: "Patient not found or access denied." });
  const documents = await ClinicalDocument.find({ patient: patient._id }).select("-storagePath -filePath").sort({ createdAt: -1 }).lean();
  res.json({ patientId: patient._id, documents });
}));

app.get("/api/patients/:patientId/conversations", asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.params.patientId, { _id: 1 });
  if (!patient) return res.status(404).json({ error: "Patient not found or access denied." });
  const conversations = await Conversation.find({ patient: patient._id }).sort({ updatedAt: -1 }).lean();
  const withCounts = await attachMessageCounts(conversations);
  res.json({ patientId: patient._id, conversations: withCounts });
}));

app.post("/api/patients/:patientId/conversations", asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.params.patientId, { _id: 1 });
  if (!patient) return res.status(404).json({ error: "Patient not found or access denied." });
  const title = String(req.body.title || "Clinical review").trim().slice(0, 180) || "Clinical review";
  const conversation = await Conversation.create({ patient: patient._id, doctor: req.currentUser?._id || null, doctorName: currentDoctorName(req), title });
  res.status(201).json({ conversation });
}));

app.get("/api/conversations/:conversationId/messages", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.conversationId)) return res.status(404).json({ error: "Conversation not found." });
  const conversation = await Conversation.findById(req.params.conversationId).lean();
  if (!conversation) return res.status(404).json({ error: "Conversation not found." });
  const patient = await findAccessiblePatient(req, conversation.patient, { _id: 1 });
  if (!patient) return res.status(404).json({ error: "Conversation not found or access denied." });
  const messages = await Message.find({ conversation: conversation._id }).sort({ createdAt: 1 }).lean();
  res.json({ conversation, messages });
}));

app.post("/api/conversations/:conversationId/messages", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.conversationId)) return res.status(404).json({ error: "Conversation not found." });
  const conversation = await Conversation.findById(req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: "Conversation not found." });
  const patient = await findAccessiblePatient(req, conversation.patient);
  if (!patient) return res.status(404).json({ error: "Conversation not found or access denied." });
  const message = String(req.body.message || req.body.content || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required." });
  await Message.create({ conversation: conversation._id, role: "USER", content: message });
  const [documents, soapNotes] = await Promise.all([
    ClinicalDocument.find({ patient: patient._id }).sort({ createdAt: -1 }).lean(),
    SOAPNote.find({ patient: patient._id }).sort({ createdAt: -1 }).lean(),
  ]);
  const result = await answerClinicalQuestion(patient, documents, soapNotes, message);
  const assistantMessage = await Message.create({ conversation: conversation._id, role: "ASSISTANT", content: result.reply });
  conversation.updatedAt = new Date();
  await conversation.save();
  await recordAudit("ASSISTANT_QUERY", { patient: patient._id, actorName: currentDoctorName(req), data: { conversationId: conversation._id, question: message.slice(0, 300) } });
  res.json({ ...result, conversationId: conversation._id, messageId: assistantMessage._id });
}));

app.post("/api/assistant/chat", asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.body.patientId);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  const message = String(req.body.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required." });
  const requestedConversationId = String(req.body.conversationId || "");
  if (requestedConversationId && !mongoose.isValidObjectId(requestedConversationId)) return res.status(400).json({ error: "Conversation id is invalid." });
  let conversation = requestedConversationId ? await Conversation.findOne({ _id: requestedConversationId, patient: patient._id }) : null;
  if (!conversation) conversation = await Conversation.create({ patient: patient._id, doctor: req.currentUser?._id || null, doctorName: currentDoctorName(req), title: message.slice(0, 180) });
  await Message.create({ conversation: conversation._id, role: "USER", content: message });
  const documents = await ClinicalDocument.find({ patient: patient._id }).sort({ createdAt: -1 }).lean();
  const soapNotes = await SOAPNote.find({ patient: patient._id }).sort({ createdAt: -1 }).lean();
  const result = await answerClinicalQuestion(patient, documents, soapNotes, message);
  const assistantMessage = await Message.create({ conversation: conversation._id, role: "ASSISTANT", content: result.reply });
  conversation.updatedAt = new Date();
  await conversation.save();
  await recordAudit("ASSISTANT_QUERY", { patient: patient._id, actorName: currentDoctorName(req), data: { conversationId: conversation._id, question: message.slice(0, 300) } });
  res.json({ ...result, conversationId: conversation._id, messageId: assistantMessage._id });
}));

app.post("/api/assistant/soap", asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.body.patientId);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  let documentId = null;
  if (req.body.documentId) {
    if (!mongoose.isValidObjectId(req.body.documentId)) return res.status(400).json({ error: "Document id is invalid." });
    const document = await findAccessibleDocument(req, req.body.documentId);
    if (!document || String(document.patient) !== String(patient._id)) return res.status(404).json({ error: "Document not found or access denied." });
    documentId = document._id;
  }
  const documents = await ClinicalDocument.find({ patient: patient._id }).sort({ createdAt: -1 }).lean();
  const soapNotes = await SOAPNote.find({ patient: patient._id }).sort({ createdAt: -1 }).lean();
  const content = await generateSoap(patient, documents, soapNotes, req.body.doctorPrompt);
  const note = await SOAPNote.create({ patient: patient._id, document: documentId, ...content, doctorNotes: req.body.doctorPrompt, isSigned: false });
  await recordAudit("SOAP_DRAFT", { patient: patient._id, document: documentId, data: { noteId: note._id } });
  res.json({ id: note._id, patientId: patient._id, ...content, doctorNotes: note.doctorNotes, isSigned: note.isSigned, createdAt: note.createdAt });
}));

app.post("/api/interaction-check", asyncHandler(async (req, res) => {
  const medications = Array.isArray(req.body.medications) ? req.body.medications : [];
  const patient = req.body.patientId ? await findAccessiblePatient(req, req.body.patientId) : null;
  const interactions = screenInteractions(medications);
  const allergies = String(patient?.allergies || "").toLowerCase();
  const allergyConflicts = medications.filter((medication) => allergies && allergies.includes(String(medication).toLowerCase()));
  res.json({ medicationsChecked: medications, interactions, allergyConflicts, isSafe: interactions.length === 0 && allergyConflicts.length === 0 });
}));

// Document Library
app.get("/documents", asyncHandler(async (req, res) => {
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const filterType = req.query.type || "ALL";
  const filterStatus = req.query.status || "ALL";
  const searchQuery = String(req.query.search || "").trim();

  const docScope = documentAccessQuery(req, patientIds);
  const query = { ...docScope };
  if (filterType !== "ALL") query.documentType = filterType;
  if (filterStatus !== "ALL") query.status = filterStatus;
  if (searchQuery) {
    const safe = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.originalFilename = new RegExp(safe, "i");
  }

  const documents = await ClinicalDocument.find(query)
    .sort({ createdAt: -1 })
    .populate("patient", "fullName mrn")
    .lean();

  res.render("pages/documents", {
    pageTitle: "Clinical Documents",
    documents,
    filterType,
    filterStatus,
    searchQuery,
  });
}));

// Save Draft in 3-zone verification workspace
app.post("/documents/:id/draft", asyncHandler(async (req, res) => {
  const document = await findAccessibleDocument(req, req.params.id);
  if (!document) return res.status(404).json({ error: "Document not found or access denied" });
  if (isDocumentApproved(document)) {
    return redirectWithFlash(req, res, `/review/${document._id}`, "info", "This verified record is locked. You can view or amend it in Clinical Records.");
  }

  const existingDraft = await VerificationDraft.findOne({ document: document._id }).lean();
  const medications = req.body.medicationsJson
    ? safeJsonArray(req.body.medicationsJson, existingDraft?.payload?.medications || document.medications).map(normalizeMedication)
    : document.medications || [];
  const labResults = req.body.labResultsJson
    ? safeJsonArray(req.body.labResultsJson, existingDraft?.payload?.labResults || document.labResults).map(normalizeLab)
    : document.labResults || [];
  const structuredData = safeJson(
    req.body.structuredDataJson,
    existingDraft?.payload?.structuredData || document.extractedRecord?.structuredJson || null,
  );
  const correctedFields = safeJson(req.body.correctedFieldsJson, null);
  const payload = {
    medications,
    labResults,
    structuredData,
    doctorNotes: req.body.doctorNotes !== undefined ? String(req.body.doctorNotes || "").trim() : String(document.verificationNotes || ""),
    summary: req.body.summary !== undefined ? String(req.body.summary || "").trim() : String(document.extractedRecord?.aiSummary || ""),
  };
  const fieldStates = safeJson(req.body.fieldStatesJson, correctedFields || existingDraft?.fieldStates || {});
  await VerificationDraft.findOneAndUpdate(
    { document: document._id },
    { $set: { extraction: document.extraction || null, patient: document.patient, clinician: req.currentUser?._id || null, clinicianName: currentDoctorName(req), clinicName: req.session.currentClinic || CLINIC_NAME, payload, fieldStates, status: "DRAFT" } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await recordAudit("VERIFICATION_DRAFT_SAVED", { document: document._id, patient: document.patient, actorId: req.currentUser?._id || null, actorName: currentDoctorName(req), clinic: req.session.currentClinic, data: { medicationCount: medications.length, labCount: labResults.length, fieldsWithState: Object.keys(fieldStates).length } });
  await Promise.all(Object.entries(fieldStates).map(([field, state]) => {
    const normalizedState = String(state?.status || state || "").toLowerCase();
    const action = normalizedState === "unresolved" || normalizedState === "unclear"
      ? "FIELD_UNCLEAR"
      : normalizedState === "clinician_corrected" || normalizedState === "corrected"
        ? "FIELD_CORRECTED"
        : normalizedState === "clinician_verified" || normalizedState === "verified"
          ? "FIELD_VERIFIED"
          : null;
    return action ? recordAudit(action, { document: document._id, patient: document.patient, actorId: req.currentUser?._id || null, actorName: currentDoctorName(req), clinic: req.session.currentClinic, data: { field: state?.field || field, originalValue: state?.originalValue || null, correctedValue: state?.value || null } }) : null;
  }));

  if (req.xhr || req.headers.accept?.includes("application/json") || req.body.ajax === "true") {
    return res.json({ success: true, redirectUrl: `/review/${document._id}`, message: "Draft progress saved. Ready for review whenever you return." });
  }
  redirectWithFlash(req, res, `/review/${document._id}`, "success", "Draft progress saved. Ready for review whenever you return.");
}));

// Searchable Clinical Records repository
app.get("/records", asyncHandler(async (req, res) => {
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const filter = req.query.filter || "ALL";
  const search = String(req.query.search || "").trim();

  const query = { patient: { $in: patientIds } };
  if (filter === "APPROVED") query.doctorVerified = true;
  if (filter === "PENDING") query.doctorVerified = false;
  if (filter === "AMENDED") query.version = { $gt: 1 };

  if (search) {
    const safe = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    query.$or = [
      { title: new RegExp(safe, "i") },
      { recordType: new RegExp(safe, "i") },
      { verifiedByName: new RegExp(safe, "i") },
      { "extractedData.diagnosis": new RegExp(safe, "i") },
    ];
  }

  const records = await MedicalRecord.find(query)
    .sort({ createdAt: -1 })
    .populate("patient", "fullName mrn")
    .populate("document", "originalFilename documentType status createdAt")
    .lean();

  res.render("pages/records", {
    pageTitle: "Clinical Records",
    records,
    activeFilter: filter,
    search,
  });
}));

// Record Detail with Versioning & Comparison UI
app.get("/records/:id", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).render("pages/error", { pageTitle: "Record not found", message: "Invalid clinical record ID." });
  let record = await MedicalRecord.findById(req.params.id)
    .populate("patient", "fullName mrn age gender bloodGroup phone allergies chronicConditions")
    .populate("document", "originalFilename documentType status filePath createdAt")
    .lean();
  if (!record) {
    record = await MedicalRecord.findOne({ document: req.params.id })
      .populate("patient", "fullName mrn age gender bloodGroup phone allergies chronicConditions")
      .populate("document", "originalFilename documentType status filePath createdAt")
      .lean();
  }
  if (!record) return res.status(404).render("pages/error", { pageTitle: "Record not found", message: "Clinical record could not be found." });

  const patient = await findAccessiblePatient(req, record.patient._id, { _id: 1 });
  if (!patient) return res.status(403).render("pages/error", { pageTitle: "Access Denied", message: "You are not authorized to view this patient record." });

  res.render("pages/record-detail", {
    pageTitle: `${record.title} · Version ${record.version}`,
    record,
    clinicianName: currentDoctorName(req),
  });
}));

// Clinical Record Amendment
app.post("/records/:id/amend", asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).send("Invalid record ID");
  let record = await MedicalRecord.findById(req.params.id);
  if (!record) {
    record = await MedicalRecord.findOne({ document: req.params.id });
  }
  if (!record) return res.status(404).send("Medical record not found.");
  const patient = await findAccessiblePatient(req, record.patient, { _id: 1 });
  if (!patient) return res.status(403).send("You are not authorized to amend this medical record.");
  if (!record.doctorVerified) {
    return redirectWithFlash(req, res, `/records/${record._id}`, "danger", "Only doctor-verified records can be amended.");
  }

  const reason = String(req.body.amendmentReason || req.body.reason || "").trim();
  if (!reason) {
    return redirectWithFlash(req, res, `/records/${record._id}`, "danger", "A clinical reason is mandatory to amend a verified medical record.");
  }

  const clinician = currentDoctorName(req);

  // Preserve a deep-cloned snapshot; never let later edits mutate the prior
  // approved version through a shared object reference.
  const previousVersionData = JSON.parse(JSON.stringify(record.extractedData || {}));
  if (!record.originalVersionSnapshot) record.originalVersionSnapshot = JSON.parse(JSON.stringify(previousVersionData));
  record.history.push({
    version: record.version,
    extractedData: previousVersionData,
    modifiedBy: req.currentUser?._id || null,
    modifiedByName: record.verifiedByName || clinician,
    modifiedAt: record.verifiedAt || record.updatedAt || record.createdAt,
    reason: record.amendmentReason || "Initial clinician verification",
  });

  // Increment version
  record.version += 1;
  record.status = "AMENDED";
  record.amendmentReason = reason;
  record.verifiedByName = clinician;
  record.verifiedAt = new Date();

  // Apply changes
  const updatedDose = req.body.dosage || req.body.dose;
  if (updatedDose && record.extractedData?.medications?.length) {
    record.extractedData.medications[0].dosage = String(updatedDose).trim();
  }
  if (req.body.frequency && record.extractedData?.medications?.length) {
    record.extractedData.medications[0].frequency = String(req.body.frequency).trim();
  }
  if (req.body.instructions && record.extractedData?.medications?.length) {
    record.extractedData.medications[0].instructions = String(req.body.instructions).trim();
  }
  if (req.body.notes) {
    record.verificationNotes = String(req.body.notes).trim();
  }

  record.markModified("extractedData");
  record.markModified("history");
  await record.save();

  if (record.document) {
    await ClinicalDocument.findByIdAndUpdate(record.document, {
      $set: {
        status: "AMENDED",
        verificationNotes: record.verificationNotes,
        verifiedBy: clinician,
        verifiedById: req.currentUser?._id || null,
        verifiedAt: record.verifiedAt,
        medications: record.extractedData?.medications || [],
        labResults: record.extractedData?.labResults || [],
        "extractedRecord.structuredJson": record.extractedData?.structuredData || {},
        "extractedRecord.aiSummary": record.extractedData?.summary || record.extractedData?.aiSummary || "",
        "extractedRecord.clinicalFlags": record.extractedData?.clinicalFlags || {},
      }
    });
  }

  await recordAudit("RECORD_AMENDED", {
    patient: record.patient,
    document: record.document,
    actorName: clinician,
    data: { newVersion: record.version, reason },
  });

  // Real-time incremental update of the DSA search index
  try {
    const [populatedDoc, populatedRecord] = await Promise.all([
      ClinicalDocument.findById(record.document).populate("patient", "fullName mrn").lean(),
      MedicalRecord.findById(record._id).populate("patient", "fullName mrn").lean(),
    ]);
    if (populatedDoc) clinicalSearchEngine.indexSingleDocument(populatedDoc);
    if (populatedRecord) clinicalSearchEngine.indexSingleRecord(populatedRecord);
  } catch (err) {
    console.warn("Search index update failed:", err.message);
  }

  redirectWithFlash(req, res, `/records/${record._id}`, "success", `Record updated to Version ${record.version}. Original version preserved in audit history.`);
}));

// Integration Page: HIS & HL7 FHIR R4 Sandbox
app.get("/integration", asyncHandler(async (req, res) => {
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const patientScope = { patient: { $in: patientIds } };
  const [patientCount, verifiedCount, observationCount, conditionCount, provenanceCount] = await Promise.all([
    patientIds.length,
    MedicalRecord.countDocuments({ ...patientScope, doctorVerified: true }),
    ClinicalDocument.countDocuments({ ...patientScope, "labResults.0": { $exists: true } }),
    Patient.countDocuments({ _id: { $in: patientIds }, chronicConditions: { $nin: [null, "", "None"] } }),
    AuditLog.countDocuments({ $or: [{ patient: { $in: patientIds } }, { patient: null }] }),
  ]);
  res.render("pages/integration", {
    pageTitle: "FHIR R4 Sandbox",
    stats: { patientCount, verifiedCount },
    patientId: (patientIds && patientIds[0]) ? String(patientIds[0]) : "66e000000000000000000001",
    endpointUrl: "/api/fhir/patient/:id",
    lastSync: "Generated on demand",
    resources: [
      { name: "Patient", code: "Patient", status: "Active", count: patientCount, description: "Demographics, MRN, phone, allergies" },
      { name: "MedicationRequest", code: "MedicationRequest", status: "Active", count: verifiedCount, description: "Verified prescriptions, dosage, frequency" },
      { name: "Observation", code: "Observation", status: "Active", count: observationCount, description: "Lab findings, metabolic panels, vitals" },
      { name: "Condition", code: "Condition", status: "Active", count: conditionCount, description: "Documented diagnoses, acute fever, HTN" },
      { name: "Provenance", code: "Provenance", status: "Active", count: provenanceCount, description: "Actor history, signer identity, verification timestamps" },
    ],
  });
}));

// Clinic Settings
app.get("/settings", asyncHandler(async (req, res) => {
  res.render("pages/settings", {
    pageTitle: "Clinic Settings",
    clinics: app.locals.activeClinics,
    currentClinic: req.session.currentClinic || CLINIC_NAME,
    clinicianName: currentDoctorName(req),
  });
}));

// Multi-clinic switcher
app.post("/settings/clinic", (req, res) => {
  const requestedClinic = String(req.body.clinic || CLINIC_NAME).trim();
  if (app.locals.activeClinics.includes(requestedClinic)) {
    req.session.currentClinic = requestedClinic;
    setFlash(req, "success", `Switched clinic context to ${requestedClinic}.`);
  }
  const candidateRedirect = String(req.body.redirect || req.headers.referer || "");
  const redirectUrl = candidateRedirect.startsWith("/") && !candidateRedirect.startsWith("//") ? candidateRedirect : "/dashboard";
  res.redirect(redirectUrl);
});

// Advanced DSA Search Cockpit Route
app.get("/search", asyncHandler(async (req, res) => {
  const query = String(req.query.q || "").trim();
  const category = String(req.query.category || "ALL").toUpperCase();

  await refreshScopedSearchIndex(req);

  const dsaResults = query ? clinicalSearchEngine.search(query, { category, limit: 30 }) : null;

  res.render("pages/search", {
    pageTitle: query ? `Search: ${query}` : "Clinical Records Search",
    query,
    category,
    dsaResults,
    searchStats: clinicalSearchEngine.stats,
  });
}));

// Advanced DSA Clinical Search API
app.get("/api/search", asyncHandler(async (req, res) => {
  const query = String(req.query.q || req.query.query || "").trim();
  const category = String(req.query.category || "ALL").toUpperCase();
  if (!query) {
    return res.json({
      query: "",
      total: 0,
      results: [],
      facets: { ALL: 0, PATIENT: 0, MEDICATION: 0, LAB_TEST: 0, DOCUMENT: 0, RECORD: 0 },
      appliedAlgorithm: "NONE",
      executionTimeMs: 0,
      patients: [],
      documents: [],
      records: [],
    });
  }

  await refreshScopedSearchIndex(req);

  const dsaResponse = clinicalSearchEngine.search(query, { category, limit: 15 });

  // Map backward-compatible structures for existing frontend dropdowns
  const patients = dsaResponse.results
    .filter((r) => r.entityType === "PATIENT")
    .map((r) => ({
      _id: r.id.replace("patient_", ""),
      fullName: r.title,
      mrn: r.meta?.mrn || "",
      age: r.meta?.age,
      gender: r.meta?.gender,
      matchAlgorithm: r.matchAlgorithm,
    }));

  const documents = dsaResponse.results
    .filter((r) => r.entityType === "DOCUMENT" || r.entityType === "MEDICATION" || r.entityType === "LAB_TEST")
    .map((r) => ({
      _id: r.id.replace(/^(doc|med|lab)_/, "").split("_")[0],
      originalFilename: r.title,
      documentType: r.subtitle,
      matchAlgorithm: r.matchAlgorithm,
    }));

  const records = dsaResponse.results
    .filter((r) => r.entityType === "RECORD")
    .map((r) => ({
      _id: r.id.replace("rec_", ""),
      title: r.title,
      version: r.meta?.version || 1,
      matchAlgorithm: r.matchAlgorithm,
    }));

  res.json({
    ...dsaResponse,
    patients,
    documents,
    records,
  });
}));

// FHIR R4 Patient Bundle exporter
app.get("/api/fhir/patient/:id", asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.params.id);
  if (!patient) return res.status(404).json({ error: "Patient not found or access denied" });
  const records = await MedicalRecord.find({ patient: patient._id, doctorVerified: true }).lean();

  const bundle = {
    resourceType: "Bundle",
    id: `bundle-patient-${patient.mrn}`,
    type: "collection",
    timestamp: new Date().toISOString(),
    meta: {
      lastUpdated: new Date().toISOString(),
      source: "urn:oid:curaclinic:ai-clinical-records",
    },
    entry: [
      {
        fullUrl: `urn:uuid:${patient._id}`,
        resource: {
          resourceType: "Patient",
          id: String(patient._id),
          identifier: [{ system: "http://hospital.org/mrn", value: patient.mrn }],
          name: [{ use: "official", text: patient.fullName }],
          gender: (patient.gender || "unknown").toLowerCase(),
          telecom: [{ system: "phone", value: patient.phone }],
        },
      },
      ...records.map((rec) => ({
        fullUrl: `urn:uuid:${rec._id}`,
        resource: {
          resourceType: "MedicationRequest",
          id: String(rec._id),
          status: "active",
          intent: "order",
          subject: { reference: `Patient/${patient._id}`, display: patient.fullName },
          authoredOn: (rec.verifiedAt || rec.createdAt).toISOString(),
          requester: { display: rec.verifiedByName || "Clinician not recorded" },
          medicationCodeableConcept: {
            text: rec.extractedData?.medications?.[0]?.name || rec.title,
          },
          dosageInstruction: [
            {
              text: `${rec.extractedData?.medications?.[0]?.dosage || ''} ${rec.extractedData?.medications?.[0]?.frequency || ''}`.trim(),
            },
          ],
        },
      })),
    ],
  };

  res.setHeader("Content-Type", "application/fhir+json; charset=utf-8");
  res.json(bundle);
}));

app.get("/audit", asyncHandler(async (req, res) => {
  const search = String(req.query.search || "").trim();
  const safeSearch = escapeRegExp(search);
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const accessScope = { $or: [{ patient: { $in: patientIds } }, { patient: null }] };
  const query = search
    ? { $and: [accessScope, { $or: [{ action: new RegExp(safeSearch, "i") }, { actorName: new RegExp(safeSearch, "i") }] }] }
    : accessScope;
  const logs = await AuditLog.find(query).sort({ timestamp: -1 }).limit(100).populate("document", "originalFilename").populate("patient", "fullName mrn").lean();
  res.render("pages/audit", { pageTitle: "Audit trail", logs, search });
}));

app.get("/api/audit/export", asyncHandler(async (req, res) => {
  const search = String(req.query.search || "").trim();
  const safeSearch = escapeRegExp(search);
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const accessScope = { $or: [{ patient: { $in: patientIds } }, { patient: null }] };
  const query = search
    ? { $and: [accessScope, { $or: [{ action: new RegExp(safeSearch, "i") }, { actorName: new RegExp(safeSearch, "i") }] }] }
    : accessScope;
  const logs = await AuditLog.find(query).sort({ timestamp: -1 }).limit(500).populate("document", "originalFilename").populate("patient", "fullName mrn").lean();

  const escapeCsv = (val) => {
    if (val === null || val === undefined) return '""';
    const str = String(val).replace(/"/g, '""');
    return `"${str}"`;
  };

  const headers = ["Timestamp", "Action", "Actor Name", "Actor Role", "Patient Name", "Patient MRN", "Document", "IP Address", "Payload Details"];
  const rows = logs.map(log => [
    escapeCsv(log.timestamp ? new Date(log.timestamp).toISOString() : ""),
    escapeCsv(log.action || ""),
    escapeCsv(log.actorName || "System"),
    escapeCsv(log.actorRole || "DOCTOR"),
    escapeCsv(log.patient?.fullName || "System"),
    escapeCsv(log.patient?.mrn || ""),
    escapeCsv(log.document?.originalFilename || ""),
    escapeCsv(log.ipAddress || ""),
    escapeCsv(JSON.stringify(log.details || {}))
  ]);

  const csvContent = [headers.join(","), ...rows.map(r => r.join(","))].join("\r\n");
  const dateStr = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="curaclinic_audit_log_${dateStr}.csv"`);
  res.send(csvContent);
}));

// DSA extraction pipeline observability
app.get("/api/pipeline-status", asyncHandler(async (req, res) => {
  res.json({
    ...getPipelineMetrics(),
    searchIndex: {
      isIndexed: clinicalSearchEngine.isIndexed,
      totalEntities: clinicalSearchEngine.stats.totalEntities,
      totalTokens: clinicalSearchEngine.stats.totalTokens,
      lastIndexedAt: clinicalSearchEngine.stats.lastIndexedAt,
      ttlMs: SEARCH_INDEX_TTL_MS,
      ageMs: searchIndexRefreshedAt ? Date.now() - searchIndexRefreshedAt : null,
    },
  });
}));

app.get("/api/stats", asyncHandler(async (req, res) => {
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const documentScope = { patient: { $in: patientIds } };
  const [totalPatients, totalDocuments, pendingVerification, verifiedDocuments, abnormalLabAlerts] = await Promise.all([
    patientIds.length,
    ClinicalDocument.countDocuments(documentScope),
    ClinicalDocument.countDocuments({ ...documentScope, status: { $in: ["DRAFT", "AI_EXTRACTED", "NEEDS_VERIFICATION", "EXTRACTED", "PENDING_OCR"] } }),
    ClinicalDocument.countDocuments({ ...documentScope, status: { $in: ["APPROVED", "CLINICIAN_VERIFIED", "AMENDED", "DOCTOR_VERIFIED"] } }),
    ClinicalDocument.countDocuments({ ...documentScope, "extractedRecord.clinicalFlags.totalAlerts": { $gt: 0 } }),
  ]);
  res.json({ totalPatients, totalDocuments, pendingVerification, verifiedDocuments, abnormalLabAlerts });
}));

app.use((req, res) => res.status(404).render("pages/error", { pageTitle: "Page not found", message: "The page you requested is not part of the clinical workspace." }));
app.use((error, req, res, _next) => {
  console.error(error);
  if (req.path.startsWith("/api/")) return res.status(500).json({ error: "The clinical service could not complete this request." });
  res.status(500).render("pages/error", { pageTitle: "Something went wrong", message: isProduction ? "The clinical service could not complete this request." : error.message });
});

const server = app.listen(PORT, () => console.log(`${CLINIC_NAME} running at http://localhost:${PORT}`));

mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000) })
  .then(async () => {
    console.log("MongoDB connected");
    try {
      const coll = mongoose.connection.db.collection("clinical_extractions");
      const indexes = await coll.indexes();
      if (indexes.some((i) => i.name === "mrn_1")) {
        await coll.dropIndex("mrn_1").catch(() => {});
        console.log("Cleaned legacy mrn_1 unique index from clinical_extractions");
      }
    } catch (_) {}
    await refreshSearchIndex();
  })
  .catch((error) => console.error("MongoDB connection failed:", error.message));

process.on("SIGTERM", async () => { await mongoose.connection.close(); server.close(() => process.exit(0)); });

module.exports = app;
