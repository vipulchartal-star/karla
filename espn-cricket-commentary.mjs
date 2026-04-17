const DEFAULT_REGION = "in";
const DEFAULT_LANG = "en";

function parseIdsFromUrl(input) {
  const url = new URL(input);
  const match = url.pathname.match(/\/cricket\/series\/(\d+)\/commentary\/(\d+)\b/);
  if (!match) {
    throw new Error("URL does not look like an ESPN cricket commentary page.");
  }

  return {
    seriesId: match[1],
    eventId: match[2],
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; ESPNCricketCommentaryScraper/1.0)",
      accept: "application/json,text/plain,*/*",
    },
  });

  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }

  return response.json();
}

function extractTeams(summary) {
  const competition = summary?.header?.competitions?.[0];
  const competitors = competition?.competitors || [];

  return competitors.map((team) => ({
    id: team.id ?? null,
    homeAway: team.homeAway ?? null,
    winner: team.winner === true || team.winner === "true",
    team: {
      id: team.team?.id ?? null,
      name: team.team?.displayName ?? team.team?.name ?? null,
      abbreviation: team.team?.abbreviation ?? null,
    },
    score: team.score ?? null,
    overs: team.linescores?.[0]?.displayValue ?? null,
    record: team.records?.map((item) => item.summary).filter(Boolean) ?? [],
  }));
}

function extractMatch(summary, seriesId, eventId) {
  const header = summary?.header ?? {};
  const competition = header.competitions?.[0] ?? {};
  const status = competition.status?.type ?? {};
  const noteItems = summary?.notes ?? [];
  const gameInfo = summary?.gameInfo ?? {};
  const competitionClass = competition.class ?? {};

  return {
    seriesId,
    eventId,
    title: header.title ?? header.name ?? null,
    name: header.name ?? null,
    shortName: header.shortName ?? null,
    description: header.description ?? competition.description ?? null,
    status: {
      state: status.state ?? null,
      completed: Boolean(competition.status?.completed || status.completed || status.state === "post"),
      description: status.description ?? null,
      summary: competition.status?.summary ?? null,
      detail: competition.status?.displayClock
        ? `${competition.status.displayClock} ${competition.status.type?.shortDetail ?? ""}`.trim()
        : competition.status?.type?.detail ?? null,
    },
    startDate: competition.date ?? null,
    format: competitionClass.eventType ?? competitionClass.generalClassCard ?? competitionClass.name ?? null,
    venue: {
      name: gameInfo.venue?.fullName ?? null,
      city: gameInfo.venue?.address?.city ?? null,
      country: gameInfo.venue?.address?.country ?? null,
    },
    teams: extractTeams(summary),
    toss: noteItems.find((note) => note.type === "toss")?.text ?? null,
    matchNotes: noteItems.map((note) => ({
      type: note.type ?? null,
      section: note.section ?? null,
      text: note.text ?? null,
    })),
    officials: (gameInfo.officials || []).map((official) => ({
      name: official.displayName ?? null,
      role: official.position?.displayName ?? official.position?.name ?? null,
    })),
  };
}

function simplifyCommentaryItem(item) {
  return {
    id: item.id ?? null,
    sequence: item.sequence ?? null,
    timestamp: item.bbbTimestamp ?? null,
    date: item.date ?? null,
    period: item.period ?? null,
    periodText: item.periodText ?? null,
    playType: item.playType?.description ?? null,
    over: item.over?.overs ?? item.over?.actual ?? null,
    overNumber: item.over?.number ?? null,
    ballInOver: item.over?.ball ?? null,
    shortText: item.shortText ?? null,
    text: item.text ?? null,
    preText: item.preText ?? null,
    postText: item.postText ?? null,
    battingTeam: item.team?.displayName ?? item.team?.name ?? null,
    score: item.awayScore ?? item.homeScore ?? null,
    inningsScore: item.innings
      ? {
          runs: item.innings.runs ?? null,
          wickets: item.innings.wickets ?? null,
          over: item.over?.overs ?? null,
          runRate: item.innings.runRate ?? null,
          target: item.innings.target || null,
          remainingRuns: item.innings.remainingRuns ?? null,
          remainingOvers: item.innings.remainingOvers ?? null,
          requiredRunRate: item.innings.requiredRunRate ?? null,
        }
      : null,
    batsman: item.batsman?.athlete?.displayName ?? null,
    bowler: item.bowler?.athlete?.displayName ?? null,
    dismissal: item.dismissal?.dismissal
      ? {
          type: item.dismissal.type ?? null,
          text: item.dismissal.text ?? null,
          batsman: item.dismissal.batsman?.athlete?.displayName ?? null,
          bowler: item.dismissal.bowler?.athlete?.displayName ?? null,
          fielder: item.dismissal.fielder?.athlete?.displayName ?? null,
        }
      : null,
  };
}

async function fetchPeriodCommentary(seriesId, eventId, period) {
  const firstPageUrl =
    `https://site.web.api.espn.com/apis/site/v2/sports/cricket/${seriesId}/playbyplay` +
    `?contentorigin=espn&event=${eventId}&page=1&period=${period}`;
  const firstPage = await fetchJson(firstPageUrl);
  const commentary = firstPage?.commentary;

  if (!commentary?.items?.length) {
    return null;
  }

  const allItems = [...commentary.items];
  const pageCount = commentary.pageCount ?? 1;

  for (let page = 2; page <= pageCount; page += 1) {
    const url =
      `https://site.web.api.espn.com/apis/site/v2/sports/cricket/${seriesId}/playbyplay` +
      `?contentorigin=espn&event=${eventId}&page=${page}&period=${period}`;
    const payload = await fetchJson(url);
    const items = payload?.commentary?.items ?? [];
    allItems.push(...items);
  }

  allItems.sort((a, b) => {
    const aSequence = a.sequence ?? 0;
    const bSequence = b.sequence ?? 0;
    return aSequence - bSequence;
  });

  return {
    period,
    periodText: allItems[0]?.periodText ?? `${period} innings`,
    totalItems: commentary.count ?? allItems.length,
    pageCount,
    commentary: allItems.map(simplifyCommentaryItem),
  };
}

async function scrapeEspnCommentary(url) {
  const { seriesId, eventId } = parseIdsFromUrl(url);
  const summaryUrl =
    `https://site.web.api.espn.com/apis/site/v2/sports/cricket/${seriesId}/summary` +
    `?contentorigin=espn&event=${eventId}&lang=${DEFAULT_LANG}&region=${DEFAULT_REGION}`;
  const summary = await fetchJson(summaryUrl);
  const competition = summary?.header?.competitions?.[0];
  const inningsCount = Math.max(summary?.boxscore?.innings?.length || 0, competition?.status?.period || 0, 2);

  const innings = [];
  for (let period = 1; period <= Math.max(inningsCount, 2); period += 1) {
    const periodCommentary = await fetchPeriodCommentary(seriesId, eventId, period);
    if (periodCommentary) {
      innings.push(periodCommentary);
    }
  }

  return {
    source: url,
    scrapedAt: new Date().toISOString(),
    match: extractMatch(summary, seriesId, eventId),
    innings,
  };
}

export { parseIdsFromUrl, scrapeEspnCommentary };
