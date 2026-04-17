import { handleRequest, initializeApp } from "../app.mjs";

await initializeApp();

export default async function handler(request, response) {
  await handleRequest(request, response);
}
