import { AppError, type Tokens } from "./domain";
import { Store } from "./store";
import { http, jsonResponse, type Http } from "./upstream";
interface DeviceRow {
  profile_id: string;
  secret: string;
  expires_at: number;
  next_poll: number;
  interval_ms: number;
}
interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}
export class DeviceAuth {
  private polls = new Set<string>();
  constructor(
    private store: Store,
    private clientId: string,
    private clientSecret: string,
    private request: Http = http,
  ) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS devices (
      profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,
      secret TEXT NOT NULL, expires_at INTEGER NOT NULL, next_poll INTEGER NOT NULL, interval_ms INTEGER NOT NULL
    )`);
  }
  async start(id: string) {
    if (this.polls.has(id)) throw new AppError("Trakt check in progress.", 409);
    const code = await jsonResponse<DeviceCode>(
      await this.request("https://api.trakt.tv/oauth/device/code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: this.clientId }),
      }),
      "Trakt",
    );
    if (
      !code.device_code ||
      !code.user_code ||
      !Number.isFinite(code.expires_in) ||
      !Number.isFinite(code.interval)
    )
      throw new AppError("Trakt: invalid activation code.", 502);
    const verification = new URL(code.verification_url);
    if (
      verification.protocol !== "https:" ||
      !["trakt.tv", "app.trakt.tv", "auth.trakt.tv"].includes(
        verification.hostname,
      )
    )
      throw new AppError("Trakt: invalid activation URL.", 502);
    const interval = Math.max(5, code.interval) * 1000;
    const expires = Date.now() + code.expires_in * 1000;
    this.store.db
      .query("INSERT OR REPLACE INTO devices VALUES (?,?,?,?,?)")
      .run(
        id,
        this.store.encrypt(code.device_code),
        expires,
        Date.now() + interval,
        interval,
      );
    return {
      device: {
        userCode: code.user_code,
        verificationUrl: verification.toString(),
        expiresAt: expires,
        interval,
      },
    };
  }
  async poll(id: string): Promise<{ connected: boolean; interval?: number }> {
    const row = this.store.db
      .query<DeviceRow, [string]>("SELECT * FROM devices WHERE profile_id=?")
      .get(id);
    if (!row) throw new AppError("Reconnect Trakt.", 409);
    if (row.expires_at < Date.now()) {
      this.remove(id);
      throw new AppError("Trakt code expired. Reconnect.", 410);
    }
    if (this.polls.has(id) || row.next_poll > Date.now())
      return { connected: false, interval: row.interval_ms };
    this.polls.add(id);
    this.store.db
      .query("UPDATE devices SET next_poll=? WHERE profile_id=?")
      .run(Date.now() + row.interval_ms, id);
    try {
      const response = await this.request(
        "https://api.trakt.tv/oauth/device/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            code: this.store.decrypt<string>(row.secret),
            client_id: this.clientId,
            client_secret: this.clientSecret,
          }),
        },
      );
      if (response.status === 400)
        return { connected: false, interval: row.interval_ms };
      if (response.status === 429) {
        const interval = row.interval_ms + 5000;
        this.store.db
          .query(
            "UPDATE devices SET interval_ms=?,next_poll=? WHERE profile_id=?",
          )
          .run(interval, Date.now() + interval, id);
        return { connected: false, interval };
      }
      if ([404, 409, 410, 418].includes(response.status)) {
        this.remove(id);
        throw new AppError(
          "Trakt: code expired or access denied. Reconnect.",
          409,
        );
      }
      const tokens = await jsonResponse<Tokens>(response, "Trakt");
      if (
        !tokens.access_token ||
        !tokens.refresh_token ||
        !Number.isFinite(tokens.expires_in) ||
        !Number.isFinite(tokens.created_at)
      )
        throw new AppError("Trakt: invalid authorization response.", 502);
      this.store.update(id, { trakt: tokens });
      this.store.clearCache(id);
      this.remove(id);
      return { connected: true };
    } finally {
      this.polls.delete(id);
    }
  }
  private remove(id: string) {
    this.store.db.query("DELETE FROM devices WHERE profile_id=?").run(id);
  }
}
