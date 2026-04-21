import { existsSync, readFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeEspnCommentary } from "./espn-cricket-commentary.mjs";
import { fetchBtcPriceSnapshot, renderBtcPage } from "./btc-page.mjs";

const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MATCH_URL =
  "https://www.espn.com/cricket/series/1529136/commentary/1529146/namibia-vs-scotland-2nd-t20i-24279";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOME_PAGE_PATH = path.join(__dirname, "web", "index.html");
const ACTIVE_MARKET_PATH = path.join(__dirname, "active-market.txt");
const LOG_PATH = path.join(__dirname, "activity.log");
const LOCAL_ENV_PATH = path.join(__dirname, ".env");

function loadLocalEnvFile() {
  if (!existsSync(LOCAL_ENV_PATH)) {
    return;
  }

  try {
    const raw = readFileSync(LOCAL_ENV_PATH, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const equalsIndex = trimmed.indexOf("=");
      if (equalsIndex <= 0) {
        continue;
      }

      const key = trimmed.slice(0, equalsIndex).trim();
      let value = trimmed.slice(equalsIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // Ignore local env load failures.
  }
}

loadLocalEnvFile();
const DATABASE_URL = process.env.DATABASE_URL || process.env.POSTGRES_URL || null;
const POSTGRES_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS app_events (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    source TEXT NOT NULL,
    event TEXT NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb
  )`,
  `CREATE TABLE IF NOT EXISTS scrape_runs (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_url TEXT NOT NULL,
    scraped_at TIMESTAMPTZ NULL,
    cached BOOLEAN NOT NULL DEFAULT FALSE,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS live_snapshots (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_url TEXT NOT NULL,
    reason TEXT NULL,
    payload JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS user_bets (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_url TEXT NOT NULL,
    target_ball_id TEXT NULL,
    target_ball_label TEXT NULL,
    pick TEXT NOT NULL,
    selected_picks JSONB NOT NULL DEFAULT '[]'::jsonb
  )`,
  `CREATE TABLE IF NOT EXISTS bet_settlements (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    market_url TEXT NOT NULL,
    target_ball_id TEXT NULL,
    actual TEXT NOT NULL,
    result TEXT NOT NULL,
    selected_picks JSONB NOT NULL DEFAULT '[]'::jsonb,
    message TEXT NULL
  )`,
];

const cache = new Map();
const liveJobs = new Map();
const sseClients = new Set();
let postgresPoolPromise = null;
let postgresSchemaPromise = null;
let postgresReady = false;
let postgresInitFailed = false;
const gameState = {
  marketUrl: null,
  wins: 0,
  losses: 0,
  selectedPicks: [],
  selectionBallId: null,
  targetBallId: null,
  targetBallLabel: null,
  resolvedBallId: null,
  lastResult: "Make your move for the next delivery.",
  lastResultType: "neutral",
};
let logWriteChain = Promise.resolve();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS,POST",
    "access-control-allow-headers": "content-type",
  });
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS,POST",
    "access-control-allow-headers": "content-type",
  });
  response.end(html);
}

function sendSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function shouldUsePostgresSsl(connectionString) {
  if (process.env.PGSSLMODE === "require") {
    return true;
  }

  try {
    const url = new URL(connectionString);
    return !["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function getPostgresPool() {
  if (!DATABASE_URL) {
    return null;
  }

  if (!postgresPoolPromise) {
    postgresPoolPromise = (async () => {
      try {
        const { Pool } = await import("pg");
        const pool = new Pool({
          connectionString: DATABASE_URL,
          ssl: shouldUsePostgresSsl(DATABASE_URL)
            ? { rejectUnauthorized: false }
            : undefined,
        });
        return pool;
      } catch (error) {
        if (!postgresInitFailed) {
          postgresInitFailed = true;
          void logServer("postgres_disabled", {
            message: error.message,
          });
        }
        return null;
      }
    })();
  }

  return postgresPoolPromise;
}

async function ensurePostgresSchema() {
  const pool = await getPostgresPool();
  if (!pool) {
    return null;
  }

  if (!postgresSchemaPromise) {
    postgresSchemaPromise = (async () => {
      for (const statement of POSTGRES_SCHEMA) {
        await pool.query(statement);
      }
      postgresReady = true;
      return pool;
    })().catch((error) => {
      postgresSchemaPromise = null;
      postgresReady = false;
      if (!postgresInitFailed) {
        postgresInitFailed = true;
        void logServer("postgres_disabled", {
          message: error.message,
        });
      }
      return null;
    });
  }

  return postgresSchemaPromise;
}

async function persistPostgresEvent(source, event, details) {
  const pool = await ensurePostgresSchema();
  if (!pool) {
    return;
  }

  try {
    await pool.query(
      `INSERT INTO app_events (source, event, details) VALUES ($1, $2, $3::jsonb)`,
      [source, event, JSON.stringify(details ?? {})],
    );
  } catch {
    // Keep the app running if the database is unavailable.
  }
}

async function persistScrapeRun(marketUrl, scrapedAt, cached, fetchedAt, payload) {
  const pool = await ensurePostgresSchema();
  if (!pool) {
    return;
  }

  try {
    await pool.query(
      `INSERT INTO scrape_runs (market_url, scraped_at, cached, fetched_at, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        marketUrl,
        scrapedAt || null,
        Boolean(cached),
        fetchedAt || new Date().toISOString(),
        JSON.stringify(payload ?? {}),
      ],
    );
  } catch {
    // Keep the app running if the database is unavailable.
  }
}

async function persistLiveSnapshot(marketUrl, reason, payload) {
  const pool = await ensurePostgresSchema();
  if (!pool) {
    return;
  }

  try {
    await pool.query(
      `INSERT INTO live_snapshots (market_url, reason, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [marketUrl, reason || null, JSON.stringify(payload ?? {})],
    );
  } catch {
    // Keep the app running if the database is unavailable.
  }
}

async function persistUserBet(marketUrl, bet) {
  const pool = await ensurePostgresSchema();
  if (!pool) {
    return;
  }

  try {
    await pool.query(
      `INSERT INTO user_bets (market_url, target_ball_id, target_ball_label, pick, selected_picks)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        marketUrl,
        bet.targetBallId || null,
        bet.targetBallLabel || null,
        bet.pick,
        JSON.stringify(bet.selectedPicks ?? []),
      ],
    );
  } catch {
    // Keep the app running if the database is unavailable.
  }
}

async function persistBetSettlement(marketUrl, settlement) {
  const pool = await ensurePostgresSchema();
  if (!pool) {
    return;
  }

  try {
    await pool.query(
      `INSERT INTO bet_settlements (market_url, target_ball_id, actual, result, selected_picks, message)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        marketUrl,
        settlement.targetBallId || null,
        settlement.actual,
        settlement.result,
        JSON.stringify(settlement.selectedPicks ?? []),
        settlement.message || null,
      ],
    );
  } catch {
    // Keep the app running if the database is unavailable.
  }
}

function broadcastSnapshot(activeUrl, latestData, reason) {
  const snapshot = summarizeLiveScore(latestData);
  snapshot.reason = reason;
  snapshot.activeUrl = activeUrl;

  void persistLiveSnapshot(activeUrl, reason, snapshot);

  for (const client of sseClients) {
    try {
      sendSse(client.response, "snapshot", snapshot);
    } catch {
      sseClients.delete(client);
    }
  }
}

function queueLog(entry) {
  const line = `${JSON.stringify({
    ts: new Date().toISOString(),
    ...entry,
  })}\n`;

  logWriteChain = logWriteChain
    .then(async () => {
      await appendFile(LOG_PATH, line, "utf8");
      await persistPostgresEvent(entry.source || "unknown", entry.event || "unknown", entry.details || {});
    })
    .catch(() => {});

  return logWriteChain;
}

function logServer(event, details = {}) {
  return queueLog({
    source: "server",
    event,
    details,
  });
}

function logUser(event, details = {}) {
  return queueLog({
    source: "user",
    event,
    details,
  });
}

function parseJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100_000) {
        reject(new Error("Request body too large."));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body."));
      }
    });
    request.on("error", reject);
  });
}

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function getEventLabel(item) {
  const shortText = String(item?.shortText || "").toUpperCase();
  if (shortText.includes("OUT")) return "OUT";
  if (shortText.includes("SIX")) return "6";
  if (shortText.includes("FOUR")) return "4";
  if (shortText.includes("WIDE")) return "WD";
  if (shortText.includes("NO BALL")) return "NB";
  const runMatch = shortText.match(/(\d+)\s+RUN/);
  return runMatch ? runMatch[1] : "0";
}

function getNextBallLabel(overValue) {
  if (overValue === null || overValue === undefined || overValue === "") {
    return "next ball";
  }

  const text = String(overValue);
  const parts = text.split(".");
  const over = Number.parseInt(parts[0] || "0", 10);
  const ball = Number.parseInt(parts[1] || "0", 10);

  if (!Number.isFinite(over) || !Number.isFinite(ball)) {
    return "next ball";
  }

  if (ball >= 6) {
    return `${over + 1}.1`;
  }

  return `${over}.${ball + 1}`;
}

async function getActiveMarketUrl() {
  try {
    const configured = await readFile(ACTIVE_MARKET_PATH, "utf8");
    const url = configured.trim();
    return url || DEFAULT_MATCH_URL;
  } catch {
    return DEFAULT_MATCH_URL;
  }
}

async function readRecentLogs(limit = 100) {
  try {
    const raw = await readFile(LOG_PATH, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { ts: null, source: "unknown", event: "parse_error", raw: line };
      }
    });
  } catch {
    return [];
  }
}

function summarizeLiveScore(data) {
  const match = data?.match ?? {};
  const teams = match.teams ?? [];
  const innings = data?.innings ?? [];
  const latestInnings = innings[innings.length - 1] ?? null;
  const latestBall = latestInnings?.commentary?.[latestInnings.commentary.length - 1] ?? null;
  const feed = (latestInnings?.commentary ?? [])
    .slice(-24)
    .reverse()
    .map((item) => ({
      id: item.id ?? null,
      over: item.over ?? null,
      shortText: item.shortText ?? null,
      text: item.text ?? null,
      score: item.inningsScore?.runs !== null && item.inningsScore?.runs !== undefined
        ? `${item.inningsScore.runs}/${item.inningsScore.wickets ?? 0}`
        : item.score ?? null,
      playType: item.playType ?? null,
    }));

  return {
    match: match.name,
    state: match.status?.state ?? null,
    completed: Boolean(match.status?.completed || match.status?.state === "post"),
    status: match.status?.description ?? null,
    statusSummary: match.status?.summary ?? null,
    detail: match.status?.detail ?? null,
    format: match.format ?? null,
    venue: match.venue?.name ?? null,
    score: teams.map((team) => ({
      team: team.team?.abbreviation ?? team.team?.name ?? null,
      score: team.score ?? null,
      winner: Boolean(team.winner),
    })),
    latestOver: latestBall?.over ?? null,
    latestBall: latestBall?.shortText ?? null,
    summary: match.title ?? null,
    result: match.status?.summary ?? match.description ?? match.status?.detail ?? match.title ?? null,
    updatedAt: data?.scrapedAt ?? null,
    feed,
    game: {
      wins: gameState.wins,
      losses: gameState.losses,
      selectedPicks: gameState.selectedPicks,
      selectionBallId: gameState.selectionBallId,
      targetBallId: gameState.targetBallId,
      targetBallLabel: gameState.targetBallLabel,
      lastResult: gameState.lastResult,
      lastResultType: gameState.lastResultType,
    },
  };
}

function renderHomePage() {
  return readFile(HOME_PAGE_PATH, "utf8").then((html) => {
    const config = {
      solanaPayUrl: process.env.SOLANA_PAY_URL || "",
      solanaPayRecipient:
        process.env.SOLANA_PAY_RECIPIENT ||
        "9idsurpeyaXMygRmmnKuwauuB1zEjarj2r6Bjdji4SoK",
    };
    const injected = `<script>window.__APP_CONFIG__ = ${JSON.stringify(config)};</script>`;
    return html.replace("</head>", `${injected}\n</head>`);
  });
}

async function getScrape(url, ttlMs) {
  const cached = cache.get(url);
  const now = Date.now();

  if (cached && now - cached.fetchedAt < ttlMs) {
    return {
      data: cached.data,
      cached: true,
      fetchedAt: new Date(cached.fetchedAt).toISOString(),
    };
  }

  const data = await scrapeEspnCommentary(url);
  cache.set(url, {
    data,
    fetchedAt: now,
  });
  void persistScrapeRun(url, data?.scrapedAt ?? null, false, new Date(now).toISOString(), data);

  return {
    data,
    cached: false,
    fetchedAt: new Date(now).toISOString(),
  };
}

function buildLiveResponse(job) {
  return {
    url: job.url,
    intervalMs: job.intervalMs,
    startedAt: job.startedAt,
    lastUpdatedAt: job.lastUpdatedAt,
    lastError: job.lastError,
    inFlight: job.inFlight,
    hasData: Boolean(job.latest),
    data: job.latest,
  };
}

function getLiveJobSnapshot(url) {
  const job = liveJobs.get(url);
  if (!job || !job.latest) {
    return null;
  }

  return {
    data: job.latest,
    cached: true,
    fetchedAt: job.lastUpdatedAt,
  };
}

function startLiveJob(url, intervalMs) {
  const existing = liveJobs.get(url);
  if (existing) {
    return existing;
  }

  const job = {
    url,
    intervalMs,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: null,
    lastError: null,
    inFlight: false,
    latest: null,
    timer: null,
  };

  async function tick() {
    if (job.inFlight) {
      return;
    }

    job.inFlight = true;
    try {
      const latest = await scrapeEspnCommentary(url);
      job.latest = latest;
      job.lastUpdatedAt = new Date().toISOString();
      job.lastError = null;
      cache.set(url, {
        data: latest,
        fetchedAt: Date.now(),
      });
      void persistScrapeRun(
        url,
        latest?.scrapedAt ?? null,
        false,
        job.lastUpdatedAt,
        latest,
      );
      reconcileGameState(url, latest);
      broadcastSnapshot(url, latest, "tick");
    } catch (error) {
      job.lastError = error.message;
    } finally {
      job.inFlight = false;
    }
  }

  job.timer = setInterval(tick, intervalMs);
  tick();
  void logServer("live_job_started", { url, intervalMs });
  liveJobs.set(url, job);
  return job;
}

function stopLiveJob(url) {
  const job = liveJobs.get(url);
  if (!job) {
    return false;
  }

  clearInterval(job.timer);
  liveJobs.delete(url);
  void logServer("live_job_stopped", { url });
  return true;
}

function resetGameStateForMarket(activeUrl) {
  if (gameState.marketUrl === activeUrl) {
    return;
  }

  gameState.marketUrl = activeUrl;
  gameState.wins = 0;
  gameState.losses = 0;
  gameState.selectedPicks = [];
  gameState.selectionBallId = null;
  gameState.targetBallId = null;
  gameState.targetBallLabel = null;
  gameState.resolvedBallId = null;
  gameState.lastResult = "Make your move for the next delivery.";
  gameState.lastResultType = "neutral";
}

function reconcileGameState(activeUrl, latestData) {
  resetGameStateForMarket(activeUrl);

  const latestFeedItem = latestData?.innings?.[latestData.innings.length - 1]?.commentary?.slice(-1)[0] || null;
  const ended = Boolean(latestData?.match?.status?.completed || latestData?.match?.status?.state === "post");
  const previousTargetBallId = gameState.targetBallId;

  if (!latestFeedItem) {
    return;
  }

  const selectionChanged = latestFeedItem.id !== previousTargetBallId;
  const selectedPicks = gameState.selectedPicks;

  if (ended) {
    if (selectedPicks.length) {
      gameState.lastResultType = "neutral";
      gameState.lastResult = "Match ended before your last pick could resolve.";
    }
    gameState.selectedPicks = [];
    gameState.selectionBallId = null;
    gameState.targetBallId = latestFeedItem.id;
    gameState.targetBallLabel = "match finished";
    return;
  }

  if (selectionChanged) {
      if (gameState.selectionBallId === previousTargetBallId && selectedPicks.length) {
      const actual = getEventLabel(latestFeedItem);
      const won = selectedPicks.includes(actual);
      gameState.resolvedBallId = latestFeedItem.id;
      gameState.wins += won ? 1 : 0;
      gameState.losses += won ? 0 : 1;
      gameState.lastResultType = won ? "win" : "lose";
      gameState.lastResult = won
        ? `Correct! It was ${actual}`
        : `Missed! It was ${actual}`;
      void logServer("settlement", {
        targetBallId: previousTargetBallId,
        selectedPicks: [...selectedPicks],
        actual,
        result: won ? "win" : "lose",
        message: gameState.lastResult,
      });
      void persistBetSettlement(activeUrl, {
        targetBallId: previousTargetBallId,
        selectedPicks: [...selectedPicks],
        actual,
        result: won ? "win" : "lose",
        message: gameState.lastResult,
      });
    } else {
      gameState.lastResultType = "neutral";
      gameState.lastResult = "Make your move for the next delivery.";
    }

    gameState.selectedPicks = [];
    gameState.selectionBallId = latestFeedItem.id;
  } else if (!gameState.selectionBallId) {
    gameState.selectionBallId = latestFeedItem.id;
  }

  gameState.targetBallId = latestFeedItem.id;
  gameState.targetBallLabel = getNextBallLabel(latestFeedItem.over);

  if (latestFeedItem.id !== previousTargetBallId) {
    void logServer("active_ball", {
      targetBallId: latestFeedItem.id,
      targetBallLabel: gameState.targetBallLabel,
      over: latestFeedItem.over,
      playType: latestFeedItem.playType,
    });
  }
}

async function ensureActiveMarketJob() {
  const activeUrl = await getActiveMarketUrl();

  for (const url of [...liveJobs.keys()]) {
    if (url !== activeUrl) {
      stopLiveJob(url);
    }
  }

  startLiveJob(activeUrl, DEFAULT_POLL_INTERVAL_MS);
  return activeUrl;
}

async function handleRequest(request, response) {
  if (!request.url) {
    sendJson(response, 400, { error: "Missing request URL." });
    return;
  }

  if (request.method === "OPTIONS") {
    response.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS,POST",
      "access-control-allow-headers": "content-type",
    });
    response.end();
    return;
  }

  const requestUrl = new URL(request.url, "http://127.0.0.1");
  const activeUrl = await ensureActiveMarketJob();
  const activeSnapshot = getLiveJobSnapshot(activeUrl) || (await getScrape(activeUrl, DEFAULT_CACHE_TTL_MS));
  reconcileGameState(activeUrl, activeSnapshot.data);

  if (request.method === "POST" && requestUrl.pathname === "/activity-log") {
    try {
      const body = await parseJsonBody(request);
      const details = body.details && typeof body.details === "object" ? { ...body.details } : {};
      await logUser(String(body.event || "unknown"), {
        ...details,
        serverPath: requestUrl.pathname,
      });
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method === "POST" && requestUrl.pathname === "/pick") {
    try {
      const body = await parseJsonBody(request);
      const pick = String(body.pick || "").toUpperCase();
      const validPicks = new Set(["0", "1", "2", "3", "4", "6", "WD", "NB", "OUT"]);
      if (!validPicks.has(pick)) {
        sendJson(response, 400, { error: "Invalid pick." });
        return;
      }

      if (activeSnapshot.data?.match?.status?.completed || activeSnapshot.data?.match?.status?.state === "post") {
        sendJson(response, 409, { error: "Match already ended." });
        return;
      }

      if (!gameState.selectionBallId) {
        gameState.selectionBallId = gameState.targetBallId;
      }

      if (gameState.selectionBallId !== gameState.targetBallId) {
        gameState.selectedPicks = [];
        gameState.selectionBallId = gameState.targetBallId;
      }

      if (gameState.selectedPicks.includes(pick)) {
        sendJson(response, 409, {
          error: "That outcome is already selected.",
          game: summarizeLiveScore(activeSnapshot.data).game,
        });
        return;
      }

      gameState.selectedPicks = [...gameState.selectedPicks, pick];
      gameState.lastResult = `Selected: ${gameState.selectedPicks.join(", ")}`;
      gameState.lastResultType = "neutral";
      await logUser("pick", {
        pick,
        targetBallId: gameState.selectionBallId,
        targetBallLabel: gameState.targetBallLabel,
        selectedPicks: [...gameState.selectedPicks],
      });
      void persistUserBet(activeUrl, {
        targetBallId: gameState.selectionBallId,
        targetBallLabel: gameState.targetBallLabel,
        pick,
        selectedPicks: [...gameState.selectedPicks],
      });
      broadcastSnapshot(activeUrl, activeSnapshot.data, "pick");
      sendJson(response, 200, { ok: true, game: summarizeLiveScore(activeSnapshot.data).game });
    } catch (error) {
      sendJson(response, 400, { error: error.message });
    }
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Only GET is supported." });
    return;
  }

  if (requestUrl.pathname === "/") {
    try {
      const html = await renderHomePage();
      sendHtml(response, 200, html);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/btc") {
    try {
      const html = await renderBtcPage();
      sendHtml(response, 200, html);
    } catch (error) {
      sendJson(response, 500, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/btc-price.json") {
    try {
      const snapshot = await fetchBtcPriceSnapshot();
      sendJson(response, 200, snapshot);
    } catch (error) {
      sendJson(response, 502, { error: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/score.json") {
    try {
      sendJson(response, 200, summarizeLiveScore(activeSnapshot.data));
    } catch (error) {
      sendJson(response, 502, { error: error.message, url: activeUrl });
    }
    return;
  }

  if (requestUrl.pathname === "/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    });
    response.write("retry: 5000\n\n");

    const client = {
      response,
      pingTimer: setInterval(() => {
        try {
          response.write(": ping\n\n");
        } catch {
          clearInterval(client.pingTimer);
          sseClients.delete(client);
        }
      }, 25000),
    };

    sseClients.add(client);
    sendSse(response, "snapshot", summarizeLiveScore(activeSnapshot.data));

    request.on("close", () => {
      clearInterval(client.pingTimer);
      sseClients.delete(client);
    });
    return;
  }

  if (requestUrl.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      now: new Date().toISOString(),
      activeMarketUrl: activeUrl,
      liveJobs: liveJobs.size,
      cacheEntries: cache.size,
      postgresEnabled: Boolean(DATABASE_URL),
      postgresReady,
    });
    return;
  }

  if (requestUrl.pathname === "/logs") {
    const limit = normalizePositiveInt(requestUrl.searchParams.get("limit"), 100);
    sendJson(response, 200, {
      ok: true,
      entries: await readRecentLogs(limit),
    });
    return;
  }

  if (requestUrl.pathname === "/scrape") {
    const ttlMs = normalizePositiveInt(requestUrl.searchParams.get("ttl"), DEFAULT_CACHE_TTL_MS);

    try {
      const result = ttlMs === DEFAULT_CACHE_TTL_MS ? activeSnapshot : await getScrape(activeUrl, ttlMs);
      sendJson(response, 200, result);
    } catch (error) {
      sendJson(response, 502, { error: error.message, url: activeUrl });
    }
    return;
  }

  if (requestUrl.pathname === "/live/start") {
    const intervalMs = normalizePositiveInt(
      requestUrl.searchParams.get("interval"),
      DEFAULT_POLL_INTERVAL_MS,
    );

    try {
      const job = startLiveJob(activeUrl, intervalMs);
      sendJson(response, 200, buildLiveResponse(job));
    } catch (error) {
      sendJson(response, 502, { error: error.message, url: activeUrl });
    }
    return;
  }

  if (requestUrl.pathname === "/live") {
    const job = liveJobs.get(activeUrl);
    if (!job) {
      sendJson(response, 404, {
        error: "No live job for the active market. Start one at /live/start.",
        url: activeUrl,
      });
      return;
    }

    sendJson(response, 200, buildLiveResponse(job));
    return;
  }

  if (requestUrl.pathname === "/live/stop") {
    sendJson(response, 200, {
      url: activeUrl,
      stopped: stopLiveJob(activeUrl),
    });
    return;
  }

  if (requestUrl.pathname === "/live/jobs") {
    sendJson(response, 200, {
      activeMarketUrl: activeUrl,
      count: liveJobs.size,
      jobs: [...liveJobs.values()].map((job) => ({
        url: job.url,
        intervalMs: job.intervalMs,
        startedAt: job.startedAt,
        lastUpdatedAt: job.lastUpdatedAt,
        lastError: job.lastError,
        inFlight: job.inFlight,
        hasData: Boolean(job.latest),
      })),
    });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

async function initializeApp() {
  await ensureActiveMarketJob();
  await ensurePostgresSchema();
  await logServer("server_active", {
    activeMarketUrl: await getActiveMarketUrl(),
    postgresEnabled: Boolean(DATABASE_URL),
  });
}

export { handleRequest, initializeApp };
