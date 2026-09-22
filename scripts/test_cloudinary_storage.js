const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.CLOUDINARY_CLOUD_NAME = "test-cloud";
process.env.CLOUDINARY_API_KEY = "test-key";
process.env.CLOUDINARY_API_SECRET = "test-secret";
process.env.CLOUDINARY_CLINICAL_PRESET = "clinical-preset";

const requests = [];
let missingPresetOnce = true;
global.fetch = async (url, options) => {
  requests.push({ url, options });
  if (String(url).endsWith("/destroy")) {
    return { ok: true, status: 200, json: async () => ({ result: "ok" }) };
  }
  if (missingPresetOnce) {
    missingPresetOnce = false;
    return { ok: false, status: 400, json: async () => ({ error: { message: "Upload preset not found" } }) };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      asset_id: "asset-123",
      public_id: "curaclinic/clinical/test/doctor/file-123",
      resource_type: "raw",
      type: "authenticated",
      version: 42,
      format: "pdf",
      bytes: 18,
    }),
  };
};

const { uploadClinicalDocument, destroyClinicalDocument, createUploadSignature, inferredMimeType } = require("../utils/cloudinaryStorage");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "curaclinic-cloudinary-test-"));

async function run() {
  try {
    assert.equal(inferredMimeType({ originalname: "record.PDF" }), "application/pdf");
    assert.equal(createUploadSignature({ timestamp: 1, public_id: "x", type: "authenticated" }).length, 40);

    const filePath = path.join(tempDir, "record.pdf");
    fs.writeFileSync(filePath, "%PDF-1.4\nmock PDF\n");
    const asset = await uploadClinicalDocument({
      path: filePath,
      originalname: "record.pdf",
      mimetype: "application/octet-stream",
      size: 18,
    }, { clinic: "Test Clinic", doctorId: "doctor-1" });

    assert.equal(asset.assetId, "asset-123");
    assert.equal(asset.deliveryType, "authenticated");
    assert.match(requests[0].url, /\/v1_1\/test-cloud\/auto\/upload$/);
    assert.equal(requests[0].options.body.get("type"), "authenticated");
    assert.equal(requests[0].options.body.get("upload_preset"), "clinical-preset");
    assert.ok(requests[0].options.body.get("signature"));
    assert.equal(requests[1].options.body.get("upload_preset"), null);

    await destroyClinicalDocument(asset);
    assert.match(requests[2].url, /\/raw\/destroy$/);
    assert.equal(requests[2].options.body.get("public_id"), asset.publicId);
    console.log("Cloudinary clinical-storage tests passed.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
