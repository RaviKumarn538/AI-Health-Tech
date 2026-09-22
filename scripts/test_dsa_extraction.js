/**
 * Network-free tests for the DSA extraction pipeline performance layer.
 * Covers: LRU file-buffer cache, single-flight coalescing, trie + bounded
 * Levenshtein drug lexicon, memoized analyzer, extraction result cache,
 * incremental search indexing, and the fast extractDocument() wrapper.
 */

const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AI_PROVIDER = "openrouter";
process.env.OPENROUTER_API_KEY = "test-key";
process.env.OPENROUTER_BASE_URL = "https://provider.test";
process.env.OPENROUTER_MODEL = "configured/vision-model";
process.env.EXTRACT_CACHE_TTL_MS = "600000";
process.env.DRUG_FUZZY_MAX_DISTANCE = "2";

let fetchCount = 0;
global.fetch = async (_url, _options) => {
  fetchCount += 1;
  // Widen the window so concurrent extractions reliably coalesce.
  await new Promise((resolve) => setTimeout(resolve, 40));
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
            patient: { name: { value: "Test Patient", confidence: 0.95 } },
            encounter: {},
            diagnosis: [],
            medications: [{ name: { value: "Panctoprazol 40 mg", confidence: 0.92 } }],
            investigations: [
              { testName: { value: "Fasting Glucose", confidence: 0.9 }, resultValue: { value: "110", confidence: 0.9 } },
            ],
            observations: [],
            followUp: {},
          }),
        },
      }],
    }),
  };
};

const {
  LexiconTrie,
  drugTrie,
  getCachedFileBuffer,
  coalesceByKey,
  correctMedicationNames,
  cachedAnalyzeDocumentPayload,
  buildExtractionCacheKey,
  getCachedExtraction,
  cacheExtraction,
  getPipelineMetrics,
  resetPipelineMetrics,
} = require("../utils/dsaExtraction");
const { extractDocument } = require("../utils/aiClinical");
const { clinicalSearchEngine } = require("../utils/dsaSearchEngine");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "curaclinic-dsa-test-"));

function section(title) {
  console.log(`\n== ${title} ==`);
}

async function testLexiconTrie() {
  section("Lexicon trie + bounded Levenshtein");
  assert.equal(drugTrie.has("Metformin"), true);
  assert.equal(drugTrie.has("metformin"), true);
  assert.equal(drugTrie.has("Metforminn"), false);

  const exact = drugTrie.fuzzySearch("Metformin");
  assert.deepEqual(exact, { word: "Metformin", distance: 0 });

  const oneAway = drugTrie.fuzzySearch("Amlodipne");
  assert.ok(oneAway, "typo should match");
  assert.equal(oneAway.word, "Amlodipine");
  assert.equal(oneAway.distance, 1);

  const twoAway = drugTrie.fuzzySearch("Panctoprazol");
  assert.ok(twoAway, "two-edit typo should match");
  assert.equal(twoAway.word, "Pantoprazole");
  assert.equal(twoAway.distance, 2);

  assert.equal(drugTrie.fuzzySearch("abx"), null, "very short queries are never fuzzy-matched");
  assert.equal(drugTrie.fuzzySearch("Zzqqxwvv"), null, "words beyond max distance stay unmatched");

  const tiny = new LexiconTrie();
  tiny.insert("Iron");
  assert.equal(tiny.has("iron"), true);
  console.log("Lexicon trie tests passed.");
}

async function testFileBufferCache() {
  section("LRU file-buffer cache");
  resetPipelineMetrics();
  const fileA = path.join(tempDir, "buffer-a.bin");
  fs.writeFileSync(fileA, Buffer.from("version-one"));

  const first = await getCachedFileBuffer(fileA);
  assert.equal(first.toString(), "version-one");
  const afterFirst = getPipelineMetrics();
  assert.equal(afterFirst.fileCacheHits, 0, "first read is a miss");

  const second = await getCachedFileBuffer(fileA);
  assert.equal(second.toString(), "version-one");
  const afterSecond = getPipelineMetrics();
  assert.equal(afterSecond.fileCacheHits, 1, "second read hits the cache");
  assert.ok(afterSecond.bytesReadSaved >= 11);

  fs.writeFileSync(fileA, Buffer.from("version-two-longer"));
  const third = await getCachedFileBuffer(fileA);
  assert.equal(third.toString(), "version-two-longer", "changed files invalidate the cache entry");
  assert.equal(getPipelineMetrics().fileCacheHits, 1, "mtime change forces a miss");
  console.log("File-buffer cache tests passed.");
}

async function testCoalescing() {
  section("Single-flight coalescing");
  let runs = 0;
  const factory = async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return `run-${runs}`;
  };
  const [r1, r2] = await Promise.all([
    coalesceByKey("coalesce-unit", factory),
    coalesceByKey("coalesce-unit", factory),
  ]);
  assert.equal(runs, 1, "concurrent identical work runs once");
  assert.equal(r1, "run-1");
  assert.equal(r2, "run-1");

  const r3 = await coalesceByKey("coalesce-unit-2", factory);
  assert.equal(runs, 2, "a different key runs its own factory");
  assert.equal(r3, "run-2");

  await assert.rejects(
    () => coalesceByKey("coalesce-unit-fail", async () => { throw new Error("boom"); }),
    /boom/,
  );
  await coalesceByKey("coalesce-unit-fail", factory); // failed promise is evicted
  assert.equal(runs, 3, "failures do not poison the key");
  console.log("Coalescing tests passed.");
}

async function testFuzzyMedicationCorrection() {
  section("Fuzzy medication-name correction");
  resetPipelineMetrics();
  const meds = correctMedicationNames([
    { name: "Panctoprazol 40 mg", warning: "" },
    { name: "Amlodipne 5 mg", warning: "" },
    { name: "Paracetamol 650 mg", warning: "" },
    { name: "40 mg", warning: "" },
  ]);
  assert.equal(meds[0].name, "Pantoprazole 40 mg");
  assert.match(meds[0].warning, /Pantoprazole/);
  assert.match(meds[0].warning, /edit distance 2/);
  assert.equal(meds[1].name, "Amlodipine 5 mg");
  assert.equal(meds[2].name, "Paracetamol 650 mg", "exact lexicon names are untouched");
  assert.equal(meds[2].warning, "");
  assert.equal(meds[3].name, "40 mg", "dose-only names are untouched");
  assert.equal(getPipelineMetrics().fuzzyCorrections, 2);
  console.log("Fuzzy correction tests passed.");
}

async function testAnalyzerAndExtractionCaches() {
  section("Memoized analyzer + extraction cache");
  resetPipelineMetrics();
  const medRow = [{ name: "Metformin", status: "NORMAL" }];
  const a1 = cachedAnalyzeDocumentPayload(medRow, [], "");
  const a2 = cachedAnalyzeDocumentPayload([{ name: "Metformin", status: "NORMAL" }], [], "");
  assert.deepEqual(a1, a2);
  assert.equal(getPipelineMetrics().analyzerCacheHits, 1, "identical analyzer input hits the cache");

  const keyA = buildExtractionCacheKey({ fileIdentity: "abc", documentType: "PRESCRIPTION", allergies: "" });
  const keyB = buildExtractionCacheKey({ fileIdentity: "abc", documentType: "LAB_REPORT", allergies: "" });
  assert.notEqual(keyA, keyB, "different inputs produce different cache keys");
  assert.equal(keyA, buildExtractionCacheKey({ fileIdentity: "abc", documentType: "PRESCRIPTION", allergies: "" }));

  assert.equal(getCachedExtraction(keyA), null, "cache miss before set");
  cacheExtraction(keyA, { aiSummary: "cached summary", medications: [{ name: "Metformin" }] });
  const hit = getCachedExtraction(keyA);
  assert.ok(hit);
  assert.equal(hit.aiSummary, "cached summary");
  assert.equal(getPipelineMetrics().extractionCacheHits, 1);
  hit.aiSummary = "mutated";
  assert.equal(getCachedExtraction(keyA).aiSummary, "cached summary", "cached values are deep-cloned on read");
  console.log("Cache tests passed.");
}

async function testIncrementalSearchIndex() {
  section("Incremental search indexing");
  clinicalSearchEngine.buildIndex({ patients: [], documents: [], records: [] });
  const doc = {
    _id: "doc-test-1",
    originalFilename: "rx-john.pdf",
    documentType: "PRESCRIPTION",
    status: "NEEDS_VERIFICATION",
    createdAt: new Date(),
    medications: [{ name: "Metformin", dosage: "500 mg", isVerified: false }],
    labResults: [],
  };
  clinicalSearchEngine.indexSingleDocument(doc);
  assert.ok(clinicalSearchEngine.search("rx-john").results.length > 0, "indexed doc is searchable");
  assert.ok(clinicalSearchEngine.search("Metformin").results.length > 0, "medication sub-entity is searchable");
  assert.equal(clinicalSearchEngine.search("500", { category: "MEDICATION" }).results[0]?.entityType, "MEDICATION", "medication tokens keep their entity type");

  clinicalSearchEngine.removeDocument("doc-test-1");
  assert.equal(clinicalSearchEngine.search("rx-john").results.length, 0, "removed doc no longer matches");
  assert.equal(clinicalSearchEngine.search("Metformin").results.length, 0, "stale sub-entities are filtered");

  // Re-index and replace the same document id (verify path upserts).
  doc.status = "APPROVED";
  doc.medications = [{ name: "Glimepiride", dosage: "1 mg", isVerified: true }];
  clinicalSearchEngine.indexSingleDocument(doc);
  assert.ok(clinicalSearchEngine.search("Glimepiride").results.length > 0);
  assert.equal(clinicalSearchEngine.search("Metformin").results.length, 0, "replaced entries are not duplicated");

  clinicalSearchEngine.indexSingleRecord({
    _id: "record-test-1",
    title: "Initial prescription",
    recordType: "PRESCRIPTION",
    version: 1,
    verifiedByName: "Dr. Test",
  });
  assert.ok(clinicalSearchEngine.search("Initial", { category: "RECORD" }).results.length > 0);
  clinicalSearchEngine.indexSingleRecord({
    _id: "record-test-1",
    title: "Amended prescription",
    recordType: "PRESCRIPTION",
    version: 2,
    verifiedByName: "Dr. Test",
  });
  assert.equal(clinicalSearchEngine.search("Initial", { category: "RECORD" }).results.length, 0, "re-indexed records remove stale titles");
  assert.equal(clinicalSearchEngine.search("Amended", { category: "RECORD" }).results.length, 1);
  console.log("Incremental search index tests passed.");
}

async function testFastExtractDocument() {
  section("Fast extractDocument (cache + coalescing end-to-end)");
  resetPipelineMetrics();
  const filePath = path.join(tempDir, "record.jpeg");
  fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));

  const first = await extractDocument(
    { filePath, mimeType: "application/octet-stream" },
    "record.jpeg",
    "PRESCRIPTION",
    "Penicillin",
  );
  assert.equal(first.modelName, "configured/vision-model");
  assert.equal(first.medications[0].name, "Pantoprazole 40 mg", "extraction output is fuzzy-corrected");
  const aiCallsAfterFirst = getPipelineMetrics().aiCalls;
  assert.equal(aiCallsAfterFirst, 1);
  assert.equal(fetchCount, 1);

  // Identical re-upload: served from the LRU extraction cache, zero AI calls.
  const second = await extractDocument(
    { filePath, mimeType: "application/octet-stream" },
    "record.jpeg",
    "PRESCRIPTION",
    "Penicillin",
  );
  assert.deepEqual(second, first);
  assert.notEqual(second, first, "cached results are returned as fresh clones");
  assert.equal(getPipelineMetrics().aiCalls, aiCallsAfterFirst, "re-upload does not call the AI again");
  assert.equal(getPipelineMetrics().extractionCacheHits, 1);

  // Concurrent first-time uploads of the same fresh file coalesce into one AI call.
  const filePath3 = path.join(tempDir, "record3.jpeg");
  fs.writeFileSync(filePath3, Buffer.from([0xff, 0xd8, 0xff, 0xe2, 0x00, 0x12]));
  const [c1, c2] = await Promise.all([
    extractDocument({ filePath: filePath3, mimeType: "application/octet-stream" }, "record3.jpeg", "PRESCRIPTION", "Penicillin"),
    extractDocument({ filePath: filePath3, mimeType: "application/octet-stream" }, "record3.jpeg", "PRESCRIPTION", "Penicillin"),
  ]);
  assert.deepEqual(c1, c2);
  assert.equal(fetchCount, 2, "coalescing collapses two concurrent extractions into one AI call");
  assert.ok(getPipelineMetrics().coalescedRequests >= 1, "the duplicate request joined the in-flight promise");

  // A different file still goes to the model.
  const filePath2 = path.join(tempDir, "record2.jpeg");
  fs.writeFileSync(filePath2, Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x11]));
  await extractDocument({ filePath: filePath2, mimeType: "application/octet-stream" }, "record2.jpeg", "PRESCRIPTION", "");
  assert.equal(fetchCount, 3, "new content triggers exactly one new AI call (1 first + 1 coalesced pair + 1 new file)");

  const metrics = getPipelineMetrics();
  assert.ok(metrics.averageAiDurationMs >= 0);
  assert.ok(metrics.drugLexiconSize > 300);
  console.log(`Fast extractDocument tests passed. Metrics: ${JSON.stringify({
    aiCalls: metrics.aiCalls,
    extractionCacheHits: metrics.extractionCacheHits,
    coalescedRequests: metrics.coalescedRequests,
    fileCacheHits: metrics.fileCacheHits,
    fuzzyCorrections: metrics.fuzzyCorrections,
  })}`);
}

async function run() {
  try {
    await testLexiconTrie();
    await testFileBufferCache();
    await testCoalescing();
    await testFuzzyMedicationCorrection();
    await testAnalyzerAndExtractionCaches();
    await testIncrementalSearchIndex();
    await testFastExtractDocument();
    console.log("\nAll DSA extraction pipeline tests passed.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
