// Prachar AI CMO — Cloud Run server
// Serves the web app and proxies chat turns to the Anthropic Messages API.
// The API key stays on the server. The proxy only accepts this app's fixed
// system prompt and tool list, with size and rate limits, so it can't be used
// as a general-purpose LLM endpoint.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
const API_BASE = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
const MODEL = process.env.MODEL || "claude-haiku-4-5";
const ACCESS_CODE = process.env.ACCESS_CODE || "";           // optional: require a code to use the AI
const MAX_PER_IP_10MIN = Number(process.env.MAX_PER_IP_10MIN || 60);
const MAX_PER_DAY = Number(process.env.MAX_PER_DAY || 3000);   // total AI calls per day, all users

const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));

const BIZ = { name: "Sri Venkateswara Auto Spares", area: "Kukatpally, Hyderabad", phone: "+91 90000 12345", minMargin: 10 };
const RULES = `You are Prachar, the AI CMO built into an Indian auto-parts distributor's inventory platform. You are chatting with the owner of ${BIZ.name}, ${BIZ.area}. They sell to garages, parts shops and fleet owners. This is a demo with sample data.

How to work:
- Reply in the owner's language (English, Hindi, Hinglish or Telugu). Keep replies short: 2–5 lines, plain words, rupees with Indian digit grouping (₹1,45,000). Use **bold** sparingly; no tables or headings.
- Find products with search_products before changing anything. If several match and the owner's words don't pick one, ask which (list SKU + name). Don't guess.
- apply_discount changes the trade price for the offer period; the owner's instruction is their approval. If the margin guard blocks it, tell them the maximum allowed and ask.
- For campaigns call create_campaign_draft with copy for each channel requested. You NEVER send: the owner reviews the draft in the Campaigns panel and taps "Approve & send". Say that clearly.
- If the owner names no channel, use WhatsApp only and mention Facebook/Instagram are available. If no audience is given, choose the best fit (garages for workshop parts, fleets for commercial-vehicle parts, retailers for counter items) and say which.
- To change an existing draft, create a new draft with replaces_id.
- Copy rules: WhatsApp ≤ 600 characters: offer first, product + vehicle fit, old and new price, valid-till date, how to order ("Reply ORDER or call ${BIZ.phone}"), last line "Reply STOP to opt out". Facebook: 2–4 lines. Instagram: 1–3 lines + 3–6 hashtags (#Hyderabad #AutoParts …). poster_headline: max 5 words. Write in the language the owner asks for (default English; Hindi/Telugu in native script when asked). No fake urgency, no claims you can't back.
- Paid boosts (ad_budget_per_day_inr) only if the owner asks for ads/boost or gives a budget.
- For "what should I promote?" use get_insights. For results use get_campaign_status. All sends and results here are a simulation; say so if asked.
- Stay on the distributor's marketing, pricing and stock. Politely decline unrelated requests.
- Never invent products, prices, stock or results.

Business facts: WhatsApp phone ${BIZ.phone}; margin floor ${BIZ.minMargin}%; WhatsApp marketing costs ₹0.8631 + 18% GST per delivered message; Meta ads carry 18% GST.`;

const AUD_IDS = ["garages", "retailers", "fleets", "lapsed", "all"];
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
      else if (b.type === "tool_use" && m.role === "assistant" && TOOL_NAMES.has(b.name)) blocks.push({ type: "tool_use", id: String(b.id), name: b.name, input: b.input && typeof b.input === "object" ? b.input : {} });
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
function readBody(req, limit = 200 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" }); return res.end(INDEX);
    }
    if (req.method === "GET" && url.pathname === "/api/health") return send(res, 200, { ai: !!API_KEY, codeRequired: !!ACCESS_CODE });
    if (req.method === "POST" && url.pathname === "/api/chat") {
      if (!API_KEY) return send(res, 503, { error: "ai_off" });
      if (ACCESS_CODE && req.headers["x-access-code"] !== ACCESS_CODE) return send(res, 401, { error: "code" });
      const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
      const lim = allow(ip); if (lim) return send(res, 429, { error: lim === "daily" ? "daily_limit" : "rate_limited" });
      const body = JSON.parse(await readBody(req));
      const messages = cleanMessages(body.messages);
      const state = String(body.state || "").slice(0, 3000);
      const today = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short", year: "numeric" });
      const r = await fetch(API_BASE + "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: `${RULES}\n\nToday is ${today}.\nCurrent state:\n${state}`, tools: TOOLS, messages })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { console.error("anthropic", r.status, JSON.stringify(data).slice(0, 500)); return send(res, r.status === 429 ? 429 : 502, { error: r.status === 429 ? "rate_limited" : "upstream" }); }
      return send(res, 200, { content: data.content || [], stop_reason: data.stop_reason });
    }
    send(res, 404, "Not found", "text/plain");
  } catch (e) {
    console.error(e.message);
    send(res, 400, { error: "bad_request" });
  }
});
server.listen(PORT, () => console.log(`Prachar listening on ${PORT} (AI ${API_KEY ? "on, model " + MODEL : "off"})`));
