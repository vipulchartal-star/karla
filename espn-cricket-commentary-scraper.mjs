#!/usr/bin/env node

import { scrapeEspnCommentary } from "./espn-cricket-commentary.mjs";

function usage() {
  console.error(
    [
      "Usage:",
      '  node espn-cricket-commentary-scraper.mjs "<espn-commentary-url>" [--out file.json] [--pretty]',
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const args = {
    url: "",
    out: "",
    pretty: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value) {
      continue;
    }

    if (!args.url && !value.startsWith("--")) {
      args.url = value;
      continue;
    }

    if (value === "--pretty") {
      args.pretty = true;
      continue;
    }

    if (value === "--out") {
      args.out = argv[i + 1] || "";
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${value}`);
  }

  if (!args.url) {
    throw new Error("Missing ESPN commentary URL.");
  }

  return args;
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await scrapeEspnCommentary(args.url);
    const spacing = args.pretty || args.out ? 2 : 0;
    const output = JSON.stringify(result, null, spacing);

    if (args.out) {
      const fs = await import("node:fs/promises");
      await fs.writeFile(args.out, `${output}\n`, "utf8");
      console.error(`Wrote ${args.out}`);
      return;
    }

    process.stdout.write(`${output}\n`);
  } catch (error) {
    usage();
    console.error(error.message);
    process.exitCode = 1;
  }
}

await main();
