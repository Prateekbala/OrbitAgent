import { randomUUID, X509Certificate } from 'node:crypto';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'undici';
import * as oidc from 'openid-client';
import { SAML, ValidateInResponseTo, type CacheProvider } from '@node-saml/node-saml';
import { identityScope, type Database, type Sql } from '@ao/database';
import type { z } from 'zod';
import type { providerInput } from '@ao/contracts';
import { digest, hashPassword, token } from '../lib/security.js';
import { createSession } from '../lib/sessions.js';
import { AppError } from '../lib/errors.js';
import { AccountSecurity } from './security.js';
import { requireOrganizationEntitlement } from '../billing/entitlements.js';
import { organizationActor, organizationAudit } from './organizations.js';
import { securityEvent } from './tokens.js';
export interface FederationOptions {
  allowedHosts?: string[];
  allowLoopback?: boolean;
}
interface ProviderConfiguration {
  issuer: string;
  workspaceId: string;
  jitProvisioning: boolean;
  clientId?: string;
  entryPoint?: string;
  idpCert?: string;
}
interface Provider extends Record<string, unknown> {
  id: string;
  organization_id: string;
  protocol: 'oidc' | 'saml';
  configuration: ProviderConfiguration;
  secret: string | null;
  enabled: boolean;
}
function publicAddress(value: string) {
  if (isIP(value) === 4) {
    const p = value.split('.').map(Number);
    return !(
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0]! >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1]! >= 64 && p[1]! <= 127) ||
      (p[0] === 198 && [18, 19].includes(p[1]!))
    );
  }
  const v = value.toLowerCase();
  return isIP(v) === 6 && /^[23]/.test(v) && !v.startsWith('2001:db8:');
}
export class FederationService {
  private readonly dispatcher: Agent;
  constructor(
    readonly db: Database,
    readonly security: AccountSecurity,
    readonly origin: string,
    private readonly options: FederationOptions = {},
  ) {
    this.dispatcher = new Agent({
      connect: {
        lookup: (hostname, opts, callback) => {
          lookup(hostname, { all: true }, (error, addresses) => {
            if (error) return callback(error, [], 4);
            const acceptable = addresses.filter(
              (a) =>
                publicAddress(a.address) ||
                (options.allowLoopback && ['127.0.0.1', '::1'].includes(a.address)),
            );
            if (!acceptable.length || acceptable.length !== addresses.length)
              return callback(
                new Error('Identity provider DNS resolves to a prohibited network.'),
                [],
                4,
              );
            if ((opts as { all?: boolean }).all) callback(null, acceptable);
            else callback(null, acceptable[0]!.address, acceptable[0]!.family);
          });
        },
      },
    });
  }
  close() {
    return this.dispatcher.close();
  }
  validateUrl(value: string) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.hash ||
      !this.options.allowedHosts?.includes(url.hostname) ||
      (url.protocol !== 'https:' &&
        !(
          this.options.allowLoopback &&
          url.protocol === 'http:' &&
          ['localhost', '127.0.0.1'].includes(url.hostname)
        ))
    )
      throw new AppError(
        400,
        'PROVIDER_HOST_NOT_ALLOWED',
        'The operator must allow this HTTPS identity-provider hostname before it can be used.',
      );
    if (isIP(url.hostname) && !publicAddress(url.hostname) && !this.options.allowLoopback)
      throw new AppError(
        400,
        'PROVIDER_HOST_NOT_ALLOWED',
        'Identity providers cannot use private networks.',
      );
    return url;
  }
  private fetch: oidc.CustomFetch = async (input, init) => {
    const url = String(input);
    this.validateUrl(url);
    return fetch(input, {
      ...init,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      dispatcher: this.dispatcher,
    } as RequestInit);
  };
  callback(id: string) {
    return `${this.origin}/api/v1/auth/federation/${id}/callback`;
  }
  async provider(id: string) {
    const [provider] = await identityScope(() =>
      this.db.query<Provider>('SELECT * FROM identity_providers WHERE id=$1 AND enabled', [id]),
    );
    if (!provider)
      throw new AppError(404, 'PROVIDER_UNAVAILABLE', 'This identity provider is unavailable.');
    return provider;
  }
  async configure(tx: Sql, org: string, account: string, input: z.infer<typeof providerInput>) {
    const actor = await organizationActor(tx, org, account, true, true);
    if (input.enabled) await requireOrganizationEntitlement(tx, org, 'sso');
    if (actor.role !== 'owner')
      throw new AppError(
        403,
        'OWNER_REQUIRED',
        'Only an organization owner can configure identity providers.',
      );
    const [workspace] = await tx.query(
      'SELECT id FROM workspaces WHERE id=$1 AND organization_id=$2',
      [input.workspaceId, org],
    );
    if (!workspace)
      throw new AppError(400, 'INVALID_WORKSPACE', 'Select a workspace in this organization.');
    const id = randomUUID();
    let configuration: ProviderConfiguration,
      secret: string | null = null;
    if (input.protocol === 'oidc') {
      this.validateUrl(input.issuer);
      secret = this.security.secrets.seal('provider:' + id, input.clientSecret);
      configuration = {
        issuer: input.issuer,
        clientId: input.clientId,
        workspaceId: input.workspaceId,
        jitProvisioning: input.jitProvisioning,
      };
    } else {
      this.validateUrl(input.entryPoint);
      let cert: X509Certificate;
      try {
        cert = new X509Certificate(input.idpCert);
      } catch {
        throw new AppError(
          400,
          'INVALID_CERTIFICATE',
          'Provide a PEM-encoded IdP signing certificate.',
        );
      }
      if (
        cert.publicKey.asymmetricKeyType !== 'rsa' ||
        (cert.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new AppError(
          400,
          'INVALID_CERTIFICATE',
          'SAML signing certificates require an RSA key of at least 2048 bits.',
        );
      if (
        new Date(cert.validTo).getTime() <= Date.now() ||
        new Date(cert.validFrom).getTime() > Date.now()
      )
        throw new AppError(
          400,
          'INVALID_CERTIFICATE',
          'Provide a currently valid IdP signing certificate.',
        );
      configuration = {
        entryPoint: input.entryPoint,
        issuer: input.issuer,
        idpCert: input.idpCert,
        workspaceId: input.workspaceId,
        jitProvisioning: input.jitProvisioning,
      };
      this.security.secrets.seal('provider:' + id, 'configuration-check');
    }
    await tx.query(
      'INSERT INTO identity_providers(id,organization_id,name,protocol,configuration,secret,enabled,workspace_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        id,
        org,
        input.name,
        input.protocol,
        configuration,
        secret,
        input.enabled,
        input.workspaceId,
      ],
    );
    await organizationAudit(tx, org, account, 'identity_provider.created', id);
    return { id, callbackUrl: this.callback(id), entityId: this.callback(id) + '/metadata' };
  }
  private oidc(provider: Provider) {
    const c = provider.configuration;
    return oidc.discovery(
      this.validateUrl(c.issuer!),
      c.clientId!,
      this.security.secrets.open('provider:' + provider.id, provider.secret!),
      undefined,
      {
        [oidc.customFetch]: this.fetch,
        execute: [
          oidc.enableNonRepudiationChecks,
          ...(this.options.allowLoopback ? [oidc.allowInsecureRequests] : []),
        ],
      },
    );
  }
  saml(provider: Provider, state?: string) {
    const c = provider.configuration,
      db = this.db,
      id = provider.id;
    const cache: CacheProvider = {
      saveAsync: async (key, value) =>
        identityScope(async () => {
          if (!state) throw new Error('SAML request state is required.');
          await db.query(
            'INSERT INTO saml_request_ids(id,provider_id,state_hash) VALUES($1,$2,$3)',
            [key, id, digest(state)],
          );
          return { value, createdAt: Date.now() };
        }),
      getAsync: async (key) =>
        identityScope(async () => {
          const [row] = await db.query(
            "SELECT created_at FROM saml_request_ids WHERE id=$1 AND provider_id=$2 AND state_hash=$3 AND created_at>now()-interval '5 minutes'",
            [key, id, digest(state ?? '')],
          );
          return row ? new Date(String(row.created_at)).toISOString() : null;
        }),
      removeAsync: async (key) =>
        identityScope(async () => {
          const [row] = await db.query(
            'DELETE FROM saml_request_ids WHERE id=$1 AND provider_id=$2 AND state_hash=$3 RETURNING id',
            [key, id, digest(state ?? '')],
          );
          return row ? String(row.id) : null;
        }),
    };
    return new SAML({
      callbackUrl: this.callback(id),
      issuer: this.callback(id) + '/metadata',
      idpIssuer: c.issuer!,
      entryPoint: this.validateUrl(c.entryPoint!).href,
      idpCert: c.idpCert!,
      audience: this.callback(id) + '/metadata',
      validateInResponseTo: ValidateInResponseTo.always,
      requestIdExpirationPeriodMs: 300000,
      cacheProvider: cache,
      wantAssertionsSigned: true,
      wantAuthnResponseSigned: true,
      maxAssertionAgeMs: 300000,
      acceptedClockSkewMs: 30000,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      disableRequestedAuthnContext: true,
    });
  }
  async begin(
    provider: Provider,
    browser: string,
    link?: { accountId: string; sessionId: string },
  ) {
    const state = token(),
      verifier = oidc.randomPKCECodeVerifier(),
      nonce = token();
    await identityScope(() =>
      this.db.transaction(async (tx) => {
        await tx.query('DELETE FROM federation_transactions WHERE expires_at<=now()');
        await tx.query("DELETE FROM saml_request_ids WHERE created_at<=now()-interval '5 minutes'");
        await tx.query(
          'INSERT INTO federation_transactions(token_hash,browser_hash,provider_id,verifier,nonce,account_id,session_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            digest(state),
            digest(browser),
            provider.id,
            this.security.secrets.seal('federation:' + digest(state), verifier),
            nonce,
            link?.accountId ?? null,
            link?.sessionId ?? null,
          ],
        );
      }),
    );
    if (provider.protocol === 'saml')
      return this.saml(provider, state).getAuthorizeUrlAsync(state, undefined, {});
    const configuration = await this.oidc(provider);
    return oidc.buildAuthorizationUrl(configuration, {
      redirect_uri: this.callback(provider.id),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).href;
  }
  async finish(
    provider: Provider,
    state: string,
    browser: string,
    currentUrl: URL,
    body?: Record<string, string>,
  ) {
    const [transaction] = await identityScope(() =>
      this.db.query(
        'DELETE FROM federation_transactions WHERE token_hash=$1 AND browser_hash=$2 AND provider_id=$3 AND expires_at>now() RETURNING *',
        [digest(state), digest(browser), provider.id],
      ),
    );
    if (!transaction)
      throw new AppError(
        401,
        'FEDERATION_STATE_INVALID',
        'This sign-in request is invalid, expired, or already used.',
      );
    let subject: string, email: string, name: string;
    try {
      if (provider.protocol === 'oidc') {
        const configuration = await this.oidc(provider),
          result = await oidc.authorizationCodeGrant(configuration, currentUrl, {
            expectedState: state,
            expectedNonce: String(transaction.nonce),
            pkceCodeVerifier: this.security.secrets.open(
              'federation:' + digest(state),
              String(transaction.verifier),
            ),
            idTokenExpected: true,
          });
        const claims = result.claims();
        if (!claims?.sub || claims.email_verified !== true || typeof claims.email !== 'string')
          throw new Error('A verified email claim is required.');
        subject = claims.sub;
        email = claims.email.toLowerCase();
        name = typeof claims.name === 'string' ? claims.name : email.split('@')[0]!;
      } else {
        const result = await this.saml(provider, state).validatePostResponseAsync(body ?? {});
        const profile = result.profile;
        if (
          !profile?.nameID ||
          !profile.issuer ||
          profile.issuer !== provider.configuration.issuer ||
          !profile.email
        )
          throw new Error('The SAML profile must provide a persistent subject and email.');
        subject = profile.nameID;
        email = String(profile.email).toLowerCase();
        name = typeof profile.displayName === 'string' ? profile.displayName : email.split('@')[0]!;
      }
    } catch {
      throw new AppError(
        401,
        'FEDERATION_RESPONSE_INVALID',
        'The identity provider response could not be verified. Start a new sign-in.',
      );
    }
    if (subject.length > 1000 || email.length > 254 || !/^\S+@[^@\s]+\.[^@\s]+$/.test(email))
      throw new AppError(
        401,
        'FEDERATION_RESPONSE_INVALID',
        'The identity provider returned an invalid identity.',
      );
    return {
      subject,
      email,
      name: name.slice(0, 80),
      linkAccountId: transaction.account_id ? String(transaction.account_id) : null,
      linkSessionId: transaction.session_id ? String(transaction.session_id) : null,
    };
  }
  async login(
    provider: Provider,
    profile: {
      subject: string;
      email: string;
      name: string;
      linkAccountId: string | null;
      linkSessionId: string | null;
    },
    metadata: { userAgent: string; ipAddress: string },
  ) {
    const password = await hashPassword(token());
    return identityScope(() =>
      this.db.transaction(async (tx) => {
        const [org] = await tx.query('SELECT * FROM organizations WHERE id=$1 FOR UPDATE', [
          provider.organization_id,
        ]);
        const [currentProvider] = await tx.query(
          'SELECT enabled FROM identity_providers WHERE id=$1 FOR SHARE',
          [provider.id],
        );
        if (!org || !currentProvider?.enabled)
          throw new AppError(401, 'PROVIDER_UNAVAILABLE', 'The identity provider was disabled.');
        const [linked] = await tx.query(
          'SELECT account_id FROM federated_identities WHERE provider_id=$1 AND subject=$2',
          [provider.id, profile.subject],
        );
        let accountId = linked ? String(linked.account_id) : profile.linkAccountId;
        if (linked && profile.linkAccountId && linked.account_id !== profile.linkAccountId)
          throw new AppError(
            409,
            'IDENTITY_ALREADY_LINKED',
            'This provider identity belongs to another account.',
          );
        if (!accountId) {
          const [existing] = await tx.query(
            'SELECT id,managed_organization_id FROM accounts WHERE email=$1',
            [profile.email],
          );
          const [managed] =
            existing?.managed_organization_id === provider.organization_id
              ? await tx.query(
                  "SELECT account_id FROM organization_members WHERE organization_id=$1 AND account_id=$2 AND external_id=$3 AND provisioned AND status='active' AND scim_deleted_at IS NULL",
                  [provider.organization_id, existing.id, profile.subject],
                )
              : [];
          if (existing && !managed)
            throw new AppError(
              409,
              'IDENTITY_LINK_REQUIRED',
              'Sign in to your existing account and link this provider in account settings first.',
            );
          if (!managed && !provider.configuration.jitProvisioning)
            throw new AppError(
              403,
              'ORGANIZATION_INVITATION_REQUIRED',
              'Accept an organization invitation or ask your administrator to provision your account.',
            );
          const domain = profile.email.split('@')[1]!;
          const [verified] = await tx.query(
            'SELECT id FROM organization_domains WHERE organization_id=$1 AND domain=$2 AND verified_at IS NOT NULL',
            [provider.organization_id, domain],
          );
          if (
            !verified ||
            ((org.allowed_domains as string[]).length &&
              !(org.allowed_domains as string[]).includes(domain))
          )
            throw new AppError(
              403,
              'DOMAIN_RESTRICTED',
              'Automatic account creation requires an organization-verified email domain.',
            );
          accountId = managed ? String(existing!.id) : randomUUID();
          if (managed)
            await tx.query(
              'UPDATE accounts SET email_verified_at=coalesce(email_verified_at,now()) WHERE id=$1',
              [accountId],
            );
          else
            await tx.query(
              'INSERT INTO accounts(id,email,name,password_hash,email_verified_at) VALUES($1,$2,$3,$4,now())',
              [accountId, profile.email, profile.name, password],
            );
        }
        const [account] = await tx.query(
          'SELECT * FROM accounts WHERE id=$1 AND disabled_at IS NULL AND email_verified_at IS NOT NULL FOR UPDATE',
          [accountId],
        );
        if (!account)
          throw new AppError(
            401,
            'ACCOUNT_UNAVAILABLE',
            'The account is unavailable or its email is unverified.',
          );
        if (profile.linkAccountId) {
          const [link] = await tx.query(
            "SELECT s.id FROM sessions s JOIN accounts a ON a.id=s.account_id LEFT JOIN memberships m ON m.id=s.membership_id LEFT JOIN workspaces w ON w.id=m.workspace_id LEFT JOIN organizations o ON o.id=w.organization_id LEFT JOIN organization_members om ON om.organization_id=w.organization_id AND om.account_id=a.id WHERE s.id=$1 AND s.account_id=$2 AND s.auth_version=a.auth_version AND s.expires_at>now() AND s.created_at>now()-coalesce(o.session_hours,168)*interval '1 hour' AND (s.membership_id IS NULL OR (m.status='active' AND om.status='active')) AND a.disabled_at IS NULL AND (NOT a.mfa_enabled OR s.mfa_verified_at IS NOT NULL) FOR SHARE OF s",
            [profile.linkSessionId, profile.linkAccountId],
          );
          if (!link)
            throw new AppError(
              401,
              'LINK_SESSION_CHANGED',
              'Sign in and start identity linking again.',
            );
        }
        if (profile.linkAccountId && account.email !== profile.email)
          throw new AppError(
            409,
            'IDENTITY_EMAIL_MISMATCH',
            'The provider must verify the current account email address before linking.',
          );
        const [orgMember] = await tx.query(
          'SELECT status,provisioned FROM organization_members WHERE organization_id=$1 AND account_id=$2',
          [provider.organization_id, accountId],
        );
        if (orgMember?.status === 'suspended')
          throw new AppError(
            403,
            'MEMBERSHIP_UNAVAILABLE',
            'Organization access has been revoked.',
          );
        const domain = String(account.email).split('@')[1]!;
        const permittedDomain =
          !(org.allowed_domains as string[]).length ||
          (org.allowed_domains as string[]).includes(domain);
        const [verifiedDomain] =
          provider.configuration.jitProvisioning && permittedDomain
            ? await tx.query(
                'SELECT id FROM organization_domains WHERE organization_id=$1 AND domain=$2 AND verified_at IS NOT NULL',
                [provider.organization_id, domain],
              )
            : [];
        const canProvision = Boolean(verifiedDomain);
        if (!orgMember && !canProvision)
          throw new AppError(
            403,
            'ORGANIZATION_INVITATION_REQUIRED',
            'Linking an identity does not grant organization access. Accept an invitation or ask an administrator to provision your account.',
          );
        await tx.query(
          'INSERT INTO organization_members(organization_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
          [provider.organization_id, accountId],
        );
        const [activeGrant] = await tx.query(
          "SELECT m.workspace_id FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE w.organization_id=$1 AND m.account_id=$2 AND m.status='active' AND (m.access_type='guest' OR $4::boolean) ORDER BY (w.id=$3) DESC,w.name,m.id LIMIT 1",
          [
            provider.organization_id,
            accountId,
            provider.configuration.workspaceId,
            permittedDomain,
          ],
        );
        if (!activeGrant && (orgMember?.provisioned || !canProvision))
          throw new AppError(
            403,
            'WORKSPACE_ACCESS_REQUIRED',
            'Ask an administrator to assign an organization workspace before signing in.',
          );
        const workspaceId = activeGrant
          ? String(activeGrant.workspace_id)
          : provider.configuration.workspaceId;
        await tx.query("SELECT set_config('ao.workspace_id',$1,true)", [workspaceId]);
        const [workspace] = await tx.query(
          'SELECT id FROM workspaces WHERE id=$1 AND organization_id=$2',
          [workspaceId, provider.organization_id],
        );
        if (!workspace)
          throw new AppError(
            401,
            'PROVIDER_UNAVAILABLE',
            'The configured workspace is unavailable.',
          );
        let [member] = await tx.query(
          'SELECT id,status FROM memberships WHERE workspace_id=$1 AND account_id=$2',
          [workspace.id, accountId],
        );
        if (member?.status === 'suspended')
          throw new AppError(403, 'MEMBERSHIP_UNAVAILABLE', 'Workspace access has been revoked.');
        if (!member) {
          if (orgMember?.provisioned)
            throw new AppError(
              403,
              'SCIM_WORKSPACE_REQUIRED',
              'Your identity provider must assign you to this workspace through a provisioning group.',
            );
          member = { id: randomUUID(), status: 'active' };
          await tx.query(
            "INSERT INTO memberships(id,workspace_id,account_id,name,kind,role) VALUES($1,$2,$3,$4,'human','member')",
            [member.id, workspace.id, accountId, account.name],
          );
        }
        if (!linked) {
          await tx.query(
            'INSERT INTO federated_identities(provider_id,subject,account_id) VALUES($1,$2,$3)',
            [provider.id, profile.subject, accountId],
          );
          await securityEvent(tx, accountId, 'federation.linked');
        }
        if (account.mfa_enabled)
          return {
            challenge: await this.security.challenge(
              tx,
              accountId,
              String(member.id),
              Number(account.auth_version),
              provider.protocol,
              provider.id,
            ),
          };
        return {
          session: await createSession(
            tx,
            accountId,
            String(member.id),
            Number(account.auth_version),
            { ...metadata, method: provider.protocol, providerId: provider.id },
          ),
        };
      }),
    );
  }
}
