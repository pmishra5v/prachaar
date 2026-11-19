// Prachaar AI CMO: Cloud Run server
// Serves the chat app and forwards chat turns to Gemini on Vertex AI (or Claude), plus Sarvam voice.
// The AI only gets this app's fixed system prompt and tool list, with size and rate limits,
// so the server can't be used as a general-purpose LLM endpoint.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
// Vertex AI mode: no API key; the Cloud Run service account signs in through the metadata server.
const USE_VERTEX = /^(1|true|yes)$/i.test(process.env.USE_VERTEX || "");
const VERTEX_REGION = process.env.VERTEX_REGION || "global";
const META = "http://" + (process.env.GCE_METADATA_HOST || "metadata.google.internal") + "/computeMetadata/v1";
const VERTEX_BASE = process.env.VERTEX_BASE_URL || (VERTEX_REGION === "global" ? "https://aiplatform.googleapis.com" : `https://${VERTEX_REGION}-aiplatform.googleapis.com`);
const API_BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
// PROVIDER=gemini uses Google's Gemini on Vertex AI (no quota request needed, runs in Mumbai).
const PROVIDER = (process.env.PROVIDER || "claude").toLowerCase();
const GEMINI = PROVIDER === "gemini";
const GEMINI_REGION = process.env.GEMINI_REGION || "asia-south1";
const MODEL = process.env.MODEL || (GEMINI ? "gemini-2.5-flash" : USE_VERTEX ? "claude-haiku-4-5@20251001" : "claude-haiku-4-5");
const AI_ON = GEMINI || USE_VERTEX || !!API_KEY;
const HOST = process.env.HOST || "0.0.0.0";
const LOCAL = /^(1|true|yes)$/i.test(process.env.LOCAL || "");
const crypto = require("crypto");

const BRAND = { id: "prachaar", name: "Prachaar", assistant: "Prachaar", title: "Prachaar AI CMO" };
// ---- Test dataset (anonymised InsiTE export, built by tools/anonymize_insite.py) ----
const DATASET_FILE = process.env.DATASET_FILE || path.join(__dirname, "dataset", "insite-demo.json");
let DATASET = null, DATASET_GZ = null;
try {
  DATASET = JSON.parse(fs.readFileSync(DATASET_FILE, "utf8"));
  DATASET_GZ = require("zlib").gzipSync(JSON.stringify(DATASET));
} catch (e) { if (e.code !== "ENOENT") console.error("[dataset] could not load", DATASET_FILE, e.message); }

// Backup model when the main one is busy (429/503). Default for Gemini 3.x: Gemini 2.5 Flash in Mumbai.
const FALLBACK = (process.env.FALLBACK_MODEL ?? (GEMINI && /^gemini-3/.test(MODEL) ? "gemini-2.5-flash@asia-south1" : "")).trim();
let tok = { value: "", exp: 0 }, projectId = process.env.GOOGLE_CLOUD_PROJECT || "", authMode = "";
const { execFile } = require("child_process");
function gcloud(args) {                     // local runs: use the developer's own `gcloud auth login`
  return new Promise((resolve, reject) => execFile(process.platform === "win32" ? "gcloud.cmd" : "gcloud", args,
    { timeout: 20000, windowsHide: true, shell: process.platform === "win32" },
    (err, out) => err ? reject(err) : resolve(String(out).trim())));
}
async function meta(path) {
  const r = await fetch(META + path, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(1500) });
  if (!r.ok) throw new Error("metadata " + r.status);
  return r;
}
async function vertexToken() {
  if (tok.value && Date.now() < tok.exp - 60000) return tok.value;
  if (process.env.ACCESS_TOKEN) { authMode = "ACCESS_TOKEN env"; tok = { value: process.env.ACCESS_TOKEN, exp: Date.now() + 50 * 60000 }; return tok.value; }
  try {
    const j = await (await meta("/instance/service-accounts/default/token")).json();
    authMode = "Cloud Run service account";
    tok = { value: j.access_token, exp: Date.now() + (j.expires_in || 300) * 1000 };
  } catch (e) {
    const t = await gcloud(["auth", "print-access-token"]).catch(() => "");
    if (!t) throw new Error("No Google credentials: run `gcloud auth login` (local) or deploy to Cloud Run.");
    authMode = "gcloud CLI (your login)";
    tok = { value: t, exp: Date.now() + 45 * 60000 };
  }
  return tok.value;
}
async function getProject() {
  if (projectId) return projectId;
  try { projectId = (await (await meta("/project/project-id")).text()).trim(); }
  catch { projectId = await gcloud(["config", "get-value", "project"]).catch(() => ""); }
  if (!projectId) throw new Error("Set GOOGLE_CLOUD_PROJECT");
  return projectId;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Storage: campaigns, offers and prices survive refreshes and restarts ----
// STORE=file      → data/<id>.json on disk (default when LOCAL=1)
// STORE=firestore → Firestore (Native mode) document prachar/<id> (default on Cloud Run)
const STORE = (process.env.STORE || (LOCAL ? "file" : "firestore")).toLowerCase();
// One stable store: campaigns and offers survive dataset rebuilds (part codes don't change).
const STORE_ID = (process.env.STORE_ID || "svas-main").replace(/[^a-z0-9_-]/gi, "");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const FS_BASE = process.env.FIRESTORE_BASE_URL || "https://firestore.googleapis.com";
const FS_DB = process.env.FIRESTORE_DATABASE || "(default)";
const fsUpdateTimes = new Map();              // per workspace: Firestore precondition so two windows don't overwrite each other blindly
async function storeGet(ws = STORE_ID) {
  if (STORE === "file") {
    try { const j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, ws + ".json"), "utf8")); return { state: j.state, rev: j.rev || 0 }; }
    catch { return { state: null, rev: 0 }; }
  }
  const url = `${FS_BASE}/v1/projects/${await getProject()}/databases/${FS_DB}/documents/prachar/${ws}`;
  const r = await fetch(url, { headers: { authorization: "Bearer " + (await vertexToken()), "x-goog-user-project": await getProject() }, signal: AbortSignal.timeout(10000) });
  if (r.status === 404) return { state: null, rev: 0 };
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("firestore get " + r.status + " " + JSON.stringify(d).slice(0, 300));
  fsUpdateTimes.set(ws, d.updateTime || "");
  const f = d.fields || {};
  return { state: f.json ? JSON.parse(f.json.stringValue) : null, rev: Number((f.rev && f.rev.integerValue) || 0) };
}
async function storePut(state, expectRev, ws = STORE_ID) {
  const cur = await storeGet(ws);
  if (cur.rev !== expectRev) return { conflict: true, ...cur };
  const rev = cur.rev + 1, json = JSON.stringify(state);
  if (STORE === "file") {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const f = path.join(DATA_DIR, ws + ".json"), tmp = f + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({ rev, savedAt: new Date().toISOString(), state }, null, 1));
    fs.renameSync(tmp, f);
    return { rev };
  }
  const ut = fsUpdateTimes.get(ws) || "";
  const q = ut ? `currentDocument.updateTime=${encodeURIComponent(ut)}` : "currentDocument.exists=false";
  const url = `${FS_BASE}/v1/projects/${await getProject()}/databases/${FS_DB}/documents/prachar/${ws}?${q}`;
  const r = await fetch(url, { method: "PATCH", signal: AbortSignal.timeout(10000),
    headers: { "content-type": "application/json", authorization: "Bearer " + (await vertexToken()), "x-goog-user-project": await getProject() },
    body: JSON.stringify({ fields: { json: { stringValue: json }, rev: { integerValue: String(rev) }, savedAt: { timestampValue: new Date().toISOString() } } }) });
  const d = await r.json().catch(() => ({}));
  if (r.status === 400 || r.status === 409 || r.status === 412) { const now = await storeGet(ws); return { conflict: true, ...now }; }
  if (!r.ok) throw new Error("firestore put " + r.status + " " + JSON.stringify(d).slice(0, 300));
  fsUpdateTimes.set(ws, d.updateTime || ut);
  return { rev };
}
function validState(st) {
  return st && typeof st === "object" && Array.isArray(st.campaigns) && st.campaigns.length <= 2000
    && ((st.offers && typeof st.offers === "object") || (Array.isArray(st.products) && st.products.length <= 5000));
}


// ---- Gemini adapter: converts the Claude-style conversation to Gemini generateContent and back ----
function toGeminiSchema(sc) {
  if (!sc || typeof sc !== "object") return sc;
  const o = {};
  for (const [k, v] of Object.entries(sc)) {
    if (k === "properties") { o.properties = {}; for (const [pk, pv] of Object.entries(v)) o.properties[pk] = toGeminiSchema(pv); }
    else if (k === "items") o.items = toGeminiSchema(v);
    else o[k] = v;
  }
  return o;
}
let GEMINI_TOOLS_CACHE = null;
const geminiTools = () => GEMINI_TOOLS_CACHE || (GEMINI_TOOLS_CACHE = [{ functionDeclarations: TOOLS.map(t => {
  const d = { name: t.name, description: t.description };
  if (t.input_schema && Object.keys(t.input_schema.properties || {}).length) d.parameters = toGeminiSchema(t.input_schema);
  return d;
}) }]);
function toGeminiContents(messages) {
  const idToName = {};
  return messages.map(m => {
    if (typeof m.content === "string") return { role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] };
    const parts = [];
    for (const b of m.content) {
      if (b.type === "text") parts.push({ text: b.text });
      else if (b.type === "tool_use") { idToName[b.id] = b.name; const fc = { functionCall: { name: b.name, args: b.input || {} } }; if (b.sig) fc.thoughtSignature = b.sig; parts.push(fc); }
      else if (b.type === "tool_result") {
        let resp; try { resp = JSON.parse(b.content); } catch { resp = b.content; }
        if (resp === null || typeof resp !== "object" || Array.isArray(resp)) resp = { result: resp };
        if (b.is_error) resp = { error: b.content };
        parts.push({ functionResponse: { name: idToName[b.tool_use_id] || "unknown", response: resp } });
      }
    }
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });
}
async function geminiOnce(model, region, system, contents, max_tokens) {
  const project = await getProject();
  const host = region === "global" ? "aiplatform.googleapis.com" : `${region}-aiplatform.googleapis.com`;
  const base = process.env.VERTEX_BASE_URL || `https://${host}`;
  const url = `${base}/v1/projects/${project}/locations/${region}/publishers/google/models/${model}:generateContent`;
  const gen = { maxOutputTokens: max_tokens };
  if (/^gemini-3/.test(model)) gen.thinkingConfig = { thinkingLevel: process.env.THINKING_LEVEL || "low" };   // Gemini 3.x: keep default temperature
  else { gen.temperature = 0.4; if (/2\.5-flash/.test(model)) gen.thinkingConfig = { thinkingBudget: 0 }; }    // faster + cheaper for tool calls
  const post = async g => fetch(url, { method: "POST", signal: AbortSignal.timeout(90000),
    headers: { "content-type": "application/json", authorization: "Bearer " + (await vertexToken()), "x-goog-user-project": project },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, tools: geminiTools(), generationConfig: g }) });
  let r = await post(gen);
  if (r.status === 400 && gen.thinkingConfig) {            // a model may reject a thinking setting: retry without it
    console.error(`[gemini] ${model} 400, retrying without thinkingConfig:`, (await r.text()).slice(0, 300));
    const { thinkingConfig, ...rest } = gen; r = await post(rest);
  }
  if (r.status === 401) tok = { value: "", exp: 0 };        // expired local token: fetch a fresh one next time
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}
function fromGemini(data) {
  const cand = (data.candidates && data.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const content = []; let n = 0;
  for (const p of parts) {
    if (p.thought) continue;
    if (typeof p.text === "string" && p.text.trim()) content.push({ type: "text", text: p.text });
    if (p.functionCall) content.push({ type: "tool_use", id: `g${Date.now().toString(36)}_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {}, ...(p.thoughtSignature ? { sig: p.thoughtSignature } : {}) });
  }
  return { content, finish: cand.finishReason || "" };
}
let primaryCoolUntil = 0;                                  // after the main model says "busy", use the backup for a minute
async function callGemini({ system, messages, max_tokens }) {
  const base = toGeminiContents(messages);
  const plan = [];
  if (!FALLBACK || Date.now() > primaryCoolUntil) plan.push([MODEL, GEMINI_REGION, true]);
  if (FALLBACK) { const [m, r] = FALLBACK.split("@"); plan.push([m, r || GEMINI_REGION, false]); }
  let last = { status: 0, data: {} };
  for (const [model, region, isPrimary] of plan) {
    // Gemini 3 checks "thought signatures" on earlier tool calls; calls made by another model have none.
    const contents = /^gemini-3/.test(model) ? base.map(c => ({ ...c, parts: c.parts.map(p => p.functionCall && !p.thoughtSignature ? { ...p, thoughtSignature: "skip_thought_signature_validator" } : p) })) : base;
    const tries = isPrimary && FALLBACK ? 2 : 3;
    for (let attempt = 0; attempt < tries; attempt++) {
      const t0 = Date.now();
      const res = await geminiOnce(model, region, system, contents, max_tokens).catch(e => ({ status: 599, data: { error: { message: e.message } } }));
      last = res;
      if (res.status === 200) {
        const out = fromGemini(res.data);
        if (!out.content.length && attempt < 2) {           // empty or MALFORMED_FUNCTION_CALL: ask again
          console.warn(`[gemini] ${model} empty reply (finish=${out.finish}), retrying`); continue;
        }
        if (!out.content.length) out.content.push({ type: "text", text: "Sorry, I didn't catch that. Could you say it again?" });
        console.log(`[gemini] ${model}@${region} ${Date.now() - t0}ms → ${out.content.map(c => c.type === "tool_use" ? "tool:" + c.name : "text").join(", ")}`);
        return { ok: true, model, data: { content: out.content, stop_reason: out.content.some(c => c.type === "tool_use") ? "tool_use" : "end_turn" } };
      }
      const msg = JSON.stringify(res.data).slice(0, 400);
      if (res.status === 429 || res.status >= 500) {        // busy: back off and retry, then try the backup model
        console.warn(`[gemini] ${model}@${region} ${res.status} (attempt ${attempt + 1}) ${msg}`);
        if (attempt < tries - 1) await sleep(700 * Math.pow(2, attempt) + Math.random() * 300);
        else if (isPrimary && FALLBACK) { primaryCoolUntil = Date.now() + 60000; console.warn(`[gemini] ${model} busy — using backup ${FALLBACK} for 60s`); }
        continue;
      }
      console.error(`[gemini] ${model}@${region} ${res.status} ${msg}`);
      break;                                               // 400/403/404: don't retry this model; try the backup
    }
  }
  return { ok: false, status: last.status, data: last.data };
}

async function callClaude(payload) {
  if (!USE_VERTEX) {
    return fetch(API_BASE + "/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, ...payload }) });
  }
  const url = `${VERTEX_BASE}/v1/projects/${await getProject()}/locations/${VERTEX_REGION}/publishers/anthropic/models/${MODEL}:rawPredict`;
  return fetch(url, { method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + (await vertexToken()) },
    body: JSON.stringify({ anthropic_version: "vertex-2023-10-16", ...payload }) });
}

// ---- Voice (Sarvam AI): speech-to-text for the mic button, text-to-speech for "read replies aloud" ----
// The key stays on the server: SARVAM_API_KEY env var (local: start-local.ps1; Cloud Run: Secret Manager).
const SARVAM_KEY = (process.env.SARVAM_API_KEY || "").trim();
const SARVAM_BASE = (process.env.SARVAM_BASE_URL || "https://api.sarvam.ai").replace(/\/$/, "");
const STT_MODEL = process.env.SARVAM_STT_MODEL || "saaras:v4";
const TTS_MODEL = process.env.SARVAM_TTS_MODEL || "bulbul:v3";
const TTS_SPEAKER = process.env.SARVAM_SPEAKER || "";          // empty = Sarvam's default voice for the model
const VOICE_LANGS = new Set(["unknown", "en-IN", "hi-IN", "te-IN", "ta-IN", "kn-IN", "mr-IN", "bn-IN", "gu-IN", "ml-IN", "pa-IN", "od-IN"]);
// Domain words help the recogniser with part names and bike models (Sarvam accepts up to 50).
const KEYTERMS = (() => {
  if (!DATASET) return [];
  const cnt = new Map();
  const add = (w, n = 1) => { w = String(w || "").trim(); if (w.length >= 3 && w.length <= 40) cnt.set(w, (cnt.get(w) || 0) + n); };
  for (const p of DATASET.products) { add(p.name, 2); add(String(p.fit || "").split(/[(/]/)[0].trim()); }
  ["CDI", "Coil Plate", "Self Motor", "RR Unit", "ECM", "WhatsApp", "Instagram", "Facebook", "garages"].forEach(w => add(w, 100));
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([w]) => w);
})();
let keytermsOk = true;
async function sarvamSTT(audio, mime, lang) {
  const ext = /ogg/.test(mime) ? "ogg" : /mp4|m4a|aac/.test(mime) ? "m4a" : /wav/.test(mime) ? "wav" : "webm";
  const make = withTerms => {
    const fd = new FormData();
    fd.append("file", new Blob([audio], { type: mime || "audio/webm" }), "voice." + ext);
    fd.append("model", STT_MODEL);
    fd.append("language_code", lang);
    if (withTerms && KEYTERMS.length && /v4/.test(STT_MODEL)) fd.append("keyterms", JSON.stringify(KEYTERMS));
    return fd;
  };
  const post = fd => fetch(SARVAM_BASE + "/speech-to-text", { method: "POST", headers: { "api-subscription-key": SARVAM_KEY }, body: fd, signal: AbortSignal.timeout(30000) });
  let r = await post(make(keytermsOk));
  if (r.status === 400 && keytermsOk && KEYTERMS.length) {     // if the API rejects the term list, carry on without it
    console.warn("[voice] STT 400 with keyterms, retrying without:", (await r.text()).slice(0, 200));
    keytermsOk = false; r = await post(make(false));
  }
  const d = await r.json().catch(() => ({}));
  return { status: r.status, data: d };
}
function speakable(text) {                     // plain words for TTS: no markdown, short
  let t = String(text || "").replace(/\*\*/g, "").replace(/^[-•]\s+/gm, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (t.length > 600) { const cut = t.slice(0, 600); const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("। "), cut.lastIndexOf("? ")); t = end > 200 ? cut.slice(0, end + 1) : cut; }
  return t;
}
async function sarvamTTS(text, lang) {
  const body = { text, target_language_code: lang, model: TTS_MODEL, speech_sample_rate: 22050 };
  if (TTS_SPEAKER) body.speaker = TTS_SPEAKER;
  const r = await fetch(SARVAM_BASE + "/text-to-speech", { method: "POST", signal: AbortSignal.timeout(30000),
    headers: { "api-subscription-key": SARVAM_KEY, "content-type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  return { status: r.status, data: d };
}

const ACCESS_CODE = process.env.ACCESS_CODE || "";           // optional: require a code to use the AI
const MAX_PER_IP_10MIN = Number(process.env.MAX_PER_IP_10MIN || (LOCAL ? 100000 : 200));   // one chat message ≈ 3–5 AI calls
const MAX_PER_DAY = Number(process.env.MAX_PER_DAY || 3000);   // total AI calls per day, all users

const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));

const BIZ = DATASET
  ? { name: DATASET.store.name, area: DATASET.store.area, phone: DATASET.store.phone, minMargin: 10, business: DATASET.store.business }
  : { name: "Sri Venkateswara Auto Spares", area: "Kukatpally, Hyderabad", phone: "+91 90000 12345", minMargin: 10, business: "" };
const rulesFor = (BIZ, live) => `You are ${BRAND.assistant}, the AI CMO built into an Indian auto-parts distributor's inventory platform. You are chatting with the owner of ${BIZ.name}, ${BIZ.area}. ${BIZ.business ? "Business: " + BIZ.business + ". " : ""}They sell to ${DATASET ? DATASET.audiences.filter(a => a.id !== "all" && a.id !== "lapsed").map(a => a.name.toLowerCase()).join(", ") : "garages, parts shops and fleet owners"}. This is a test setup${DATASET ? ` with anonymised real stock and sales data (sales up to ${DATASET.asOf})` : " with sample data"}; ${live ? "WhatsApp is connected: when the owner approves a draft, the WhatsApp message really goes to customers who opted in (using the approved offer template). Facebook and Instagram are still simulated." : "nothing is really sent."}

How to work:
- Reply in the owner's language (English, Hindi, Hinglish or Telugu). Keep replies short: 2–5 lines, plain words, rupees with Indian digit grouping (₹1,45,000). Use **bold** sparingly; no tables or headings.
- Find products with search_products before changing anything. If several match and the owner's words don't pick one, ask which (list SKU + name). Don't guess.
- apply_discount changes the trade price for the offer period; the owner's instruction is their approval. If the margin guard blocks it, tell them the maximum allowed and ask.
- For campaigns you MUST call create_campaign_draft (with the exact SKU from search_products and copy for each channel requested). A draft only exists after that tool returns a campaign_id: never say a campaign or draft is ready unless it did. If a tool returns an error, fix the input and call it again. You NEVER send: the owner reviews the draft in the Campaigns panel and taps "Approve & send". Say that clearly and mention the campaign id.
- When the owner asks for an offer and a campaign in one message, do all steps in this turn: search_products → apply_discount → create_campaign_draft.
- If the owner names no channel, use WhatsApp only and mention Facebook/Instagram are available. If no audience is given, choose the best fit (garages for workshop parts, fleets for commercial-vehicle parts, retailers for counter items) and say which.
- To change an existing draft, create a new draft with replaces_id.
- Copy rules: WhatsApp ≤ 600 characters: offer first, product + vehicle fit, old and new price, valid-till date, how to order ("Reply ORDER or call ${BIZ.phone}"), last line "Reply STOP to opt out". Facebook: 2–4 lines. Instagram: 1–3 lines + 3–6 hashtags (#Hyderabad #AutoParts …). poster_headline: max 5 words. Write in the language the owner asks for (default English; Hindi/Telugu in native script when asked). No fake urgency, no claims you can't back.
- Paid boosts (ad_budget_per_day_inr) only if the owner asks for ads/boost or gives a budget.
- For "what should I promote?" use get_insights. For results use get_campaign_status. ${live ? "WhatsApp delivery is real; orders and sales figures are still estimates." : "All sends and results here are a simulation; say so if asked."}
- Stay on the distributor's marketing, pricing and stock. Politely decline unrelated requests.
- Never invent products, prices, stock or results.

Business facts: WhatsApp phone ${BIZ.phone}; margin floor ${BIZ.minMargin}%; WhatsApp marketing messages are charged by Meta per delivered message plus 18% GST (the app shows an estimate); Meta ads carry 18% GST.`;
const RULES = rulesFor(BIZ, false);

const AUD_IDS = DATASET ? DATASET.audiences.map(a => a.id) : ["garages", "retailers", "fleets", "lapsed", "all"];
const TOOLS = [
  { name: "search_products", description: "Search the distributor's catalogue by product, brand, vehicle or SKU. Returns up to 6 matches with trade price, MRP, stock, margin, any active offer and days since last sale.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
  { name: "apply_discount", description: "Apply a percentage discount to one SKU's trade price for N days (default 7). Enforces the margin floor; errors with the max allowed % if blocked. Returns old and offer price.",
    input_schema: { type: "object", properties: { sku: { type: "string" }, percent: { type: "number" }, days: { type: "number" } }, required: ["sku", "percent"] } },
  { name: "remove_discount", description: "End the active offer on a SKU and restore the normal trade price.",
    input_schema: { type: "object", properties: { sku: { type: "string" } }, required: ["sku"] } },
  { name: "list_audiences", description: "List customer audiences with total customers, WhatsApp opted-in counts and cost per WhatsApp blast, plus Facebook/Instagram follower counts.",
    input_schema: { type: "object", properties: {} } },
  { name: "create_campaign_draft", description: "Create a campaign DRAFT with ready copy for WhatsApp, Facebook and/or Instagram. It appears in the Campaigns panel for the owner to approve; it is not sent. Uses the SKU's active offer for the poster. Returns id and estimated cost.",
    input_schema: { type: "object", properties: {
      name: { type: "string", description: "Short campaign name" },
      skus: { type: "array", items: { type: "string" } },
      audience_id: { type: "string", enum: AUD_IDS },
      channels: { type: "array", items: { type: "string", enum: ["whatsapp", "facebook", "instagram"] } },
      language: { type: "string" },
      poster_headline: { type: "string" },
      whatsapp_message: { type: "string" }, facebook_post: { type: "string" }, instagram_caption: { type: "string" },
      ad_budget_per_day_inr: { type: "number", description: "0 for organic posts only" }, ad_days: { type: "number" },
      replaces_id: { type: "string", description: "Draft id this one replaces" } },
      required: ["name", "skus", "audience_id", "channels", "poster_headline"] } },
  { name: "get_insights", description: "Marketing opportunities from inventory data: dead stock (no sale 90+ days), fast movers, lapsed customers, and the current season/festival context.",
    input_schema: { type: "object", properties: {} } },
  { name: "get_campaign_status", description: "Status, delivery and (simulated) results for a campaign id.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }
];
const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

// ---- limits ----
const hits = new Map(); let day = new Date().toISOString().slice(0, 10), dayCount = 0;
function allow(ip) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; hits.clear(); }
  if (dayCount >= MAX_PER_DAY) return "daily";
  const now = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter(t => now - t < win);
  if (arr.length >= MAX_PER_IP_10MIN) { hits.set(ip, arr); return "ip"; }
  arr.push(now); hits.set(ip, arr); dayCount++; return "";
}

// ---- validation of the conversation the browser sends ----
function cleanMessages(msgs) {
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > 60) throw new Error("bad messages");
  const out = [];
  for (const m of msgs) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) throw new Error("bad role");
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content.slice(0, 4000) }); continue; }
    if (!Array.isArray(m.content)) throw new Error("bad content");
    const blocks = [];
    for (const b of m.content) {
      if (b.type === "text" && typeof b.text === "string") blocks.push({ type: "text", text: b.text.slice(0, 6000) });
      else if (b.type === "tool_use" && m.role === "assistant" && TOOL_NAMES.has(b.name)) blocks.push({ type: "tool_use", id: String(b.id), name: b.name, input: b.input && typeof b.input === "object" ? b.input : {}, ...(typeof b.sig === "string" && b.sig.length < 20000 ? { sig: b.sig } : {}) });
      else if (b.type === "tool_result" && m.role === "user") blocks.push({ type: "tool_result", tool_use_id: String(b.tool_use_id), content: String(b.content ?? "").slice(0, 12000), ...(b.is_error ? { is_error: true } : {}) });
    }
    if (!blocks.length) throw new Error("empty message");
    out.push({ role: m.role, content: blocks });
  }
  if (out[0].role !== "user" || out[out.length - 1].role !== "user") throw new Error("must start and end with user");
  return out;
}

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function readBody(req, limit = 200 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}


function isHttps(req) { return String(req.headers["x-forwarded-proto"] || "").includes("https"); }
const CSP = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' data: blob: https:", "connect-src 'self'", "media-src 'self' blob: data:",
  "worker-src 'self' blob:", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; ");
function securityHeaders(req, res) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(), payment=(), usb=()");
  if (isHttps(req)) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
}
const APP_HTML = INDEX.toString("utf8").replace("</head>", `<script>window.BRAND=${JSON.stringify(BRAND)}</script></head>`);
function sendHtml(res, html, code = 200) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff" });
  res.end(html);
}
const FORM_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  securityHeaders(req, res);
  try {
    const p = url.pathname;
    // Changes must come from our own page: block cross-site requests and plain HTML form posts (CSRF)
    if (req.method !== "GET" && req.method !== "HEAD" && p.startsWith("/api/")) {
      const ct = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
      if (req.headers["sec-fetch-site"] === "cross-site" || FORM_TYPES.has(ct)) return send(res, 403, { error: "forbidden" });
    }
    if (req.method === "GET" && (p === "/" || p === "/index.html")) return sendHtml(res, APP_HTML);
    if (req.method === "GET" && url.pathname === "/api/dataset") {
      if (!DATASET) return send(res, 404, { error: "no_dataset" });
      const gz = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-cache", ...(gz ? { "Content-Encoding": "gzip" } : {}) });
      return res.end(gz ? DATASET_GZ : JSON.stringify(DATASET));
    }
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { brand: BRAND.id, store: STORE, ai: AI_ON, voice: !!SARVAM_KEY, codeRequired: !!ACCESS_CODE, parts: DATASET ? DATASET.products.length : 0, datasetVersion: DATASET ? DATASET.version : null, ...(LOCAL ? { model: MODEL, fallback: FALLBACK, provider: PROVIDER } : {}) });
    if (req.method === "GET" && url.pathname === "/api/selftest" && LOCAL) {   // local only: checks credentials + model with one tiny call
      const t0 = Date.now();
      const out = GEMINI
        ? await callGemini({ system: "Reply with exactly: OK", messages: [{ role: "user", content: "ping" }], max_tokens: 20 })
        : { ok: false, data: { note: "selftest only implemented for Gemini" } };
      return send(res, out.ok ? 200 : 502, { ok: out.ok, model: out.model || MODEL, auth: authMode, project: projectId, ms: Date.now() - t0, reply: out.ok ? out.data.content : out.data });
    }
    if (url.pathname === "/api/state" && (req.method === "GET" || req.method === "PUT")) {
      if (ACCESS_CODE && req.method === "PUT" && req.headers["x-access-code"] !== ACCESS_CODE) return send(res, 401, { error: "code" });
      try {
        const ws = STORE_ID;
        if (req.method === "GET") return send(res, 200, await storeGet(ws));
        const body = JSON.parse(await readBody(req, 800 * 1024));
        if (!validState(body.state)) return send(res, 400, { error: "bad_state" });
        const out = await storePut(body.state, Number(body.rev) || 0, ws);
        if (out.conflict) { console.warn("[store] conflict, client rev", body.rev, "server rev", out.rev); return send(res, 409, out); }
        console.log(`[store] ${ws} saved rev ${out.rev} (${STORE})`);
        return send(res, 200, out);
      } catch (e) { console.error("[store]", e.message); return send(res, 503, { error: "store_unavailable" }); }
    }
    if (req.method === "POST" && (url.pathname === "/api/stt" || url.pathname === "/api/tts")) {
      if (!SARVAM_KEY) return send(res, 503, { error: "voice_off" });
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      const lim = allow(ip); if (lim) return send(res, 429, { error: lim === "daily" ? "daily_limit" : "local_limit" });
      let lang = String(url.searchParams.get("lang") || "unknown"); if (!VOICE_LANGS.has(lang)) lang = "unknown";
      const t0 = Date.now();
      if (url.pathname === "/api/stt") {
        const audio = await readRaw(req, 4 * 1024 * 1024);         // ~30 s of compressed audio is far below this
        if (audio.length < 800) return send(res, 400, { error: "too_short" });
        const out = await sarvamSTT(audio, String(req.headers["content-type"] || "audio/webm").split(";")[0], lang)
          .catch(e => ({ status: 599, data: { error: e.message } }));   // network/timeouts → "voice service unavailable"
        if (out.status !== 200) { console.error("[voice] STT", out.status, JSON.stringify(out.data).slice(0, 300)); return send(res, out.status === 429 ? 429 : 502, { error: out.status === 401 || out.status === 403 ? "voice_key" : "voice_upstream" }); }
        console.log(`[voice] STT ${Date.now() - t0}ms ${Math.round(audio.length / 1024)}KB lang=${out.data.language_code || lang} "${String(out.data.transcript || "").slice(0, 60)}"`);
        return send(res, 200, { transcript: out.data.transcript || "", language_code: out.data.language_code || lang });
      }
      const body = JSON.parse(await readBody(req, 20 * 1024));
      const text = speakable(body.text);
      if (!text) return send(res, 400, { error: "no_text" });
      // Voice follows the script of the reply; Latin-script replies keep the speaker's language (Hinglish -> Hindi voice).
      if (/[\u0C00-\u0C7F]/.test(text)) lang = "te-IN";
      else if (/[\u0900-\u097F]/.test(text)) lang = "hi-IN";
      else if (/[\u0B80-\u0BFF]/.test(text)) lang = "ta-IN";
      else if (/[\u0C80-\u0CFF]/.test(text)) lang = "kn-IN";
      else if (lang !== "hi-IN") lang = "en-IN";
      const out = await sarvamTTS(text, lang).catch(e => ({ status: 599, data: { error: e.message } }));
      const b64 = out.data && Array.isArray(out.data.audios) && out.data.audios[0];
      if (out.status !== 200 || !b64) { console.error("[voice] TTS", out.status, JSON.stringify(out.data).slice(0, 300)); return send(res, out.status === 429 ? 429 : 502, { error: out.status === 401 || out.status === 403 ? "voice_key" : "voice_upstream" }); }
      const wav = Buffer.from(b64, "base64");
      console.log(`[voice] TTS ${Date.now() - t0}ms ${text.length} chars lang=${lang}`);
      res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store", "Content-Length": wav.length });
      return res.end(wav);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!AI_ON) return send(res, 503, { error: "ai_off" });
      if (ACCESS_CODE && req.headers["x-access-code"] !== ACCESS_CODE) return send(res, 401, { error: "code" });
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      const lim = allow(ip); if (lim) { console.warn("[limit]", lim, ip); return send(res, 429, { error: lim === "daily" ? "daily_limit" : "local_limit" }); }
      const body = JSON.parse(await readBody(req));
      const messages = cleanMessages(body.messages);
      const state = String(body.state || "").slice(0, 3000);
      const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" });
      const voiceMode = body.voice === true;
      const system = `${RULES}\n\nToday is ${today}.\nCurrent state:\n${state}` + (voiceMode ? `\n\nVOICE MODE: the owner is talking to you and hears your reply read aloud. Answer in 1–3 short spoken sentences in the language they used (Telugu or Hindi in native script if they spoke it). No lists, markdown, tables or SKU codes. Say amounts naturally, e.g. "rupees seventeen sixty". Still use the tools exactly as usual; the screen shows the full details. If a draft is ready, say its number and that they can tap Approve and send on screen.` : "");
      let r, data;
      if (GEMINI) { const g = await callGemini({ system, messages, max_tokens: 1500 }); r = { ok: g.ok, status: g.status || 200 }; data = g.data; }
      else { r = await callClaude({ max_tokens: 1500, system, tools: TOOLS, messages }); data = await r.json().catch(() => ({})); }
      if (!r.ok) { console.error(GEMINI ? "gemini" : "claude", r.status, JSON.stringify(data).slice(0, 500)); return send(res, r.status === 429 ? 429 : 502, { error: r.status === 429 || r.status >= 500 ? "ai_busy" : "upstream" }); }
      return send(res, 200, { content: data.content || [], stop_reason: data.stop_reason });
    }
    send(res, 404, "Not found", "text/plain");
  } catch (e) {
    console.error(e.message);
    send(res, 400, { error: "bad_request" });
  }
});
server.keepAliveTimeout = 65000; server.headersTimeout = 66000;
server.on("error", e => { console.error(e.code === "EADDRINUSE" ? `Port ${PORT} is already in use. Pick another with PORT=xxxx.` : e.message); process.exit(1); });
server.listen(PORT, HOST, () => console.log(`${BRAND.name} listening on http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT} (AI ${AI_ON ? (GEMINI ? "Gemini on Vertex AI " + GEMINI_REGION : USE_VERTEX ? "Vertex AI " + VERTEX_REGION : "Anthropic API") + ", model " + MODEL + (FALLBACK ? ", backup " + FALLBACK : "") : "off"}${LOCAL ? ", LOCAL" : ""}; voice: ${SARVAM_KEY ? "Sarvam " + STT_MODEL + " / " + TTS_MODEL : "off (no SARVAM_API_KEY)"}; dataset: ${DATASET ? DATASET.products.length + " parts, v" + DATASET.version : "MISSING - put insite-demo.json in dataset/"}; data: ${STORE === "file" ? path.join(DATA_DIR, STORE_ID + ".json") : "Firestore prachar/" + STORE_ID})`));
