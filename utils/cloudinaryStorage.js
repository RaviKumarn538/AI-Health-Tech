const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const CLOUD_NAME = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
const API_KEY = String(process.env.CLOUDINARY_API_KEY || "").trim();
const API_SECRET = String(process.env.CLOUDINARY_API_SECRET || "").trim();
const CLINICAL_PRESET = String(process.env.CLOUDINARY_CLINICAL_PRESET || "").trim();
const REQUEST_TIMEOUT_MS = Number(process.env.CLOUDINARY_REQUEST_TIMEOUT_MS || 45_000);

function isCloudinaryConfigured() {
  return Boolean(CLOUD_NAME && API_KEY && API_SECRET);
}

function cleanValue(value) {
  return String(value ?? "").trim();
}

// Cloudinary signs all non-empty upload parameters except file, api_key,
// resource_type, and cloud_name. Keep this server-side: API_SECRET must never
// be sent to a browser.
function createUploadSignature(parameters) {
  const payload = Object.entries(parameters)
    .filter(([key, value]) => !["file", "api_key", "resource_type", "cloud_name", "signature"].includes(key) && value !== undefined && value !== null && value !== "")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  return crypto.createHash("sha1").update(`${payload}${API_SECRET}`).digest("hex");
}

function safeSegment(value, fallback) {
  const cleaned = cleanValue(value)
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

function inferredMimeType(file) {
  const provided = cleanValue(file?.mimetype).toLowerCase();
  const ext = path.extname(file?.originalname || "").toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return provided || "application/octet-stream";
}

function cloudinaryError(payload, status) {
  const message = cleanValue(payload?.error?.message || payload?.message || `Cloudinary upload failed (${status})`);
  return new Error(message.slice(0, 700));
}

async function uploadClinicalDocument(file, { clinic = "CuraClinic AI", doctorId = "unassigned" } = {}) {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.");
  }
  if (!file?.path) throw new Error("Clinical file is unavailable for Cloudinary upload.");

  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `curaclinic/clinical/${safeSegment(clinic, "clinic")}/${safeSegment(doctorId, "doctor")}/${crypto.randomUUID()}`;
  const baseParameters = {
    timestamp,
    public_id: publicId,
    type: "authenticated",
  };
  const bytes = await fs.readFile(file.path);
  const postUpload = async (parameters) => {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: inferredMimeType(file) }), path.basename(file.originalname || "clinical-document"));
    form.append("api_key", API_KEY);
    for (const [key, value] of Object.entries(parameters)) form.append(key, String(value));
    form.append("signature", createUploadSignature(parameters));
    const response = await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUD_NAME)}/auto/upload`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { response, payload: await response.json().catch(() => ({})) };
  };

  let { response, payload } = await postUpload({ ...baseParameters, ...(CLINICAL_PRESET ? { upload_preset: CLINICAL_PRESET } : {}) });
  // A signed server-side upload does not require a preset. Keep the configured
  // preset when it exists, but don't prevent clinical intake if it was deleted
  // or has not yet been created in the Cloudinary console.
  if (!response.ok && CLINICAL_PRESET && /upload preset not found/i.test(cleanValue(payload?.error?.message))) {
    console.warn("Configured CLOUDINARY_CLINICAL_PRESET was not found; retrying signed authenticated upload without a preset.");
    ({ response, payload } = await postUpload(baseParameters));
  }
  if (!response.ok || !payload.public_id || !payload.asset_id) throw cloudinaryError(payload, response.status);

  return {
    assetId: payload.asset_id,
    publicId: payload.public_id,
    secureUrl: payload.secure_url || "",  // HTTPS delivery URL — used by sourceAvailable check
    url: payload.url || "",              // HTTP delivery URL — fallback
    resourceType: payload.resource_type || "raw",
    deliveryType: payload.type || "authenticated",
    version: Number(payload.version || 0) || null,
    format: payload.format || path.extname(file.originalname || "").replace(/^\./, ""),
    bytes: Number(payload.bytes || file.size || 0),
    uploadedAt: new Date(),
  };
}

async function destroyClinicalDocument(asset) {
  if (!isCloudinaryConfigured() || !asset?.publicId) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const parameters = { public_id: asset.publicId, timestamp, type: asset.deliveryType || "authenticated" };
  const form = new FormData();
  form.append("public_id", asset.publicId);
  form.append("timestamp", String(timestamp));
  form.append("type", parameters.type);
  form.append("api_key", API_KEY);
  form.append("signature", createUploadSignature(parameters));
  await fetch(`https://api.cloudinary.com/v1_1/${encodeURIComponent(CLOUD_NAME)}/${encodeURIComponent(asset.resourceType || "raw")}/destroy`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {});
}

module.exports = { isCloudinaryConfigured, uploadClinicalDocument, destroyClinicalDocument, createUploadSignature, inferredMimeType };
