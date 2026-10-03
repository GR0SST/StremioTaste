import { AppError, type Taste, type TasteItem, type Tokens } from "./domain";
import type { Store } from "./store";
export type Http = (url: string, init?: RequestInit) => Promise<Response>;
export const http: Http = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(45_000) });
export async function jsonResponse<T>(
  response: Response,
  service: string,
): Promise<T> {
  if (!response.ok) {
    const hint =
      response.status === 401 || response.status === 403
        ? "Проверьте доступ и переподключите аккаунт или API-ключ."
        : response.status === 429
          ? "Лимит запросов. Попробуйте позже."
          : "Попробуйте позже.";
    throw new AppError(`${service}: HTTP ${response.status}. ${hint}`, 502);
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new AppError(`${service}: получен некорректный ответ.`, 502);
  }
}
export interface TraktMedia {
  title: string;
  year?: number;
  ids: { trakt: number; imdb?: string | null };
  overview?: string;
  genres?: string[];
}
interface Entry {
  movie?: TraktMedia;
  show?: TraktMedia;
  rating?: number;
  last_watched_at?: string;
}
export interface Candidate extends TasteItem {
  overview?: string;
  genres?: string[];
}
export class Trakt {
  private refreshes = new Map<string, Promise<Tokens>>();
  constructor(
    private store: Store,
    readonly clientId: string,
    readonly baseUrl: string,
    private request: Http = http,
    private clientSecret?: string,
  ) {}
  async exchange(body: Record<string, string>): Promise<Tokens> {
    const response = await this.request("https://api.trakt.tv/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(body.grant_type === "refresh_token" && this.clientSecret
          ? { client_secret: this.clientSecret }
          : {}),
        client_id: this.clientId,
        redirect_uri: `${this.baseUrl}/auth/trakt/callback`,
        ...body,
      }),
    });
    const tokens = await jsonResponse<Tokens>(response, "Trakt");
    if (
      !tokens.access_token ||
      !tokens.refresh_token ||
      !Number.isFinite(tokens.expires_in) ||
      !Number.isFinite(tokens.created_at)
    )
      throw new AppError("Trakt: неверный ответ авторизации.", 502);
    return tokens;
  }
  async token(id: string): Promise<Tokens> {
    const profile = this.store.byId(id);
    const tokens = profile && this.store.secrets(profile).trakt;
    if (!tokens) throw new AppError("Сначала подключите Trakt.", 401);
    if ((tokens.created_at + tokens.expires_in) * 1000 > Date.now() + 60_000)
      return tokens;
    const pending = this.refreshes.get(id);
    if (pending) return pending;
    const work = this.exchange({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
    })
      .then((fresh) => {
        this.store.update(id, { trakt: fresh });
        return fresh;
      })
      .finally(() => this.refreshes.delete(id));
    this.refreshes.set(id, work);
    return work;
  }
  async get(path: string, token: string): Promise<Response> {
    return this.request(`https://api.trakt.tv${path}`, {
      headers: {
        "trakt-api-version": "2",
        "trakt-api-key": this.clientId,
        Authorization: `Bearer ${token}`,
      },
    });
  }
  async pages<T>(path: string, token: string): Promise<T[]> {
    const all: T[] = [];
    for (let page = 1; page <= 200; page++) {
      const response = await this.get(
        `${path}${path.includes("?") ? "&" : "?"}page=${page}&limit=100`,
        token,
      );
      const data = await jsonResponse<T[]>(response, "Trakt");
      if (!Array.isArray(data))
        throw new AppError("Trakt: неверный формат списка.", 502);
      all.push(...data);
      const count = Number(response.headers.get("X-Pagination-Page-Count"));
      if (!data.length || (count > 0 && page >= count)) return all;
      // Without pagination headers, continue until an empty page; servers may reduce page size.
    }
    throw new AppError(
      "История Trakt слишком большая для первой версии (более 200 страниц).",
      422,
    );
  }
  async taste(id: string): Promise<Taste> {
    const { access_token: token } = await this.token(id);
    const result: Taste = { watched: [], ratings: [], watchlist: [] };
    for (const [kind, endpoint] of [
      ["watched", "watched"],
      ["ratings", "ratings"],
      ["watchlist", "watchlist"],
    ] as const) {
      for (const [plural, type, key] of [
        ["movies", "movie", "movie"],
        ["shows", "series", "show"],
      ] as const) {
        const rows = await this.pages<Entry>(
          `/sync/${endpoint}/${plural}`,
          token,
        );
        result[kind].push(
          ...rows.flatMap((row) => {
            const media = row[key];
            if (!media || !Number.isInteger(media.ids?.trakt) || !media.title)
              return [];
            return [
              {
                title: media.title,
                year: media.year,
                imdb: media.ids.imdb || undefined,
                trakt: media.ids.trakt,
                type,
                rating: row.rating,
                watchedAt: row.last_watched_at,
              },
            ];
          }),
        );
      }
    }
    result.watched.sort((a, b) =>
      (b.watchedAt || "").localeCompare(a.watchedAt || ""),
    );
    return result;
  }
  async candidates(
    id: string,
    taste: Taste,
    types: ("movie" | "series")[],
  ): Promise<Candidate[]> {
    const { access_token: token } = await this.token(id);
    const excluded = new Set(
      [
        ...taste.watched,
        ...taste.ratings.filter((t) => (t.rating || 0) <= 5),
      ].map(key),
    );
    const candidates = new Map<string, Candidate>();
    for (const type of types) {
      const plural = type === "movie" ? "movies" : "shows";
      const seeds = [
        ...taste.ratings
          .filter((t) => (t.rating || 0) >= 7)
          .sort((a, b) => (b.rating || 0) - (a.rating || 0)),
        ...taste.watched,
        ...taste.watchlist,
      ];
      const seen = new Set<number>();
      const selected = seeds
        .filter(
          (t) => t.type === type && !seen.has(t.trakt) && seen.add(t.trakt),
        )
        .slice(0, 4);
      const pools: TraktMedia[][] = [];
      for (const seed of selected) {
        pools.push(
          await jsonResponse<TraktMedia[]>(
            await this.get(
              `/${plural}/${seed.trakt}/related?extended=full&limit=20`,
              token,
            ),
            "Trakt",
          ),
        );
      }
      // A discovery pool also allows cross-format recommendations when history contains only one type.
      pools.push(
        await jsonResponse<TraktMedia[]>(
          await this.get(`/${plural}/popular?extended=full&limit=40`, token),
          "Trakt",
        ),
      );
      for (const media of pools.flat()) {
        if (!media.ids?.imdb || !/^tt\d+$/.test(media.ids.imdb)) continue;
        const item: Candidate = {
          type,
          title: media.title,
          year: media.year,
          trakt: media.ids.trakt,
          imdb: media.ids.imdb,
          overview: media.overview?.slice(0, 400),
          genres: media.genres,
        };
        if (!excluded.has(key(item))) candidates.set(key(item), item);
      }
    }
    return [...candidates.values()];
  }
}
export const key = (item: Pick<TasteItem, "type" | "trakt">) =>
  `${item.type}:${item.trakt}`;
