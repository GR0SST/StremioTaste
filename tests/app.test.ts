import { afterEach, describe, expect, test } from "bun:test";
import { Store } from "../src/store";
import { createApp } from "../src/app";
import { rank, Recommendations } from "../src/recommendations";
import { Trakt, type Http, type Candidate } from "../src/upstream";
import { DeviceAuth } from "../src/device";
import {
  manifest,
  validateSettings,
  type Settings,
  type Tokens,
} from "../src/domain";

const settings: Settings = {
  provider: "openai",
  apiKey: "test-private-key",
  model: "test-model",
  catalogs: ["taste-movies", "taste-series", "taste-mixed"],
  language: "ru",
};
const tokens: Tokens = {
  access_token: "private-access",
  refresh_token: "private-refresh",
  created_at: Math.floor(Date.now() / 1000),
  expires_in: 86400,
};
const stores: Store[] = [];
function setup() {
  const store = new Store(":memory:", "ab".repeat(32));
  stores.push(store);
  return store;
}
afterEach(() => {
  for (const store of stores.splice(0)) store.db.close();
});
const origin = "https://addons.example.com";
const base = `${origin}/taste`;
function req(path: string, method = "GET", body?: unknown, cookie?: string) {
  return new Request(`${base}${path}`, {
    method,
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const candidate: Candidate = {
  type: "movie",
  trakt: 2,
  imdb: "tt0000002",
  title: "New film",
  year: 2020,
};

test("settings reject unknown providers, catalogs and header injection", () => {
  expect(() => validateSettings({ ...settings, provider: "evil" })).toThrow();
  expect(() => validateSettings({ ...settings, catalogs: [] })).toThrow();
  expect(() =>
    validateSettings({ ...settings, apiKey: "secret\r\nAuthorization: bad" }),
  ).toThrow();
  expect(manifest(settings).catalogs).toHaveLength(3);
  expect(manifest().behaviorHints.configurationRequired).toBe(true);
});
test("secrets and cached recommendations are encrypted and authenticated", () => {
  const store = setup();
  const { profile, session } = store.create();
  store.update(profile.id, { settings, trakt: tokens });
  const row = store.byId(profile.id)!;
  expect(row.secret).not.toContain(settings.apiKey);
  expect(row.secret).not.toContain(tokens.access_token);
  expect(row.session_hash).not.toBe(session);
  expect(store.secrets(row).settings).toEqual(settings);
  const bytes = Buffer.from(row.secret, "base64");
  bytes[35] = bytes[35]! ^ 1;
  expect(() => store.decrypt(bytes.toString("base64"))).toThrow();
});
test("prefix routing, CORS and no user information without session", async () => {
  const store = setup();
  const app = createApp(store, { baseUrl: base, clientId: "test" });
  const html = await (await app.fetch(req("/configure"))).text();
  expect(html).toContain('src="/taste/app.js"');
  expect(html).not.toContain("__BASE_PATH__");
  expect((await app.fetch(new Request(`${origin}/configure`))).status).toBe(
    404,
  );
  const manifestResponse = await app.fetch(req("/manifest.json"));
  expect(manifestResponse.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(
    (await app.fetch(req("/api/status"))).headers.get(
      "Access-Control-Allow-Origin",
    ),
  ).toBeNull();
  expect((await app.fetch(req("/api/refresh", "POST"))).status).toBe(401);
  expect(
    (
      await app.fetch(
        new Request(`${base}/api/trakt/connect`, {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        }),
      )
    ).status,
  ).toBe(403);
});
test("OAuth state is session-bound and one-use, installation token cannot manage profile", async () => {
  const store = setup();
  const request: Http = async () => Response.json(tokens);
  const app = createApp(store, { baseUrl: base, clientId: "test" }, request);
  const connect = await app.fetch(req("/api/trakt/connect", "POST", {}));
  const cookie = connect.headers.get("set-cookie")!.split(";")[0]!;
  const link = new URL((await connect.json()).url);
  const state = link.searchParams.get("state")!;
  expect(link.searchParams.get("redirect_uri")).toBe(
    `${base}/auth/trakt/callback`,
  );
  expect(link.searchParams.get("code_challenge_method")).toBe("S256");
  expect(
    (await app.fetch(req(`/auth/trakt/callback?code=test&state=${state}`)))
      .status,
  ).toBe(401);
  expect(
    (
      await app.fetch(
        req(
          `/auth/trakt/callback?code=test&state=${state}`,
          "GET",
          undefined,
          cookie,
        ),
      )
    ).headers.get("location"),
  ).toBe("/taste/configure?auth=connected");
  expect(
    (
      await app.fetch(
        req(
          `/auth/trakt/callback?code=test&state=${state}`,
          "GET",
          undefined,
          cookie,
        ),
      )
    ).headers.get("location"),
  ).toContain("expired");
  expect(
    (await app.fetch(req("/api/settings", "POST", settings, cookie))).status,
  ).toBe(200);
  const status = await (
    await app.fetch(req("/api/status", "GET", undefined, cookie))
  ).json();
  expect(JSON.stringify(status)).not.toContain(settings.apiKey);
  expect(JSON.stringify(status)).not.toContain(tokens.access_token);
  const addon = await app.fetch(new Request(status.manifestUrl));
  expect((await addon.json()).catalogs).toHaveLength(3);
  const addonToken = new URL(status.manifestUrl).pathname.split("/")[3];
  expect(
    (
      await app.fetch(
        req("/api/profile", "DELETE", undefined, `__Host-taste=${addonToken}`),
      )
    ).status,
  ).toBe(401);
  expect(
    (await app.fetch(req("/api/profile", "DELETE", undefined, cookie))).status,
  ).toBe(200);
  expect((await app.fetch(new Request(status.manifestUrl))).status).toBe(404);
});
test("Trakt follows every page even if server returns short pages without count", async () => {
  const store = setup();
  let calls = 0;
  const trakt = new Trakt(store, "client", base, async (url) => {
    calls++;
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json(page < 3 ? [{ id: page }] : []);
  });
  expect(await trakt.pages("/sync/watched/movies", "token")).toEqual([
    { id: 1 },
    { id: 2 },
  ]);
  expect(calls).toBe(3);
});
test("simultaneous expiry checks rotate Trakt refresh token only once", async () => {
  const store = setup();
  const { profile } = store.create();
  store.update(profile.id, { trakt: { ...tokens, created_at: 0 } });
  let calls = 0;
  const trakt = new Trakt(store, "client", base, async () => {
    calls++;
    await Bun.sleep(10);
    return Response.json({ ...tokens, refresh_token: "rotated" });
  });
  await Promise.all([
    trakt.token(profile.id),
    trakt.token(profile.id),
    trakt.token(profile.id),
  ]);
  expect(calls).toBe(1);
  expect(store.secrets(store.byId(profile.id)!).trakt?.refresh_token).toBe(
    "rotated",
  );
});
test("ranking drops invented IDs and duplicates; routes keys to the selected provider", async () => {
  for (const provider of ["openai", "openrouter"] as const) {
    const result = await rank(
      { ...settings, provider },
      { watched: [], ratings: [], watchlist: [] },
      [candidate],
      async (url, init) => {
        expect(url).toBe(
          provider === "openai"
            ? "https://api.openai.com/v1/chat/completions"
            : "https://openrouter.ai/api/v1/chat/completions",
        );
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${settings.apiKey}`,
        );
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  recommendations: [
                    { key: "movie:999", reason: "invented" },
                    { key: "movie:2", reason: "Fits your taste" },
                    { key: "movie:2", reason: "duplicate" },
                  ],
                }),
              },
            },
          ],
        });
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.item.imdb).toBe(candidate.imdb);
  }
});
test("malformed or truncated AI responses fail without exposing provider secrets", async () => {
  await expect(
    rank(
      settings,
      { watched: [], ratings: [], watchlist: [] },
      [candidate],
      async () =>
        Response.json({ error: { message: settings.apiKey } }, { status: 401 }),
    ),
  ).rejects.toThrow("HTTP 401");
  await expect(
    rank(
      settings,
      { watched: [], ratings: [], watchlist: [] },
      [candidate],
      async () =>
        Response.json({
          choices: [{ finish_reason: "length", message: { content: "{}" } }],
        }),
    ),
  ).rejects.toThrow("Generation incomplete");
});
test("device authorization enforces polling interval and persists tokens", async () => {
  const store = setup();
  const { profile } = store.create();
  let polls = 0;
  const device = new DeviceAuth(store, "client", "secret", async (url) => {
    if (url.endsWith("/code"))
      return Response.json({
        device_code: "private-device",
        user_code: "ABCD",
        verification_url: "https://trakt.tv/activate",
        expires_in: 600,
        interval: 5,
      });
    polls++;
    return polls === 1
      ? new Response(null, { status: 429 })
      : Response.json(tokens);
  });
  await device.start(profile.id);
  expect((await device.poll(profile.id)).connected).toBe(false);
  expect(polls).toBe(0);
  store.db.query("UPDATE devices SET next_poll=0").run();
  expect((await device.poll(profile.id)).interval).toBe(10000);
  store.db.query("UPDATE devices SET next_poll=0").run();
  expect((await device.poll(profile.id)).connected).toBe(true);
  expect(store.secrets(store.byId(profile.id)!).trakt).toEqual(tokens);
});
test("end-to-end generation excludes watched items, shares concurrent work and preserves stale cache on failure", async () => {
  const store = setup();
  const { profile } = store.create();
  store.update(profile.id, { settings, trakt: tokens });
  let aiCalls = 0,
    failing = false;
  const watched = { title: "Seen film", ids: { trakt: 1, imdb: "tt0000001" } };
  const movie = {
    title: candidate.title,
    year: candidate.year,
    ids: { trakt: 2, imdb: candidate.imdb },
  };
  const request: Http = async (url, init) => {
    if (failing) return new Response(null, { status: 503 });
    if (url.includes("/sync/"))
      return Response.json(
        url.includes("watched/movies") ? [{ movie: watched }] : [],
        { headers: { "X-Pagination-Page-Count": "1" } },
      );
    if (url.includes("/related") || url.includes("/popular"))
      return Response.json(url.includes("/movies/") ? [watched, movie] : []);
    if (url.includes("chat/completions")) {
      aiCalls++;
      const input = JSON.parse(String(init?.body));
      const data = JSON.parse(input.messages[1].content);
      expect(
        data.candidates.some((c: { key: string }) => c.key === "movie:1"),
      ).toBe(false);
      return Response.json({
        choices: [
          {
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                recommendations: [
                  { key: "movie:2", reason: "Personal recommendation" },
                ],
              }),
            },
          },
        ],
      });
    }
    if (url.includes("cinemeta"))
      return Response.json({
        meta: {
          id: candidate.imdb,
          type: "movie",
          name: candidate.title,
          poster: "https://images.example/poster.jpg",
        },
      });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const engine = new Recommendations(
    store,
    new Trakt(store, "client", base, request),
    request,
  );
  await Promise.all([engine.start(profile.id), engine.start(profile.id)]);
  expect(aiCalls).toBe(1);
  expect(store.cached(store.byId(profile.id)!)).toHaveLength(1);
  await engine.start(profile.id);
  expect(aiCalls).toBe(1);
  failing = true;
  store.db.query("UPDATE profiles SET attempted_at=0,cached_at=1").run();
  await engine.start(profile.id);
  expect(store.cached(store.byId(profile.id)!)).toHaveLength(1);
  expect(store.byId(profile.id)!.error).toContain("503");
});
