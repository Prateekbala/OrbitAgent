import { z } from 'zod';
import type { ConnectorId } from '@ao/contracts/connections';
import { AppError } from '../lib/errors.js';
import type { Credential } from './provider.js';
export type OAuthAccess = 'read' | 'write';
interface ConnectorOAuth {
  authorization(state: string, challenge: string, access?: OAuthAccess): string;
  exchange(code: string, verifier: string, access?: OAuthAccess): Promise<Credential>;
  refresh(credential: Credential): Promise<Credential>;
}
export type ConnectorOAuthProviders = Partial<Record<ConnectorId, ConnectorOAuth>>;
interface Profile {
  authorize: string;
  token: string;
  read: string[];
  write: string[];
  pkce: boolean;
  encoding: 'form' | 'json' | 'basic-json';
  expiryOptional?: boolean;
  parameters?: Record<string, string>;
}
export const oauthProfiles = {
  google_drive: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    read: ['https://www.googleapis.com/auth/drive.readonly'],
    write: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
    pkce: true,
    encoding: 'form',
    parameters: { access_type: 'offline', prompt: 'consent' },
  },
  linear: {
    authorize: 'https://linear.app/oauth/authorize',
    token: 'https://api.linear.app/oauth/token',
    read: ['read'],
    write: ['read', 'write'],
    pkce: true,
    encoding: 'form',
  },
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    read: ['repo'],
    write: ['repo'],
    pkce: true,
    encoding: 'form',
    expiryOptional: true,
  },
  gitlab: {
    authorize: 'https://gitlab.com/oauth/authorize',
    token: 'https://gitlab.com/oauth/token',
    read: ['read_api'],
    write: ['api'],
    pkce: true,
    encoding: 'form',
  },
  jira: {
    authorize: 'https://auth.atlassian.com/authorize',
    token: 'https://auth.atlassian.com/oauth/token',
    read: ['read:jira-work', 'offline_access'],
    write: ['read:jira-work', 'write:jira-work', 'offline_access'],
    pkce: false,
    encoding: 'json',
    parameters: { audience: 'api.atlassian.com', prompt: 'consent' },
  },
  microsoft365: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    read: ['https://graph.microsoft.com/Files.Read', 'offline_access'],
    write: ['https://graph.microsoft.com/Files.ReadWrite', 'offline_access'],
    pkce: true,
    encoding: 'form',
  },
  notion: {
    authorize: 'https://api.notion.com/v1/oauth/authorize',
    token: 'https://api.notion.com/v1/oauth/token',
    read: [],
    write: [],
    pkce: false,
    encoding: 'basic-json',
    expiryOptional: true,
    parameters: { owner: 'user' },
  },
  hubspot: {
    authorize: 'https://app.hubspot.com/oauth/authorize',
    token: 'https://api.hubapi.com/oauth/v1/token',
    read: ['oauth', 'crm.objects.contacts.read'],
    write: ['oauth', 'crm.objects.contacts.read', 'crm.objects.contacts.write'],
    pkce: false,
    encoding: 'form',
  },
} satisfies Record<string, Profile>;
export type OAuthProviderId = keyof typeof oauthProfiles;
const oauthFailure = () =>
  new AppError(
    502,
    'CONNECTOR_OAUTH_FAILED',
    'The provider could not authorize or refresh this connection. Start a new consent request.',
  );
export class FixedConnectorOAuth implements ConnectorOAuth {
  private profile: Profile;
  constructor(
    provider: OAuthProviderId,
    private clientId: string,
    private clientSecret: string,
    private redirectUri: string,
  ) {
    this.profile = oauthProfiles[provider];
  }
  authorization(state: string, challenge: string, access: OAuthAccess = 'read') {
    const url = new URL(this.profile.authorize);
    const params: Record<string, string> = {
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      state,
      ...this.profile.parameters,
    };
    const scopes = this.profile[access];
    if (scopes.length) params.scope = scopes.join(' ');
    if (this.profile.pkce)
      Object.assign(params, { code_challenge: challenge, code_challenge_method: 'S256' });
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.href;
  }
  exchange(code: string, verifier: string, access: OAuthAccess = 'read') {
    return this.token(
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri,
        ...(this.profile.pkce ? { code_verifier: verifier } : {}),
      },
      access,
    );
  }
  async refresh(credential: Credential) {
    if (!credential.refreshToken)
      throw new AppError(
        409,
        'CONNECTION_RECONNECT_REQUIRED',
        'The connection has no refresh token.',
      );
    const next = await this.token(
      { grant_type: 'refresh_token', refresh_token: credential.refreshToken },
      credential.writeAllowed ? 'write' : 'read',
    );
    return {
      ...next,
      ...((next.scopes ?? credential.scopes) ? { scopes: next.scopes ?? credential.scopes! } : {}),
      refreshToken: next.refreshToken ?? credential.refreshToken,
    };
  }
  private async token(values: Record<string, string>, access: OAuthAccess): Promise<Credential> {
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type':
          this.profile.encoding === 'form'
            ? 'application/x-www-form-urlencoded'
            : 'application/json',
      };
      let fields: Record<string, string> = {
        ...values,
        client_id: this.clientId,
        client_secret: this.clientSecret,
      };
      if (this.profile.encoding === 'basic-json') {
        headers.authorization =
          'Basic ' + Buffer.from(this.clientId + ':' + this.clientSecret).toString('base64');
        fields = { ...values };
      }
      const response = await fetch(this.profile.token, {
        method: 'POST',
        headers,
        body:
          this.profile.encoding === 'form' ? new URLSearchParams(fields) : JSON.stringify(fields),
        signal: AbortSignal.timeout(10000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw oauthFailure();
      }
      const reader = response.body?.getReader();
      if (!reader) throw oauthFailure();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 32000) throw oauthFailure();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      const value = z
        .object({
          access_token: z.string().min(1).max(20000),
          refresh_token: z.string().min(1).max(20000).optional(),
          expires_in: z.coerce.number().positive().max(31536000).optional(),
          token_type: z.string().optional(),
          scope: z.union([z.string().max(4000), z.array(z.string().max(200)).max(100)]).optional(),
          error: z.unknown().optional(),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (
        value.error ||
        (value.token_type && value.token_type.toLowerCase() !== 'bearer') ||
        (!value.expires_in && !this.profile.expiryOptional)
      )
        throw oauthFailure();
      const granted =
        typeof value.scope === 'string' ? value.scope.split(/[ ,]+/).filter(Boolean) : value.scope;
      const normalize = (s: string) => s.replace('https://graph.microsoft.com/', '').toLowerCase();
      const required = this.profile[access].filter((s) => !['offline_access', 'oauth'].includes(s));
      if (granted && required.some((s) => !granted.some((g) => normalize(g) === normalize(s))))
        throw oauthFailure();
      return {
        accessToken: value.access_token,
        tokenType: 'Bearer',
        writeAllowed: access === 'write',
        ...(granted ? { scopes: granted } : {}),
        ...(value.expires_in ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}),
        ...(value.refresh_token ? { refreshToken: value.refresh_token } : {}),
      };
    } catch {
      throw oauthFailure();
    }
  }
}
