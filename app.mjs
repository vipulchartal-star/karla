import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scrapeEspnCommentary } from "./espn-cricket-commentary.mjs";

const DEFAULT_CACHE_TTL_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_MATCH_URL =
  "https://www.espn.com/cricket/series/1529136/commentary/1529146/namibia-vs-scotland-2nd-t20i-24279";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOME_PAGE_PATH = path.join(__dirname, "web", "index.html");
const ACTIVE_MARKET_PATH = path.join(__dirname, "active-market.txt");

const cache = new Map();
const liveJobs = new Map();
const gameState = {
  marketUrl: null,
  wins: 0,
  losses: 0,
  pendingPick: null,
  targetBallId: null,
  targetBallLabel: null,
  resolvedBallId: null,
  lastResult: "Make your move for the next delivery.",
  lastResultType: "neutral",
};

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
      pendingPick: gameState.pendingPick,
      targetBallId: gameState.targetBallId,
      targetBallLabel: gameState.targetBallLabel,
      lastResult: gameState.lastResult,
      lastResultType: gameState.lastResultType,
    },
  };
}

function renderHomePage() {
  return readFile(HOME_PAGE_PATH, "utf8");
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
    } catch (error) {
      job.lastError = error.message;
    } finally {
      job.inFlight = false;
    }
  }

  job.timer = setInterval(tick, intervalMs);
  tick();
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
  return true;
}

function resetGameStateForMarket(activeUrl) {
  if (gameState.marketUrl === activeUrl) {
    return;
  }

  gameState.marketUrl = activeUrl;
  gameState.wins = 0;
  gameState.losses = 0;
  gameState.pendingPick = null;
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

  if (!latestFeedItem) {
    return;
  }

  if (gameState.pendingPick && latestFeedItem.id !== gameState.targetBallId && latestFeedItem.id !== gameState.resolvedBallId) {
    const actual = getEventLabel(latestFeedItem);
    const won = actual === gameState.pendingPick;
    gameState.resolvedBallId = latestFeedItem.id;
    if (won) {
      gameState.wins += 1;
      gameState.lastResultType = "win";
      gameState.lastResult = `Correct! It was ${actual}`;
    } else {
      gameState.losses += 1;
      gameState.lastResultType = "lose";
      gameState.lastResult = `Missed! It was ${actual}`;
    }
    gameState.pendingPick = null;
  }

  if (ended) {
    if (gameState.pendingPick) {
      gameState.pendingPick = null;
      gameState.lastResultType = "neutral";
      gameState.lastResult = "Match ended before your last pick could resolve.";
    }
    gameState.targetBallId = latestFeedItem.id;
    gameState.targetBallLabel = "match finished";
    return;
  }

  gameState.targetBallId = latestFeedItem.id;
  gameState.targetBallLabel = getNextBallLabel(latestFeedItem.over);
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

      if (gameState.pendingPick) {
        sendJson(response, 409, {
          error: "A pick is already locked for the current target ball.",
          game: summarizeLiveScore(activeSnapshot.data).game,
        });
        return;
      }

      gameState.pendingPick = pick;
      gameState.lastResult = `Locked: ${pick}. Waiting for update...`;
      gameState.lastResultType = "neutral";
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

  if (requestUrl.pathname === "/score.json") {
    try {
      sendJson(response, 200, summarizeLiveScore(activeSnapshot.data));
    } catch (error) {
      sendJson(response, 502, { error: error.message, url: activeUrl });
    }
    return;
  }

  if (requestUrl.pathname === "/health") {
    sendJson(response, 200, {
      ok: true,
      now: new Date().toISOString(),
      activeMarketUrl: activeUrl,
      liveJobs: liveJobs.size,
      cacheEntries: cache.size,
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
}

export { handleRequest, initializeApp };
