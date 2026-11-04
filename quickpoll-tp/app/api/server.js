// QuickPoll API — Node 22, sans framework
const http = require("node:http");
const fs = require("node:fs");
const { Pool } = require("pg");
const { createClient } = require("redis");

const VERSION = process.env.APP_VERSION || "v1";
const BROKEN = process.env.BREAK_HEALTH === "true"; // v3 volontairement cassée
const PORT = 3000;

// Le mot de passe peut venir d'une variable OU d'un fichier (docker secret)
function dbPassword() {
  if (process.env.DB_PASSWORD_FILE) {
    return fs.readFileSync(process.env.DB_PASSWORD_FILE, "utf8").trim();
  }
  return process.env.DB_PASSWORD;
}

const pool = new Pool({
  host: process.env.DB_HOST || "postgres",
  user: process.env.DB_USER || "quickpoll",
  database: process.env.DB_NAME || "quickpoll",
  password: dbPassword(),
});
const redis = createClient({ url: process.env.REDIS_URL || "redis://redis:6379" });

const OPTIONS = ["swarm", "kubernetes", "nomad"];

async function init() {
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS votes (
        id SERIAL PRIMARY KEY,
        vote_id TEXT UNIQUE NOT NULL,
        option TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )`);
      await redis.connect();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      // Un connect() échoué laisse le socket ouvert : le fermer pour pouvoir réessayer
      if (redis.isOpen) await redis.disconnect().catch(() => {});
      const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
      console.error(`init attempt ${attempt}/${maxAttempts} failed: ${err.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function send(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === "/api/health") {
      if (BROKEN) return send(res, 500, { status: "ko" });
      await pool.query("SELECT 1");
      return send(res, 200, { status: "ok" });
    }
    if (req.url === "/api/version") {
      return send(res, 200, { version: VERSION, host: require("node:os").hostname() });
    }
    if (req.url === "/api/results" && req.method === "GET") {
      const { rows } = await pool.query(
        "SELECT option, COUNT(*)::int AS count FROM votes GROUP BY option ORDER BY option"
      );
      return send(res, 200, { version: VERSION, results: rows });
    }
    if (req.url === "/api/vote" && req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const { option } = JSON.parse(raw || "{}");
      if (!OPTIONS.includes(option)) return send(res, 400, { error: "option inconnue" });
      const vote = { vote_id: crypto.randomUUID(), option };
      await redis.lPush("votes", JSON.stringify(vote));
      return send(res, 202, { queued: vote.vote_id });
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

init()
  .then(() => server.listen(PORT, () => console.log(`api ${VERSION} listening on ${PORT}`)))
  .catch((err) => {
    console.error("init failed:", err.message);
    process.exit(1);
  });

process.on("SIGTERM", () => server.close(() => process.exit(0)));
