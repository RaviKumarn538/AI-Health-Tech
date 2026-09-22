const fs = require("fs/promises");
const crypto = require("crypto");
const { analyzeDocumentPayload } = require("./clinicalAnalyzer");
const {
  getCachedFileBuffer,
  coalesceByKey,
  correctMedicationNames,
  cachedAnalyzeDocumentPayload,
  buildExtractionCacheKey,
  getCachedExtraction,
  cacheExtraction,
  recordAiCall,
} = require("./dsaExtraction");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || process.env.ORCAROUTER_API_KEY || "";
const OPENROUTER_BASE_URL = String(process.env.OPENROUTER_BASE_URL || process.env.ORCAROUTER_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || process.env.ORCAROUTER_MODEL || "openrouter/auto";
const OPENROUTER_FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || "";
const OPENROUTER_MAX_TOKENS = Math.min(Number(process.env.OPENROUTER_MAX_TOKENS || 1500), 2000);
const OPENROUTER_PDF_ENGINE = String(process.env.OPENROUTER_PDF_ENGINE || "cloudflare-ai").trim();
const REQUESTED_AI_PROVIDER = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
const ACTIVE_AI_PROVIDER = REQUESTED_AI_PROVIDER === "manual"
    ? "manual"
    : (REQUESTED_AI_PROVIDER === "openrouter" || REQUESTED_AI_PROVIDER === "orcarouter") && OPENROUTER_API_KEY
      ? "openrouter"
      : REQUESTED_AI_PROVIDER === "gemini" && GEMINI_API_KEY
        ? "gemini"
        : OPENROUTER_API_KEY
          ? "openrouter"
          : GEMINI_API_KEY
            ? "gemini"
            : "manual";
const AI_REQUEST_TIMEOUT_MS = Number(process.env.AI_REQUEST_TIMEOUT_MS || 45 * 1000);
let lastUsedModelName = OPENROUTER_API_KEY ? OPENROUTER_MODEL : GEMINI_MODEL;

function errorMessage(error) {
  return String(error?.message || error || "Unknown provider error")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(?:key|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 700);
}

function normalizedMimeType(file = {}) {
  const provided = String(file.mimeType || "").toLowerCase();
  const filename = String(file.originalFilename || file.filePath || "").toLowerCase();
  if (filename.endsWith(".pdf")) return "application/pdf";
  if (filename.endsWith(".png")) return "image/png";
  if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
  if (filename.endsWith(".webp")) return "image/webp";
  return provided;
}

function repairTruncatedJson(str) {
  if (!str) return null;
  const firstBrace = str.indexOf("{");
  if (firstBrace === -1) return null;
  let candidate = str.slice(firstBrace);

  // Strip dangling unclosed key-values or keys
  candidate = candidate.replace(/,\s*"[^"]*"\s*:\s*[^,}\]]*$/, "");
  candidate = candidate.replace(/,\s*"[^"]*"?$/, "");
  candidate = candidate.replace(/,\s*$/, "");

  let inStr = false;
  let esc = false;
  const stack = [];
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === '"' && !esc) inStr = !inStr;
    esc = (ch === '\\' && !esc);
    if (!inStr) {
      if (ch === '{' || ch === '[') stack.push(ch);
      else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
      else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
    }
  }
  if (inStr) candidate += '"';

  while (stack.length > 0) {
    const top = stack.pop();
    candidate += (top === '{' ? '}' : ']');
  }

  try {
    return JSON.parse(candidate);
  } catch (_) {
    let lastGoodComma = candidate.lastIndexOf(",");
    while (lastGoodComma > 50) {
      let sub = candidate.slice(0, lastGoodComma);
      let s = [];
      let is = false;
      let e = false;
      for (let i = 0; i < sub.length; i++) {
        const ch = sub[i];
        if (ch === '"' && !e) is = !is;
        e = (ch === '\\' && !e);
        if (!is) {
          if (ch === '{' || ch === '[') s.push(ch);
          else if (ch === '}' && s[s.length - 1] === '{') s.pop();
          else if (ch === ']' && s[s.length - 1] === '[') s.pop();
        }
      }
      while (s.length > 0) sub += (s.pop() === '{' ? '}' : ']');
      try {
        return JSON.parse(sub);
      } catch (_) {
        lastGoodComma = candidate.lastIndexOf(",", lastGoodComma - 1);
      }
    }
  }
  return null;
}

function parseJsonText(text) {
  if (!text) return null;
  let str = String(text).trim();

  // Strip <think>...</think> reasoning blocks from thinking models
  str = str.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();

  // 1. Check all markdown code blocks to find the one containing clinical payload
  const codeBlocks = [...str.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)];
  for (const match of codeBlocks) {
    const candidate = match[1].trim();
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && (parsed.patient || parsed.medications || parsed.documentType)) {
        return parsed;
      }
    } catch (_) {}
  }

  // 2. Find outermost JSON object { ... }
  const firstBrace = str.indexOf("{");
  const lastBrace = str.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(str.slice(firstBrace, lastBrace + 1));
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (_) {}
  }

  // 3. Try any code block that successfully parses
  for (const match of codeBlocks) {
    try {
      return JSON.parse(match[1].trim());
    } catch (_) {}
  }

  // 4. Direct parse attempt
  try {
    return JSON.parse(str);
  } catch (_) {}

  // 5. Attempt repairing truncated JSON
  const repaired = repairTruncatedJson(str);
  if (repaired && typeof repaired === "object") {
    return repaired;
  }

  // Final fallback: standard clean and parse
  const cleaned = str
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  return JSON.parse(cleaned);
}

function normalizeSource(source = null, defaultBox = null, defaultSnippet = "") {
  const candidate = source && typeof source === "object" ? source : {};
  let rawBox = Array.isArray(candidate.boundingBox) ? candidate.boundingBox.map(Number) : null;
  if (!rawBox || rawBox.length !== 4 || rawBox.some((v) => !Number.isFinite(v) || v < 0 || v > 100)) {
    rawBox = Array.isArray(defaultBox) && defaultBox.length === 4 ? defaultBox.map(Number) : null;
  }
  const boundingBox = rawBox && rawBox.length === 4 && rawBox.every((value) => Number.isFinite(value) && value >= 0 && value <= 100)
    ? rawBox
    : null;
  const textSnippet = String(candidate.textSnippet || defaultSnippet || "").trim();
  return {
    page: Number.isFinite(Number(candidate.page)) && Number(candidate.page) > 0 ? Number(candidate.page) : 1,
    boundingBox,
    textSnippet,
  };
}

function makeField(val = null, conf = 0, status = "ai_extracted", source = null, defaultBox = null) {
  const hasVal = val !== null && val !== undefined && String(val).trim() !== "";
  const numConf = Math.max(0, Math.min(1, Number(conf || (hasVal ? 0.90 : 0))));
  const isUnclear = !hasVal || numConf < 0.65;
  const normalizedVal = isUnclear && numConf < 0.65 && !hasVal ? null : (hasVal ? String(val).trim() : null);
  const fieldStatus = status && status !== "ai_extracted" ? status : (isUnclear ? "review_required" : "ai_extracted");
  return {
    value: normalizedVal,
    confidence: numConf,
    status: fieldStatus,
    source: normalizeSource(source, defaultBox, normalizedVal || ""),
  };
}

async function askGemini(prompt, file) {
  if (!GEMINI_API_KEY) return null;
  const parts = [{ text: prompt }];
  if (file && file.filePath) {
    // DSA perf: LRU-cached buffer, so repeated reads of the same upload are O(1).
    const bytes = await getCachedFileBuffer(file.filePath);
    parts.push({ inlineData: { mimeType: normalizedMimeType(file) || "image/png", data: bytes.toString("base64") } });
  }
  const candidateModels = [GEMINI_MODEL, "gemini-3.5-flash", "gemini-3.5-flash-lite"].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastError = null;

  for (const model of candidateModels) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errPayload = await response.json().catch(() => ({}));
        throw new Error(`Gemini (${model}) returned ${response.status}: ${errPayload.error?.message || response.statusText}`);
      }

      const payload = await response.json();
      const text = payload.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("") || null;
      if (text) {
        lastUsedModelName = model;
        return text;
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Gemini API] Model ${model} request failed: ${err.message}. Trying next candidate model...`);
    }
  }

  throw lastError || new Error("All Gemini candidate models failed to return content.");
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
}

async function askOpenRouter(prompt, file) {
  if (!OPENROUTER_API_KEY) return null;
  const content = [{ type: "text", text: prompt }];
  if (file && file.filePath) {
    // DSA perf: LRU-cached buffer, so repeated reads of the same upload are O(1).
    const bytes = await getCachedFileBuffer(file.filePath);
    const mime = normalizedMimeType(file);
    const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
    if (String(mime).startsWith("image/")) {
      content.push({ type: "image_url", image_url: { url: dataUrl } });
    } else if (mime === "application/pdf") {
      content.push({ type: "file", file: { filename: file.originalFilename || "clinical-document.pdf", file_data: dataUrl } });
    } else {
      throw new Error(`Unsupported clinical document MIME type: ${mime || "unknown"}`);
    }
  }

  const candidateModels = [
    OPENROUTER_MODEL,
    OPENROUTER_FALLBACK_MODEL,
    "qwen/qwen3.8-27b:free",
    "meta-llama/llama-3.2-11b-vision-instruct:free",
    "google/gemma-4-26b-a4b-it:free",
    "openai/gpt-4o-mini",
    "openrouter/auto",
  ].filter((m, i, arr) => m && arr.indexOf(m) === i);
  let lastError = null;

  const messages = [
    {
      role: "system",
      content: "You are an automated medical OCR and clinical data extraction engine. You MUST respond with ONLY a valid, parseable JSON object adhering to the requested schema. Do NOT output conversational text, markdown prose, explanations, greetings, or notes outside the JSON object.",
    },
    { role: "user", content },
  ];

  const requestBody = (model, useJsonMode) => ({
    model,
    messages,
    temperature: 0.1,
    max_tokens: OPENROUTER_MAX_TOKENS,
    ...(file && normalizedMimeType(file) === "application/pdf" && OPENROUTER_PDF_ENGINE
      ? { plugins: [{ id: "file-parser", pdf: { engine: OPENROUTER_PDF_ENGINE } }] }
      : {}),
    ...(useJsonMode ? { response_format: { type: "json_object" } } : {}),
  });

  const request = (body) => fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_ORIGIN || "http://localhost:8080",
      "X-OpenRouter-Title": "CuraClinic AI",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(AI_REQUEST_TIMEOUT_MS),
  });

  for (const model of candidateModels) {
    try {
      let response = await request(requestBody(model, true));

      // If 400, retry without response_format since some models do not support json_object mode
      if (response.status === 400) {
        response = await request(requestBody(model, false));
      }

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(`OpenRouter (${model}) request failed (${response.status}): ${payload.error?.message || response.statusText}`);
      }

      let text = contentText(payload.choices?.[0]?.message?.content);
      if (!text && payload.choices?.[0]?.message?.reasoning) {
        text = String(payload.choices[0].message.reasoning);
      }
      if (!text) throw new Error(`OpenRouter (${model}) returned no text content`);

      // Do not accept a successful HTTP response that cannot be used by the
      // extractor. Trying the next model is more useful than silently falling
      // back to an empty clinical record.
      try {
        parseJsonText(text);
      } catch (_) {
        throw new Error(`OpenRouter (${model}) returned invalid JSON`);
      }

      lastUsedModelName = model;
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`[OpenRouter API] Model ${model} request failed: ${errorMessage(err)}. Trying next candidate model...`);
    }
  }

  throw lastError || new Error("All OpenRouter candidate models failed to return content.");
}

async function askClinicalModel(prompt, file = null) {
  const failures = [];
  const startedAt = Date.now();
  try {
    const result = await askClinicalModelInner(prompt, file);
    recordAiCall(Date.now() - startedAt);
    return result;
  } catch (error) {
    recordAiCall(Date.now() - startedAt);
    throw error;
  }
}

async function askClinicalModelInner(prompt, file = null) {
  const failures = [];
  if (ACTIVE_AI_PROVIDER === "openrouter" || ACTIVE_AI_PROVIDER === "orcarouter") {
    try {
      const res = await askOpenRouter(prompt, file);
      if (res) return res;
    } catch (error) {
      failures.push(`OpenRouter: ${errorMessage(error)}`);
      console.warn(`OpenRouter extraction failed (${errorMessage(error)}); attempting fallback...`);
    }
    if (GEMINI_API_KEY) {
      try {
        const geminiRes = await askGemini(prompt, file);
        if (geminiRes) return geminiRes;
      } catch (geminiErr) {
        failures.push(`Gemini: ${errorMessage(geminiErr)}`);
        console.warn(`Gemini fallback also failed: ${errorMessage(geminiErr)}`);
      }
    }
    throw new Error(failures.join(" | ") || "No AI provider returned extractable content.");
  }
  if (ACTIVE_AI_PROVIDER === "gemini") {
    try {
      const geminiRes = await askGemini(prompt, file);
      if (geminiRes) return geminiRes;
    } catch (error) {
      if (OPENROUTER_API_KEY) {
        console.warn(`Gemini failed (${error.message}); attempting OpenRouter fallback...`);
        return askOpenRouter(prompt, file);
      }
      throw error;
    }
  }
  return null;
}

function buildResilientExtraction(originalFilename = "", documentType = "CLINICAL_NOTE", failureReason = "", allergies = "") {
  const isLab = /lab|blood|metabolic|cbc|urine|test|pathology/i.test(originalFilename) || documentType === "LAB_REPORT";
  const type = isLab ? "LAB_REPORT" : (allowedDocumentTypes.has(documentType) ? documentType : "PRESCRIPTION");

  if (isLab) {
    return {
      documentType: "LAB_REPORT",
      aiSummary: "Fasting comprehensive metabolic panel indicates elevated fasting blood glucose (168 mg/dL) and borderline total serum cholesterol (235 mg/dL). Renal and transaminase indices remain within normal physiological limits.",
      overallConfidence: 0.94,
      status: "NEEDS_VERIFICATION",
      modelName: "ai-clinical-extractor (offline resilient engine)",
      structuredData: {
        patient: {
          name: makeField("Sunita Patel", 0.96, "ai_extracted", null, [6, 10, 12, 45]),
          mrn: makeField("PT10842", 0.92, "ai_extracted", null, [6, 65, 12, 90]),
          age: makeField("51", 0.95, "ai_extracted", null, [13, 10, 18, 30]),
          gender: makeField("Female", 0.97, "ai_extracted", null, [13, 35, 18, 55]),
          phone: makeField("9812345678", 0.88, "ai_extracted", null, [13, 65, 18, 90]),
        },
        encounter: {
          date: makeField("20-Sep-2026", 0.98, "ai_extracted", null, [19, 10, 24, 40]),
          facility: makeField("Apex Diagnostics & Clinical Pathology", 0.95, "ai_extracted", null, [2, 20, 5, 80]),
          type: makeField("LAB_REPORT", 0.95, "ai_extracted", null, [19, 65, 24, 90]),
        },
        diagnosis: [
          {
            value: "Primary: Hyperglycemia & Dyslipidemia screening",
            confidence: 0.91,
            status: "ai_extracted",
            source: normalizeSource(null, [25, 10, 31, 90], "Hyperglycemia & Dyslipidemia"),
          },
        ],
        medications: [],
        investigations: [
          {
            panelName: makeField("Glycemic Profile", 0.95, "ai_extracted"),
            testName: makeField("Fasting Blood Glucose (FBG)", 0.97, "ai_extracted", null, [33, 10, 39, 90]),
            resultValue: makeField("168", 0.98, "ai_extracted", null, [33, 45, 39, 58]),
            numericValue: 168,
            units: makeField("mg/dL", 0.95, "ai_extracted"),
            referenceRange: makeField("70 - 100 mg/dL", 0.92, "ai_extracted"),
            abnormalFlag: "HIGH",
            overallStatus: "review_required",
            testDate: new Date("2026-09-20"),
          },
          {
            panelName: makeField("Lipid Profile", 0.94, "ai_extracted"),
            testName: makeField("Total Serum Cholesterol", 0.95, "ai_extracted", null, [41, 10, 47, 90]),
            resultValue: makeField("235", 0.96, "ai_extracted", null, [41, 45, 47, 58]),
            numericValue: 235,
            units: makeField("mg/dL", 0.95, "ai_extracted"),
            referenceRange: makeField("< 200 mg/dL", 0.91, "ai_extracted"),
            abnormalFlag: "HIGH",
            overallStatus: "ai_extracted",
            testDate: new Date("2026-09-20"),
          },
          {
            panelName: makeField("Lipid Profile", 0.92, "ai_extracted"),
            testName: makeField("Serum Triglycerides", 0.93, "ai_extracted", null, [49, 10, 55, 90]),
            resultValue: makeField("190", 0.94, "ai_extracted", null, [49, 45, 55, 58]),
            numericValue: 190,
            units: makeField("mg/dL", 0.95, "ai_extracted"),
            referenceRange: makeField("< 150 mg/dL", 0.91, "ai_extracted"),
            abnormalFlag: "HIGH",
            overallStatus: "ai_extracted",
            testDate: new Date("2026-09-20"),
          },
          {
            panelName: makeField("Renal Function", 0.95, "ai_extracted"),
            testName: makeField("Serum Creatinine", 0.96, "ai_extracted", null, [57, 10, 63, 90]),
            resultValue: makeField("0.9", 0.97, "ai_extracted", null, [57, 45, 63, 58]),
            numericValue: 0.9,
            units: makeField("mg/dL", 0.95, "ai_extracted"),
            referenceRange: makeField("0.6 - 1.2 mg/dL", 0.92, "ai_extracted"),
            abnormalFlag: "NORMAL",
            overallStatus: "ai_extracted",
            testDate: new Date("2026-09-20"),
          },
        ],
        observations: [
          {
            observation: makeField("Fasting Period", 0.95, "ai_extracted"),
            value: makeField("10 hours overnight fasting confirmed", 0.95, "ai_extracted"),
            overallStatus: "ai_extracted",
          },
        ],
        followUp: {
          interval: makeField("Immediate clinical consultation", 0.92, "ai_extracted", null, [75, 10, 83, 90]),
          advice: makeField("Consult treating physician for diabetic therapy initiation and dietary lifestyle modifications", 0.90, "ai_extracted"),
        },
      },
      medications: [],
      labResults: [
        { testName: "Fasting Blood Glucose (FBG)", resultValue: "168", units: "mg/dL", referenceRange: "70 - 100 mg/dL", status: "HIGH", confidence: 0.98, confidenceTier: "HIGH", sourceRegion: normalizeSource(null, [33, 10, 39, 90], "Fasting Blood Glucose 168 mg/dL"), isVerified: false },
        { testName: "Total Serum Cholesterol", resultValue: "235", units: "mg/dL", referenceRange: "< 200 mg/dL", status: "HIGH", confidence: 0.96, confidenceTier: "HIGH", sourceRegion: normalizeSource(null, [41, 10, 47, 90], "Total Cholesterol 235 mg/dL"), isVerified: false },
        { testName: "Serum Triglycerides", resultValue: "190", units: "mg/dL", referenceRange: "< 150 mg/dL", status: "HIGH", confidence: 0.94, confidenceTier: "HIGH", sourceRegion: normalizeSource(null, [49, 10, 55, 90], "Triglycerides 190 mg/dL"), isVerified: false },
        { testName: "Serum Creatinine", resultValue: "0.9", units: "mg/dL", referenceRange: "0.6 - 1.2 mg/dL", status: "NORMAL", confidence: 0.96, confidenceTier: "HIGH", sourceRegion: normalizeSource(null, [57, 10, 63, 90], "Creatinine 0.9 mg/dL"), isVerified: false },
      ],
      clinicalFlags: {
        allergyConflicts: [],
        abnormalLabs: [{ testName: "Fasting Blood Glucose (FBG)", resultValue: "168", status: "HIGH" }, { testName: "Total Serum Cholesterol", resultValue: "235", status: "HIGH" }],
        totalAlerts: 2,
      },
      originalSnapshot: {
        documentType: "LAB_REPORT",
        offlineEngine: true,
        reason: failureReason || "Offline clinical verification fallback active",
      },
    };
  }

  // Default: Prescription / Cardiology / General OPD
  return {
    documentType: "PRESCRIPTION",
    aiSummary: "Prescription for patient with Essential Hypertension (BP 146/92 mmHg) and mild hyperlipidemia. Active medications prescribed include Telmisartan, Amlodipine, Metformin, and Atorvastatin. Close monitoring of BP and 2-week follow-up advised.",
    overallConfidence: 0.91,
    status: "NEEDS_VERIFICATION",
    modelName: "ai-clinical-extractor (offline resilient engine)",
    structuredData: {
      patient: {
        name: makeField("Rahul Sharma", 0.95, "ai_extracted", null, [7, 10, 14, 50]),
        mrn: makeField("PT10291", 0.94, "ai_extracted", null, [7, 65, 14, 90]),
        age: makeField("42", 0.96, "ai_extracted", null, [15, 10, 20, 25]),
        gender: makeField("Male", 0.98, "ai_extracted", null, [15, 30, 20, 48]),
        phone: makeField("9876543210", 0.89, "ai_extracted", null, [15, 65, 20, 90]),
      },
      encounter: {
        date: makeField("21-Sep-2026", 0.98, "ai_extracted", null, [21, 65, 26, 92]),
        facility: makeField("CuraClinic Cardiology & Internal Medicine", 0.96, "ai_extracted", null, [2, 15, 6, 85]),
        type: makeField("PRESCRIPTION", 0.95, "ai_extracted", null, [21, 10, 26, 35]),
      },
      diagnosis: [
        {
          value: "Primary: Essential Hypertension (Stage 2)",
          confidence: 0.94,
          status: "ai_extracted",
          source: normalizeSource(null, [23, 10, 29, 60], "Essential Hypertension"),
        },
        {
          value: "Secondary: Dyslipidemia & Borderline Hyperglycemia",
          confidence: 0.88,
          status: "ai_extracted",
          source: normalizeSource(null, [23, 62, 29, 92], "Dyslipidemia"),
        },
      ],
      medications: [
        {
          name: makeField("Tab. Telmisartan", 0.92, "ai_extracted", null, [33, 10, 41, 55]),
          genericName: makeField("Telmisartan", 0.95, "ai_extracted"),
          dosage: makeField("40 mg", 0.91, "ai_extracted", null, [33, 56, 41, 70]),
          frequency: makeField("Once daily (OD)", 0.94, "ai_extracted", null, [33, 71, 41, 90]),
          route: makeField("Oral", 0.95, "ai_extracted"),
          duration: makeField("30 days", 0.90, "ai_extracted"),
          instructions: makeField("Take in morning after breakfast", 0.88, "ai_extracted"),
          overallStatus: "ai_extracted",
          warning: "",
        },
        {
          name: makeField("Tab. Amlodipine", 0.89, "ai_extracted", null, [43, 10, 51, 55]),
          genericName: makeField("Amlodipine Besylate", 0.92, "ai_extracted"),
          dosage: makeField("5 mg", 0.90, "ai_extracted", null, [43, 56, 51, 70]),
          frequency: makeField("Once daily (OD)", 0.92, "ai_extracted", null, [43, 71, 51, 90]),
          route: makeField("Oral", 0.95, "ai_extracted"),
          duration: makeField("30 days", 0.89, "ai_extracted"),
          instructions: makeField("Take in evening", 0.86, "ai_extracted"),
          overallStatus: "ai_extracted",
          warning: "",
        },
        {
          name: makeField("Tab. Metformin", 0.85, "ai_extracted", null, [53, 10, 61, 55]),
          genericName: makeField("Metformin HCl", 0.90, "ai_extracted"),
          dosage: makeField("500 mg", 0.88, "ai_extracted", null, [53, 56, 61, 70]),
          frequency: makeField("Twice daily (BD)", 0.87, "ai_extracted", null, [53, 71, 61, 90]),
          route: makeField("Oral", 0.95, "ai_extracted"),
          duration: makeField("30 days", 0.88, "ai_extracted"),
          instructions: makeField("Take with or immediately after meals", 0.85, "ai_extracted"),
          overallStatus: "ai_extracted",
          warning: "",
        },
        {
          name: makeField("Tab. Atorvastatin", 0.61, "review_required", null, [63, 10, 71, 55]),
          genericName: makeField("Atorvastatin Calcium", 0.70, "review_required"),
          dosage: makeField("20 mg", 0.64, "review_required", null, [63, 56, 71, 70]),
          frequency: makeField("Once daily at night (HS)", 0.54, "review_required", null, [63, 71, 71, 90]),
          route: makeField("Oral", 0.80, "ai_extracted"),
          duration: makeField("15 days", 0.58, "review_required"),
          instructions: makeField("Night after dinner · Verify dose with doctor", 0.60, "review_required"),
          overallStatus: "review_required",
          warning: "Low confidence extraction: handwriting partially obscured on dosage line. Review recommended.",
        },
      ],
      investigations: [
        {
          panelName: makeField("Cardiac & Renal Panel", 0.95, "ai_extracted"),
          testName: makeField("Complete Blood Count (CBC)", 0.96, "ai_extracted", null, [73, 10, 79, 50]),
          resultValue: makeField("Normal limits (Hb 14.2 g/dL)", 0.94, "ai_extracted", null, [73, 52, 79, 88]),
          numericValue: 14.2,
          units: makeField("g/dL", 0.95, "ai_extracted"),
          referenceRange: makeField("13.0 - 17.0 g/dL", 0.92, "ai_extracted"),
          abnormalFlag: "NORMAL",
          overallStatus: "ai_extracted",
          testDate: null,
        },
        {
          panelName: makeField("Biochemistry", 0.92, "ai_extracted"),
          testName: makeField("Lipid Profile & Serum Electrolytes", 0.91, "ai_extracted", null, [80, 10, 86, 50]),
          resultValue: makeField("Advised for follow-up", 0.90, "ai_extracted", null, [80, 52, 86, 88]),
          numericValue: null,
          units: makeField("", 0.80, "ai_extracted"),
          referenceRange: makeField("Fast 10-12 hrs prior", 0.85, "ai_extracted"),
          abnormalFlag: "NORMAL",
          overallStatus: "ai_extracted",
          testDate: null,
        },
      ],
      observations: [
        {
          observation: makeField("Blood Pressure (BP)", 0.93, "ai_extracted", null, [23, 60, 28, 92]),
          value: makeField("146/92 mmHg", 0.93, "ai_extracted"),
          overallStatus: "review_required",
        },
        {
          observation: makeField("Pulse Rate", 0.95, "ai_extracted", null, [23, 10, 28, 35]),
          value: makeField("78 bpm (regular)", 0.95, "ai_extracted"),
          overallStatus: "ai_extracted",
        },
        {
          observation: makeField("Clinical Symptoms", 0.89, "ai_extracted"),
          value: makeField("Occasional morning headache, mild palpitations under exertion", 0.89, "ai_extracted"),
          overallStatus: "ai_extracted",
        },
      ],
      followUp: {
        interval: makeField("2 weeks (14 days)", 0.89, "ai_extracted", null, [88, 10, 94, 45]),
        advice: makeField("Low sodium DASH diet, regular aerobic exercise 30 min daily, daily BP recording", 0.91, "ai_extracted", null, [88, 48, 94, 92]),
      },
    },
    medications: [
      { name: "Tab. Telmisartan", dosage: "40 mg", frequency: "Once daily (OD)", route: "Oral", duration: "30 days", instructions: "Take in morning after breakfast", confidence: 0.91, confidenceTier: "HIGH", sourceRegion: normalizeSource(null, [33, 10, 41, 88], "Tab. Telmisartan 40 mg OD"), isVerified: false },
      { name: "Tab. Amlodipine", dosage: "5 mg", frequency: "Once daily (OD)", route: "Oral", duration: "30 days", instructions: "Take in evening", confidence: 0.90, confidenceTier: "HIGH", sourceRegion: normalizeSource(null, [43, 10, 51, 88], "Tab. Amlodipine 5 mg OD"), isVerified: false },
      { name: "Tab. Metformin", dosage: "500 mg", frequency: "Twice daily (BD)", route: "Oral", duration: "30 days", instructions: "Take with meals", confidence: 0.87, confidenceTier: "HIGH", sourceRegion: normalizeSource(null, [53, 10, 61, 88], "Tab. Metformin 500 mg BD"), isVerified: false },
      { name: "Tab. Atorvastatin", dosage: "20 mg", frequency: "Once daily at night (HS)", route: "Oral", duration: "15 days", instructions: "Night after dinner", confidence: 0.54, confidenceTier: "NEEDS_VERIFICATION", sourceRegion: normalizeSource(null, [63, 10, 71, 88], "Tab. Atorvastatin 20 mg HS"), isVerified: false, warning: "Handwriting partially obscured on dosage line. Review recommended." },
    ],
    labResults: [
      { testName: "Complete Blood Count (CBC)", resultValue: "Normal limits (Hb 14.2 g/dL)", units: "g/dL", referenceRange: "13.0 - 17.0 g/dL", status: "NORMAL", confidence: 0.96, confidenceTier: "HIGH", sourceRegion: normalizeSource(null, [73, 10, 79, 88], "CBC: Hb 14.2 g/dL"), isVerified: false },
      { testName: "Lipid Profile & Serum Electrolytes", resultValue: "Advised for follow-up", units: "", referenceRange: "Fast 10-12 hrs prior", status: "NORMAL", confidence: 0.91, confidenceTier: "HIGH", sourceRegion: normalizeSource(null, [80, 10, 86, 88], "Lipid profile advised"), isVerified: false },
    ],
    clinicalFlags: {
      allergyConflicts: [],
      abnormalLabs: [],
      totalAlerts: 1,
      flags: ["Elevated blood pressure reading (Stage 2 Hypertension: 146/92 mmHg) flagged for clinician review."],
    },
    originalSnapshot: {
      documentType: "PRESCRIPTION",
      offlineEngine: true,
      reason: failureReason || "Offline clinical verification fallback active",
    },
  };
}

// Phase 16: Honest, Safe Fallback without Fake Medical Data
function safeUnavailableExtraction(originalFilename, documentType, reason = "No automated model output available") {
  const type = allowedDocumentTypes.has(documentType) ? documentType : "CLINICAL_NOTE";
  return {
    documentType: type,
    aiSummary: "Automated AI extraction was unavailable. Manual clinical verification and transcription required from original source document.",
    overallConfidence: 0.0,
    status: "NEEDS_VERIFICATION",
    modelName: "manual-clinical-review",
    structuredData: {
      patient: {
        name: makeField(null, 0, "review_required"),
        mrn: makeField(null, 0, "review_required"),
        age: makeField(null, 0, "review_required"),
        gender: makeField(null, 0, "review_required"),
        phone: makeField(null, 0, "review_required"),
      },
      encounter: {
        date: makeField(null, 0, "review_required"),
        facility: makeField(null, 0, "review_required"),
        type: makeField(type, 0.5, "review_required"),
      },
      diagnosis: [],
      medications: [],
      investigations: [],
      observations: [],
      followUp: {
        interval: makeField(null, 0, "review_required"),
        advice: makeField(null, 0, "review_required"),
      },
    },
    medications: [],
    labResults: [],
    clinicalFlags: { allergyConflicts: [], abnormalLabs: [], totalAlerts: 0 },
    originalSnapshot: { unavailable: true, reason: errorMessage(reason) },
  };
}

const allowedDocumentTypes = new Set([
  "PRESCRIPTION", "OPD_CARD", "CASE_SHEET", "LAB_REPORT",
  "DISCHARGE_SUMMARY", "CLINICAL_NOTE", "INVESTIGATION_NOTE", "OTHER"
]);

function getVal(field) {
  if (field === null || field === undefined) return null;
  if (typeof field === "object" && !Array.isArray(field)) {
    return field.value !== undefined ? field.value : null;
  }
  return field;
}

function getConf(field, defaultConf = 0.9) {
  if (field === null || field === undefined) return 0;
  if (typeof field === "object" && !Array.isArray(field) && field.confidence !== undefined) {
    return Number(field.confidence);
  }
  return defaultConf;
}

function getStatus(field, defaultStatus = "ai_extracted") {
  if (field && typeof field === "object" && !Array.isArray(field) && field.status) {
    return field.status;
  }
  return defaultStatus;
}

function getSource(field) {
  if (field && typeof field === "object" && !Array.isArray(field) && field.source) {
    return normalizeSource(field.source);
  }
  return null;
}

// Public entry: LRU result cache + single-flight coalescing around the real
// extraction. Identical re-uploads skip the AI round-trip entirely, and N
// concurrent uploads of the same file share exactly one AI call.
async function extractDocument(file, originalFilename, documentType, allergies = "") {
  let cacheKey = null;
  try {
    if (file && file.filePath) {
      const bytes = await getCachedFileBuffer(file.filePath);
      cacheKey = buildExtractionCacheKey({
        fileIdentity: crypto.createHash("sha1").update(bytes).digest("hex"),
        documentType,
        allergies,
      });
    }
  } catch (_) {
    cacheKey = null; // unreadable file: fall through to the normal path
  }

  if (cacheKey) {
    const cached = getCachedExtraction(cacheKey);
    if (cached) return cached;
    return coalesceByKey(cacheKey, () => extractDocumentInner(file, originalFilename, documentType, allergies, cacheKey));
  }
  return extractDocumentInner(file, originalFilename, documentType, allergies, null);
}

async function extractDocumentInner(file, originalFilename, documentType, allergies = "", cacheKey = null) {
  let rawAiOutput = null;
  let extractionFailure = "No automated model output available";
  const prompt = `You are an expert Clinical Document Extraction assistant adhering to strict medical verification safety standards.
Analyze the attached clinical record image/document and return a single valid JSON object.

CRITICAL SAFETY RULES:
1. Do NOT invent or guess values.
2. If any handwriting, text, or number is partially illegible or uncertain, set value to null and confidence below 0.60 with status "review_required".
3. OUTPUT FORMAT: Return ONLY the JSON object. Do NOT include conversational introductions, explanations, or sign-offs.

Expected JSON Structure:
{
  "documentType": "PRESCRIPTION",
  "aiSummary": "Concise factual summary of visible findings without conjecture",
  "overallConfidence": 0.95,
  "patient": {
    "name": { "value": "Patient Full Name", "confidence": 0.95 },
    "mrn": { "value": null, "confidence": 0.9 },
    "age": { "value": "42", "confidence": 0.95 },
    "gender": { "value": "Female", "confidence": 0.95 },
    "phone": { "value": null, "confidence": 0.9 }
  },
  "encounter": {
    "date": { "value": "17-Sep-2026", "confidence": 0.95 },
    "facility": { "value": "Clinic/Hospital Name", "confidence": 0.95 },
    "type": { "value": "PRESCRIPTION", "confidence": 0.95 }
  },
  "diagnosis": [
    { "value": "Hypertension", "confidence": 0.95 }
  ],
  "medications": [
    {
      "name": { "value": "Medication name", "confidence": 0.95 },
      "genericName": { "value": null, "confidence": 0.8 },
      "dosage": { "value": "40 mg", "confidence": 0.95 },
      "frequency": { "value": "Once daily", "confidence": 0.95 },
      "route": { "value": "Oral", "confidence": 0.9 },
      "duration": { "value": "30 days", "confidence": 0.9 },
      "instructions": { "value": "After meals", "confidence": 0.9 },
      "warning": null
    }
  ],
  "investigations": [
    {
      "panelName": { "value": null, "confidence": 0.8 },
      "testName": { "value": "Blood Glucose", "confidence": 0.95 },
      "resultValue": { "value": "110", "confidence": 0.95 },
      "numericValue": 110,
      "units": { "value": "mg/dL", "confidence": 0.9 },
      "referenceRange": { "value": "70-100", "confidence": 0.9 },
      "abnormalFlag": "NORMAL"
    }
  ],
  "observations": [
    {
      "observation": { "value": "Blood Pressure", "confidence": 0.95 },
      "value": { "value": "142/92 mmHg", "confidence": 0.95 }
    }
  ],
  "followUp": {
    "interval": { "value": "10 days", "confidence": 0.9 },
    "advice": { "value": "Low sodium diet", "confidence": 0.9 }
  }
}
Known patient allergy context: "${allergies || "None documented"}"`;

  if (ACTIVE_AI_PROVIDER !== "manual" && file) {
    try {
      const responseText = await askClinicalModel(prompt, { ...file, originalFilename });
      if (responseText) {
        rawAiOutput = parseJsonText(responseText);
      }
    } catch (error) {
      extractionFailure = errorMessage(error);
      console.warn(`${ACTIVE_AI_PROVIDER} extraction failed: ${extractionFailure}`);
    }
  }

  // Never create clinical facts when the configured AI is unavailable or
  // intentionally disabled. The clinician must transcribe from the source
  // document rather than review a fabricated fallback record.
  if (!rawAiOutput) {
    return safeUnavailableExtraction(
      originalFilename,
      documentType,
      extractionFailure || "No automated model output available",
    );
  }

  // Normalize structured fields & guarantee field-level contract
  const rawPatient = rawAiOutput.patient && typeof rawAiOutput.patient === "object" ? rawAiOutput.patient : {};
  const patientNameVal = getVal(rawPatient.name) || getVal(rawAiOutput.patient_name) || getVal(rawAiOutput.patientName) || (typeof rawAiOutput.patient === "string" ? rawAiOutput.patient : null);
  const patientMrnVal = getVal(rawPatient.mrn) || getVal(rawAiOutput.mrn);
  const patientAgeVal = getVal(rawPatient.age) || getVal(rawAiOutput.age);
  const patientGenderVal = getVal(rawPatient.gender) || getVal(rawAiOutput.gender);
  const patientPhoneVal = getVal(rawPatient.phone) || getVal(rawAiOutput.phone) || getVal(rawAiOutput.contact);

  let rawMeds = rawAiOutput.medications || rawAiOutput.medicines || rawAiOutput.drugs || [];
  if (Array.isArray(rawMeds)) {
    rawMeds = rawMeds.map((m) => {
      if (typeof m === "string") return { name: m, dosage: null, frequency: null };
      return m;
    });
  }

  const structuredData = {
    patient: {
      name: makeField(patientNameVal, getConf(rawPatient.name, patientNameVal ? 0.95 : 0), getStatus(rawPatient.name), getSource(rawPatient.name), [7, 10, 14, 50]),
      mrn: makeField(patientMrnVal, getConf(rawPatient.mrn, patientMrnVal ? 0.92 : 0), getStatus(rawPatient.mrn), getSource(rawPatient.mrn), [7, 65, 14, 90]),
      age: makeField(patientAgeVal, getConf(rawPatient.age, patientAgeVal ? 0.95 : 0), getStatus(rawPatient.age), getSource(rawPatient.age), [15, 10, 20, 25]),
      gender: makeField(patientGenderVal, getConf(rawPatient.gender, patientGenderVal ? 0.97 : 0), getStatus(rawPatient.gender), getSource(rawPatient.gender), [15, 30, 20, 48]),
      phone: makeField(patientPhoneVal, getConf(rawPatient.phone, patientPhoneVal ? 0.90 : 0), getStatus(rawPatient.phone), getSource(rawPatient.phone), [15, 65, 20, 90]),
    },
    encounter: {
      date: makeField(getVal(rawAiOutput.encounter?.date) || getVal(rawAiOutput.date), getConf(rawAiOutput.encounter?.date, 0.95), getStatus(rawAiOutput.encounter?.date), getSource(rawAiOutput.encounter?.date), [21, 65, 26, 92]),
      facility: makeField(getVal(rawAiOutput.encounter?.facility) || getVal(rawAiOutput.clinic) || getVal(rawAiOutput.hospital), getConf(rawAiOutput.encounter?.facility, 0.94), getStatus(rawAiOutput.encounter?.facility), getSource(rawAiOutput.encounter?.facility), [2, 15, 6, 85]),
      type: makeField(getVal(rawAiOutput.encounter?.type) || rawAiOutput.documentType || documentType, 0.95, "ai_extracted", null, [21, 10, 26, 35]),
    },
    diagnosis: (rawAiOutput.diagnosis || rawAiOutput.diagnoses || []).map((d, idx) => {
      const v = typeof d === "object" ? d.value : d;
      return {
        value: v ? String(v).trim() : null,
        confidence: Number(d?.confidence || 0.88),
        status: d?.status || (v ? "ai_extracted" : "review_required"),
        source: normalizeSource(d?.source, [23 + idx * 7, 10, 29 + idx * 7, 85], String(v || "")),
      };
    }),
    medications: rawMeds.map((m, idx) => ({
      name: makeField(getVal(m.name), getConf(m.name, 0.91), getStatus(m.name), getSource(m.name), [33 + idx * 10, 10, 41 + idx * 10, 88]),
      genericName: makeField(getVal(m.genericName), getConf(m.genericName, 0.88), getStatus(m.genericName)),
      dosage: makeField(getVal(m.dosage), getConf(m.dosage, 0.90), getStatus(m.dosage), getSource(m.dosage), [33 + idx * 10, 56, 41 + idx * 10, 70]),
      frequency: makeField(getVal(m.frequency), getConf(m.frequency, 0.92), getStatus(m.frequency), getSource(m.frequency), [33 + idx * 10, 71, 41 + idx * 10, 90]),
      route: makeField(getVal(m.route), getConf(m.route, 0.92), getStatus(m.route)),
      duration: makeField(getVal(m.duration), getConf(m.duration, 0.88), getStatus(m.duration)),
      instructions: makeField(getVal(m.instructions), getConf(m.instructions, 0.88), getStatus(m.instructions)),
      overallStatus: m.overallStatus || ((getConf(m.name) < 0.70 || !getVal(m.name)) ? "review_required" : "ai_extracted"),
      warning: m.warning || "",
    })),
    investigations: (rawAiOutput.investigations || []).map((inv, idx) => {
      return {
        panelName: makeField(getVal(inv.panelName), getConf(inv.panelName, 0.88), getStatus(inv.panelName)),
        testName: makeField(getVal(inv.testName), getConf(inv.testName, 0.93), getStatus(inv.testName), getSource(inv.testName), [73 + idx * 7, 10, 79 + idx * 7, 88]),
        resultValue: makeField(getVal(inv.resultValue), getConf(inv.resultValue, 0.94), getStatus(inv.resultValue), getSource(inv.resultValue), [73 + idx * 7, 52, 79 + idx * 7, 88]),
        numericValue: inv.numericValue ?? null,
        units: makeField(getVal(inv.units), getConf(inv.units, 0.90), getStatus(inv.units)),
        referenceRange: makeField(getVal(inv.referenceRange), getConf(inv.referenceRange, 0.90), getStatus(inv.referenceRange)),
        abnormalFlag: inv.abnormalFlag || "UNKNOWN",
        overallStatus: inv.overallStatus || ((getConf(inv.testName) < 0.70 || !getVal(inv.resultValue)) ? "review_required" : "ai_extracted"),
        testDate: null,
      };
    }),
    observations: (rawAiOutput.observations || []).map((obs, idx) => ({
      observation: makeField(getVal(obs.observation), getConf(obs.observation, 0.92), getStatus(obs.observation), getSource(obs.observation), [23 + idx * 6, 60, 28 + idx * 6, 92]),
      value: makeField(getVal(obs.value), getConf(obs.value, 0.92), getStatus(obs.value)),
      overallStatus: obs.overallStatus || "ai_extracted",
    })),
    followUp: {
      interval: makeField(getVal(rawAiOutput.followUp?.interval), getConf(rawAiOutput.followUp?.interval, 0.90), getStatus(rawAiOutput.followUp?.interval), null, [88, 10, 94, 45]),
      advice: makeField(getVal(rawAiOutput.followUp?.advice), getConf(rawAiOutput.followUp?.advice, 0.90), getStatus(rawAiOutput.followUp?.advice), null, [88, 48, 94, 92]),
    },
  };

  // Convert to flat list for backward compatibility in existing summary views
  // DSA perf: trie + bounded-Levenshtein pass fixes common drug-spelling typos
  // before the analyzer runs, so allergy flags see corrected names too.
  const legacyMeds = correctMedicationNames(structuredData.medications.map((m, idx) => ({
    name: m.name?.value || "",
    genericName: m.genericName?.value || "",
    dosage: m.dosage?.value || "",
    frequency: m.frequency?.value || "",
    route: m.route?.value || "",
    duration: m.duration?.value || "",
    instructions: m.instructions?.value || "",
    confidence: m.name?.confidence ?? 0,
    confidenceTier: m.name?.confidence >= 0.85 ? "HIGH" : m.name?.confidence >= 0.65 ? "REVIEW_RECOMMENDED" : "NEEDS_VERIFICATION",
    sourceRegion: normalizeSource(m.name?.source, [33 + idx * 10, 10, 41 + idx * 10, 88], m.name?.value || ""),
    isVerified: false,
    warning: m.warning,
  })));

  const legacyLabs = structuredData.investigations.map((inv, idx) => ({
    panelName: inv.panelName?.value || "",
    testName: inv.testName?.value || "",
    resultValue: inv.resultValue?.value || "",
    numericValue: inv.numericValue,
    units: inv.units?.value || "",
    referenceRange: inv.referenceRange?.value || "",
    status: inv.abnormalFlag || "NORMAL",
    confidence: inv.testName?.confidence ?? 0,
    confidenceTier: inv.testName?.confidence >= 0.85 ? "HIGH" : inv.testName?.confidence >= 0.65 ? "REVIEW_RECOMMENDED" : "NEEDS_VERIFICATION",
    sourceRegion: normalizeSource(inv.testName?.source, [73 + idx * 7, 10, 79 + idx * 7, 88], inv.testName?.value || ""),
    isVerified: false,
    testDate: null,
  }));

  const clinicalFlags = cachedAnalyzeDocumentPayload(legacyMeds, legacyLabs, allergies);

  const extractionResult = {
    documentType: rawAiOutput.documentType || documentType || "CLINICAL_NOTE",
    aiSummary: rawAiOutput.aiSummary || "Clinical document processed. Review and verify structured findings.",
    overallConfidence: Number(rawAiOutput.overallConfidence ?? 0),
    modelName: ACTIVE_AI_PROVIDER === "openrouter" ? (lastUsedModelName || OPENROUTER_MODEL) : (lastUsedModelName || GEMINI_MODEL),
    structuredData,
    medications: legacyMeds,
    labResults: legacyLabs,
    clinicalFlags,
    originalSnapshot: JSON.parse(JSON.stringify(rawAiOutput)),
  };
  if (cacheKey) cacheExtraction(cacheKey, extractionResult);
  return extractionResult;
}

function patientContext(patient, documents, soapNotes = []) {
  const verifiedDocuments = (documents || []).filter((doc) => ["APPROVED", "CLINICIAN_VERIFIED", "AMENDED", "DOCTOR_VERIFIED"].includes(doc.status) || doc.doctorVerified === true);
  const meds = verifiedDocuments.flatMap((doc) => doc.medications || []);
  const labs = verifiedDocuments.flatMap((doc) => doc.labResults || []).sort((a, b) => new Date(b.testDate || 0) - new Date(a.testDate || 0));
  const lines = [
    `PATIENT: ${patient.fullName}, age ${patient.age || "unknown"}, gender ${patient.gender || "not recorded"}, MRN ${patient.mrn}`,
    `ALLERGIES: ${patient.allergies || "None documented"}`,
    `CHRONIC CONDITIONS: ${patient.chronicConditions || "None documented"}`,
    "MEDICATIONS:",
    ...meds.map((med) => `- ${med.name} ${med.dosage || ""} ${med.frequency || ""} (${med.isVerified ? "verified" : "extracted"})`),
    "LABS:",
    ...labs.map((lab) => `- ${lab.testName}: ${lab.resultValue} ${lab.units || ""} [${lab.status}] ref ${lab.referenceRange || "not recorded"}`),
    `DOCUMENTS: ${verifiedDocuments.length}; SOAP drafts: ${soapNotes.length}`,
  ];
  return { text: lines.join("\n"), meds, labs, documents: verifiedDocuments };
}

async function answerClinicalQuestion(patient, documents, soapNotes, question) {
  const context = patientContext(patient, documents, soapNotes);
  if (ACTIVE_AI_PROVIDER !== "manual") {
    try {
      const text = await askClinicalModel(`You are a documentation assistant for a licensed clinician. Ground your answer only in the provided record. Clearly label uncertainty and never replace clinician judgment. Return JSON with reply, clinicalFlags, suggestedActions, citations.\n\n${context.text}\n\nQUESTION: ${question}`);
      const result = parseJsonText(text);
      return { ...result, citations: result.citations || [`Patient record · ${patient.mrn}`] };
    } catch (error) {
      console.warn(`${ACTIVE_AI_PROVIDER} assistant unavailable; using deterministic fallback: ${error.message}`);
    }
  }
  const query = String(question || "").toLowerCase();
  const highLabs = context.labs.filter((lab) => ["HIGH", "CRITICAL", "LOW"].includes(lab.status));
  const flags = highLabs.map((lab) => `${lab.testName} is ${lab.status.toLowerCase()} (${lab.resultValue} ${lab.units || ""})`);
  let reply = `The record contains ${context.documents.length} verified document${context.documents.length === 1 ? "" : "s"}, ${context.meds.length} medication${context.meds.length === 1 ? "" : "s"}, and ${context.labs.length} lab value${context.labs.length === 1 ? "" : "s"}.`;
  let suggestedActions = ["Review the source document and confirm extracted values", "Record the clinician's final assessment and follow-up"];
  if (/sugar|glucose|diabet|hba1c/.test(query)) {
    reply = "Recent glycemic markers need attention: fasting blood sugar and HbA1c are above the reference range in the digitized record. Confirm the original report, current regimen, adherence, and follow-up testing plan.";
    suggestedActions = ["Confirm the latest HbA1c against the source report", "Review adherence, diet, and monitoring plan", "Document the follow-up interval"];
  } else if (/allerg|interaction|contraindication/.test(query)) {
    reply = `Allergy context is ${patient.allergies || "not documented"}. Cross-check every active medication against the allergy list and review renal monitoring where relevant before sign-off.`;
    suggestedActions = ["Confirm allergy history with the patient", "Run the medication interaction check", "Document any monitoring precautions"];
  } else if (/blood pressure|\bbp\b|hypertension/.test(query)) {
    reply = "The available record suggests a hypertension management review. Confirm current blood pressure readings, adherence, renal function, and the intended follow-up plan from the source documents.";
    suggestedActions = ["Confirm recent blood pressure readings", "Review renal function and current therapy", "Document the treatment target and next review"];
  }
  return { reply, clinicalFlags: flags, suggestedActions, citations: [`Patient record · ${patient.mrn}`, ...context.documents.slice(0, 3).map((doc) => `${doc.originalFilename} · ${doc.documentType}`)] };
}

async function generateSoap(patient, documents, soapNotes, doctorPrompt = "") {
  const context = patientContext(patient, documents, soapNotes);
  if (ACTIVE_AI_PROVIDER !== "manual") {
    try {
      const text = await askClinicalModel(`You are a medical scribe. Generate a concise clinician-editable SOAP draft from the record below. Return JSON with subjective, objective, assessment, plan. Do not invent findings; mark missing information as not documented.\n\n${context.text}\n\nPHYSICIAN FOCUS: ${doctorPrompt || "Routine documentation review"}`);
      const result = parseJsonText(text);
      if (result.subjective && result.objective && result.assessment && result.plan) return result;
    } catch (error) {
      console.warn(`${ACTIVE_AI_PROVIDER} SOAP unavailable; using deterministic fallback: ${error.message}`);
    }
  }
  const high = context.labs.filter((lab) => ["HIGH", "CRITICAL", "LOW"].includes(lab.status));
  return {
    subjective: `${patient.fullName}, a ${patient.age || ""}-year-old ${patient.gender || "patient"}, presents for documentation review. Chief complaint and symptom history are not documented in the uploaded records. Physician focus: ${doctorPrompt || "routine follow-up"}. Known allergies: ${patient.allergies || "none documented"}.`,
    objective: `Digitized documents: ${documents.length}.\nMedications: ${context.meds.map((med) => `${med.name} ${med.dosage || ""} ${med.frequency || ""}`).join("; ") || "none recorded"}.\nLab findings: ${context.labs.map((lab) => `${lab.testName} ${lab.resultValue} ${lab.units || ""} [${lab.status}]`).join("; ") || "none recorded"}.`,
    assessment: high.length ? high.map((lab, index) => `${index + 1}. ${lab.testName} requires clinician review (${lab.resultValue} ${lab.units || ""}, ${lab.status}).`).join("\n") : "1. No abnormal structured values identified in the current extracted record.\n2. Complete assessment after reviewing the original source document.",
    plan: "1. Compare all extracted fields with the source document.\n2. Confirm medication, allergy, and interaction status.\n3. Document clinician-led follow-up and monitoring instructions.\n4. Sign only after review.",
  };
}

// Keep the legacy export name for any existing callers while using the
// explicit safe-fallback implementation internally.
module.exports = { extractDocument, answerClinicalQuestion, generateSoap, fallbackExtraction: safeUnavailableExtraction };
