const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AI_PROVIDER = "openrouter";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENROUTER_BASE_URL = "https://provider.test";
process.env.OPENROUTER_MODEL = "configured/vision-model";
process.env.OPENROUTER_PDF_ENGINE = "cloudflare-ai";

const requests = [];
global.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  requests.push(body);
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      choices: [{
        message: {
          content: JSON.stringify({
            documentType: "PRESCRIPTION",
            aiSummary: "Test extraction",
            overallConfidence: 0.9,
            patient: {},
            encounter: {},
            diagnosis: [],
            medications: [],
            investigations: [],
            observations: [],
            followUp: {},
          }),
        },
      }],
    }),
  };
};

const { extractDocument } = require("../utils/aiClinical");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "curaclinic-ai-test-"));

async function run() {
  try {
    const imagePath = path.join(tempDir, "record.jpeg");
    fs.writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const imageResult = await extractDocument(
      { filePath: imagePath, mimeType: "application/octet-stream" },
      "record.jpeg",
      "PRESCRIPTION"
    );

    assert.equal(imageResult.modelName, "configured/vision-model");
    assert.equal(requests[0].model, "configured/vision-model");
    const imagePart = requests[0].messages[1].content.find((part) => part.type === "image_url");
    assert.ok(imagePart?.image_url?.url.startsWith("data:image/jpeg;base64,"));

    const pdfPath = path.join(tempDir, "record.pdf");
    fs.writeFileSync(pdfPath, Buffer.from("%PDF-1.4\n% mock PDF\n"));
    await extractDocument(
      { filePath: pdfPath, mimeType: "application/octet-stream" },
      "record.pdf",
      "PRESCRIPTION"
    );

    const pdfRequest = requests[1];
    const pdfPart = pdfRequest.messages[1].content.find((part) => part.type === "file");
    assert.ok(pdfPart?.file?.file_data.startsWith("data:application/pdf;base64,"));
    assert.deepEqual(pdfRequest.plugins, [{ id: "file-parser", pdf: { engine: "cloudflare-ai" } }]);
    console.log("AI extraction request tests passed.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
