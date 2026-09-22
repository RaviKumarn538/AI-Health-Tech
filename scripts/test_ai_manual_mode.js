const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// An explicit manual provider must never call a configured provider by
// accident. This is also useful for offline/local development.
process.env.AI_PROVIDER = "manual";
delete process.env.OPENROUTER_API_KEY;
delete process.env.GEMINI_API_KEY;
global.fetch = async () => {
  throw new Error("manual mode must not call fetch");
};

const { extractDocument } = require("../utils/aiClinical");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "curaclinic-manual-ai-test-"));

async function run() {
  try {
    const filePath = path.join(tempDir, "record.png");
    fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await extractDocument({ filePath, mimeType: "image/png" }, "record.png", "PRESCRIPTION");
    assert.equal(result.modelName, "manual-clinical-review");
    assert.equal(result.overallConfidence, 0);
    assert.deepEqual(result.medications, []);
    assert.deepEqual(result.labResults, []);
    assert.deepEqual(result.structuredData.diagnosis, []);
    console.log("Explicit manual AI mode test passed.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
