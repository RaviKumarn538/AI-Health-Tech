/**
 * DSA Extraction Pipeline — performance layer for clinical document processing.
 *
 * Document processing used to pay the same costs on every request:
 *   1. fs.readFile on every AI call (O(file size) per request, no reuse)
 *   2. One full AI round-trip per upload even for identical re-uploads
 *   3. N concurrent uploads of the same file => N expensive AI calls
 *   4. Linear drug-name scans; medication typos degraded matching quality
 *   5. analyzeDocumentPayload recomputed on every render/verify
 *
 * This module fixes all five with classic data structures:
 *   - LRU Cache (hash map + doubly linked list) => O(1) cached file buffers,
 *     cached extraction results, and cached analyzer outputs
 *   - In-flight promise map (single-flight coalescing) => concurrent identical
 *     extractions share exactly one AI round-trip
 *   - Trie + bounded Levenshtein DFS (edit-distance automaton over the prefix
 *     tree, pruned when min(row) > allowed distance) => O(L x branch) fuzzy
 *     medication spelling correction instead of O(dictionary) scans
 */

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { LRUCache } = require("./dsaSearchEngine");
const { analyzeDocumentPayload } = require("./clinicalAnalyzer");

const EXTRACT_CACHE_TTL_MS = Math.max(0, Number(process.env.EXTRACT_CACHE_TTL_MS ?? 10 * 60 * 1000));
const DRUG_FUZZY_MAX_DISTANCE = Math.max(0, Number(process.env.DRUG_FUZZY_MAX_DISTANCE ?? 2));
const EXTRACTION_PROMPT_VERSION = "extract-v2";

// ============================================================================
// 1. LRU-CACHED FILE BUFFERS (avoids re-reading the same upload per AI call)
// ============================================================================
const fileBufferCache = new LRUCache(32);

async function getCachedFileBuffer(filePath) {
  const key = path.resolve(String(filePath));
  const stat = await fs.stat(key);
  const hit = fileBufferCache.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    pipelineMetrics.fileCacheHits += 1;
    pipelineMetrics.bytesReadSaved += hit.buffer.length;
    return hit.buffer;
  }
  const buffer = await fs.readFile(key);
  fileBufferCache.set(key, { buffer, mtimeMs: stat.mtimeMs, size: stat.size });
  return buffer;
}

// ============================================================================
// 2. SINGLE-FLIGHT COALESCING (concurrent identical work runs once)
// ============================================================================
const inFlight = new Map();

function coalesceByKey(key, factory) {
  const existing = inFlight.get(key);
  if (existing) {
    pipelineMetrics.coalescedRequests += 1;
    return existing;
  }
  const promise = (async () => {
    try {
      return await factory();
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

// ============================================================================
// 3. MEDICATION LEXICON TRIE + BOUNDED LEVENSHTEIN (typo-tolerant matching)
// ============================================================================
class LexiconTrie {
  constructor() {
    this.root = { children: new Map(), word: null };
    this.size = 0;
  }

  insert(word) {
    const original = String(word || "").trim();
    if (!original) return;
    const normalized = original.toLowerCase();
    let node = this.root;
    for (const ch of normalized) {
      let child = node.children.get(ch);
      if (!child) {
        child = { children: new Map(), word: null };
        node.children.set(ch, child);
      }
      node = child;
    }
    if (!node.word) this.size += 1;
    node.word = node.word || original; // keep first-seen casing
  }

  _nodeFor(query) {
    let node = this.root;
    for (const ch of String(query || "").toLowerCase()) {
      node = node.children.get(ch);
      if (!node) return null;
    }
    return node;
  }

  has(word) {
    const node = this._nodeFor(word);
    return Boolean(node && node.word);
  }

  /**
   * Bounded fuzzy lookup: Levenshtein automaton walked over the trie.
   * Prunes any branch whose DP row minimum exceeds the allowed distance, so
   * the search costs O(L x branch factor) instead of O(dictionary x L^2).
   * Distance allowance is tightened for short words to avoid false matches.
   */
  fuzzySearch(query, maxDistance = DRUG_FUZZY_MAX_DISTANCE) {
    const q = String(query || "").toLowerCase();
    if (!q || q.length < 4) return null;
    const allowed = Math.min(Number(maxDistance), q.length >= 8 ? 2 : 1);
    if (allowed <= 0) {
      const node = this._nodeFor(q);
      return node && node.word ? { word: node.word, distance: 0 } : null;
    }

    let best = null;
    const row = new Array(q.length + 1);
    for (let i = 0; i <= q.length; i++) row[i] = i;

    const dfs = (node, rowArr) => {
      const finalDistance = rowArr[q.length];
      if (node.word && finalDistance <= allowed && (!best || finalDistance < best.distance)) {
        best = { word: node.word, distance: finalDistance };
        if (finalDistance === 0) return;
      }
      let rowMin = Infinity;
      for (let i = 0; i < rowArr.length; i++) if (rowArr[i] < rowMin) rowMin = rowArr[i];
      if (rowMin > allowed) return; // prune: no descendant can recover

      for (const [ch, child] of node.children) {
        const next = new Array(q.length + 1);
        next[0] = rowArr[0] + 1;
        for (let i = 1; i <= q.length; i++) {
          const cost = q[i - 1] === ch ? 0 : 1;
          next[i] = Math.min(next[i - 1] + 1, rowArr[i] + 1, rowArr[i - 1] + cost);
        }
        dfs(child, next);
        if (best && best.distance === 0) return;
      }
    };

    dfs(this.root, row);
    return best;
  }
}

// Single-word salt/generic names seen in Indian clinic prescriptions.
const DRUG_LEXICON = [
  // Analgesics / antipyretics / NSAIDs
  "Paracetamol", "Acetaminophen", "Ibuprofen", "Diclofenac", "Aceclofenac", "Aspirin",
  "Naproxen", "Etoricoxib", "Mefenamic", "Tramadol", "Tapentadol", "Ketorolac", "Nimesulide",
  // Antibiotics / antimicrobials
  "Amoxicillin", "Clavulanate", "Azithromycin", "Cefixime", "Cefpodoxime", "Ceftriaxone",
  "Cefotaxime", "Cephalexin", "Cefuroxime", "Ciprofloxacin", "Levofloxacin", "Ofloxacin",
  "Moxifloxacin", "Norfloxacin", "Doxycycline", "Minocycline", "Metronidazole", "Tinidazole",
  "Ornidazole", "Secnidazole", "Clindamycin", "Erythromycin", "Roxithromycin", "Clarithromycin",
  "Rifampicin", "Isoniazid", "Pyrazinamide", "Ethambutol", "Linezolid", "Vancomycin",
  "Meropenem", "Piperacillin", "Tazobactam", "Colistin", "Nitrofurantoin", "Fosfomycin",
  // Antifungals / antivirals / antiparasitics
  "Fluconazole", "Itraconazole", "Voriconazole", "Ketoconazole", "Terbinafine", "Griseofulvin",
  "Acyclovir", "Valacyclovir", "Famciclovir", "Oseltamivir", "Entecavir", "Tenofovir",
  "Albendazole", "Mebendazole", "Ivermectin", "Praziquantel", "Hydroxychloroquine",
  "Chloroquine", "Artesunate", "Artemether", "Lumefantrine", "Primaquine", "Quinine",
  // Cardiovascular
  "Amlodipine", "Nifedipine", "Nicardipine", "Cilnidipine", "Benidipine", "Lercanidipine",
  "Telmisartan", "Losartan", "Valsartan", "Irbesartan", "Olmesartan", "Azilsartan",
  "Enalapril", "Ramipril", "Lisinopril", "Perindopril", "Captopril", "Quinapril",
  "Metoprolol", "Atenolol", "Bisoprolol", "Carvedilol", "Propranolol", "Nebivolol",
  "Esmolol", "Sotalol", "Atorvastatin", "Rosuvastatin", "Simvastatin", "Pitavastatin",
  "Pravastatin", "Ezetimibe", "Fenofibrate", "Gemfibrozil", "Clopidogrel", "Ticagrelor",
  "Prasugrel", "Ticlopidine", "Warfarin", "Rivaroxaban", "Apixaban", "Dabigatran",
  "Enoxaparin", "Heparin", "Fondaparinux", "Furosemide", "Torsemide", "Spironolactone",
  "Eplerenone", "Hydrochlorothiazide", "Chlorthalidone", "Indapamide", "Amiloride",
  "Clonidine", "Moxonidine", "Prazosin", "Terazosin", "Doxazosin", "Nitroglycerin",
  "Isosorbide", "Digoxin", "Amiodarone", "Diltiazem", "Verapamil", "Flecainide",
  "Ivabradine", "Ranolazine", "Trimetazidine",
  // Endocrine / diabetes / thyroid
  "Metformin", "Glimepiride", "Gliclazide", "Glibenclamide", "Glipizide", "Sitagliptin",
  "Vildagliptin", "Linagliptin", "Saxagliptin", "Teneligliptin", "Anagliptin",
  "Dapagliflozin", "Empagliflozin", "Canagliflozin", "Pioglitazone", "Acarbose",
  "Voglibose", "Miglitol", "Repaglinide", "Nateglinide", "Insulin", "Semaglutide",
  "Liraglutide", "Dulaglutide", "Exenatide", "Levothyroxine", "Liothyronine",
  "Carbimazole", "Methimazole", "Propylthiouracil",
  // Gastrointestinal
  "Pantoprazole", "Omeprazole", "Rabeprazole", "Esomeprazole", "Lansoprazole",
  "Dexlansoprazole", "Vonoprazan", "Ranitidine", "Famotidine", "Nizatidine",
  "Sucralfate", "Misoprostol", "Domperidone", "Metoclopramide", "Ondansetron",
  "Granisetron", "Palonosetron", "Mosapride", "Itopride", "Drotaverine", "Mebeverine",
  "Dicyclomine", "Drotaverine", "Loperamide", "Bisacodyl", "Docusate", "Lactulose",
  "Mesalamine", "Ursodeoxycholic", "Rifaximin", "Silymarin", "Cholestyramine",
  // Respiratory / allergy
  "Montelukast", "Cetirizine", "Levocetirizine", "Fexofenadine", "Loratadine",
  "Desloratadine", "Hydroxyzine", "Chlorpheniramine", "Bilastine", "Salbutamol",
  "Levosalbutamol", "Formoterol", "Salmeterol", "Budesonide", "Fluticasone",
  "Ciclesonide", "Theophylline", "Doxofylline", "Ambroxol", "Bromhexine", "Terbutaline",
  "Ipratropium", "Tiotropium", "Zafirlukast", "Omalizumab",
  // Steroids
  "Prednisolone", "Prednisone", "Dexamethasone", "Deflazacort", "Methylprednisolone",
  "Hydrocortisone", "Betamethasone", "Triamcinolone", "Mometasone",
  // Neuro / psychiatric
  "Gabapentin", "Pregabalin", "Amitriptyline", "Nortriptyline", "Duloxetine",
  "Sertraline", "Escitalopram", "Citalopram", "Fluoxetine", "Paroxetine", "Fluvoxamine",
  "Venlafaxine", "Desvenlafaxine", "Mirtazapine", "Bupropion", "Alprazolam",
  "Clonazepam", "Lorazepam", "Diazepam", "Chlordiazepoxide", "Zolpidem", "Etizolam",
  "Buspirone", "Quetiapine", "Olanzapine", "Risperidone", "Paliperidone", "Aripiprazole",
  "Haloperidol", "Trifluoperazine", "Lithium", "Valproate", "Divalproex", "Levetiracetam",
  "Carbamazepine", "Oxcarbazepine", "Phenytoin", "Fosphenytoin", "Lamotrigine",
  "Topiramate", "Lacosamide", "Zonisamide", "Clobazam", "Perampanel", "Sumatriptan",
  "Rizatriptan", "Zolmitriptan", "Flunarizine", "Prochlorperazine", "Baclofen",
  "Tizanidine", "Thiocolchicoside", "Chlorzoxazone", "Memantine", "Rivastigmine",
  "Donepezil", "Levodopa", "Pramipexole", "Ropinirole", "Trihexyphenidyl",
  // Urology / nephrology
  "Tamsulosin", "Silodosin", "Alfuzosin", "Finasteride", "Dutasteride", "Sildenafil",
  "Tadalafil", "Vardenafil", "Solifenacin", "Oxybutynin", "Mirabegron", "Fesoterodine",
  "Sevelamer", "Calcitriol", "Cinacalcet", "Erythropoietin",
  // Anticoagulant-adjacent / hematology / rheumatology / oncology
  "Methotrexate", "Leflunomide", "Sulfasalazine", "Hydroxychloroquine", "Azathioprine",
  "Mycophenolate", "Tacrolimus", "Cyclosporine", "Hydroxyurea", "Imatinib",
  "Lenalidomide", "Eltrombopag", "Deferasirox", "Deferiprone", "Allopurinol",
  "Febuxostat", "Colchicine", "Probenecid", "Rasburicase",
  // Vitamins / supplements / minerals
  "Calcium", "Zinc", "Ferrous", "Folic", "Folate", "Cyanocobalamin", "Methylcobalamin",
  "Thiamine", "Pyridoxine", "Riboflavin", "Niacinamide", "Ascorbic", "Cholecalciferol",
  "Ergocalciferol", "Biotin", "Selenium", "Chromium", "Coenzyme", "Lycopene",
  "Glucosamine", "Chondroitin", "Collagen", "Elemental",
  // Gynecology / misc
  "Clomiphene", "Letrozole", "Anastrozole", "Tamoxifen", "Norethisterone",
  "Medroxyprogesterone", "Estradiol", "Conjugated", "Tranexamic", "Etilefrine",
  "Isometheptene", "Caffeine", "Orlistat", "Sibutramine", "Disulfiram", "Naltrexone",
  "Buprenorphine", "Methadone", "Nicotine",
];

const drugTrie = new LexiconTrie();
const drugLexicon = new Set();
for (const drug of DRUG_LEXICON) {
  if (!drugLexicon.has(drug.toLowerCase())) {
    drugLexicon.add(drug.toLowerCase());
    drugTrie.insert(drug);
  }
}

/**
 * Corrects common medication spelling mistakes in extracted (legacy-shaped)
 * medication rows. Only corrects word tokens of length >= 5 that are absent
 * from the lexicon; never touches dose/unit tokens. One correction per
 * medication keeps clinical meaning intact, and the original spelling is
 * preserved in `warning` for the clinician.
 */
function correctMedicationNames(medications = []) {
  if (!Array.isArray(medications) || medications.length === 0 || DRUG_FUZZY_MAX_DISTANCE <= 0) return medications;
  for (const med of medications) {
    if (!med || typeof med.name !== "string" || !med.name.trim()) continue;
    const tokens = med.name.split(/[^A-Za-z]+/).filter((token) => token.length >= 5);
    for (const token of tokens) {
      if (drugLexicon.has(token.toLowerCase())) continue; // exact lexicon word
      const match = drugTrie.fuzzySearch(token, DRUG_FUZZY_MAX_DISTANCE);
      if (!match) continue;
      med.name = med.name.replace(token, match.word);
      const note = `Spelling auto-corrected from "${token}" to "${match.word}" (edit distance ${match.distance}).`;
      med.warning = med.warning ? `${med.warning} ${note}` : note;
      pipelineMetrics.fuzzyCorrections += 1;
      break; // one correction per medication
    }
  }
  return medications;
}

// ============================================================================
// 4. MEMOIZED CLINICAL ANALYZER + EXTRACTION RESULT CACHE
// ============================================================================
const analyzerCache = new LRUCache(128);
const extractionCache = new LRUCache(64);

function hashKey(parts) {
  return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

function cachedAnalyzeDocumentPayload(medications = [], labResults = [], allergies = "") {
  const key = hashKey([
    "analyzer-v1",
    JSON.stringify(medications || []),
    JSON.stringify(labResults || []),
    String(allergies || "").toLowerCase(),
  ]);
  const hit = analyzerCache.get(key);
  if (hit) {
    pipelineMetrics.analyzerCacheHits += 1;
    return hit;
  }
  const result = analyzeDocumentPayload(medications, labResults, allergies);
  analyzerCache.set(key, result);
  return result;
}

function buildExtractionCacheKey({ fileIdentity, documentType, allergies }) {
  return hashKey([
    EXTRACTION_PROMPT_VERSION,
    String(fileIdentity || ""),
    String(documentType || ""),
    String(allergies || "").toLowerCase(),
    ACTIVE_PROVIDER_HINT(),
  ]);
}

function ACTIVE_PROVIDER_HINT() {
  return [
    process.env.OPENROUTER_MODEL || process.env.GEMINI_MODEL || "",
    process.env.AI_PROVIDER || "",
  ].join("::");
}

function getCachedExtraction(key) {
  if (!EXTRACT_CACHE_TTL_MS || !key) return null;
  const hit = extractionCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) return null; // lazy TTL eviction
  pipelineMetrics.extractionCacheHits += 1;
  return structuredClone(hit.value);
}

function cacheExtraction(key, value) {
  if (!EXTRACT_CACHE_TTL_MS || !key || !value) return;
  extractionCache.set(key, { value: structuredClone(value), expiresAt: Date.now() + EXTRACT_CACHE_TTL_MS });
}

// ============================================================================
// 5. PIPELINE METRICS (observability for /api/pipeline-status)
// ============================================================================
const pipelineMetrics = {
  startedAt: Date.now(),
  aiCalls: 0,
  extractionCacheHits: 0,
  coalescedRequests: 0,
  fileCacheHits: 0,
  bytesReadSaved: 0,
  fuzzyCorrections: 0,
  analyzerCacheHits: 0,
  lastAiDurationMs: 0,
  totalAiDurationMs: 0,
};

function recordAiCall(durationMs) {
  pipelineMetrics.aiCalls += 1;
  pipelineMetrics.lastAiDurationMs = durationMs;
  pipelineMetrics.totalAiDurationMs += durationMs;
}

function getPipelineMetrics() {
  const m = pipelineMetrics;
  return {
    ...m,
    averageAiDurationMs: m.aiCalls ? Math.round(m.totalAiDurationMs / m.aiCalls) : 0,
    drugLexiconSize: drugTrie.size,
    extractionCacheTtlMs: EXTRACT_CACHE_TTL_MS,
    uptimeMs: Date.now() - m.startedAt,
  };
}

function resetPipelineMetrics() {
  pipelineMetrics.startedAt = Date.now();
  pipelineMetrics.aiCalls = 0;
  pipelineMetrics.extractionCacheHits = 0;
  pipelineMetrics.coalescedRequests = 0;
  pipelineMetrics.fileCacheHits = 0;
  pipelineMetrics.bytesReadSaved = 0;
  pipelineMetrics.fuzzyCorrections = 0;
  pipelineMetrics.analyzerCacheHits = 0;
  pipelineMetrics.lastAiDurationMs = 0;
  pipelineMetrics.totalAiDurationMs = 0;
}

module.exports = {
  getCachedFileBuffer,
  coalesceByKey,
  correctMedicationNames,
  cachedAnalyzeDocumentPayload,
  buildExtractionCacheKey,
  getCachedExtraction,
  cacheExtraction,
  recordAiCall,
  getPipelineMetrics,
  resetPipelineMetrics,
  drugTrie,
  LexiconTrie,
};
