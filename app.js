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
const { MedicalRecord, VerificationDraft, Conversation, Message, ClinicalHandoff } = require("./models/history");
const { analyzeDocumentPayload, evaluateLab, screenInteractions, semanticConfidence } = require("./utils/clinicalAnalyzer");
const { answerClinicalQuestion, extractDocument, generateSoap, generatePatientHistorySummary } = require("./utils/aiClinical");
const { buildPatientHistoryIntelligence } = require("./utils/patientHistory");
const { indexClinicalRecord, retrieveClinicalContext } = require("./utils/clinicalRag");
const { uploadClinicalDocument, destroyClinicalDocument, generateSignedDeliveryUrl } = require("./utils/cloudinaryStorage");
const { clinicalSearchEngine } = require("./utils/dsaSearchEngine");
const { getPipelineMetrics, cachedAnalyzeDocumentPayload } = require("./utils/dsaExtraction");

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION:", err);
  // Do not keep serving requests after a fatal invariant failure. A process
  // supervisor can restart the app with a known-good configuration.
  process.exit(1);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("UNHANDLED REJECTION:", reason);
  process.exit(1);
});

const app = express();
const isProduction = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT || 8080);
const MONGO_URL = process.env.MONGO_URL || "mongodb://127.0.0.1:27017/curaclinic_documentation";
const SESSION_SECRET = process.env.SESSION_SECRET || (isProduction ? "" : "curaclinic-development-session-secret");
const CLINIC_NAME = process.env.CLINIC_NAME || "AI Clinical Records";
const TAGLINE = "Turn handwritten clinical documents into verified digital records.";
const DEFAULT_CLINICIAN = process.env.CLINICIAN_NAME || "Clinical Team";
const MIN_PASSWORD_LENGTH = 12;
const clinicianSignupEnabled = String(process.env.ALLOW_CLINICIAN_SIGNUP || (isProduction ? "false" : "true")).toLowerCase() === "true";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const normalizeOrigin = (value) => String(value || "").trim().replace(/\/+$/, "");
const PRODUCTION_APP_URL = normalizeOrigin(process.env.APP_ORIGIN || "https://ai-health-tech.onrender.com");
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

if (isProduction && SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be configured with at least 32 characters in production.");
}

if (isProduction && !process.env.MONGO_URL) {
  throw new Error("MONGO_URL must be configured in production.");
}

if (isProduction && !sessionCookieSecure) {
  throw new Error("APP_ORIGIN must use HTTPS in production so session cookies remain secure.");
}
// The landing page is public, but every clinical workspace and API route is
// protected. There is intentionally no local/demo authentication bypass.
const authenticationRequired = true;
const GOOGLE_STATE_TTL_MS = 10 * 60 * 1000;

function getAssetVersion() {
  const assetPaths = [
    path.join(__dirname, "public", "css", "clinic.css"),
    path.join(__dirname, "public", "js", "clinic.js"),
  ];

  try {
    const digest = crypto.createHash("sha256");
    assetPaths.forEach((assetPath) => digest.update(fs.readFileSync(assetPath)));
    return digest.digest("hex").slice(0, 12);
  } catch (error) {
    console.warn("Could not fingerprint static assets:", error.message);
    return "dev";
  }
}

const ASSET_VERSION = getAssetVersion();

function getGoogleRedirectUri(req = null) {
  if (process.env.GOOGLE_REDIRECT_URI) return String(process.env.GOOGLE_REDIRECT_URI).trim();
  if (req && !isProduction) {
    const proto = req.protocol || "http";
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
  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.includes("\\") ||
    candidate.startsWith("/logout") ||
    candidate.startsWith("/login") ||
    candidate.startsWith("/signup") ||
    candidate.startsWith("/auth/")
  ) {
    return "/dashboard";
  }
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

async function buildGoogleAuthUrl(req, nextPath = "/dashboard") {
  const googleOAuthClient = getOAuthClient(req);
  if (!googleOAuthClient) return "";

  const state = crypto.randomBytes(24).toString("hex");
  const nonce = crypto.randomBytes(24).toString("hex");
  req.session.googleOAuthState = {
    value: state,
    nonce,
    createdAt: Date.now(),
    nextUrl: safeNextPath(nextPath),
  };
  await saveSession(req);

  return googleOAuthClient.generateAuthUrl({
    access_type: "offline",
    scope: ["openid", "email", "profile"],
    prompt: "select_account",
    state,
    nonce,
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
// Trust the first proxy only in production, where the deployment topology is
// known. In local development, trusting forwarded headers would let a client
// spoof its IP and protocol.
app.set("trust proxy", isProduction ? 1 : false);
app.use(compression());
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.json({ limit: "2mb" }));
// Only accept method overrides from the parsed request body. Query-string
// overrides can turn an otherwise harmless cross-site request into a mutation.
app.use(methodOverride((req) => req.body?._method || null));

app.use((req, res, next) => {
  const cspNonce = crypto.randomBytes(18).toString("base64");
  res.locals.cspNonce = cspNonce;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("X-XSS-Protection", "0");
  res.setHeader("X-Download-Options", "noopen");
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${cspNonce}'`,
    "script-src-attr 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: https:",
    "media-src 'self' https: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' https://generativelanguage.googleapis.com https://openrouter.ai",
  ].join("; "));
  if (isProduction && sessionCookieSecure) {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});
// Clinical source files are private. A legacy /uploads URL must never expose
// anything even though the public folder is served for UI assets.
app.use("/uploads", (_req, res) => res.sendStatus(404));
app.use(express.static(path.join(__dirname, "public"), { maxAge: isProduction ? "1d" : 0 }));
app.use("/vendor/bootstrap", express.static(path.join(__dirname, "node_modules", "bootstrap", "dist", "css")));
app.use("/vendor/bulma", express.static(path.join(__dirname, "node_modules", "bulma", "css")));
app.use("/vendor/foundation", express.static(path.join(__dirname, "node_modules", "foundation-sites", "dist", "css")));
// HTML, redirects, and API responses must always reflect the current server
// build. Static files are safely cacheable because their URLs carry a content
// fingerprint from the layout below.
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  next();
});
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

function createRateLimiter({ windowMs, max, message }) {
  const buckets = new Map();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }, Math.min(windowMs, 60_000));
  cleanup.unref?.();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}:${req.path}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader("Retry-After", Math.ceil((bucket.resetAt - now) / 1000));
      if (req.path.startsWith("/api/")) return res.status(429).json({ error: message });
      return res.status(429).send(message);
    }
    next();
  };
}

const authRateLimit = createRateLimiter({
  windowMs: 15 * 60 * 1000,
  max: 12,
  message: "Too many sign-in attempts. Please try again later.",
});
const uploadRateLimit = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: "Too many document uploads. Please try again later.",
});
const assistantRateLimit = createRateLimiter({
  windowMs: 5 * 60 * 1000,
  max: 40,
  message: "Too many AI requests. Please wait before trying again.",
});
const searchRateLimit = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: "Too many search requests. Please wait a moment and try again.",
});

// SameSite cookies provide a browser-level CSRF barrier, while this origin
// check protects state-changing requests when a browser still sends a session
// cookie. Requests without browser origin headers remain usable for trusted
// server-to-server integrations.
function sameOriginGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const expectedOrigin = normalizeOrigin(`${req.protocol}://${req.get("host")}`);
  const origin = normalizeOrigin(req.get("origin"));
  const referer = req.get("referer");
  if (origin && origin !== expectedOrigin) return res.status(403).send("Cross-site request blocked.");
  if (!origin && referer) {
    try {
      if (normalizeOrigin(new URL(referer).origin) !== expectedOrigin) return res.status(403).send("Cross-site request blocked.");
    } catch (_error) {
      return res.status(403).send("Cross-site request blocked.");
    }
  }
  next();
}

app.use(sameOriginGuard);

app.locals.clinicName = CLINIC_NAME;
app.locals.tagline = TAGLINE;
app.locals.clinicianName = DEFAULT_CLINICIAN;
app.locals.assetVersion = ASSET_VERSION;
app.locals.currentPath = "";
app.locals.activeClinics = [CLINIC_NAME, "Sunrise Hospital", "Private Practice"];
app.locals.clinicDisplayName = (clinic) => clinic || CLINIC_NAME;
app.locals.semanticConfidence = semanticConfidence;
app.locals.googleConfigured = googleConfigured;
app.locals.clinicianSignupEnabled = clinicianSignupEnabled;
app.locals.safeJsonForScript = (value) => JSON.stringify(value)
  .replace(/</g, "\\u003c")
  .replace(/>/g, "\\u003e")
  .replace(/&/g, "\\u0026")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");
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
  res.locals.loginMode = req.query.mode === "signup" && clinicianSignupEnabled;
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
  // Only administrators may change clinic context. All other roles are
  // permanently scoped to the clinic assigned to their account.
  if (currentUser && currentUser.role !== "ADMIN") {
    req.session.currentClinic = currentUser.clinic || CLINIC_NAME;
  }
  res.locals.currentClinic = req.session.currentClinic;
  res.locals.isAuthenticated = isAuth;
  res.locals.currentUser = currentUser;
  next();
});

app.use((req, res, next) => {
  const publicPaths = new Set(["/", "/login", "/signup", "/patient/login", "/patient/signup", "/logout", "/auth/google", "/auth/google/callback", "/health"]);
  if (authenticationRequired && !req.currentUser && !publicPaths.has(req.path)) {
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Sign in as an authorized clinician to continue." });
    return res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
  }
  if (req.currentUser?.role === "PATIENT") {
    const patientAllowed = req.path === "/patient" || req.path.startsWith("/patient/") || req.path.startsWith("/patients/") || req.path.startsWith("/documents/") || req.path === "/logout";
    if (!patientAllowed) return req.path.startsWith("/api/") ? res.status(403).json({ error: "Patient portal access is limited to your own authorized records." }) : res.redirect("/patient");
  }
  if (req.currentUser?.role === "STAFF" && req.path === "/dashboard") return res.redirect("/staff");
  if (req.currentUser?.role === "STAFF" && (req.path === "/review" || req.path.startsWith("/review/") || req.path === "/upload" || req.path.startsWith("/handoffs/"))) return res.redirect("/staff");
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

function hasUnresolvedReviewExceptions(structuredData, medications = [], labResults = []) {
  const unresolvedStatuses = new Set(["review_required", "unresolved", "unclear"]);
  const normalizedConfidence = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return numeric > 1 ? numeric / 100 : numeric;
  };
  const hasValue = (value) => {
    if (value === null || value === undefined) return false;
    if (typeof value === "string") return Boolean(value.trim());
    return true;
  };

  const walkStructured = (node) => {
    if (Array.isArray(node)) return node.some(walkStructured);
    if (!node || typeof node !== "object") return false;

    const status = String(node.status || node.overallStatus || "").toLowerCase();
    const clinicianResolved = status === "clinician_verified" || status === "clinician_corrected" || node.isVerified === true;
    if (unresolvedStatuses.has(status)) return true;

    if (Object.prototype.hasOwnProperty.call(node, "value")) {
      const confidence = normalizedConfidence(node.confidence);
      if (!clinicianResolved && (!hasValue(node.value) || (confidence !== null && confidence < 0.8))) return true;
    }

    return Object.entries(node).some(([key, value]) => {
      if (["source", "sourceRegion", "boundingBox"].includes(key)) return false;
      return walkStructured(value);
    });
  };

  const unresolvedCollectionItem = (item) => {
    if (!item || typeof item !== "object") return false;
    const status = String(item.status || item.overallStatus || "").toLowerCase();
    if (unresolvedStatuses.has(status)) return true;
    if (item.isVerified === true || status === "clinician_verified" || status === "clinician_corrected") return false;
    const confidence = normalizedConfidence(item.confidence);
    return confidence !== null && confidence < 0.8;
  };

  return walkStructured(structuredData) || medications.some(unresolvedCollectionItem) || labResults.some(unresolvedCollectionItem);
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeClinicalSearchQuery(value) {
  return String(value || "")
    .replace(/\bpatients?\b/gi, "patient")
    .replace(/\bprescriptions?\b/gi, "prescription")
    .replace(/\bmedicines?\b/gi, "medicine")
    .replace(/\bdiagnoses?\b/gi, "diagnosis")
    .replace(/\b(with|having|from|in|for|the)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function localAccessAllowed() {
  return false;
}

function patientAccessQuery(req) {
  const clinic = req.session?.currentClinic || CLINIC_NAME;
  const clinicScope = { clinic };
  if (req.currentUser?._id) {
    if (req.currentUser.role === "PATIENT") return { ...clinicScope, portalUser: req.currentUser._id };
    if (req.currentUser.role === "ADMIN" || req.currentUser.role === "STAFF") return clinicScope;
    return {
      $and: [
        clinicScope,
        {
          $or: [
            { ownerDoctor: req.currentUser._id },
            { authorizedDoctors: req.currentUser._id },
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
    ...(req.currentUser?.role === "ADMIN" || req.currentUser?.role === "STAFF" || localAccessAllowed()
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
  const uploaderMatches = !document.uploadedBy || (req.currentUser?._id && String(document.uploadedBy) === String(req.currentUser._id)) || req.currentUser?.role === "ADMIN" || req.currentUser?.role === "STAFF" || localAccessAllowed();
  return clinicMatches && uploaderMatches ? document : null;
}

function currentDoctorName(req) {
  return req.currentUser?.name || req.session.doctorName || DEFAULT_CLINICIAN;
}

function landingPathForUser(user) {
  if (user?.role === "STAFF") return "/staff";
  if (user?.role === "PATIENT") return "/patient";
  return "/dashboard";
}

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.currentUser || !roles.includes(req.currentUser.role)) {
      return res.status(403).render("pages/error", {
        pageTitle: "Access denied",
        message: "This workflow is restricted to an authorized DEUS account.",
      });
    }
    next();
  };
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

async function buildPatientRagContext(req, patient, question) {
  const clinic = req.session.currentClinic || CLINIC_NAME;
  const documents = await ClinicalDocument.find({
    patient: patient._id,
    status: { $in: ["APPROVED", "CLINICIAN_VERIFIED", "AMENDED", "DOCTOR_VERIFIED"] },
  }).sort({ verifiedAt: -1, createdAt: -1 }).lean();
  const records = [];
  for (const document of documents) {
    const record = await ensureMedicalRecordForDocument(document, req);
    if (!record || !record.doctorVerified) continue;
    records.push(record);
    await indexClinicalRecord({ clinic, patient, document, record });
  }
  const retrieval = await retrieveClinicalContext({ clinic, patientId: patient._id, query: question });
  const documentIds = new Set(retrieval.documentIds || []);
  return {
    ...retrieval,
    documents: documents.filter((document) => documentIds.has(String(document._id))),
    records,
  };
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
  const extractedDob = String(fieldValue(extractedPatient.dateOfBirth || extractedPatient.dob || extractedPatient.date_of_birth) || "").trim();
  if (!extractedName && !extractedMrn && !extractedPhone && !extractedDob) return [];

  const patients = await Patient.find(patientAccessQuery(req)).sort({ updatedAt: -1 }).limit(250).lean();
  const normalizedName = compactMatchValue(extractedName);
  const normalizedMrn = compactMatchValue(extractedMrn);
  const normalizedPhone = compactMatchValue(extractedPhone);
  const normalizedDob = compactMatchValue(extractedDob);
  // A name by itself is never enough to suggest a patient match. MRN or
  // phone, or date of birth must provide an additional identity signal before
  // a candidate appears. A name-only match is always blocked.
  if (!normalizedMrn && !normalizedPhone && !normalizedDob) return [];
  const scoredCandidates = patients.map((patient) => {
    const patientName = compactMatchValue(patient.fullName);
    const patientMrn = compactMatchValue(patient.mrn);
    const patientPhone = compactMatchValue(patient.phone);
    const patientDob = compactMatchValue(patient.dateOfBirth || patient.dob);
    let score = 0;
    const reasons = [];
    const mrnExact = Boolean(normalizedMrn && patientMrn === normalizedMrn);
    const phoneExact = Boolean(normalizedPhone && patientPhone && patientPhone === normalizedPhone);
    const dobExact = Boolean(normalizedDob && patientDob && patientDob === normalizedDob);
    const nameExact = Boolean(normalizedName && patientName === normalizedName);
    if (mrnExact) { score += 100; reasons.push("MRN exact match"); }
    if (phoneExact) { score += 80; reasons.push("phone exact match"); }
    if (dobExact) { score += 65; reasons.push("date of birth exact match"); }
    if (nameExact) { score += 50; reasons.push("name exact match"); }
    else if (normalizedName && (patientName.includes(normalizedName) || normalizedName.includes(patientName))) { score += 15; reasons.push("name partial match"); }
    else if (normalizedName) reasons.push("name differs; verify before linking");
    const identitySignal = mrnExact || phoneExact || dobExact;
    const highConfidence = (mrnExact && (!normalizedName || nameExact)) || (phoneExact && (!normalizedName || nameExact)) || (dobExact && nameExact);
    const matchConfidence = highConfidence ? "HIGH" : (identitySignal ? "MEDIUM" : "LOW");
    return { ...patient, matchScore: score, matchConfidence, matchReasons: reasons, identitySignal };
  }).filter((patient) => patient.identitySignal && patient.matchScore >= 60)
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 10);

  if (!scoredCandidates.length) return [];
  const candidateIds = scoredCandidates.map((candidate) => candidate._id);
  const [recentRecords, recentDocuments] = await Promise.all([
    MedicalRecord.find({ patient: { $in: candidateIds }, doctorVerified: true })
      .sort({ verifiedAt: -1, createdAt: -1 })
      .select("patient verifiedAt createdAt")
      .lean(),
    ClinicalDocument.find({ patient: { $in: candidateIds }, status: { $in: ["APPROVED", "CLINICIAN_VERIFIED", "AMENDED", "DOCTOR_VERIFIED"] } })
      .sort({ verifiedAt: -1, createdAt: -1 })
      .select("patient verifiedAt createdAt")
      .lean(),
  ]);
  const lastVisitByPatient = new Map();
  [...recentRecords, ...recentDocuments].sort((a, b) => new Date(b.verifiedAt || b.createdAt) - new Date(a.verifiedAt || a.createdAt)).forEach((record) => {
    const key = String(record.patient);
    if (!lastVisitByPatient.has(key)) lastVisitByPatient.set(key, record.verifiedAt || record.createdAt);
  });
  return scoredCandidates.map((candidate) => ({
    ...candidate,
    lastVisit: lastVisitByPatient.get(String(candidate._id)) || null,
  }));
}

function extractionNeedsDoctorReview(extracted, patient) {
  if (!patient) return true;
  const medications = (extracted?.medications || []).map(normalizeMedication);
  const labResults = (extracted?.labResults || []).map(normalizeLab);
  return hasUnresolvedReviewExceptions(extracted?.structuredData, medications, labResults)
    || Number(extracted?.clinicalFlags?.totalAlerts || 0) > 0;
}

async function processDocumentExtraction(req, document, patient, file, documentType) {
  const extracted = await extractDocument(
    { filePath: file.path, mimeType: file.mimetype },
    document.originalFilename,
    documentType,
    patient?.allergies || "",
  );
  document.documentType = extracted.documentType || documentType;
  document.status = "NEEDS_VERIFICATION";
  document.extractedRecord = {
    rawText: JSON.stringify(extracted.originalSnapshot || extracted),
    structuredJson: extracted.structuredData,
    confidenceScore: extracted.overallConfidence || 0,
    modelName: extracted.modelName,
    aiSummary: extracted.aiSummary,
    clinicalFlags: extracted.clinicalFlags,
    extractedAt: new Date(),
  };
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
  const needsDoctorReview = extractionNeedsDoctorReview(extracted, patient);
  document.requiresDoctorReview = needsDoctorReview;
  document.processingStatus = patient
    ? (needsDoctorReview ? "DOCTOR_REVIEW_REQUIRED" : "VALIDATION_COMPLETE")
    : "PATIENT_MATCH_REQUIRED";
  document.autoValidatedAt = patient && !needsDoctorReview ? new Date() : null;
  document.processingError = "";
  await document.save();
  await recordAudit("AI_EXTRACTION", {
    document: document._id,
    patient: patient?._id || null,
    actorName: currentDoctorName(req),
    data: {
      model: extracted.modelName,
      status: document.status,
      processingStatus: document.processingStatus,
      ingestionSource: document.ingestionSource,
      overallConfidence: extracted.overallConfidence || 0,
      alertsFound: extracted.clinicalFlags?.totalAlerts || 0,
    },
  });
  // DSA perf: incremental index update — O(document) instead of a full rebuild.
  clinicalSearchEngine.indexSingleDocument({
    ...document.toObject(),
    patient: patient ? { fullName: patient.fullName, mrn: patient.mrn } : null,
  });
  const patientCandidates = patient ? [] : await findPatientMatchCandidates(req, extracted.structuredData);
  return { document, patient, extracted, extraction, patientCandidates };
}

async function processDocumentUpload(req, patientId, file, options = {}) {
  await validateUploadedFile(file);
  const patient = patientId ? await findAccessiblePatient(req, patientId) : null;
  if (patientId && !patient) throw new Error("The selected patient was not found or you are not authorized to access this patient.");
  const requestedType = String(req.body.documentType || "CLINICAL_NOTE");
  const documentType = requestedType === "AUTO" ? "CLINICAL_NOTE" : allowedDocumentTypes.has(requestedType) ? requestedType : "CLINICAL_NOTE";
  const clinic = req.session.currentClinic || CLINIC_NAME;
  const ingestionSource = ["staff", "patient", "doctor", "integration"].includes(options.source) ? options.source : "doctor";
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
      status: options.background ? "PENDING_OCR" : "DRAFT",
      ingestionSource,
      processingStatus: options.background ? "PROCESSING" : "RECEIVED",
      requiresDoctorReview: true,
    });
    await recordAudit("DOCUMENT_UPLOAD", {
      document: document._id,
      patient: patient?._id || null,
      actorName: currentDoctorName(req),
      actorRole: req.currentUser?.role,
      data: { filename: document.originalFilename, size: document.fileSize, cloudinaryAssetId: cloudAsset?.assetId || null, ingestionSource },
    });

    if (options.background) {
      setImmediate(async () => {
        try {
          await processDocumentExtraction(req, document, patient, file, documentType);
        } catch (error) {
          console.error("Background document processing failed:", error.message);
          await ClinicalDocument.findByIdAndUpdate(document._id, {
            $set: {
              status: "REJECTED",
              processingStatus: "FAILED",
              processingError: error.message.slice(0, 500),
              requiresDoctorReview: true,
            },
          }).catch(() => {});
          await recordAudit("PROCESSING_FAILED", {
            document: document._id,
            patient: patient?._id || null,
            actorName: currentDoctorName(req),
            data: { ingestionSource, error: error.message.slice(0, 500) },
          });
        }
      });
      return { document, patient, queued: true, patientCandidates: [] };
    }

    return await processDocumentExtraction(req, document, patient, file, documentType);
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

async function restrictSearchResultsToAuthorizedScope(req, dsaResponse) {
  if (!dsaResponse || !Array.isArray(dsaResponse.results)) return dsaResponse;
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const [documentIds, recordIds] = await Promise.all([
    ClinicalDocument.find(documentAccessQuery(req, patientIds)).distinct("_id"),
    MedicalRecord.find({ patient: { $in: patientIds }, doctorVerified: true }).distinct("_id"),
  ]);
  const allowedPatients = new Set(patientIds.map((id) => String(id)));
  const allowedDocuments = new Set(documentIds.map((id) => String(id)));
  const allowedRecords = new Set(recordIds.map((id) => String(id)));
  const isAllowed = (entityId) => {
    const id = String(entityId || "");
    if (id.startsWith("patient_")) return allowedPatients.has(id.slice("patient_".length));
    if (id.startsWith("doc_")) return allowedDocuments.has(id.slice("doc_".length));
    if (id.startsWith("rec_")) return allowedRecords.has(id.slice("rec_".length));
    if (id.startsWith("med_") || id.startsWith("lab_")) {
      const documentId = id.split("_")[1];
      return allowedDocuments.has(documentId);
    }
    return false;
  };
  const results = dsaResponse.results.filter((item) => isAllowed(item.id));
  const facets = { ALL: results.length, PATIENT: 0, MEDICATION: 0, LAB_TEST: 0, DOCUMENT: 0, RECORD: 0 };
  results.forEach((item) => {
    if (facets[item.entityType] !== undefined) facets[item.entityType] += 1;
  });
  return { ...dsaResponse, results, total: results.length, facets };
}

async function seedDemoData() {
  return false;
}

app.get("/", asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.render("pages/home", {
    pageTitle: "Clinical intelligence for the human side of care",
    brandName: "DEUS — AI-powered Clinical Intelligence",
    googleAuthUrl: "/auth/google?next=%2Fdashboard",
  });
}));

app.get("/health", (_req, res) => {
  const databaseReady = mongoose.connection.readyState === 1;
  res.status(databaseReady ? 200 : 503).json({
    status: databaseReady ? "healthy" : "unavailable",
    service: CLINIC_NAME,
  });
});

app.get("/login", (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const nextUrl = req.query.next ? safeNextPath(req.query.next) : landingPathForUser(req.currentUser);
  const signedOut = req.query.signed_out === "true";
  const error = req.query.error || null;
  const mode = req.query.mode === "signup" && clinicianSignupEnabled ? "signup" : "login";

  if (req.currentUser) {
    return res.redirect(nextUrl);
  }

  res.render("pages/login", {
    pageTitle: mode === "signup" ? "Create Clinician Account — DEUS" : "Sign in to DEUS",
    brandName: "DEUS — AI-powered Clinical Intelligence",
    error,
    signedOut,
    googleConfigured,
    nextUrl,
    mode,
  });
});

app.get("/signup", (req, res) => {
  if (!clinicianSignupEnabled) return res.redirect("/login?error=" + encodeURIComponent("Clinician account creation is disabled. Ask an administrator to provision access."));
  const nextParam = req.query.next ? `&next=${encodeURIComponent(req.query.next)}` : "";
  res.redirect(`/login?mode=signup${nextParam}`);
});

app.post("/login", authRateLimit, asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const requestedNextUrl = req.body.next || req.query.next || "";
  const nextUrl = requestedNextUrl ? safeNextPath(requestedNextUrl) : "/dashboard";

  if (!email || !password) {
    return res.status(400).render("pages/login", {
      pageTitle: "Sign in to DEUS",
      brandName: "DEUS — AI-powered Clinical Intelligence",
      error: "Please enter both clinician email and password.",
      signedOut: false,
      googleConfigured,
      nextUrl,
      mode: "login",
    });
  }

  const clinician = await User.findOne({ email });
  if (!clinician) {
    return res.status(401).render("pages/login", {
      pageTitle: "Sign in to DEUS",
      brandName: "DEUS — AI-powered Clinical Intelligence",
      error: "Invalid email or password.",
      signedOut: false,
      googleConfigured,
      nextUrl,
      mode: "login",
    });
  }

  if (!clinician.passwordHash) {
    return res.status(400).render("pages/login", {
      pageTitle: "Sign in to DEUS",
      brandName: "DEUS — AI-powered Clinical Intelligence",
      error: "Invalid email or password.",
      signedOut: false,
      googleConfigured,
      nextUrl,
      mode: "login",
    });
  }

  if (!clinician.validatePassword(password)) {
    return res.status(401).render("pages/login", {
      pageTitle: "Sign in to DEUS",
      brandName: "DEUS — AI-powered Clinical Intelligence",
      error: "Invalid email or password.",
      signedOut: false,
      googleConfigured,
      nextUrl,
      mode: "login",
    });
  }

  clinician.lastLoginAt = new Date();
  await clinician.save();

  await regenerateAuthenticatedSession(req, {
    userId: clinician._id,
    doctorName: clinician.name,
    currentClinic: clinician.clinic || CLINIC_NAME,
  });

  setFlash(req, "success", `Welcome back, ${clinician.name}.`);
  await saveSession(req);
  res.redirect(requestedNextUrl ? nextUrl : landingPathForUser(clinician));
}));

app.post("/signup", authRateLimit, asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (!clinicianSignupEnabled) {
    return res.status(403).render("pages/login", {
      pageTitle: "Sign in to DEUS",
      brandName: "DEUS — AI-powered Clinical Intelligence",
      error: "Clinician account creation is disabled. Ask an administrator to provision access.",
      signedOut: false,
      googleConfigured,
      nextUrl: "/dashboard",
      mode: "login",
    });
  }
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const clinic = String(req.body.clinic || "").trim();
  const nextUrl = safeNextPath(req.body.next || req.query.next);

  if (!name || !email || !password) {
    return res.status(400).render("pages/login", {
      pageTitle: "Create Clinician Account — DEUS",
      brandName: "DEUS — AI-powered Clinical Intelligence",
      error: "Please fill in all required fields (Name, Email, and Password).",
      signedOut: false,
      googleConfigured,
      nextUrl,
      mode: "signup",
    });
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).render("pages/login", {
      pageTitle: "Create Clinician Account — DEUS",
      brandName: "DEUS — AI-powered Clinical Intelligence",
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`,
      signedOut: false,
      googleConfigured,
      nextUrl,
      mode: "signup",
    });
  }

  const existing = await User.findOne({ email });
  if (existing) {
    return res.status(409).render("pages/login", {
      pageTitle: "Sign in to DEUS",
      brandName: "DEUS — AI-powered Clinical Intelligence",
      error: "An account with this email already exists. Please sign in.",
      signedOut: false,
      googleConfigured,
      nextUrl,
      mode: "login",
    });
  }

  const clinician = new User({
    name,
    email,
    clinic: clinic || CLINIC_NAME,
    role: "DOCTOR",
    lastLoginAt: new Date(),
  });
  clinician.setPassword(password);
  await clinician.save();

  await regenerateAuthenticatedSession(req, {
    userId: clinician._id,
    doctorName: clinician.name,
    currentClinic: clinician.clinic || CLINIC_NAME,
  });

  setFlash(req, "success", `Account created successfully. Welcome to DEUS, ${clinician.name}.`);
  await saveSession(req);
  res.redirect(nextUrl);
}));

app.get("/auth/google", authRateLimit, asyncHandler(async (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const authUrl = await buildGoogleAuthUrl(req, req.query.next);
  if (!authUrl) {
    return res.status(503).render("pages/login", {
      pageTitle: "Sign in to DEUS",
      brandName: "DEUS — AI-powered Clinical Intelligence",
      error: "Google Sign-in is temporarily unavailable. You may sign in with your email and password.",
      signedOut: false,
      googleConfigured: false,
      nextUrl: safeNextPath(req.query.next),
      mode: "login",
    });
  }
  res.redirect(authUrl);
}));

app.get("/auth/google/callback", asyncHandler(async (req, res) => {
  const googleOAuthClient = getOAuthClient(req);
  if (!googleOAuthClient) return res.redirect("/login?error=Sign-in+is+temporarily+unavailable.");
  const oauthState = req.session.googleOAuthState;
  const expectedState = typeof oauthState === "string" ? oauthState : oauthState?.value;
  const expectedNonce = typeof oauthState === "string" ? "" : oauthState?.nonce;
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
  if (expectedNonce && profile.nonce !== expectedNonce) return res.redirect("/login?error=Google+sign-in+could+not+be+verified.+Please+try+again.");
  let clinician = await User.findOne({ googleId: profile.sub });
  if (!clinician) clinician = await User.findOne({ email: profile.email.toLowerCase() });
  if (clinician) {
    clinician.googleId = profile.sub;
    clinician.name = profile.name || clinician.name;
    clinician.avatar = profile.picture || clinician.avatar;
    clinician.lastLoginAt = new Date();
    await clinician.save();
  } else {
    if (!clinicianSignupEnabled) {
      return res.redirect("/login?error=" + encodeURIComponent("Your Google account is not provisioned for clinician access. Ask an administrator to create your account."));
    }
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

const handleLogout = (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const clearSessionCookie = () => {
    res.clearCookie("curaclinic.sid", { path: "/", httpOnly: true, sameSite: "lax", secure: sessionCookieSecure });
  };

  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        console.error("Error destroying session on logout:", err.message);
      }
      clearSessionCookie();
      res.redirect("/login?signed_out=true");
    });
  } else {
    clearSessionCookie();
    res.redirect("/login?signed_out=true");
  }
};

app.post("/logout", handleLogout);

function renderPatientAuth(res, { mode = "login", error = null } = {}) {
  return res.render("pages/patient-auth", {
    pageTitle: mode === "signup" ? "Create Patient Portal Account" : "Patient Portal Sign in",
    mode,
    error,
  });
}

app.get("/patient/login", (req, res) => {
  if (req.currentUser) return res.redirect(landingPathForUser(req.currentUser));
  return renderPatientAuth(res);
});

app.get("/patient/signup", (req, res) => {
  if (req.currentUser) return res.redirect(landingPathForUser(req.currentUser));
  return renderPatientAuth(res, { mode: "signup" });
});

app.post("/patient/login", authRateLimit, asyncHandler(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const patientUser = await User.findOne({ email, role: "PATIENT" });
  if (!patientUser || !patientUser.validatePassword(password)) {
    return renderPatientAuth(res, { error: "Patient portal credentials could not be verified." });
  }
  patientUser.lastLoginAt = new Date();
  await patientUser.save();
  await regenerateAuthenticatedSession(req, { userId: patientUser._id, doctorName: patientUser.name, currentClinic: patientUser.clinic || CLINIC_NAME });
  await recordAudit("LOGIN", { actorId: patientUser._id, actorName: patientUser.name, actorRole: "PATIENT", data: { portal: "patient" } });
  await saveSession(req);
  res.redirect("/patient");
}));

app.post("/patient/signup", authRateLimit, asyncHandler(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const mrn = String(req.body.mrn || "").trim();
  const identityCheck = String(req.body.identityCheck || "").trim();
  const password = String(req.body.password || "");
  if (!email || !mrn || !identityCheck || password.length < MIN_PASSWORD_LENGTH) {
    return renderPatientAuth(res, { mode: "signup", error: `Enter the registered email, MRN, identity check, and a password of at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const patient = await Patient.findOne({ mrn, email, clinic: req.session.currentClinic || CLINIC_NAME });
  const normalizedCheck = identityCheck.replace(/\s+/g, "").toLowerCase();
  const normalizedPhone = String(patient?.phone || "").replace(/\D/g, "");
  const storedDate = patient?.dateOfBirth ? new Date(patient.dateOfBirth) : null;
  const dateOfBirthCheck = storedDate && !Number.isNaN(storedDate.getTime())
    ? storedDate.toISOString().slice(0, 10) === normalizedCheck
    : false;
  const phoneCheck = normalizedPhone.length >= 4 && normalizedPhone.slice(-4) === normalizedCheck.replace(/\D/g, "");
  const patientSignupFailure = "The patient details could not be verified or are already linked. Contact clinic staff for portal access.";
  if (!patient || (!dateOfBirthCheck && !phoneCheck)) return renderPatientAuth(res, { mode: "signup", error: patientSignupFailure });
  if (patient.portalUser) return renderPatientAuth(res, { mode: "signup", error: patientSignupFailure });
  if (await User.exists({ email })) return renderPatientAuth(res, { mode: "signup", error: patientSignupFailure });

  const patientUser = new User({ name: patient.fullName, email, role: "PATIENT", patient: patient._id, clinic: patient.clinic || CLINIC_NAME, lastLoginAt: new Date() });
  patientUser.setPassword(password);
  await patientUser.save();
  patient.portalUser = patientUser._id;
  await patient.save();
  await recordAudit("PATIENT_CREATED", { patient: patient._id, actorId: patientUser._id, actorName: patient.fullName, actorRole: "PATIENT", data: { portalAccount: true } });
  await regenerateAuthenticatedSession(req, { userId: patientUser._id, doctorName: patient.fullName, currentClinic: patient.clinic || CLINIC_NAME });
  await saveSession(req);
  res.redirect("/patient");
}));

app.post("/api/staff", authRateLimit, requireRoles("ADMIN"), asyncHandler(async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!name || !email || password.length < MIN_PASSWORD_LENGTH) return res.status(400).json({ error: `Staff name, email, and a password of at least ${MIN_PASSWORD_LENGTH} characters are required.` });
  if (await User.exists({ email })) return res.status(409).json({ error: "An account with this email already exists." });
  const staff = new User({ name, email, role: "STAFF", clinic: req.session.currentClinic || CLINIC_NAME });
  staff.setPassword(password);
  await staff.save();
  await recordAudit("STAFF_ACCOUNT_CREATED", { actorId: req.currentUser._id, actorName: currentDoctorName(req), data: { accountCreated: "STAFF", staffId: staff._id, email } });
  res.status(201).json({ id: staff._id, name: staff.name, email: staff.email, role: staff.role });
}));

app.get("/staff", requireRoles("STAFF", "ADMIN"), asyncHandler(async (req, res) => {
  const clinic = req.session.currentClinic || CLINIC_NAME;
  const [documents, patients] = await Promise.all([
    ClinicalDocument.find({ clinic, ingestionSource: "staff" }).sort({ createdAt: -1 }).limit(30).populate("patient", "fullName mrn").lean(),
    Patient.find(patientAccessQuery(req)).sort({ fullName: 1 }).select("_id fullName mrn age gender").lean(),
  ]);
  res.render("pages/staff-dashboard", { pageTitle: "Staff Intake", documents, patients, staffName: currentDoctorName(req) });
}));

function roleUploadPageMiddleware(fallbackPath) {
  return (req, res, next) => upload.single("file")(req, res, (error) => {
    if (error) return redirectWithFlash(req, res, fallbackPath, "danger", error.code === "LIMIT_FILE_SIZE" ? "This record is larger than the 15 MB upload limit." : error.message);
    next();
  });
}

app.post("/staff/documents", requireRoles("STAFF", "ADMIN"), roleUploadPageMiddleware("/staff"), asyncHandler(async (req, res) => {
  if (!req.file) return redirectWithFlash(req, res, "/staff", "danger", "Choose a prescription before continuing.");
  try {
    const patientId = req.body.patientId || "";
    const { document } = await processDocumentUpload(req, patientId, req.file, { source: "staff", background: true });
    redirectWithFlash(req, res, `/staff?document=${document._id}`, "success", "Prescription received. DEUS is processing it in the background.");
  } catch (error) {
    await fsPromises.unlink(req.file.path).catch(() => {});
    redirectWithFlash(req, res, "/staff", "danger", error.message);
  }
}));

app.get("/staff/documents/:id/status", requireRoles("STAFF", "ADMIN"), asyncHandler(async (req, res) => {
  const document = await findAccessibleDocument(req, req.params.id, { lean: true });
  if (!document) return res.status(404).json({ error: "Document not found or access denied." });
  res.json({ id: document._id, status: document.status, processingStatus: document.processingStatus, requiresDoctorReview: document.requiresDoctorReview, processingError: document.processingError || "", patient: document.patient || null });
}));

app.get("/patient", requireRoles("PATIENT"), asyncHandler(async (req, res) => {
  const patient = await Patient.findOne({ _id: req.currentUser.patient, portalUser: req.currentUser._id, clinic: req.session.currentClinic || CLINIC_NAME }).lean();
  if (!patient) return res.status(404).render("pages/error", { pageTitle: "Patient profile unavailable", message: "Your patient portal is not linked to an authorized profile." });
  const documents = await ClinicalDocument.find({ patient: patient._id }).sort({ createdAt: -1 }).limit(50).select("originalFilename documentType status processingStatus processingError ingestionSource createdAt verifiedAt").lean();
  res.render("pages/patient-portal", { pageTitle: "Patient Portal", patient, documents });
}));

app.post("/patient/documents", requireRoles("PATIENT"), roleUploadPageMiddleware("/patient"), asyncHandler(async (req, res) => {
  if (!req.file) return redirectWithFlash(req, res, "/patient", "danger", "Choose a prescription before continuing.");
  try {
    const patient = await Patient.findOne({ _id: req.currentUser.patient, portalUser: req.currentUser._id, clinic: req.session.currentClinic || CLINIC_NAME });
    if (!patient) throw new Error("Your patient portal is not linked to an authorized profile.");
    const { document } = await processDocumentUpload(req, patient._id, req.file, { source: "patient", background: true });
    redirectWithFlash(req, res, `/patient?document=${document._id}`, "success", "Prescription received. DEUS is processing it in the background.");
  } catch (error) {
    await fsPromises.unlink(req.file.path).catch(() => {});
    redirectWithFlash(req, res, "/patient", "danger", error.message);
  }
}));

app.get("/patient/documents/:id/status", requireRoles("PATIENT"), asyncHandler(async (req, res) => {
  const document = await findAccessibleDocument(req, req.params.id, { lean: true });
  if (!document || String(document.patient || "") !== String(req.currentUser.patient || "")) return res.status(404).json({ error: "Document not found or access denied." });
  res.json({ id: document._id, status: document.status, processingStatus: document.processingStatus, processingError: document.processingError || "", requiresDoctorReview: document.requiresDoctorReview });
}));

app.get("/dashboard", asyncHandler(async (req, res) => {
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const documentScope = documentAccessQuery(req, patientIds);

  const [rawPatientsCount, todayDocsCount, pendingDocs, recentRecords, processedDocumentsCount, totalVisitsCount, analyticsRecords] = await Promise.all([
    Patient.countDocuments(patientAccessQuery(req)),
    ClinicalDocument.countDocuments({
      ...documentScope,
      createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
    }),
    ClinicalDocument.find({
      ...documentScope,
      status: { $in: ["DRAFT", "AI_EXTRACTED", "NEEDS_VERIFICATION", "EXTRACTED", "PENDING_OCR"] },
      $or: [
        { requiresDoctorReview: { $ne: false } },
        { processingStatus: { $in: ["PATIENT_MATCH_REQUIRED", "DOCTOR_REVIEW_REQUIRED", "FAILED"] } },
      ],
    })
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
    ClinicalDocument.countDocuments(documentScope),
    MedicalRecord.countDocuments({ patient: { $in: patientIds }, doctorVerified: true }),
    MedicalRecord.find({ patient: { $in: patientIds }, doctorVerified: true })
      .select("extractedData")
      .limit(5000)
      .lean(),
  ]);
  const automaticallyValidatedCount = await ClinicalDocument.countDocuments({
    ...documentScope,
    processingStatus: { $in: ["VALIDATION_COMPLETE", "AUTO_PROCESSED"] },
  });

  // Transform pending verification docs with humanized review field counts
  const pendingQueue = pendingDocs.map((doc) => {
    if (doc.processingStatus === "PATIENT_MATCH_REQUIRED" || !doc.patient) {
      return {
        ...doc,
        patient: doc.patient ? { ...doc.patient, fullName: app.locals.toTitleCase(doc.patient.fullName) } : null,
        reviewStatusText: "Patient match required",
        totalNeedReview: 0,
        actionPath: `/documents/${doc._id}/match`,
      };
    }
    if (doc.processingStatus === "FAILED") {
      return {
        ...doc,
        patient: doc.patient ? { ...doc.patient, fullName: app.locals.toTitleCase(doc.patient.fullName) } : null,
        reviewStatusText: "Processing failed",
        totalNeedReview: 1,
        actionPath: `/review/${doc._id}`,
      };
    }
    if (doc.requiresDoctorReview === false || doc.processingStatus === "VALIDATION_COMPLETE" || doc.processingStatus === "AUTO_PROCESSED") {
      return {
        ...doc,
        patient: doc.patient ? { ...doc.patient, fullName: app.locals.toTitleCase(doc.patient.fullName) } : null,
        reviewStatusText: "Automatically processed",
        totalNeedReview: 0,
        actionPath: `/review/${doc._id}`,
      };
    }
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
      actionPath: `/review/${doc._id}`,
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
  const statNeedsReview = pendingQueue.filter((item) => item.totalNeedReview > 0 || item.reviewStatusText === "Patient match required" || item.reviewStatusText === "Processing failed").length;
  const medicineCounts = new Map();
  const diagnosisCounts = new Map();
  analyticsRecords.forEach((record) => {
    const data = record.extractedData || {};
    (Array.isArray(data.medications) ? data.medications : []).forEach((medication) => {
      const name = String(fieldValue(medication?.name || medication?.genericName || "") || "").trim();
      if (name) medicineCounts.set(name, (medicineCounts.get(name) || 0) + 1);
    });
    const diagnoses = Array.isArray(data.diagnosis) ? data.diagnosis : [data.diagnosis];
    diagnoses.flatMap((item) => String(fieldValue(item?.value ?? item) || "").split(/[;,]/)).map((item) => item.trim()).filter(Boolean).forEach((diagnosis) => {
      diagnosisCounts.set(diagnosis, (diagnosisCounts.get(diagnosis) || 0) + 1);
    });
  });
  const topCounts = (counts) => [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));

  res.render("pages/dashboard", {
    pageTitle: "Dashboard",
    clinicianGreeting: currentDoctorName(req),
    stats: {
      patients: statPatients,
      todayDocs: statTodayDocs,
      needsReview: statNeedsReview,
    },
    analytics: {
      totalPatients: statPatients,
      totalVisits: totalVisitsCount,
      prescriptionsProcessed: processedDocumentsCount,
      pendingReviews: statNeedsReview,
      recordsAddedToday: statTodayDocs,
      commonMedicines: topCounts(medicineCounts),
      commonDiagnoses: topCounts(diagnosisCounts),
    },
    doctorMetrics: {
      documentsProcessed: processedDocumentsCount,
      automaticallyValidated: automaticallyValidatedCount,
      requireAttention: statNeedsReview,
    },
    pendingQueue,
    recentClinicalRecords,
  });
}));

// Evaluation metrics are deliberately evidence-based. The system reports
// workflow measurements, but never presents proxy audit counts as clinical
// accuracy claims without a labeled reference dataset.
app.get("/api/analytics/evaluation", asyncHandler(async (req, res) => {
  const patientIds = await Patient.find(patientAccessQuery(req)).distinct("_id");
  const documentScope = documentAccessQuery(req, patientIds);
  const documents = await ClinicalDocument.find(documentScope).select("_id createdAt verifiedAt status").lean();
  const documentIds = new Set(documents.map((document) => String(document._id)));
  const auditLogs = await AuditLog.find({
    clinic: req.session.currentClinic || CLINIC_NAME,
    $or: [{ patient: { $in: patientIds } }, { document: { $in: [...documentIds] } }],
  }).select("action timestamp document patient details").sort({ timestamp: 1 }).lean();
  const scopedAuditLogs = auditLogs.filter((log) => !log.document || documentIds.has(String(log.document)));
  const fieldReviewLogs = scopedAuditLogs.filter((log) => ["FIELD_VERIFIED", "FIELD_CORRECTED", "FIELD_UNCLEAR"].includes(log.action));
  const correctionLogs = fieldReviewLogs.filter((log) => log.action === "FIELD_CORRECTED");
  const verificationLogs = fieldReviewLogs.filter((log) => log.action === "FIELD_VERIFIED");
  const reviewedDocuments = new Set(fieldReviewLogs.filter((log) => log.document).map((log) => String(log.document)));
  const extractionDocuments = new Set(scopedAuditLogs.filter((log) => log.action === "AI_EXTRACTION" && log.document).map((log) => String(log.document)));
  const extractionToReviewMinutes = [];
  for (const correction of correctionLogs) {
    const extraction = [...scopedAuditLogs].reverse().find((log) => log.document && String(log.document) === String(correction.document) && log.action === "AI_EXTRACTION" && new Date(log.timestamp) <= new Date(correction.timestamp));
    if (extraction) extractionToReviewMinutes.push((new Date(correction.timestamp) - new Date(extraction.timestamp)) / 60000);
  }
  const processingMinutes = documents
    .filter((document) => document.verifiedAt && document.createdAt)
    .map((document) => (new Date(document.verifiedAt) - new Date(document.createdAt)) / 60000)
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0);
  const average = (values) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null;
  res.json({
    scope: { clinic: req.session.currentClinic || CLINIC_NAME, authorizedPatients: patientIds.length, authorizedDocuments: documents.length },
    metrics: {
      fieldReviewEvents: fieldReviewLogs.length,
      correctedFieldEvents: correctionLogs.length,
      verifiedWithoutCorrectionEvents: verificationLogs.length,
      reviewRate: documents.length ? Number(((reviewedDocuments.size / documents.length) * 100).toFixed(2)) : null,
      extractionToReviewMinutes: average(extractionToReviewMinutes),
      documentProcessingMinutes: average(processingMinutes),
      indexedExtractionDocuments: extractionDocuments.size,
      patientMatchingAccuracy: null,
      falsePatientMatches: null,
    },
    evaluationNotes: [
      "Patient matching accuracy and false-match rate require a labeled evaluation set; they are not inferred from clinician actions.",
      "Field review counts measure workflow behavior, not ground-truth extraction accuracy.",
      "Add a de-identified reference set before publishing accuracy percentages.",
    ],
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
    if (error) {
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "This record is larger than the 15 MB upload limit."
        : (isProduction ? "The clinical record could not be uploaded." : error.message);
      return redirectWithFlash(req, res, "/upload", "danger", message);
    }
    next();
  });
}

function clinicalUploadApiMiddleware(req, res, next) {
  upload.single("file")(req, res, (error) => {
    if (error) {
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "This record is larger than the 15 MB upload limit."
        : (isProduction ? "The clinical record could not be uploaded." : error.message);
      return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: message });
    }
    next();
  });
}

app.post("/documents/upload", uploadRateLimit, clinicalUploadPageMiddleware, asyncHandler(async (req, res) => {
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
    redirectWithFlash(req, res, "/upload", "danger", isProduction ? "The clinical record could not be processed." : error.message);
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
  document.processingStatus = "DOCTOR_REVIEW_REQUIRED";
  document.requiresDoctorReview = true;
  document.processingError = "";
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

app.post("/api/patients/:patientId/documents", uploadRateLimit, clinicalUploadApiMiddleware, asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Choose a clinical record before continuing." });
  try {
    const { document, patient, extracted } = await processDocumentUpload(req, req.params.patientId, req.file);
    res.status(201).json({ patientId: patient._id, documentId: document._id, status: document.status, documentType: document.documentType, extracted });
  } catch (error) {
    await fsPromises.unlink(req.file.path).catch(() => {});
    const status = error.message.includes("not found") || error.message.includes("authorized") ? 404 : 400;
    res.status(status).json({ error: isProduction ? "The clinical record could not be processed." : error.message });
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

  if (req.body.exceptionsReviewed !== "yes") {
    return redirectWithFlash(req, res, `/review/${document._id}`, "danger", "Confirm that the highlighted exceptions were reviewed before signing this record.");
  }
  if (hasUnresolvedReviewExceptions(structuredData, medications, labResults)) {
    return redirectWithFlash(req, res, `/review/${document._id}`, "danger", "Resolve all required extraction exceptions before approving this clinical record.");
  }

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
    if (populatedDoc && populatedRecord?.patient) {
      await indexClinicalRecord({
        clinic: req.session.currentClinic || CLINIC_NAME,
        patient: populatedRecord.patient,
        document: populatedDoc,
        record: populatedRecord,
      });
    }
  } catch (err) {
    console.warn("Search or RAG index update failed:", err.message);
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

// Instant, access-scoped patient retrieval for the clinician search workflow.
// The response deliberately includes only clinician-approved longitudinal data.
app.get("/api/patients/search", searchRateLimit, asyncHandler(async (req, res) => {
  const queryText = String(req.query.q || req.query.search || "").trim();
  if (queryText.length < 2) return res.json({ query: queryText, results: [] });

  const safeSearch = escapeRegExp(queryText);
  const accessQuery = patientAccessQuery(req);
  const patients = await Patient.find({
    $and: [accessQuery, { $or: [{ fullName: new RegExp(safeSearch, "i") }, { mrn: new RegExp(safeSearch, "i") }, { phone: new RegExp(safeSearch, "i") }] }],
  }).sort({ fullName: 1 }).limit(12).lean();
  if (!patients.length) return res.json({ query: queryText, results: [] });

  const patientIds = patients.map((patient) => patient._id);
  const approvedDocuments = await ClinicalDocument.find({ patient: { $in: patientIds } }).lean();
  await Promise.all(approvedDocuments.filter(isDocumentApproved).map((document) => ensureMedicalRecordForDocument(document, req)));
  const [records, soapNotes] = await Promise.all([
    MedicalRecord.find({ patient: { $in: patientIds }, doctorVerified: true }).sort({ createdAt: 1 }).lean(),
    SOAPNote.find({ patient: { $in: patientIds } }).sort({ createdAt: -1 }).lean(),
  ]);
  const recordsByPatient = new Map();
  const notesByPatient = new Map();
  records.forEach((record) => {
    const key = String(record.patient);
    if (!recordsByPatient.has(key)) recordsByPatient.set(key, []);
    recordsByPatient.get(key).push(record);
  });
  soapNotes.forEach((note) => {
    const key = String(note.patient);
    if (!notesByPatient.has(key)) notesByPatient.set(key, []);
    notesByPatient.get(key).push(note);
  });

  const results = patients.map((patient) => {
    const intelligence = buildPatientHistoryIntelligence(
      patient,
      recordsByPatient.get(String(patient._id)) || [],
      notesByPatient.get(String(patient._id)) || [],
    );
    return {
      patient: {
        _id: patient._id,
        fullName: patient.fullName,
        mrn: patient.mrn,
        age: patient.age,
        gender: patient.gender,
        phone: patient.phone,
      },
      profileUrl: `/patients/${patient._id}`,
      summary: intelligence.atAGlance,
      totalVisits: intelligence.overview?.totalVisits || 0,
      lastVisit: intelligence.overview?.mostRecentVisit || "Not documented in available records.",
      medicationHistory: intelligence.medicationHistory,
      diagnosisHistory: intelligence.clinicalHistory?.diagnoses || ["Not documented in available records."],
      investigationHistory: intelligence.investigationHistory,
      timeline: intelligence.timeline || [],
      sourceEvidence: intelligence.sourceEvidence || [],
    };
  });
  res.json({ query: queryText, results });
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
  const historyIntelligence = await generatePatientHistorySummary(
    context.patient,
    buildPatientHistoryIntelligence(context.patient, context.medicalRecords, context.soapNotes),
  );
  const verifiedDocuments = context.documents.filter(isDocumentApproved);
  const labs = verifiedDocuments.flatMap((doc) => (doc.labResults || []).map((lab) => ({ ...lab, documentName: doc.originalFilename, recordedAt: lab.testDate || doc.createdAt }))).sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));
  const trends = labs.filter((lab) => lab.numericValue !== null && lab.numericValue !== undefined).reduce((groups, lab) => { const key = /glucose|sugar|fbs/i.test(lab.testName) ? "glucose" : /hba1c/i.test(lab.testName) ? "hba1c" : /creatinine/i.test(lab.testName) ? "creatinine" : /cholesterol|ldl/i.test(lab.testName) ? "cholesterol" : null; if (key) (groups[key] ||= []).push(lab); return groups; }, {});
  res.render("pages/patient", { pageTitle: context.patient.fullName, ...context, historyIntelligence, timeline: timelineFor(context.patient, verifiedDocuments), trends });
}));

function buildClinicalHandoffText(patient, intelligence, reason, sourceDocuments = []) {
  const list = (value) => Array.isArray(value) && value.length ? value.join("; ") : "Not documented in available records.";
  const clinical = intelligence?.clinicalHistory || {};
  const medication = intelligence?.medicationHistory || {};
  const investigations = intelligence?.investigationHistory || {};
  const recent = Array.isArray(intelligence?.recentHistory) ? intelligence.recentHistory.slice(0, 3) : [];
  const timeline = recent.length
    ? recent.map((visit) => `${visit.dateLabel || "Date not documented"}: ${visit.title || "Visit"}; diagnoses: ${list(visit.diagnosis)}; medications: ${list(visit.medications)}`).join("\n")
    : "Not documented in available records.";
  const documentedChanges = list(intelligence?.changesSincePreviousVisit);
  const supportingDocuments = sourceDocuments.length
    ? sourceDocuments.map((document) => `${document.originalFilename || "Clinical document"} (${document.documentType || "record"})`).join("; ")
    : "Not documented in available records.";
  return [
    `CLINICAL HANDOFF — ${patient.fullName}`,
    `Patient ID / MRN: ${patient.mrn || "Not documented in available records."}`,
    `Reason for referral: ${String(reason || "").trim() || "Not documented in available records."}`,
    "",
    `Documented clinical history: ${list(clinical.diagnoses)}`,
    `Documented symptoms / observations: ${list(clinical.symptomsObservations)}`,
    `Medication history: ${list(medication.previouslyPrescribed)}`,
    `Currently documented medicines: ${list(medication.currentlyDocumented)}`,
    `Investigation history: ${list(investigations.previousInvestigations)}`,
    `Important documented results: ${list(investigations.importantResults)}`,
    `Documented changes: ${documentedChanges}`,
    "Recent documented visits:",
    timeline,
    `Supporting source documents: ${supportingDocuments}`,
    "",
    "This handoff is a source-backed documentation aid. It contains no autonomous diagnosis or treatment recommendation. Confirm all details against the linked original records.",
  ].join("\n");
}

app.get("/patients/:id/handoff/new", requireRoles("DOCTOR", "ADMIN"), asyncHandler(async (req, res) => {
  const context = await loadPatientContext(req, req.params.id);
  if (!context) return res.status(404).render("pages/error", { pageTitle: "Patient not found", message: "This patient profile is no longer available." });
  const intelligence = buildPatientHistoryIntelligence(context.patient, context.medicalRecords, context.soapNotes);
  const sourceDocuments = context.documents.filter(isDocumentApproved);
  res.render("pages/handoff", { pageTitle: `Generate handoff · ${context.patient.fullName}`, patient: context.patient, intelligence, handoff: null, sourceDocuments, reason: "", draftText: buildClinicalHandoffText(context.patient, intelligence, "", sourceDocuments) });
}));

app.post("/patients/:id/handoff", requireRoles("DOCTOR", "ADMIN"), asyncHandler(async (req, res) => {
  const context = await loadPatientContext(req, req.params.id);
  if (!context) return res.status(404).render("pages/error", { pageTitle: "Patient not found", message: "This patient profile is no longer available." });
  const intelligence = buildPatientHistoryIntelligence(context.patient, context.medicalRecords, context.soapNotes);
  const reason = String(req.body.reason || "").trim().slice(0, 1200);
  const verifiedDocuments = context.documents.filter(isDocumentApproved);
  const handoff = await ClinicalHandoff.create({
    patient: context.patient._id,
    createdBy: req.currentUser?._id || null,
    createdByName: currentDoctorName(req),
    clinicName: req.session.currentClinic || CLINIC_NAME,
    summary: buildClinicalHandoffText(context.patient, intelligence, reason, verifiedDocuments),
    sourceDocuments: verifiedDocuments.map((document) => document._id),
    sourceRecords: context.medicalRecords.map((record) => record._id),
    status: "DRAFT",
  });
  await recordAudit("HANDOFF_GENERATED", { patient: context.patient._id, actorId: req.currentUser?._id || null, actorName: currentDoctorName(req), resourceType: "ClinicalHandoff", resourceId: handoff._id, data: { handoffId: handoff._id, sourceDocumentCount: verifiedDocuments.length, sourceRecordCount: context.medicalRecords.length } });
  res.redirect(`/handoffs/${handoff._id}`);
}));

app.get("/handoffs/:id", requireRoles("DOCTOR", "ADMIN"), asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).render("pages/error", { pageTitle: "Handoff not found", message: "The clinical handoff could not be found." });
  const handoff = await ClinicalHandoff.findById(req.params.id)
    .populate("patient", "fullName mrn age gender")
    .populate("sourceDocuments", "originalFilename documentType createdAt")
    .populate("sourceRecords", "title recordType createdAt")
    .lean();
  if (!handoff || !handoff.patient || !(await findAccessiblePatient(req, handoff.patient._id, { _id: 1 }))) return res.status(404).render("pages/error", { pageTitle: "Handoff not found", message: "The clinical handoff is unavailable or access is denied." });
  res.render("pages/handoff", { pageTitle: `Clinical handoff · ${handoff.patient.fullName}`, patient: handoff.patient, handoff, sourceDocuments: handoff.sourceDocuments || [], intelligence: null, reason: "", draftText: handoff.summary });
}));

app.post("/handoffs/:id/approve", requireRoles("DOCTOR", "ADMIN"), asyncHandler(async (req, res) => {
  const handoff = await ClinicalHandoff.findById(req.params.id);
  if (!handoff || !(await findAccessiblePatient(req, handoff.patient, { _id: 1 }))) return res.status(404).send("Handoff not found or access denied.");
  handoff.status = "APPROVED";
  handoff.approvedAt = new Date();
  handoff.approvedBy = req.currentUser?._id || null;
  await handoff.save();
  await recordAudit("HANDOFF_APPROVED", { patient: handoff.patient, actorId: req.currentUser?._id || null, actorName: currentDoctorName(req), resourceType: "ClinicalHandoff", resourceId: handoff._id, data: { handoffId: handoff._id } });
  redirectWithFlash(req, res, `/handoffs/${handoff._id}`, "success", "Clinical handoff approved. It is ready to share or export.");
}));

app.post("/handoffs/:id/share", requireRoles("DOCTOR", "ADMIN"), asyncHandler(async (req, res) => {
  const handoff = await ClinicalHandoff.findById(req.params.id);
  if (!handoff || !(await findAccessiblePatient(req, handoff.patient, { _id: 1 }))) return res.status(404).send("Handoff not found or access denied.");
  if (handoff.status !== "APPROVED" && handoff.status !== "SHARED") return redirectWithFlash(req, res, `/handoffs/${handoff._id}`, "danger", "Approve the handoff before sharing it.");
  handoff.status = "SHARED";
  handoff.sharedAt = new Date();
  await handoff.save();
  await recordAudit("HANDOFF_SHARED", { patient: handoff.patient, actorId: req.currentUser?._id || null, actorName: currentDoctorName(req), resourceType: "ClinicalHandoff", resourceId: handoff._id, data: { handoffId: handoff._id } });
  redirectWithFlash(req, res, `/handoffs/${handoff._id}`, "success", "Clinical handoff marked as shared.");
}));

app.get("/handoffs/:id/export", requireRoles("DOCTOR", "ADMIN"), asyncHandler(async (req, res) => {
  const handoff = await ClinicalHandoff.findById(req.params.id).populate("patient", "fullName").lean();
  if (!handoff || handoff.status === "DRAFT" || !handoff.patient || !(await findAccessiblePatient(req, handoff.patient._id, { _id: 1 }))) return res.status(403).send("Only an approved handoff can be exported.");
  res.type("text/plain").set("Content-Disposition", `attachment; filename="DEUS-clinical-handoff-${handoff.patient.fullName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.txt"`).send(handoff.summary);
}));

app.get("/assistant", asyncHandler(async (req, res) => {
  const patients = await Patient.find(patientAccessQuery(req)).sort({ fullName: 1 }).lean();
  res.render("pages/assistant", { pageTitle: "Clinical assistant", patients, selectedPatientId: req.query.patient || patients[0]?._id || "" });
}));

app.get("/api/patients/:patientId/history", asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.params.patientId);
  if (!patient) return res.status(404).json({ error: "Patient not found or access denied." });
  const documents = await ClinicalDocument.find({ patient: patient._id }).lean();
  const verifiedDocuments = documents.filter(isDocumentApproved);
  await Promise.all(verifiedDocuments.map((document) => ensureMedicalRecordForDocument(document, req)));
  const [records, soapNotes] = await Promise.all([
    MedicalRecord.find({ patient: patient._id, doctorVerified: true }).populate("document", "originalFilename documentType createdAt").sort({ createdAt: -1 }).lean(),
    SOAPNote.find({ patient: patient._id }).sort({ createdAt: -1 }).lean(),
  ]);
  const historyIntelligence = await generatePatientHistorySummary(
    patient,
    buildPatientHistoryIntelligence(patient, records, soapNotes),
  );
  res.json({ patientId: patient._id, records, summary: historyIntelligence });
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

app.post("/api/conversations/:conversationId/messages", assistantRateLimit, asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.conversationId)) return res.status(404).json({ error: "Conversation not found." });
  const conversation = await Conversation.findById(req.params.conversationId);
  if (!conversation) return res.status(404).json({ error: "Conversation not found." });
  const patient = await findAccessiblePatient(req, conversation.patient);
  if (!patient) return res.status(404).json({ error: "Conversation not found or access denied." });
  const message = String(req.body.message || req.body.content || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required." });
  await Message.create({ conversation: conversation._id, role: "USER", content: message });
  const [ragContext, soapNotes] = await Promise.all([
    buildPatientRagContext(req, patient, message),
    SOAPNote.find({ patient: patient._id, isSigned: true }).sort({ createdAt: -1 }).lean(),
  ]);
  const result = await answerClinicalQuestion(patient, ragContext.documents, soapNotes, message, ragContext);
  const assistantMessage = await Message.create({ conversation: conversation._id, role: "ASSISTANT", content: result.reply });
  conversation.updatedAt = new Date();
  await conversation.save();
  await recordAudit("ASSISTANT_QUERY", { patient: patient._id, actorName: currentDoctorName(req), data: { conversationId: conversation._id, question: message.slice(0, 300), ragSourceCount: ragContext.chunks.length, ragDocumentIds: ragContext.documentIds } });
  res.json({ ...result, conversationId: conversation._id, messageId: assistantMessage._id });
}));

app.post("/api/assistant/chat", assistantRateLimit, asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.body.patientId);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  const message = String(req.body.message || "").trim();
  if (!message) return res.status(400).json({ error: "Message is required." });
  const requestedConversationId = String(req.body.conversationId || "");
  if (requestedConversationId && !mongoose.isValidObjectId(requestedConversationId)) return res.status(400).json({ error: "Conversation id is invalid." });
  let conversation = requestedConversationId ? await Conversation.findOne({ _id: requestedConversationId, patient: patient._id }) : null;
  if (!conversation) conversation = await Conversation.create({ patient: patient._id, doctor: req.currentUser?._id || null, doctorName: currentDoctorName(req), title: message.slice(0, 180) });
  await Message.create({ conversation: conversation._id, role: "USER", content: message });
  const [ragContext, soapNotes] = await Promise.all([
    buildPatientRagContext(req, patient, message),
    SOAPNote.find({ patient: patient._id, isSigned: true }).sort({ createdAt: -1 }).lean(),
  ]);
  const result = await answerClinicalQuestion(patient, ragContext.documents, soapNotes, message, ragContext);
  const assistantMessage = await Message.create({ conversation: conversation._id, role: "ASSISTANT", content: result.reply });
  conversation.updatedAt = new Date();
  await conversation.save();
  await recordAudit("ASSISTANT_QUERY", { patient: patient._id, actorName: currentDoctorName(req), data: { conversationId: conversation._id, question: message.slice(0, 300), ragSourceCount: ragContext.chunks.length, ragDocumentIds: ragContext.documentIds } });
  res.json({ ...result, conversationId: conversation._id, messageId: assistantMessage._id });
}));

app.post("/api/assistant/soap", assistantRateLimit, asyncHandler(async (req, res) => {
  const patient = await findAccessiblePatient(req, req.body.patientId);
  if (!patient) return res.status(404).json({ error: "Patient not found" });
  let documentId = null;
  if (req.body.documentId) {
    if (!mongoose.isValidObjectId(req.body.documentId)) return res.status(400).json({ error: "Document id is invalid." });
    const document = await findAccessibleDocument(req, req.body.documentId);
    if (!document || String(document.patient) !== String(patient._id)) return res.status(404).json({ error: "Document not found or access denied." });
    documentId = document._id;
  }
  const doctorPrompt = String(req.body.doctorPrompt || "").trim();
  const [ragContext, soapNotes] = await Promise.all([
    buildPatientRagContext(req, patient, doctorPrompt || "routine clinical summary"),
    SOAPNote.find({ patient: patient._id, isSigned: true }).sort({ createdAt: -1 }).lean(),
  ]);
  const content = await generateSoap(patient, ragContext.documents, soapNotes, doctorPrompt, ragContext);
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
  const clinics = req.currentUser?.role === "ADMIN"
    ? app.locals.activeClinics
    : [req.currentUser?.clinic || CLINIC_NAME];
  res.render("pages/settings", {
    pageTitle: "Clinic Settings",
    clinics,
    currentClinic: req.session.currentClinic || CLINIC_NAME,
    clinicianName: currentDoctorName(req),
  });
}));

// Multi-clinic switcher
app.post("/settings/clinic", (req, res) => {
  const requestedClinic = String(req.body.clinic || CLINIC_NAME).trim();
  const allowedClinics = req.currentUser?.role === "ADMIN"
    ? app.locals.activeClinics
    : [req.currentUser?.clinic || CLINIC_NAME];
  if (allowedClinics.includes(requestedClinic)) {
    req.session.currentClinic = requestedClinic;
    setFlash(req, "success", `Switched clinic context to ${requestedClinic}.`);
  }
  const candidateRedirect = String(req.body.redirect || req.headers.referer || "");
  const redirectUrl = candidateRedirect.startsWith("/") && !candidateRedirect.startsWith("//") ? candidateRedirect : "/dashboard";
  res.redirect(redirectUrl);
});

// Advanced DSA Search Cockpit Route
app.get("/search", searchRateLimit, asyncHandler(async (req, res) => {
  const query = String(req.query.q || "").trim();
  const category = String(req.query.category || "ALL").toUpperCase();

  await refreshScopedSearchIndex(req);

  const indexedQuery = normalizeClinicalSearchQuery(query);
  const dsaResults = query
    ? await restrictSearchResultsToAuthorizedScope(req, { ...clinicalSearchEngine.search(indexedQuery, { category, limit: 30 }), query })
    : null;

  res.render("pages/search", {
    pageTitle: query ? `Search: ${query}` : "Clinical Records Search",
    query,
    category,
    dsaResults,
    searchStats: clinicalSearchEngine.stats,
  });
}));

// Advanced DSA Clinical Search API
app.get("/api/search", searchRateLimit, asyncHandler(async (req, res) => {
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

  const indexedQuery = normalizeClinicalSearchQuery(query);
  const dsaResponse = await restrictSearchResultsToAuthorizedScope(req, { ...clinicalSearchEngine.search(indexedQuery, { category, limit: 15 }), query });

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
  const accessScope = { clinic: req.session.currentClinic || CLINIC_NAME, $or: [{ patient: { $in: patientIds } }, { patient: null }] };
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
  const accessScope = { clinic: req.session.currentClinic || CLINIC_NAME, $or: [{ patient: { $in: patientIds } }, { patient: null }] };
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

const serverOrigin = isProduction ? PRODUCTION_APP_URL : `http://localhost:${PORT}`;
const server = app.listen(PORT, () => console.log(`${CLINIC_NAME} running at ${serverOrigin}`));

const mongoServerSelectionTimeoutMs = Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000);
const mongoReconnectDelayMs = Number(process.env.MONGO_RECONNECT_DELAY_MS || 5000);
let mongoRetryTimer = null;
let mongoBootstrapComplete = false;
let shuttingDown = false;

function scheduleMongoReconnect() {
  if (shuttingDown || mongoRetryTimer || mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  mongoRetryTimer = setTimeout(() => {
    mongoRetryTimer = null;
    connectMongo();
  }, mongoReconnectDelayMs);
  mongoRetryTimer.unref?.();
}

async function connectMongo() {
  if (shuttingDown || mongoose.connection.readyState === 1 || mongoose.connection.readyState === 2) return;
  try {
    await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: mongoServerSelectionTimeoutMs });
    console.log("MongoDB connected");

    if (!mongoBootstrapComplete) {
      try {
        const coll = mongoose.connection.db.collection("clinical_extractions");
        const indexes = await coll.indexes();
        if (indexes.some((i) => i.name === "mrn_1")) {
          await coll.dropIndex("mrn_1").catch(() => {});
          console.log("Cleaned legacy mrn_1 unique index from clinical_extractions");
        }
      } catch (_) {}
      await refreshSearchIndex();
      mongoBootstrapComplete = true;
    }
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    scheduleMongoReconnect();
  }
}

mongoose.connection.on("disconnected", () => {
  console.error("MongoDB disconnected; retrying connection.");
  scheduleMongoReconnect();
});
mongoose.connection.on("error", (error) => {
  console.error("MongoDB connection error:", error.message);
});
connectMongo();

process.on("SIGTERM", async () => {
  shuttingDown = true;
  if (mongoRetryTimer) clearTimeout(mongoRetryTimer);
  await mongoose.connection.close();
  server.close(() => process.exit(0));
});

module.exports = app;
