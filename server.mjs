#!/usr/bin/env node

import http from "node:http";
import { handleRequest, initializeApp } from "./app.mjs";

const DEFAULT_PORT = 3000;

function normalizePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

const port = normalizePositiveInt(process.env.PORT, DEFAULT_PORT);
await initializeApp();

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(`${JSON.stringify({ error: error.message })}\n`);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Listening on http://0.0.0.0:${port}`);
});
