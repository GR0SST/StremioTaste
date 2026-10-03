export type MediaType = "movie" | "series";
export type CatalogId = "taste-movies" | "taste-series" | "taste-mixed";
export const catalogs = [
  { id: "taste-movies", type: "movie", name: "Taste · Movies" },
  { id: "taste-series", type: "series", name: "Taste · Series" },
  { id: "taste-mixed", type: "Taste", name: "Taste · Both" },
] as const;
export interface Settings {
  provider: "openai" | "openrouter";
  model: string;
  apiKey: string;
  catalogs: CatalogId[];
  preferences?: string;
}
export interface Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at: number;
}
export interface Secrets {
  settings?: Settings;
  trakt?: Tokens;
}
export interface Meta {
  id: string;
  type: MediaType;
  name: string;
  poster: string;
  releaseInfo?: string;
}
export interface TasteItem {
  title: string;
  year?: number;
  imdb?: string;
  trakt: number;
  type: MediaType;
  rating?: number;
  watchedAt?: string;
}
export interface Taste {
  watched: TasteItem[];
  ratings: TasteItem[];
  watchlist: TasteItem[];
}
export interface Profile {
  id: string;
  session_hash: string;
  addon_hash: string;
  secret: string;
  cache: string | null;
  cached_at: number;
  attempted_at: number;
  error: string | null;
}

export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function validateSettings(value: unknown): Settings {
  if (!value || typeof value !== "object")
    throw new AppError("Invalid settings.");
  const s = value as Record<string, unknown>;
  if (s.provider !== "openai" && s.provider !== "openrouter")
    throw new AppError("Select OpenAI or OpenRouter.");
  if (
    typeof s.apiKey !== "string" ||
    s.apiKey.trim().length < 8 ||
    s.apiKey.length > 512 ||
    /[\r\n]/.test(s.apiKey)
  )
    throw new AppError("Enter your API key.");
  if (
    typeof s.model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,199}$/.test(s.model)
  )
    throw new AppError("Enter a valid model ID.");
  if (
    !Array.isArray(s.catalogs) ||
    !s.catalogs.length ||
    s.catalogs.some((id) => !catalogs.some((c) => c.id === id))
  )
    throw new AppError("Select at least one catalog.");
  if (
    s.preferences !== undefined &&
    (typeof s.preferences !== "string" || s.preferences.length > 1000)
  )
    throw new AppError("Preferences must be under 1,000 characters.");
  return {
    provider: s.provider,
    apiKey: s.apiKey.trim(),
    model: s.model,
    catalogs: [...new Set(s.catalogs)] as CatalogId[],
    preferences: typeof s.preferences === "string" ? s.preferences.trim() : "",
  };
}
export function manifest(settings?: Settings) {
  const selected = settings
    ? catalogs.filter((c) => settings.catalogs.includes(c.id))
    : [];
  return {
    id: "community.stremio.taste",
    version: "0.1.0",
    name: "Taste",
    description:
      "Personal recommendations from your Trakt history and ratings.",
    resources: ["catalog"],
    types: [...new Set(selected.map((c) => c.type))],
    catalogs: selected.map((c) => ({
      ...c,
      extra: [{ name: "skip", isRequired: false }],
    })),
    behaviorHints: { configurable: true, configurationRequired: !settings },
  };
}
export function selectCatalog(metas: Meta[], id: string, skip = 0) {
  const type =
    id === "taste-movies" ? "movie" : id === "taste-series" ? "series" : null;
  return metas.filter((m) => !type || m.type === type).slice(skip, skip + 40);
}
