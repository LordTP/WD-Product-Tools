// Minimal ShipHero GraphQL client — server-side only.
// Handles refresh-token → access-token auth (cached, auto-refresh on 401/expiry),
// Bearer GraphQL requests, and basic credit-throttle backoff. This is the
// foundation for vendor sync (Phase 2) and PO push + receiving (later).
//
// Auth + rate-limit behaviour per docs/SHIPHERO_API_REFERENCE.md.

import { readFileSync, writeFileSync } from "node:fs";

const AUTH_URL = "https://public-api.shiphero.com/auth/refresh";
const GRAPHQL_URL = "https://public-api.shiphero.com/graphql";
const TOKEN_CACHE = process.env.SHIPHERO_TOKEN_CACHE ?? ".shiphero_token.json";

export class ShipheroError extends Error {
  constructor(
    message: string,
    public readonly kind:
      | "no_token"
      | "auth_failed"
      | "graphql_error"
      | "throttled"
      | "network" = "graphql_error",
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ShipheroError";
  }
}

interface CachedToken {
  accessToken: string;
  expiresAt: number; // epoch ms
}

let memo: CachedToken | null = null;

function loadCache(): CachedToken | null {
  if (memo) return memo;
  try {
    const raw = JSON.parse(readFileSync(TOKEN_CACHE, "utf-8")) as CachedToken;
    if (raw.accessToken && raw.expiresAt) {
      memo = raw;
      return raw;
    }
  } catch {
    /* no cache yet */
  }
  return null;
}

function saveCache(tok: CachedToken) {
  memo = tok;
  try {
    writeFileSync(TOKEN_CACHE, JSON.stringify(tok), "utf-8");
  } catch {
    /* cache is best-effort; memory copy still works */
  }
}

export function hasRefreshToken(): boolean {
  return Boolean(process.env.SHIPHERO_REFRESH_TOKEN);
}

/** True if we have *any* usable credential (refresh token preferred, or a
 *  pasted access token to use until it expires). */
export function hasShipheroCredential(): boolean {
  return Boolean(process.env.SHIPHERO_REFRESH_TOKEN || process.env.SHIPHERO_ACCESS_TOKEN);
}

async function mintAccessToken(): Promise<string> {
  const refresh = process.env.SHIPHERO_REFRESH_TOKEN;
  if (!refresh) {
    throw new ShipheroError(
      "SHIPHERO_REFRESH_TOKEN is not set. Add it to .env.local.",
      "no_token",
    );
  }
  let res: Response;
  try {
    res = await fetch(AUTH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
  } catch (err) {
    throw new ShipheroError("Could not reach ShipHero auth endpoint.", "network", err);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ShipheroError(
      `ShipHero auth failed (${res.status}). Check the refresh token.`,
      "auth_failed",
      body,
    );
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) {
    throw new ShipheroError("ShipHero auth response had no access_token.", "auth_failed", json);
  }
  // expires_in is seconds (~28 days). Refresh 1h early to be safe.
  const ttl = (json.expires_in ?? 60 * 60 * 24 * 28) * 1000;
  const tok: CachedToken = { accessToken: json.access_token, expiresAt: Date.now() + ttl - 3600_000 };
  saveCache(tok);
  return tok.accessToken;
}

async function getAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = loadCache();
    if (cached && cached.expiresAt > Date.now()) return cached.accessToken;
    // Optional: use a pasted access token directly (until it 401s, then we mint).
    const pasted = process.env.SHIPHERO_ACCESS_TOKEN;
    if (pasted) return pasted;
  }
  // forceRefresh (or no pasted token) → mint from the refresh token.
  if (!process.env.SHIPHERO_REFRESH_TOKEN && process.env.SHIPHERO_ACCESS_TOKEN) {
    throw new ShipheroError(
      "The pasted ShipHero access token was rejected and no refresh token is set to mint a new one. Add SHIPHERO_REFRESH_TOKEN to .env.local.",
      "auth_failed",
    );
  }
  return mintAccessToken();
}

interface GraphqlResult<T> {
  data: T;
  complexity?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Keep interactive calls responsive: at most a few short waits, then surface a
// clear "rate-limited" error the UI can offer a Retry on (pool refills 60/sec).
const MAX_THROTTLE_RETRIES = 2;
const MAX_THROTTLE_WAIT_MS = 5000;

/** Run a GraphQL query/mutation. Refreshes the token once on 401, and waits +
 *  retries on credit throttling (ShipHero refills 60 credits/sec). */
export async function shipheroGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown> = {},
  attempt = 0,
  throttleRetries = 0,
): Promise<GraphqlResult<T>> {
  const token = await getAccessToken(attempt > 0);

  let res: Response;
  try {
    res = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new ShipheroError("Could not reach ShipHero GraphQL endpoint.", "network", err);
  }

  if (res.status === 401 && attempt === 0) {
    return shipheroGraphql<T>(query, variables, 1, throttleRetries); // refresh + retry once
  }

  const json = (await res.json().catch(() => ({}))) as {
    data?: T;
    errors?: Array<{
      message: string;
      code?: number;
      time_remaining?: string | number;
      required_credits?: number;
      remaining_credits?: number;
    }>;
  };

  if (json.errors?.length) {
    const throttle = json.errors.find(
      (e) => e.code === 30 || /throttle|credit|rate/i.test(e.message) || e.time_remaining != null,
    );
    if (throttle) {
      if (throttleRetries < MAX_THROTTLE_RETRIES) {
        // Wait for the credit pool to refill, then retry. ShipHero gives
        // time_remaining (seconds); fall back to estimating from credit deficit.
        const fromField = Number(throttle.time_remaining);
        const deficit =
          (throttle.required_credits ?? 0) - (throttle.remaining_credits ?? 0);
        const estSec = deficit > 0 ? deficit / 60 : 0;
        const waitMs = Math.min(Math.max(fromField || estSec, 1) * 1000 + 250, MAX_THROTTLE_WAIT_MS);
        await sleep(waitMs);
        return shipheroGraphql<T>(query, variables, attempt, throttleRetries + 1);
      }
      throw new ShipheroError(
        "ShipHero is rate-limiting (out of credits). Try again in a moment.",
        "throttled",
        json.errors,
      );
    }
    throw new ShipheroError(json.errors.map((e) => e.message).join("; "), "graphql_error", json.errors);
  }

  if (!json.data) {
    throw new ShipheroError("ShipHero returned no data.", "graphql_error", json);
  }
  return { data: json.data };
}

/** Lightweight connectivity test — returns the authed account id if reachable. */
export async function shipheroCheck(): Promise<{ ok: true; accountId?: string }> {
  const { data } = await shipheroGraphql<{ account?: { data?: { id?: string } } }>(
    `query { account { data { id } } }`,
  );
  return { ok: true, accountId: data.account?.data?.id };
}
