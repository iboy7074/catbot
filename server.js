import express from "express";
import mysql from "mysql2/promise";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

try {
  process.loadEnvFile?.();
} catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const SERVER_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GROQ_API_KEY = (process.env.GROQ_API_KEY || "").trim();
const COHERE_API_KEY = (process.env.COHERE_API_KEY || "").trim();
const HUGGINGFACE_API_KEY = (process.env.HUGGINGFACE_API_KEY || "").trim();
const OPENROUTER_API_KEY = (process.env.OPENROUTER_API_KEY || "").trim();
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 20;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "sessions.json");

const ALLOWED_MODELS = new Set([
  // Google Gemini
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.8-flash",
  "gemini-3.8-pro",
  "gemini-flash-latest",
  "gemini-flash-lite-latest",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  // OpenRouter (Free & Auto)
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-chat:free",
  "openrouter/auto",
  // Groq Cloud
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "qwen/qwen3.8-27b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
  "gemma2-9b-it",
  // Cohere
  "command-r-08-2024",
  "command-r",
  "command-r-plus",
  // Hugging Face
  "meta-llama/Llama-3.2-3B-Instruct",
]);
const SYSTEM_PROMPT =
  "You are catchat, a helpful, thoughtful, friendly, and intelligent AI assistant. Use markdown formatting where helpful.";
const MAX_SESSIONS_PER_CLIENT = 100;

/* ---------- MySQL Database Connection Pool ---------- */
const dbSocketPath = process.env.DB_SOCKET || (!process.env.DB_HOST ? path.join(DATA_DIR, "mysql.sock") : undefined);

const DB_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3307,
  ...(dbSocketPath ? { socketPath: dbSocketPath } : {}),
  user: process.env.DB_USER || "catbot",
  password: process.env.DB_PASSWORD || "catbot_secret",
  database: process.env.DB_NAME || "catchat_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

let pool = null;

async function initDb() {
  try {
    pool = mysql.createPool(DB_CONFIG);
    const [rows] = await pool.query("SELECT 1 as connected");
    console.log("Connected to MySQL/MariaDB database: catchat_db");
    return true;
  } catch (err) {
    console.warn("Could not connect to MySQL (" + err.message + "), falling back to file storage.");
    pool = null;
    return false;
  }
}

async function getUserApiKey(clientId) {
  if (pool) {
    try {
      if (clientId && clientId !== "__default__") {
        const [rows] = await pool.query(
          "SELECT api_key FROM user_keys WHERE client_id = ? LIMIT 1",
          [clientId]
        );
        if (rows.length && rows[0].api_key) return rows[0].api_key;
      }
      // Check for default key stored in database
      const [defRows] = await pool.query(
        "SELECT api_key FROM user_keys WHERE client_id = '__default__' LIMIT 1"
      );
      if (defRows.length && defRows[0].api_key) return defRows[0].api_key;
    } catch (e) {
      console.error("DB error fetching API key:", e.message);
    }
  }
  return SERVER_KEY || null;
}

async function hasCustomApiKey(clientId) {
  if (pool && clientId && clientId !== "__default__") {
    try {
      const [rows] = await pool.query(
        "SELECT 1 FROM user_keys WHERE client_id = ? LIMIT 1",
        [clientId]
      );
      return rows.length > 0;
    } catch {}
  }
  return false;
}

async function saveUserApiKey(clientId, apiKey) {
  if (pool) {
    await pool.query(
      "INSERT INTO user_keys (client_id, api_key) VALUES (?, ?) ON DUPLICATE KEY UPDATE api_key = ?",
      [clientId, apiKey, apiKey]
    );
    return true;
  }
  return false;
}

async function deleteUserApiKey(clientId) {
  if (pool) {
    await pool.query("DELETE FROM user_keys WHERE client_id = ? AND client_id != '__default__'", [clientId]);
    return true;
  }
  return false;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "20mb" })); // images are sent inline as base64

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

/* ---------- Rate limiting (in-memory, per IP) ---------- */
const hits = new Map();
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [ip, times] of hits) {
    const fresh = times.filter((t) => t > cutoff);
    fresh.length ? hits.set(ip, fresh) : hits.delete(ip);
  }
}, 60_000).unref();

function rateLimit(req, res, next) {
  const now = Date.now();
  const times = (hits.get(req.ip) || []).filter((t) => t > now - 60_000);
  if (times.length >= RATE_LIMIT) {
    res.setHeader("Retry-After", "60");
    return res
      .status(429)
      .json({ error: { code: "RATE_LIMITED", message: "Too many requests. Try again in a minute." } });
  }
  times.push(now);
  hits.set(req.ip, times);
  next();
}

/* ---------- Chat proxy ---------- */
function validContents(contents) {
  if (!Array.isArray(contents) || contents.length === 0 || contents.length > 40) return false;
  return contents.every(
    (c) =>
      c &&
      (c.role === "user" || c.role === "model") &&
      Array.isArray(c.parts) &&
      c.parts.length > 0 &&
      c.parts.every(
        (p) =>
          (typeof p.text === "string" && p.text.length <= 100_000) ||
          (p.inlineData &&
            typeof p.inlineData.mimeType === "string" &&
            p.inlineData.mimeType.startsWith("image/") &&
            typeof p.inlineData.data === "string"),
      ),
  );
}

/* ---------- AI Providers & Auto-Failover Engine ---------- */

function isQuotaOrExhaustionError(status, message) {
  const lower = String(message || "").toLowerCase();
  return (
    status === 429 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    lower.includes("quota") ||
    lower.includes("resource_exhausted") ||
    lower.includes("rate_limit") ||
    lower.includes("rate limit") ||
    lower.includes("credit") ||
    lower.includes("token") ||
    lower.includes("high demand") ||
    lower.includes("overloaded") ||
    lower.includes("capacity") ||
    lower.includes("unavailable") ||
    lower.includes("no longer available") ||
    lower.includes("not found") ||
    lower.includes("free tier limit") ||
    lower.includes("exceeded") ||
    lower.includes("busy")
  );
}

// 1. Google Gemini
async function callGemini(modelName, contents, key) {
  try {
    const upstream = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        }),
        signal: AbortSignal.timeout(45_000),
      }
    );
    const data = await upstream.json().catch(() => ({}));
    if (upstream.ok && !data.error) {
      const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
      if (text) return { ok: true, text, model: modelName, provider: "Gemini" };
    }
    const errMsg = data.error?.message || `HTTP ${upstream.status}`;
    return { ok: false, status: upstream.status, message: errMsg };
  } catch (err) {
    return { ok: false, status: 504, message: err.message };
  }
}

// 2. Groq Cloud
async function callGroq(modelName, contents, key) {
  try {
    const groqModel =
      modelName.includes("gpt-oss") || modelName.includes("qwen") || modelName.includes("allam")
        ? modelName
        : "openai/gpt-oss-120b";
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...contents.map((c) => ({
        role: c.role === "model" ? "assistant" : "user",
        content: c.parts.map((p) => p.text || "").join("\n"),
      })),
    ];
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: groqModel, messages, temperature: 0.7 }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await upstream.json().catch(() => ({}));
    if (upstream.ok && data.choices?.[0]?.message?.content) {
      return { ok: true, text: data.choices[0].message.content, model: groqModel, provider: "Groq" };
    }
    return { ok: false, status: upstream.status, message: data.error?.message || `Groq HTTP ${upstream.status}` };
  } catch (err) {
    return { ok: false, status: 504, message: err.message };
  }
}

// 3. OpenRouter (Auto-failover target)
async function callOpenRouter(modelName, contents, key) {
  try {
    const routerModel =
      modelName.startsWith("google/") || modelName.startsWith("meta-llama/") || modelName.startsWith("deepseek/")
        ? modelName
        : "google/gemini-2.0-flash-exp:free";
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...contents.map((c) => ({
        role: c.role === "model" ? "assistant" : "user",
        content: c.parts.map((p) => p.text || "").join("\n"),
      })),
    ];
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
        "HTTP-Referer": "http://localhost:8085",
        "X-Title": "catchat",
      },
      body: JSON.stringify({ model: routerModel, messages, temperature: 0.7 }),
      signal: AbortSignal.timeout(35_000),
    });
    const data = await upstream.json().catch(() => ({}));
    if (upstream.ok && data.choices?.[0]?.message?.content) {
      return { ok: true, text: data.choices[0].message.content, model: routerModel, provider: "OpenRouter" };
    }
    return { ok: false, status: upstream.status, message: data.error?.message || `OpenRouter HTTP ${upstream.status}` };
  } catch (err) {
    return { ok: false, status: 504, message: err.message };
  }
}

// 4. Cohere
async function callCohere(modelName, contents, key) {
  try {
    const cohereModel = modelName.startsWith("command-") ? modelName : "command-r-08-2024";
    const messages = contents.map((c) => ({
      role: c.role === "model" ? "assistant" : "user",
      content: c.parts.map((p) => p.text || "").join("\n"),
    }));
    const upstream = await fetch("https://api.cohere.com/v2/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: cohereModel, messages }),
      signal: AbortSignal.timeout(35_000),
    });
    const data = await upstream.json().catch(() => ({}));
    if (upstream.ok && data.message?.content?.[0]?.text) {
      return { ok: true, text: data.message.content[0].text, model: cohereModel, provider: "Cohere" };
    }
    return { ok: false, status: upstream.status, message: data.message || `Cohere HTTP ${upstream.status}` };
  } catch (err) {
    return { ok: false, status: 504, message: err.message };
  }
}

// 5. Hugging Face
async function callHuggingFace(modelName, contents, key) {
  try {
    const hfModel = modelName.includes("/") ? modelName : "meta-llama/Llama-3.2-3B-Instruct";
    const prompt = contents.map((c) => `${c.role === "model" ? "Assistant" : "User"}: ${c.parts.map((p) => p.text || "").join("\n")}`).join("\n") + "\nAssistant:";
    const upstream = await fetch(`https://api-inference.huggingface.co/models/${hfModel}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 512 } }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await upstream.json().catch(() => ({}));
    const text = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
    if (upstream.ok && text) {
      return { ok: true, text, model: hfModel, provider: "Hugging Face" };
    }
    return { ok: false, status: upstream.status, message: data.error || `Hugging Face HTTP ${upstream.status}` };
  } catch (err) {
    return { ok: false, status: 504, message: err.message };
  }
}

app.post("/api/chat", rateLimit, async (req, res) => {
  const { model: requestedModel, contents } = req.body || {};
  const reqClientId = req.get("x-client-id") || "";

  // Auto-remap deprecated/offline models to working Gemini 3.5 Flash / Groq / Cohere
  const MODEL_ALIASES = {
    "gemini-2.0-flash": "gemini-3.5-flash",
    "gemini-2.0-flash-lite": "gemini-3.5-flash-lite",
    "gemini-2.5-flash": "gemini-3.5-flash",
    "gemini-2.5-pro": "gemini-3.8-pro",
    "llama-3.3-70b-versatile": "openai/gpt-oss-120b",
    "llama-3.1-8b-instant": "qwen/qwen3.8-27b",
    "command-r": "command-r-08-2024",
  };
  const model = MODEL_ALIASES[requestedModel] || requestedModel;

  // Priority: User's stored DB key -> Visitor header key -> Server environment key
  let userGeminiKey = "";
  if (reqClientId) {
    userGeminiKey = await getUserApiKey(reqClientId);
  }
  if (!userGeminiKey) {
    userGeminiKey = String(req.get("x-gemini-key") || "").trim() || SERVER_KEY;
  }

  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: { code: "BAD_MODEL", message: "Unsupported model." } });
  }
  if (!validContents(contents)) {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid message payload." } });
  }

  // Model classifications
  const isGroqModel = model.includes("gpt-oss") || model.includes("qwen") || model.includes("llama") || model.includes("gemma");
  const isOpenRouterModel = model.startsWith("google/") || model.startsWith("deepseek/") || model.startsWith("openrouter/");
  const isCohereModel = model.startsWith("command");
  const isHfModel = model.includes("/") && !isOpenRouterModel && !isGroqModel;

  // Build execution pipeline: Primary attempt first, followed by automatic failovers
  const attempts = [];

  // Primary attempt based on model requested
  if (isGroqModel && GROQ_API_KEY) {
    attempts.push({ name: "Groq", fn: () => callGroq(model, contents, GROQ_API_KEY) });
  } else if (isOpenRouterModel && OPENROUTER_API_KEY) {
    attempts.push({ name: "OpenRouter", fn: () => callOpenRouter(model, contents, OPENROUTER_API_KEY) });
  } else if (isCohereModel && COHERE_API_KEY) {
    attempts.push({ name: "Cohere", fn: () => callCohere(model, contents, COHERE_API_KEY) });
  } else if (isHfModel && HUGGINGFACE_API_KEY) {
    attempts.push({ name: "Hugging Face", fn: () => callHuggingFace(model, contents, HUGGINGFACE_API_KEY) });
  } else if (userGeminiKey) {
    attempts.push({ name: "Gemini", fn: () => callGemini(model, contents, userGeminiKey) });
    if (model !== "gemini-3.5-flash") {
      attempts.push({ name: "Gemini (3.5-flash)", fn: () => callGemini("gemini-3.5-flash", contents, userGeminiKey) });
    }
    attempts.push({ name: "Gemini (flash-lite)", fn: () => callGemini("gemini-flash-lite-latest", contents, userGeminiKey) });
  }

  // --- AUTOMATIC FAILOVER PROVIDERS (If token runs out / errors) ---
  // 1. Auto-switch to Groq Cloud if primary was not Groq
  if (GROQ_API_KEY && !isGroqModel) {
    attempts.push({ name: "Groq (Auto-Switch)", fn: () => callGroq("openai/gpt-oss-120b", contents, GROQ_API_KEY) });
  }
  // 2. Auto-switch to OpenRouter if primary was not OpenRouter
  if (OPENROUTER_API_KEY && !isOpenRouterModel) {
    attempts.push({ name: "OpenRouter (Auto-Switch)", fn: () => callOpenRouter("google/gemini-2.0-flash-exp:free", contents, OPENROUTER_API_KEY) });
  }
  // 3. Auto-switch to Cohere if primary was not Cohere
  if (COHERE_API_KEY && !isCohereModel) {
    attempts.push({ name: "Cohere (Auto-Switch)", fn: () => callCohere("command-r-08-2024", contents, COHERE_API_KEY) });
  }
  // 4. Auto-switch to Gemini if primary was a non-Gemini provider
  if (userGeminiKey && (isGroqModel || isOpenRouterModel || isCohereModel)) {
    attempts.push({ name: "Gemini (Auto-Switch)", fn: () => callGemini("gemini-3.5-flash", contents, userGeminiKey) });
  }

  if (attempts.length === 0) {
    return res.status(401).json({
      error: { code: "NO_API_KEY", message: "No active API key found for this model or in environment (.env)." },
    });
  }

  let lastError = null;
  let lastStatus = 502;
  let attemptCount = 0;

  for (const step of attempts) {
    attemptCount++;
    const result = await step.fn();
    if (result.ok && result.text) {
      const switched = attemptCount > 1;
      if (switched) {
        console.warn(`[catchat] Auto-switched to ${step.name} (${result.model}) because primary provider token was exhausted or busy.`);
      }
      return res.json({
        text: result.text,
        usedModel: result.model,
        provider: result.provider,
        switched,
        originalModel: requestedModel,
        switchReason: switched ? `Primary provider tokens exhausted or unavailable. Auto-switched to ${result.provider} (${result.model}).` : undefined,
      });
    }

    lastError = result.message || `Provider ${step.name} failed`;
    lastStatus = result.status || 502;
    console.warn(`[catchat] Step ${step.name} error: "${result.message}". Triggering next fallback provider...`);

    if (!isQuotaOrExhaustionError(result.status, result.message) && attemptCount === 1) {
      if (result.status === 400 && !result.message.toLowerCase().includes("not found")) {
        break;
      }
    }
  }

  res.status(lastStatus).json({
    error: {
      code: "ALL_PROVIDERS_EXHAUSTED",
      message: lastError || "All configured AI providers exhausted or unavailable. Please check your API keys.",
    },
  });
});

/* ---------- User API Key Endpoints (MySQL DB) ---------- */
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function clientId(req, res, next) {
  const id = req.get("x-client-id") || "";
  if (!ID_RE.test(id)) {
    return res.status(400).json({ error: { code: "BAD_CLIENT", message: "Missing or invalid X-Client-Id." } });
  }
  req.clientId = id;
  next();
}

app.get("/api/key", clientId, async (req, res) => {
  const isCustom = await hasCustomApiKey(req.clientId);
  const key = await getUserApiKey(req.clientId);
  if (!key) {
    return res.json({ hasKey: false, source: "none", isDefault: false });
  }
  const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****";
  res.json({
    hasKey: true,
    masked,
    source: isCustom ? "database" : "default",
    isDefault: !isCustom,
  });
});

app.post("/api/key/default", async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
    return res.status(400).json({ error: { code: "BAD_KEY", message: "Invalid API key format." } });
  }
  await saveUserApiKey("__default__", apiKey.trim());
  res.json({ ok: true, message: "Default system API key updated in MySQL database." });
});

app.post("/api/key", clientId, async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey || typeof apiKey !== "string" || apiKey.trim().length < 10) {
    return res.status(400).json({ error: { code: "BAD_KEY", message: "Invalid API key format." } });
  }
  await saveUserApiKey(req.clientId, apiKey.trim());
  res.json({ ok: true, message: "API key stored securely in MySQL database." });
});

app.delete("/api/key", clientId, async (req, res) => {
  await deleteUserApiKey(req.clientId);
  res.json({ ok: true, message: "API key removed from MySQL database." });
});

/* ---------- Session storage (MySQL primary, JSON file fallback) ---------- */
let db = {}; // in-memory/JSON fallback
let writeChain = Promise.resolve();

async function loadDb() {
  await mkdir(DATA_DIR, { recursive: true });
  try {
    db = JSON.parse(await readFile(DATA_FILE, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Could not read sessions.json, starting empty:", err.message);
    db = {};
  }
}

function persist() {
  writeChain = writeChain
    .then(async () => {
      const tmp = DATA_FILE + ".tmp";
      await writeFile(tmp, JSON.stringify(db));
      await rename(tmp, DATA_FILE);
    })
    .catch((err) => console.error("Persist failed:", err.message));
  return writeChain;
}

function sanitizeSession(body) {
  if (!body || typeof body.title !== "string" || !Array.isArray(body.messages)) return null;
  if (body.messages.length > 500) return null;
  return {
    title: body.title.slice(0, 120),
    updatedAt: Date.now(),
    messages: body.messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      text: typeof m.text === "string" ? m.text.slice(0, 100_000) : "",
      rawText: typeof m.rawText === "string" ? m.rawText.slice(0, 200_000) : undefined,
      html: typeof m.html === "string" ? m.html.slice(0, 400_000) : undefined,
    })),
  };
}

app.get("/api/sessions", clientId, async (req, res) => {
  if (pool) {
    try {
      const [sessionRows] = await pool.query(
        "SELECT id, title, updated_at as updatedAt FROM sessions WHERE client_id = ? ORDER BY updated_at DESC LIMIT ?",
        [req.clientId, MAX_SESSIONS_PER_CLIENT]
      );
      if (!sessionRows.length) return res.json({ sessions: [] });

      const sessionIds = sessionRows.map((s) => s.id);
      const [msgRows] = await pool.query(
        "SELECT session_id, role, text, raw_text as rawText, html FROM messages WHERE session_id IN (?) ORDER BY id ASC",
        [sessionIds]
      );

      const msgMap = {};
      for (const m of msgRows) {
        (msgMap[m.session_id] ||= []).push({
          role: m.role,
          text: m.text,
          rawText: m.rawText,
          html: m.html,
        });
      }

      const list = sessionRows.map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: Number(s.updatedAt),
        messages: msgMap[s.id] || [],
      }));
      return res.json({ sessions: list });
    } catch (err) {
      console.error("MySQL query sessions failed, fallback to memory/json:", err.message);
    }
  }

  const list = Object.entries(db[req.clientId] || {})
    .map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ sessions: list });
});

app.put("/api/sessions/:id", clientId, async (req, res) => {
  if (!ID_RE.test(req.params.id)) {
    return res.status(400).json({ error: { code: "BAD_ID", message: "Invalid session id." } });
  }
  const session = sanitizeSession(req.body);
  if (!session) {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid session payload." } });
  }

  if (pool) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        "INSERT INTO sessions (id, client_id, title, updated_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE title = ?, updated_at = ?",
        [req.params.id, req.clientId, session.title, session.updatedAt, session.title, session.updatedAt]
      );
      await conn.query("DELETE FROM messages WHERE session_id = ?", [req.params.id]);
      if (session.messages.length) {
        const values = session.messages.map((m) => [
          req.params.id,
          m.role,
          m.text || "",
          m.rawText || null,
          m.html || null,
        ]);
        await conn.query(
          "INSERT INTO messages (session_id, role, text, raw_text, html) VALUES ?",
          [values]
        );
      }
      await conn.commit();
      return res.json({ ok: true, source: "mysql" });
    } catch (err) {
      await conn.rollback();
      console.error("MySQL session save error, falling back to JSON:", err.message);
    } finally {
      conn.release();
    }
  }

  const mine = (db[req.clientId] ||= {});
  if (!mine[req.params.id] && Object.keys(mine).length >= MAX_SESSIONS_PER_CLIENT) {
    return res.status(409).json({ error: { code: "LIMIT", message: "Conversation limit reached." } });
  }
  mine[req.params.id] = session;
  await persist();
  res.json({ ok: true, source: "file" });
});

app.delete("/api/sessions/:id", clientId, async (req, res) => {
  if (pool) {
    try {
      await pool.query("DELETE FROM sessions WHERE id = ? AND client_id = ?", [req.params.id, req.clientId]);
    } catch (err) {
      console.error("MySQL delete session error:", err.message);
    }
  }
  if (db[req.clientId]?.[req.params.id]) {
    delete db[req.clientId][req.params.id];
    await persist();
  }
  res.json({ ok: true });
});

app.get("/api/health", async (_req, res) => {
  let dbStatus = "disconnected";
  if (pool) {
    try {
      await pool.query("SELECT 1");
      dbStatus = "mysql_connected";
    } catch {
      dbStatus = "error";
    }
  }
  res.json({ ok: true, database: dbStatus, serverKey: Boolean(SERVER_KEY) });
});

/* ---------- Static frontend ---------- */
app.use(express.static(__dirname));

/* ---------- Errors ---------- */
app.use("/api", (_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Not found." } }));
app.use((err, _req, res, _next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: { code: "TOO_LARGE", message: "Request is too large." } });
  }
  if (err.type === "entity.parse.failed") {
    return res.status(400).json({ error: { code: "BAD_JSON", message: "Malformed JSON." } });
  }
  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL", message: "Something went wrong." } });
});

await loadDb();
await initDb();

const SOCK_FILE = path.join(DATA_DIR, "backend.sock");
try {
  await unlink(SOCK_FILE);
} catch {}

app.listen(SOCK_FILE, () => {
  console.log(`catchat backend listening on unix socket: ${SOCK_FILE}`);
});

app.listen(PORT, () => {
  console.log(`catchat backend listening on http://localhost:${PORT}`);
  if (!SERVER_KEY) console.log("Users can store their Gemini API key in MySQL via the UI modal.");
});
