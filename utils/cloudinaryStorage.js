const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const CLOUD_NAME = String(process.env.CLOUDINARY_CLOUD_NAME || "").trim();
const API_KEY = String(process.env.CLOUDINARY_API_KEY || "").trim();
const API_SECRET = String(process.env.CLOUDINARY_API_SECRET || "").trim();
const CLINICAL_PRESET = String(process.env.CLOUDINARY_CLINICAL_PRESET || "").trim();
const REQUEST_TIMEOUT_MS = Number(process.env.CLOUDINARY_REQUEST_TIMEOUT_MS || 45_000);

// Signed URL expiry: 5 minutes — short enough to prevent link sharing,
// long enough for a browser to fully load the image/PDF after redirect.
const SIGNED_URL_TTL_SECONDS = 5 * 60;

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

// ─────────────────────────────────────────────────────────────────────────────
// generateSignedDeliveryUrl
//
// Generates a short-lived SIGNED URL for an "authenticated" Cloudinary asset.
//
// WHY THIS MATTERS:
//   • Authenticated Cloudinary assets are NOT publicly accessible.
//     Even if someone knows the publicId, they cannot access the file without
//     a valid server-generated signature using API_SECRET.
//   • Signed URLs expire after SIGNED_URL_TTL_SECONDS (5 min by default).
//     This prevents URL sharing or leaking between doctors.
//   • Each doctor's files are stored in an isolated folder:
//       curaclinic/doctors/{doctorId}/prescriptions/{uuid}
//     So even at the Cloudinary folder level, doctors cannot see each other's files.
//
// Returns null if Cloudinary is not configured or asset publicId is missing.
// ─────────────────────────────────────────────────────────────────────────────
function generateSignedDeliveryUrl(cloudinaryAsset) {
  if (!isCloudinaryConfigured()) return null;
  const publicId = cleanValue(cloudinaryAsset?.publicId);
  if (!publicId) return null;

  const resourceType = cleanValue(cloudinaryAsset?.resourceType || "image");
  const deliveryType = cleanValue(cloudinaryAsset?.deliveryType || "authenticated");
  const expireAt = Math.floor(Date.now() / 1000) + SIGNED_URL_TTL_SECONDS;

  // Cloudinary delivery signature: SHA-1 of "exp={expireAt}&public_id={publicId}" + API_SECRET
  const signaturePayload = `exp=${expireAt}&public_id=${publicId}`;
  const signature = crypto.createHash("sha1").update(`${signaturePayload}${API_SECRET}`).digest("hex");

  // Build URL: https://res.cloudinary.com/{cloud}/{resource}/{type}/s--{sig}--/e_{exp}/v{ver}/{public_id}.{format}
  const version = cloudinaryAsset?.version ? `v${cloudinaryAsset.version}/` : "";
  const format = cleanValue(cloudinaryAsset?.format);
  const publicIdWithExt = format && !publicId.endsWith(`.${format}`) ? `${publicId}.${format}` : publicId;

  return (
    `https://res.cloudinary.com/${encodeURIComponent(CLOUD_NAME)}/` +
    `${resourceType}/${deliveryType}/` +
    `s--${signature}--/` +
    `e_${expireAt}/` +
    `${version}${publicIdWithExt}`
  );
}

async function uploadClinicalDocument(file, { clinic = "CuraClinic AI", doctorId = "unassigned" } = {}) {
  if (!isCloudinaryConfigured()) {
    throw new Error("Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.");
  }
  if (!file?.path) throw new Error("Clinical file is unavailable for Cloudinary upload.");

  const timestamp = Math.floor(Date.now() / 1000);

  // ── DOCTOR-ISOLATED FOLDER STRUCTURE ──────────────────────────────────────
  // Each doctor's uploads go into their own private namespace:
  //   curaclinic/doctors/{doctorId}/prescriptions/{uuid}
  //
  // Access control layers:
  //   1. App layer  → findAccessibleDocument() checks uploadedBy === req.currentUser._id
  //   2. Cloudinary → type:"authenticated" means no direct public access; only
  //                   server-generated signed URLs (generateSignedDeliveryUrl) work
  //   3. Folder     → Doctor A's files are under /doctors/{docAId}/, never visible
  //                   to Doctor B even in the Cloudinary console (if folder-level
  //                   access policies are applied)
  // ──────────────────────────────────────────────────────────────────────────
  const publicId = `curaclinic/doctors/${safeSegment(doctorId, "unassigned")}/prescriptions/${crypto.randomUUID()}`;

  const baseParameters = {
    timestamp,
    public_id: publicId,
    type: "authenticated",   // Private — no public URL works; only signed URLs
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
  if (!response.ok && CLINICAL_PRESET && /upload preset not found/i.test(cleanValue(payload?.error?.message))) {
    console.warn("Configured CLOUDINARY_CLINICAL_PRESET was not found; retrying signed authenticated upload without a preset.");
    ({ response, payload } = await postUpload(baseParameters));
  }
  if (!response.ok || !payload.public_id || !payload.asset_id) throw cloudinaryError(payload, response.status);

  return {
    assetId: payload.asset_id,
    publicId: payload.public_id,
    // Raw URLs below — authenticated assets return these but they do NOT work
    // without a signature. Always use generateSignedDeliveryUrl() to serve them.
    secureUrl: payload.secure_url || "",
    url: payload.url || "",
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

module.exports = {
  isCloudinaryConfigured,
  uploadClinicalDocument,
  destroyClinicalDocument,
  generateSignedDeliveryUrl,
  createUploadSignature,
  inferredMimeType,
};
