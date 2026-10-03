import express from "express";
import mysql from "mysql2/promise";
import { readFile, writeFile, rename, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const SERVER_KEY = process.env.GEMINI_API_KEY || "";
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MIN) || 20;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "sessions.json");

const ALLOWED_MODELS = new Set([
  "gemini-3.8-flash",
  "gemini-3.8-pro",
  "gemini-2.5-flash",
  "gemini-2.5-pro",
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
]);
const SYSTEM_PROMPT =
  "You are catchat, a helpful, thoughtful, friendly, and intelligent AI assistant. Use markdown formatting where helpful.";
const MAX_SESSIONS_PER_CLIENT = 100;

/* ---------- MySQL Database Connection Pool ---------- */
const DB_CONFIG = {
  host: process.env.DB_HOST || "127.0.0.1",
  port: Number(process.env.DB_PORT) || 3307,
  socketPath: process.env.DB_SOCKET || path.join(DATA_DIR, "mysql.sock"),
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
      const [rows] = await pool.query(
        "SELECT api_key FROM user_keys WHERE client_id = ? LIMIT 1",
        [clientId]
      );
      if (rows.length && rows[0].api_key) return rows[0].api_key;
    } catch (e) {
      console.error("DB error fetching API key:", e.message);
    }
  }
  return null;
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
    await pool.query("DELETE FROM user_keys WHERE client_id = ?", [clientId]);
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

app.post("/api/chat", rateLimit, async (req, res) => {
  const { model: requestedModel, contents } = req.body || {};
  const reqClientId = req.get("x-client-id") || "";

  // Auto-remap deprecated models to current Gemini 3.8 models
  const MODEL_ALIASES = {
    "gemini-2.5-flash": "gemini-3.8-flash",
    "gemini-2.5-pro": "gemini-3.8-pro",
  };
  const model = MODEL_ALIASES[requestedModel] || requestedModel;

  // Priority: User's stored DB key -> Visitor header key -> Server environment key
  let apiKey = "";
  if (reqClientId) {
    apiKey = await getUserApiKey(reqClientId);
  }
  if (!apiKey) {
    apiKey = String(req.get("x-gemini-key") || "").trim() || SERVER_KEY;
  }

  if (!apiKey) {
    return res.status(401).json({
      error: { code: "NO_API_KEY", message: "No Gemini API key found in database or server configuration." },
    });
  }
  if (!ALLOWED_MODELS.has(model)) {
    return res.status(400).json({ error: { code: "BAD_MODEL", message: "Unsupported model." } });
  }
  if (!validContents(contents)) {
    return res.status(400).json({ error: { code: "BAD_REQUEST", message: "Invalid message payload." } });
  }

  // Model fallback order in case of high demand / temporary capacity spikes
  const candidateModels = [
    model,
    ...(model !== "gemini-2.0-flash" ? ["gemini-2.0-flash"] : []),
    ...(model !== "gemini-2.0-flash-lite" ? ["gemini-2.0-flash-lite"] : []),
  ];

  let lastError = null;
  let lastStatus = 502;

  for (const modelToTry of candidateModels) {
    try {
      const upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelToTry}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({
            contents,
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );
      const data = await upstream.json().catch(() => ({}));

      if (upstream.ok && !data.error) {
        const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
        if (text) {
          return res.json({
            text,
            usedModel: modelToTry,
            switched: modelToTry !== model,
          });
        }
      }

      const errMsg = String(data.error?.message || "");
      const lower = errMsg.toLowerCase();
      const isCapacityIssue =
        upstream.status === 503 ||
        upstream.status === 429 ||
        lower.includes("high demand") ||
        lower.includes("overloaded") ||
        lower.includes("capacity") ||
        lower.includes("resource_exhausted") ||
        lower.includes("unavailable");

      lastError = errMsg || `Gemini returned HTTP ${upstream.status}`;
      lastStatus = upstream.status === 200 ? 502 : upstream.status;

      if (!isCapacityIssue) {
        // If it's bad authentication or quota error, don't keep retrying other models
        break;
      }
      console.warn(`[catchat] Model ${modelToTry} busy: "${errMsg}". Retrying with next available model...`);
    } catch (err) {
      const timedOut = err.name === "TimeoutError";
      lastError = timedOut ? "Gemini took too long to respond." : "Could not reach Gemini.";
      lastStatus = timedOut ? 504 : 502;
    }
  }

  res.status(lastStatus).json({
    error: {
      code: "UPSTREAM_ERROR",
      message: lastError || "Failed to generate reply from Gemini.",
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
  const key = await getUserApiKey(req.clientId);
  if (!key) {
    return res.json({ hasKey: false, source: SERVER_KEY ? "server" : "none" });
  }
  const masked = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : "****";
  res.json({ hasKey: true, masked, source: "database" });
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
