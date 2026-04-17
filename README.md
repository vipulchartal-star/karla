# ESPN Cricket Commentary Scraper

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fvipulchartal-star%2Fkarla.git)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/vipulchartal-star/karla.git)

Scrapes an ESPN cricket commentary URL and returns normalized JSON with:

- Match metadata from ESPN's summary API
- Ball-by-ball commentary from ESPN's play-by-play API
- Commentary grouped by innings and sorted in chronological order

It also includes a live HTTP API for polling an active match.
The server automatically refreshes the default match every 10 seconds on startup.

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

## Deployment

### Git

Initialize and push:

```bash
git init
git add .
git commit -m "Initial commit"
```

### Vercel

This repo includes [vercel.json](/data/data/com.termux/files/home/money/vercel.json) and a serverless entrypoint at [api/index.js](/data/data/com.termux/files/home/money/api/index.js).

Deploy:

```bash
vercel
```

### Render

This repo includes [render.yaml](/data/data/com.termux/files/home/money/render.yaml).

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

curl "http://127.0.0.1:3000/live/start"
```

curl "http://127.0.0.1:3000/live"
```

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
