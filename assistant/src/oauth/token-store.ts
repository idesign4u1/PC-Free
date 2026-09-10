import type { Repositories } from '../db/repositories.js';
import type { OAuthConnection, Provider } from '../domain/types.js';
import { decryptSecret, encryptSecret } from '../utils/crypto.js';
import { IntegrationError, ReauthRequiredError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Holds OAuth tokens encrypted at rest (AES-256-GCM) and refreshes them
 * on demand. Refresh tokens are never logged and never leave this module in
 * plaintext.
 */

export interface ProviderOAuthConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  redirectUri: string;
  authUrl: string;
  scopes: string[];
  /** Extra params for the authorisation request (e.g. Google's offline access). */
  authExtras?: Record<string, string>;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

/** Refresh a little early so an in-flight request never fails on expiry. */
const REFRESH_SKEW_MS = 120_000;

export class TokenStore {
  constructor(
    private readonly repos: Repositories,
    private readonly key: Buffer,
    private readonly configs: Record<Provider, ProviderOAuthConfig | null>,
  ) {}

  config(provider: Provider): ProviderOAuthConfig {
    const cfg = this.configs[provider];
    if (!cfg) throw new IntegrationError(provider, `${provider} OAuth is not configured`, 501, false);
    return cfg;
  }

  buildAuthUrl(provider: Provider, state: string): string {
    const cfg = this.config(provider);
    const url = new URL(cfg.authUrl);
    url.searchParams.set('client_id', cfg.clientId);
    url.searchParams.set('redirect_uri', cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', cfg.scopes.join(' '));
    url.searchParams.set('state', state);
    for (const [k, v] of Object.entries(cfg.authExtras ?? {})) url.searchParams.set(k, v);
    return url.toString();
  }

  async exchangeCode(provider: Provider, code: string): Promise<TokenResponse> {
    const cfg = this.config(provider);
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: cfg.redirectUri,
    });
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new IntegrationError(provider, `Token exchange failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as TokenResponse;
  }

  async saveConnection(input: {
    userId: string;
    provider: Provider;
    accountEmail: string;
    tokens: TokenResponse;
  }): Promise<OAuthConnection> {
    const expiresAt = input.tokens.expires_in ? new Date(Date.now() + input.tokens.expires_in * 1000) : null;
    return this.repos.oauth.upsert({
      user_id: input.userId,
      provider: input.provider,
      account_email: input.accountEmail,
      scopes: input.tokens.scope?.split(' ') ?? this.config(input.provider).scopes,
      access_token_enc: encryptSecret(input.tokens.access_token, this.key),
      refresh_token_enc: input.tokens.refresh_token ? encryptSecret(input.tokens.refresh_token, this.key) : null,
      expires_at: expiresAt,
    });
  }

  /**
   * Returns a usable access token, refreshing when needed.
   * Throws ReauthRequiredError when the refresh token is gone or rejected —
   * callers surface that as "reconnect your account", never as a retry.
   */
  async accessTokenFor(connectionId: string): Promise<string> {
    const conn = await this.repos.oauth.findById(connectionId);
    if (!conn) throw new IntegrationError('oauth', `Unknown OAuth connection ${connectionId}`, 404, false);
    if (conn.status === 'revoked') {
      throw new ReauthRequiredError(conn.provider, `${conn.provider} connection was revoked`);
    }

    const stillValid = conn.access_token_enc && conn.expires_at && conn.expires_at.getTime() - REFRESH_SKEW_MS > Date.now();
    if (stillValid) return decryptSecret(conn.access_token_enc!, this.key);
    if (conn.access_token_enc && !conn.expires_at) return decryptSecret(conn.access_token_enc, this.key);

    if (!conn.refresh_token_enc) {
      await this.repos.oauth.markStatus(conn.id, 'needs_reauth', 'no refresh token stored');
      throw new ReauthRequiredError(conn.provider, `${conn.provider} needs to be reconnected`);
    }

    const cfg = this.config(conn.provider);
    const refreshToken = decryptSecret(conn.refresh_token_enc, this.key);
    const res = await fetch(cfg.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        ...(conn.provider === 'microsoft' ? { scope: cfg.scopes.join(' ') } : {}),
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      // 400 with invalid_grant means the user revoked access or changed password.
      const permanent = res.status === 400 || res.status === 401;
      await this.repos.oauth.markStatus(conn.id, permanent ? 'needs_reauth' : 'error', `refresh failed: ${detail}`);
      if (permanent) throw new ReauthRequiredError(conn.provider, `${conn.provider} needs to be reconnected`);
      throw new IntegrationError(conn.provider, `Token refresh failed (${res.status})`, res.status);
    }

    const tokens = (await res.json()) as TokenResponse;
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
    await this.repos.oauth.updateTokens(
      conn.id,
      encryptSecret(tokens.access_token, this.key),
      expiresAt,
      tokens.refresh_token ? encryptSecret(tokens.refresh_token, this.key) : null,
    );
    logger().info({ provider: conn.provider, connection: conn.id }, 'refreshed OAuth token');
    return tokens.access_token;
  }
}

/**
 * Least-privilege scopes.
 * Calendar is read/write because the assistant creates events; mail is
 * read-only — the assistant extracts action items and never sends or modifies.
 */
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export const MICROSOFT_SCOPES = [
  'openid',
  'email',
  'profile',
  'offline_access',
  'Calendars.ReadWrite',
  'Mail.Read',
  'User.Read',
];

export function googleConfig(clientId: string, clientSecret: string, redirectUri: string): ProviderOAuthConfig {
  return {
    clientId,
    clientSecret,
    redirectUri,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: GOOGLE_SCOPES,
    // access_type=offline + prompt=consent is what makes Google return a
    // refresh token; without it the connection dies after an hour.
    authExtras: { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  };
}

export function microsoftConfig(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  tenant: string,
): ProviderOAuthConfig {
  return {
    clientId,
    clientSecret,
    redirectUri,
    authUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    scopes: MICROSOFT_SCOPES,
    authExtras: { response_mode: 'query' },
  };
}
