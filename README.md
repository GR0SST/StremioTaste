# Taste for Stremio

Personal movie and series recommendations based on your Trakt history, ratings and watchlist. Built with **Bun + TypeScript + SQLite**. Bring your own **OpenAI or OpenRouter API key**. MIT licensed.

**Hosted setup:** https://addons.grosst.cc/taste/configure

## How it works

1. Connect your own Trakt account.
2. Choose OpenAI or OpenRouter, enter your own API key and model ID.
3. Enable Movies, Series, Everything, or any combination of these catalogs. Add optional Preferences (up to 1,000 characters) to guide the AI selection.
4. Generate a selection and install the personal manifest in Stremio.

Trakt supplies real candidates from titles related to your favorites/recent watches, plus a discovery pool. The model ranks these candidates and explains its choices. Watched titles and low-rated titles are excluded before ranking. Model-invented IDs and duplicates are rejected. Cinemeta supplies posters and canonical IMDb metadata; the addon provides catalogs, not streams.

The Everything catalog uses a custom `Taste` catalog type and individual `movie`/`series` cards. **Mixed catalog navigation needs verification on each Stremio client.** Disable it if your client has trouble; the two standard catalogs remain available.

## Costs and privacy

- Each person supplies their own provider key. There is no shared/server AI key or fallback billing account.
- Selected titles, years, ratings, watchlist entries, your optional preferences and candidate descriptions are sent to the chosen AI provider. Trakt credentials are never sent to the AI provider.
- API keys, Trakt tokens and cached recommendations are encrypted at rest with AES-256-GCM. The server must decrypt them to make requests; self-host if you want to control the server.
- Installation links contain random bearer tokens, not credentials. Keep them private. Browser management sessions use separate HttpOnly cookies; an installation link cannot change settings or retrieve API keys.
- Delete your profile from the setup page to remove server-side data and invalidate its installation link. Trakt's connected-app permission can also be revoked on Trakt.
- Preserve the browser cookie to manage the same profile. Recovery across browsers, shared login with BetterWatchlist and session rotation are not implemented yet.

## Local development

Requires Bun 1.3.11 or later.

```sh
bun install
cp .env.example .env
bun -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
# Put the generated value in ENCRYPTION_KEY in .env.
bun run dev
```

Open http://localhost:3000/configure. Missing Trakt app credentials are shown on the page; no AI requests happen before a user connects Trakt and saves their own key.

### Trakt application

Set `TRAKT_CLIENT_ID` to the client ID of an application you own.

- **Device code:** also set `TRAKT_CLIENT_SECRET` on the server. Users authorize at the Trakt activation page; no callback registration is needed.
- **OAuth redirect / PKCE:** leave `TRAKT_CLIENT_SECRET` empty and register the exact URL `BASE_URL/auth/trakt/callback` in your Trakt application. Use an HTTPS address for a real authorization test, including local development through an HTTPS tunnel. State and PKCE are checked, and refresh tokens rotate automatically.

### AI models

Choose Luna, Terra, Sol or Astra. OpenRouter also offers Sonnet 5.5, Opus 5.5 and Gemini 3.8 Flash. Choose Custom to enter any other model ID. The model must support Chat Completions, `response_format: {type: "json_object"}`, and the provider’s completion-token limit parameter (`max_completion_tokens` for OpenAI, `max_tokens` for OpenRouter). OpenRouter IDs usually contain a provider prefix. Unsupported-model errors are shown on the setup page; the application does not silently switch models or providers. Completion output is capped at 5,000 tokens. Reasoning-heavy models can exhaust that budget and should be replaced with a suitable model.

## Deploy beside BetterWatchlist

The services remain separate. BetterWatchlist can stay at `/configure`; Taste uses `/taste/configure`.

```sh
cp .env.example .env
# Set BASE_URL=https://addons.grosst.cc/taste, ENCRYPTION_KEY and Trakt app credentials.
# Set TRUST_PROXY=true only with the supplied nginx config and loopback-only port.
mkdir -p data
sudo chown 1000:1000 data
sudo chmod 700 data
docker compose up -d --build
```

Add the locations from `deploy/nginx.conf` to the existing nginx server block, then run `nginx -t` before reloading nginx. The proxy preserves `/taste`; do not strip it. Public HTTPS must terminate at nginx or a trusted edge proxy.

The container runs as an unprivileged user, exposes only `127.0.0.1:6007`, and persists SQLite in `./data`. Keep `.env` and the database out of Git. Back up the database **and its encryption key** together. Use a consistent SQLite backup or stop the container before copying all database/WAL files. Losing the encryption key makes existing profiles unreadable.

Use one application process/replica: in-process generation and refresh-token locks intentionally target single-VPS deployment. `INVITE_CODE` can restrict new registrations. The current IP limiter uses nginx's direct client address; behind a CDN it may group users by edge IP until nginx real-IP handling is configured for that CDN.

## Caching and limits

- One generation per profile at a time; at least one hour between attempts, including failed attempts and manual refreshes. The limit persists across restarts and settings changes.
- Up to 20 films and 20 series, depending on available candidates and metadata.
- Six-hour cache; an expired catalog triggers background refresh on access. There is no scheduler when nobody uses it.
- The setup page shows generation progress and a preview. First catalog requests may return an empty list while initial generation runs.
- On upstream failure, the previous successful catalog stays available and the setup page shows an error.
- Trakt lists are paginated; more than 200 pages per list produces an explicit limit error instead of silently incomplete filtering.
- Recommendations are drawn from a bounded pool, not the entire Trakt database. Cinemeta names/descriptions may be English even when AI explanations use another language.

## Verification

```sh
bun test
bun run typecheck
```

Tests use mocked upstream services and in-memory SQLite: OAuth state/session isolation, device polling, token rotation, encrypted storage, pagination, provider selection, candidate validation, cache behavior and subpath routing. They do not establish live AI quality, user-specific API access or mixed-catalog compatibility in Stremio.

## API documentation

- [Stremio addon protocol](https://stremio.github.io/stremio-addon-sdk/protocol.html)
- [Trakt authentication](https://developer.trakt.tv/docs/authentication-oauth)
- [Trakt PKCE](https://developer.trakt.tv/docs/pkce)
- [OpenAI structured outputs and JSON mode](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenRouter Chat Completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
