import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BTC_PAGE_PATH = path.join(__dirname, "web", "btc-price.html");
const SCRAPE_TIMEOUT_MS = 12_000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SOURCE_PAGES = [
  {
    name: "Coinbase converter",
    url: "https://www.coinbase.com/converter/btc/usd",
  },
  {
    name: "Coinbase price page",
    url: "https://www.coinbase.com/price/bitcoin",
  },
  {
    name: "Yahoo Finance crypto page",
    url: "https://finance.yahoo.com/crypto/",
  },
];

export function renderBtcPage() {
  return readFile(BTC_PAGE_PATH, "utf8");
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parsePriceFromText(text) {
  const patterns = [
    /1 Bitcoin converts to \$([\d,]+(?:\.\d+)?) USD/i,
    /current price of Bitcoin is \$([\d,]+(?:\.\d+)?) per BTC/i,
    /current value of 1 BTC is \$([\d,]+(?:\.\d+)?) USD/i,
    /Bitcoin USD Price \(BTC-USD\).*?\$([\d,]+(?:\.\d+)?)/i,
    /BTC-USD\s+Bitcoin USD\s+\$([\d,]+(?:\.\d+)?)/i,
  ];

  for (const pattern of patterns) {
    const match = String(text).match(pattern);
    if (!match) {
      continue;
    }

    const price = Number.parseFloat(match[1].replace(/,/g, ""));
    if (Number.isFinite(price)) {
      return price;
    }
  }

  return null;
}

async function fetchPageText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCRAPE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        "user-agent": USER_AGENT,
      },
    });

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return html;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchBtcPriceSnapshot() {
  const errors = [];

  for (const source of SOURCE_PAGES) {
    try {
      const html = await fetchPageText(source.url);
      const text = htmlToText(html);
      const price = parsePriceFromText(text);
      if (!Number.isFinite(price)) {
        throw new Error("price not found in page text");
      }

      return {
        price,
        source: source.name,
        updatedAt: new Date().toISOString(),
      };
    } catch (error) {
      errors.push(`${source.name}: ${error.message}`);
    }
  }

  throw new Error(errors.join("; "));
}
