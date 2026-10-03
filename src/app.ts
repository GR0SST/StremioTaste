import { DeviceAuth } from "./device";
import {
  AppError,
  catalogs,
  manifest,
  selectCatalog,
  validateSettings,
} from "./domain";
import { Store, hash } from "./store";
import { Trakt, type Http } from "./upstream";
import { Recommendations } from "./recommendations";

export interface AppConfig {
  baseUrl: string;
  clientId: string;
  clientSecret?: string;
  inviteCode?: string;
}
export function createApp(store: Store, config: AppConfig, request?: Http) {
  const trakt = new Trakt(
    store,
    config.clientId,
    config.baseUrl,
    request,
    config.clientSecret,
  );
  const device = config.clientSecret
    ? new DeviceAuth(store, config.clientId, config.clientSecret, request)
    : null;
  const recommendations = new Recommendations(store, trakt, request);
  const secure = config.baseUrl.startsWith("https:");
  const basePath = new URL(config.baseUrl).pathname.replace(/\/$/, "");
  const origin = new URL(config.baseUrl).origin;
  const cookieName = secure ? "__Host-taste" : "taste";
  const rate = new Map<string, { count: number; reset: number }>();
  const limited = (id: string) => {
    const now = Date.now();
    for (const [key, value] of rate) if (value.reset <= now) rate.delete(key);
    const bucket = rate.get(id) || { count: 0, reset: now + 60_000 };
    bucket.count++;
    rate.set(id, bucket);
    if (bucket.count > 20 || rate.size > 10_000)
      throw new AppError("Too many requests. Retry in a minute.", 429);
  };
  const cookie = (value: string, maxAge = 365 * 86400) =>
    `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status });
  const redirect = (location: string, headers: HeadersInit = {}) =>
    new Response(null, {
      status: 303,
      headers: { ...headers, Location: location },
    });
  async function route(req: Request, ip: string) {
    const url = new URL(req.url);
    if (
      basePath &&
      url.pathname !== basePath &&
      !url.pathname.startsWith(basePath + "/")
    )
      throw new AppError("Page not found.", 404);
    const path = url.pathname.slice(basePath.length) || "/";
    const token = req.headers
      .get("cookie")
      ?.split(";")
      .map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    let profile = token ? store.bySession(token) : null;
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (!["GET", "HEAD"].includes(req.method)) {
      if (req.headers.get("origin") !== origin)
        throw new AppError("Invalid request origin.", 403);
      limited(profile ? profile.id : ip);
    }
    const requireProfile = () => {
      if (!profile) throw new AppError("Connect Trakt in this browser.", 401);
      return profile;
    };
    const body = async (): Promise<Record<string, unknown>> => {
      if (!req.headers.get("content-type")?.startsWith("application/json"))
        throw new AppError("JSON required.", 415);
      const text = await req.text();
      if (text.length > 8192) throw new AppError("Request too large.", 413);
      try {
        const value = JSON.parse(text);
        if (value && typeof value === "object" && !Array.isArray(value))
          return value;
      } catch {}
      throw new AppError("Invalid JSON.");
    };
    if (req.method === "GET" && path === "/health") return json({ ok: true });
    if (
      req.method === "GET" &&
      (path === "/" ||
        path === "/configure" ||
        /^\/a\/[\w-]+\/configure$/.test(path))
    )
      return new Response(
        (
          await Bun.file(
            new URL("../public/index.html", import.meta.url),
          ).text()
        ).replaceAll("__BASE_PATH__", basePath),
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    if (req.method === "GET" && ["/app.js", "/style.css"].includes(path))
      return new Response(
        Bun.file(new URL(`../public${path}`, import.meta.url)),
      );
    if (req.method === "GET" && path === "/manifest.json")
      return json(manifest());
    if (req.method === "GET" && path === "/api/status") {
      const data = profile ? store.secrets(profile) : null;
      const settings = data?.settings;
      return json({
        serverReady: !!config.clientId,
        inviteRequired: !!config.inviteCode,
        connected: !!data?.trakt,
        configured: !!settings,
        settings: settings ? { ...settings, apiKey: undefined } : null,
        manifestUrl:
          settings && data
            ? `${config.baseUrl}/a/${data.addon}/manifest.json`
            : null,
        running: profile ? recommendations.running(profile.id) : false,
        cachedAt: profile?.cached_at || null,
        error: profile?.error || null,
        retryAt: profile?.attempted_at ? profile.attempted_at + 300_000 : null,
        metas: profile ? store.cached(profile) : [],
      });
    }
    if (req.method === "POST" && path === "/api/trakt/connect") {
      if (!config.clientId) throw new AppError("Trakt is unavailable.", 503);
      const input = await body();
      if (
        !profile &&
        config.inviteCode &&
        hash(String(input.inviteCode || "")) !== hash(config.inviteCode)
      )
        throw new AppError("Invalid invite code.", 403);
      let headers: HeadersInit = {};
      if (!profile) {
        const created = store.create();
        profile = created.profile;
        headers = { "Set-Cookie": cookie(created.session) };
      }
      if (recommendations.running(profile.id))
        throw new AppError("Дождитесь завершения обновления picks.", 409);
      if (device)
        return Response.json(await device.start(profile.id), { headers });
      const { state, challenge } = store.oauth(profile.id);
      const target = new URL("https://auth.trakt.tv/oauth/authorize");
      target.search = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: `${config.baseUrl}/auth/trakt/callback`,
        response_type: "code",
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      return Response.json({ url: target.toString() }, { headers });
    }
    if (req.method === "POST" && path === "/api/trakt/poll") {
      if (!device) throw new AppError("Device login is unavailable.", 409);
      const p = requireProfile();
      if (recommendations.running(p.id))
        throw new AppError("Generation in progress.", 409);
      return json(await device.poll(p.id));
    }
    if (req.method === "GET" && path === "/auth/trakt/callback") {
      const p = requireProfile();
      const verifier = store.consumeOAuth(
        url.searchParams.get("state") || "",
        p.id,
      );
      if (!verifier) return redirect(`${basePath}/configure?auth=expired`);
      if (url.searchParams.has("error"))
        return redirect(`${basePath}/configure?auth=denied`);
      const code = url.searchParams.get("code");
      if (!code) return redirect(`${basePath}/configure?auth=failed`);
      try {
        const tokens = await trakt.exchange({
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
        });
        store.update(p.id, { trakt: tokens });
        store.clearCache(p.id);
        return redirect(`${basePath}/configure?auth=connected`);
      } catch {
        return redirect(`${basePath}/configure?auth=failed`);
      }
    }
    if (req.method === "POST" && path === "/api/settings") {
      const p = requireProfile();
      if (recommendations.running(p.id))
        throw new AppError("Дождитесь завершения обновления picks.", 409);
      const previous = store.secrets(p);
      if (!previous.trakt) throw new AppError("Connect Trakt first.", 409);
      const input = await body();
      if (
        !input.apiKey &&
        previous.settings &&
        previous.settings.provider === input.provider
      )
        input.apiKey = previous.settings.apiKey;
      const settings = validateSettings(input);
      store.update(p.id, { settings });
      store.clearCache(p.id);
      return json({ ok: true });
    }
    if (req.method === "POST" && path === "/api/refresh") {
      const p = requireProfile();
      if (
        !recommendations.running(p.id) &&
        p.attempted_at > Date.now() - 300_000
      )
        throw new AppError("Wait 5 minutes between refreshes.", 429);
      void recommendations.start(p.id, true);
      return json({ ok: true }, 202);
    }
    if (req.method === "DELETE" && path === "/api/profile") {
      const p = requireProfile();
      if (recommendations.running(p.id))
        throw new AppError("Дождитесь завершения обновления picks.", 409);
      store.remove(p.id);
      return Response.json(
        { ok: true },
        { headers: { "Set-Cookie": cookie("", 0) } },
      );
    }
    const match = path.match(
      /^\/a\/([\w-]{43})\/(manifest\.json|catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json)$/,
    );
    if (req.method === "GET" && match) {
      const p = store.byAddon(match[1]!);
      const settings = p && store.secrets(p).settings;
      if (!p || !settings) throw new AppError("Addon not found.", 404);
      if (match[2] === "manifest.json") return json(manifest(settings));
      const catalog = catalogs.find(
        (c) =>
          c.type === match[3] &&
          c.id === match[4] &&
          settings.catalogs.includes(c.id),
      );
      if (!catalog) throw new AppError("Catalog not found.", 404);
      const params = new URLSearchParams(match[5] || "");
      const rawSkip = params.get("skip") || "0";
      if (!/^\d{1,6}$/.test(rawSkip))
        throw new AppError("Invalid catalog offset.");
      const skip = Number(rawSkip);
      // First preparation happens on the setup page. Expired catalogs refresh in the background.
      void recommendations.start(p.id);
      const current = store.byId(p.id)!;
      return json({
        metas: selectCatalog(store.cached(current), catalog.id, skip),
        cacheMaxAge: recommendations.running(p.id) ? 15 : 300,
        staleRevalidate: 60,
        staleError: 3600,
      });
    }
    throw new AppError("Page not found.", 404);
  }
  return {
    recommendations,
    async fetch(req: Request, ip = "local") {
      let response: Response;
      try {
        response = await route(req, ip);
      } catch (error) {
        response = json(
          {
            error:
              error instanceof AppError
                ? error.message
                : "Internal server error.",
          },
          error instanceof AppError ? error.status : 500,
        );
      }
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("Referrer-Policy", "no-referrer");
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
      const path = new URL(req.url).pathname.slice(basePath.length);
      if (
        path === "/manifest.json" ||
        (path.startsWith("/a/") && path.endsWith(".json"))
      ) {
        response.headers.set("Access-Control-Allow-Origin", "*");
        response.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
        response.headers.set("Access-Control-Allow-Headers", "Content-Type");
      }
      return response;
    },
  };
}
