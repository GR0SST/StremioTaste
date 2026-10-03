export type MediaType = "movie" | "series";
export type CatalogId = "taste-movies" | "taste-series" | "taste-mixed";
export const catalogs = [
  { id: "taste-movies", type: "movie", name: "Taste · Фильмы" },
  { id: "taste-series", type: "series", name: "Taste · Сериалы" },
  { id: "taste-mixed", type: "Taste", name: "Taste · Всё вместе" },
] as const;
export interface Settings {
  provider: "openai" | "openrouter";
  model: string;
  apiKey: string;
  catalogs: CatalogId[];
  language: "ru" | "uk" | "en";
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
  description?: string;
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
    throw new AppError("Неверные настройки.");
  const s = value as Record<string, unknown>;
  if (s.provider !== "openai" && s.provider !== "openrouter")
    throw new AppError("Выберите OpenAI или OpenRouter.");
  if (
    typeof s.apiKey !== "string" ||
    s.apiKey.trim().length < 8 ||
    s.apiKey.length > 512 ||
    /[\r\n]/.test(s.apiKey)
  )
    throw new AppError("Введите API-ключ выбранного провайдера.");
  if (
    typeof s.model !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_./:@+-]{0,199}$/.test(s.model)
  )
    throw new AppError("Введите корректный ID модели.");
  if (
    !Array.isArray(s.catalogs) ||
    !s.catalogs.length ||
    s.catalogs.some((id) => !catalogs.some((c) => c.id === id))
  )
    throw new AppError("Выберите хотя бы один каталог.");
  if (!["ru", "uk", "en"].includes(String(s.language)))
    throw new AppError("Выберите язык.");
  return {
    provider: s.provider,
    apiKey: s.apiKey.trim(),
    model: s.model,
    catalogs: [...new Set(s.catalogs)] as CatalogId[],
    language: s.language as Settings["language"],
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
    description: "Персональные рекомендации по вашей истории и оценкам Trakt.",
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
