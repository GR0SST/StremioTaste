import { Store } from "./store";
import { createApp } from "./app";

const port = Number(Bun.env.PORT || 3000);
const baseUrl = (Bun.env.BASE_URL || `http://localhost:${port}`).replace(
  /\/$/,
  "",
);
const parsed = new URL(baseUrl);
if (
  !["http:", "https:"].includes(parsed.protocol) ||
  parsed.search ||
  parsed.hash ||
  parsed.username ||
  parsed.password ||
  !/^\/[a-zA-Z0-9/_-]*$/.test(parsed.pathname)
)
  throw new Error(
    "BASE_URL must be an HTTP(S) URL with an optional simple path, e.g. https://addons.grosst.cc/taste.",
  );
if (
  parsed.protocol !== "https:" &&
  !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
)
  throw new Error("Public hosting requires HTTPS in BASE_URL.");
const store = new Store(
  Bun.env.DATABASE_PATH || "./data/taste.sqlite",
  Bun.env.ENCRYPTION_KEY || "",
);
const app = createApp(store, {
  baseUrl,
  clientId: Bun.env.TRAKT_CLIENT_ID || "",
  clientSecret: Bun.env.TRAKT_CLIENT_SECRET,
  inviteCode: Bun.env.INVITE_CODE,
});
const server = Bun.serve({
  port,
  hostname: Bun.env.HOST || "127.0.0.1",
  maxRequestBodySize: 8192,
  fetch: (req, server) =>
    app.fetch(
      req,
      (Bun.env.TRUST_PROXY === "true" ? req.headers.get("x-real-ip") : null) ||
        server.requestIP(req)?.address ||
        "unknown",
    ),
});
console.log(
  `Taste is listening on ${server.url}. Configure: ${baseUrl}/configure`,
);
