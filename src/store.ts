import { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Profile, Secrets, Meta } from "./domain";

export const randomToken = () => randomBytes(32).toString("base64url");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export class Store {
  db: Database;
  private key: Buffer;
  constructor(path: string, key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key))
      throw new Error(
        "ENCRYPTION_KEY must contain 64 hex characters. See .env.example.",
      );
    this.key = Buffer.from(key, "hex");
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY, session_hash TEXT UNIQUE NOT NULL, addon_hash TEXT UNIQUE NOT NULL,
        secret TEXT NOT NULL, cache TEXT, cached_at INTEGER NOT NULL DEFAULT 0,
        attempted_at INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth (
        state_hash TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        verifier TEXT NOT NULL, expires_at INTEGER NOT NULL
      );`);
  }
  encrypt(value: unknown) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  decrypt<T>(value: string): T {
    const bytes = Buffer.from(value, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.subarray(0, 12),
    );
    cipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([
        cipher.update(bytes.subarray(28)),
        cipher.final(),
      ]).toString("utf8"),
    );
  }
  create() {
    const id = crypto.randomUUID(),
      session = randomToken(),
      addon = randomToken();
    // The installation token is encrypted alongside credentials so the setup page can retrieve it.
    this.db
      .query(
        "INSERT INTO profiles (id,session_hash,addon_hash,secret) VALUES (?,?,?,?)",
      )
      .run(id, hash(session), hash(addon), this.encrypt({ addon }));
    return { profile: this.byId(id)!, session };
  }
  byId(id: string) {
    return this.db
      .query<Profile, [string]>("SELECT * FROM profiles WHERE id=?")
      .get(id);
  }
  bySession(token: string) {
    return this.db
      .query<Profile, [string]>("SELECT * FROM profiles WHERE session_hash=?")
      .get(hash(token));
  }
  byAddon(token: string) {
    return this.db
      .query<Profile, [string]>("SELECT * FROM profiles WHERE addon_hash=?")
      .get(hash(token));
  }
  secrets(profile: Profile) {
    return this.decrypt<Secrets & { addon: string }>(profile.secret);
  }
  update(id: string, change: Partial<Secrets>) {
    const profile = this.byId(id);
    if (!profile) throw new Error("Profile deleted");
    this.db
      .query("UPDATE profiles SET secret=? WHERE id=?")
      .run(this.encrypt({ ...this.secrets(profile), ...change }), id);
  }
  setCache(id: string, metas: Meta[]) {
    this.db
      .query("UPDATE profiles SET cache=?, cached_at=?, error=NULL WHERE id=?")
      .run(this.encrypt(metas), Date.now(), id);
  }
  cached(profile: Profile): Meta[] {
    return profile.cache ? this.decrypt<Meta[]>(profile.cache) : [];
  }
  clearCache(id: string) {
    this.db
      .query("UPDATE profiles SET cache=NULL,cached_at=0,error=NULL WHERE id=?")
      .run(id);
  }
  attempt(id: string) {
    this.db
      .query("UPDATE profiles SET attempted_at=?,error=NULL WHERE id=?")
      .run(Date.now(), id);
  }
  error(id: string, message: string) {
    this.db.query("UPDATE profiles SET error=? WHERE id=?").run(message, id);
  }
  remove(id: string) {
    this.db.query("DELETE FROM profiles WHERE id=?").run(id);
  }
  oauth(id: string) {
    this.db
      .query("DELETE FROM oauth WHERE expires_at < ? OR profile_id = ?")
      .run(Date.now(), id);
    const state = randomToken(),
      verifier = randomToken();
    this.db
      .query("INSERT INTO oauth VALUES (?,?,?,?)")
      .run(hash(state), id, this.encrypt(verifier), Date.now() + 600_000);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { state, challenge };
  }
  consumeOAuth(state: string, id: string) {
    const row = this.db
      .query<{ verifier: string }, [string, string, number]>(
        "DELETE FROM oauth WHERE state_hash=? AND profile_id=? AND expires_at>? RETURNING verifier",
      )
      .get(hash(state), id, Date.now());
    return row ? this.decrypt<string>(row.verifier) : null;
  }
}
