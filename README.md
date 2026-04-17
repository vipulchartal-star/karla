# ESPN Cricket Commentary Scraper

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/vipulchartal-star/karla.git)

Scrapes an ESPN cricket commentary URL and returns normalized JSON with:

- Match metadata from ESPN's summary API
- Ball-by-ball commentary from ESPN's play-by-play API
- Commentary grouped by innings and sorted in chronological order

It also includes a live HTTP API for polling an active match.
The server automatically refreshes the default match every 10 seconds on startup.
If `DATABASE_URL` is set, the server writes scraper runs, live snapshots, and activity logs to Postgres.

## Usage

```bash
node espn-cricket-commentary-scraper.mjs "https://www.espn.in/cricket/series/24246/commentary/1528272/bangladesh-vs-new-zealand-1st-odi-24246"
```

Write the result to a file:

```bash
node espn-cricket-commentary-scraper.mjs "https://www.espn.in/cricket/series/24246/commentary/1528272/bangladesh-vs-new-zealand-1st-odi-24246" --out bangladesh-vs-new-zealand.json
```

Pretty-print to stdout:

```bash
node espn-cricket-commentary-scraper.mjs "https://www.espn.in/cricket/series/24246/commentary/1528272/bangladesh-vs-new-zealand-1st-odi-24246" --pretty
```

## HTTP API

Start the API:

```bash
node server.mjs
```

Or:

```bash
npm start
```

Restart automatically on file changes:

```bash
npm run dev
```

Once it is running, `/` returns the latest live score for the active market and the server keeps refreshing that score every 10 seconds in the background.

The server controls one market at a time through [active-market.txt](/data/data/com.termux/files/home/money/active-market.txt). Put one ESPN commentary URL in that file to switch the active market.

### Postgres

Set one of these env vars before starting the server:

```bash
DATABASE_URL="postgresql://user:pass@host:5432/dbname"
```

The app will create these tables automatically on startup:

- `app_events`
- `scrape_runs`
- `live_snapshots`
- `user_bets`
- `bet_settlements`

Stored data includes:

- raw ESPN scrape payloads
- live snapshots sent to the UI
- user activity logs
- individual user bet selections
- settlement results for each ball

## Deployment

### Git

Initialize and push:

```bash
git init
git add .
git commit -m "Initial commit"
```

### Render

This repo includes [render.yaml](/data/data/com.termux/files/home/money/render.yaml) and is set up to run the full app on one Render web service.

Deploy by connecting the repo in Render and using the blueprint, or create a web service with:

```bash
Build Command: npm install
Start Command: npm start
```

Use a custom port:

```bash
PORT=8080 node server.mjs
```

Endpoints:

- `GET /health`
- `GET /scrape` uses the active market from `active-market.txt`
- `GET /live/start` starts polling the active market
- `GET /live` reads the active market live job
- `GET /live/stop` stops the active market live job
- `GET /live/jobs`

Examples:

```bash
curl "http://127.0.0.1:3000/scrape"

```

```bash
curl "http://127.0.0.1:3000/live/start"
```

```bash
curl "http://127.0.0.1:3000/live"
```

If you want the shortest path: connect the repo in Render, let the blueprint create the web service and Postgres, and use the Render URL as the only app URL.

## Output shape

```json
{
  "source": "https://www.espn.in/...",
  "scrapedAt": "2026-04-17T13:00:00.000Z",
  "match": {},
  "innings": [
    {
      "period": 1,
      "periodText": "1st innings",
      "commentary": []
    }
  ]
}
```
