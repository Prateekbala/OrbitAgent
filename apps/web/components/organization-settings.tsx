'use client';
import { EnterpriseControls } from './enterprise-controls';
import { GovernanceSettings } from './governance-settings';
import { BillingSettings } from './billing-settings';
import { NativeSelect } from './ui/native-select';
import { Card } from './ui/card';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { useCallback, useEffect, useState } from 'react';
import type {
  Organization,
  OrganizationMember,
  OrganizationWorkspace,
  IdentityProvider,
} from '@ao/contracts/identity';
import { regions } from '@ao/contracts/identity';
import { api, post } from '../lib/api';
interface Domain {
  id: string;
  domain: string;
  verified_at: string | null;
}
interface ProvisioningToken {
  id: string;
  label: string;
  expires_at: string;
  revoked_at: string | null;
}
interface ProvisioningGroup {
  id: string;
  display_name: string;
  workspace_id: string | null;
  version: number;
}
export function OrganizationSettings() {
  const [organizations, setOrganizations] = useState<Organization[]>([]),
    [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const data = await api<Organization[]>('/organizations', { ...(signal ? { signal } : {}) });
    if (!signal?.aborted) {
      setOrganizations(data);
      setSelected((current) =>
        data.some((o) => o.id === current) ? current : (data[0]?.id ?? ''),
      );
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : 'Unable to load organizations.');
    });
    return () => controller.abort();
  }, [refresh]);
  const organization = organizations.find((o) => o.id === selected);
  return (
    <section className="identity-settings" aria-label="Organization management">
      <div className="execution-heading">
        <div>
          <span className="eyebrow">SHARED GOVERNANCE</span>
          <h2>Organizations</h2>
          <p className="muted">
            Manage workspaces, membership, security policies, and provisioning.
          </p>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        Organization
        <NativeSelect value={selected} onChange={(e) => setSelected(e.target.value)}>
          {organizations.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} · {o.role}
            </option>
          ))}
        </NativeSelect>
      </label>
      <Card asChild>
        <details className="settings-card">
          <summary>Create organization</summary>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              setBusy(true);
              setError('');
              try {
                const result = await post<{ id: string }>('/organizations', {
                  name: form.get('name'),
                });
                await refresh();
                setSelected(result.id);
              } catch (error) {
                setError(error instanceof Error ? error.message : 'Unable to create organization.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Organization name
              <Input name="name" required minLength={2} maxLength={80} />
            </label>
            <Button size="sm" className="primary small" disabled={busy}>
              Create organization
            </Button>
          </form>
        </details>
      </Card>
      {organization && (
        <>
          <OrganizationDetail
            key={organization.id}
            organization={organization}
            onChange={refresh}
          />
          {['owner', 'admin'].includes(organization.role) && (
            <>
              <BillingSettings key={organization.id} organizationId={organization.id} />
              <EnterpriseControls
                key={organization.id + 'enterprise'}
                organizationId={organization.id}
                organizationName={organization.name}
                owner={organization.role === 'owner'}
              />
              <GovernanceSettings
                key={organization.id + 'governance'}
                organizationId={organization.id}
                owner={organization.role === 'owner'}
              />
            </>
          )}
        </>
      )}
    </section>
  );
}
function OrganizationDetail({
  organization: org,
  onChange,
}: {
  organization: Organization;
  onChange: () => Promise<void>;
}) {
  const [workspaces, setWorkspaces] = useState<OrganizationWorkspace[]>([]),
    [members, setMembers] = useState<OrganizationMember[]>([]),
    [domains, setDomains] = useState<Domain[]>([]),
    [providers, setProviders] = useState<IdentityProvider[]>([]),
    [tokens, setTokens] = useState<ProvisioningToken[]>([]),
    [groups, setGroups] = useState<ProvisioningGroup[]>([]);
  const [browserOrigin, setBrowserOrigin] = useState('');
  const [loginProviders, setLoginProviders] = useState<
    Array<{ id: string; name: string; protocol: string }>
  >([]);
  useEffect(() => setBrowserOrigin(window.location.origin), []);
  useEffect(() => {
    const controller = new AbortController();
    void api<typeof loginProviders>('/auth/providers', {
      method: 'POST',
      body: JSON.stringify({ organizationId: org.id }),
      signal: controller.signal,
    })
      .then((data) => {
        if (!controller.signal.aborted) setLoginProviders(data);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [org.id]);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [proof, setProof] = useState<{ name: string; value: string } | null>(null),
    [credential, setCredential] = useState<{ token: string; baseUrl: string } | null>(null),
    [protocol, setProtocol] = useState<'oidc' | 'saml'>('oidc'),
    [selectedMember, setSelectedMember] = useState<OrganizationMember | null>(null);
  const admin = ['owner', 'admin'].includes(org.role),
    owner = org.role === 'owner',
    base = '/organizations/' + org.id;
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const options = signal ? { signal } : {};
      const [spaces, idps, people, claims, keys, mappings] = await Promise.all([
        api<OrganizationWorkspace[]>(base + '/workspaces', options),
        api<IdentityProvider[]>(base + '/providers', options),
        admin ? api<OrganizationMember[]>(base + '/members', options) : [],
        admin ? api<Domain[]>(base + '/domains', options) : [],
        owner ? api<ProvisioningToken[]>(base + '/scim/tokens', options) : [],
        admin ? api<ProvisioningGroup[]>(base + '/scim/groups', options) : [],
      ]);
      if (!signal?.aborted) {
        setWorkspaces(spaces);
        setProviders(idps);
        setMembers(people);
        setDomains(claims);
        setTokens(keys);
        setGroups(mappings);
      }
    },
    [base, admin, owner],
  );
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((error) => {
      if (!controller.signal.aborted)
        setError(error instanceof Error ? error.message : 'Unable to load organization settings.');
    });
    return () => controller.abort();
  }, [refresh, org.version]);
  async function action(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await Promise.all([refresh(), onChange()]);
      setNotice(message);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to update organization.');
    } finally {
      setBusy(false);
    }
  }
  function submit(
    event: React.FormEvent<HTMLFormElement>,
    work: (form: FormData) => Promise<unknown>,
    message: string,
  ) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void action(() => work(form), message);
  }
  return (
    <>
      <p className="muted">
        Organization ID: <code>{org.id}</code>
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {error && loginProviders.length > 0 && (
        <div className="runtime-notice">
          <p>Sign in through this organization’s provider to finish connecting your account.</p>
          {loginProviders.map((provider) => (
            <a
              key={provider.id}
              className="subtle-button"
              href={`/api/v1/auth/federation/${provider.id}/start?link=true`}
            >
              Continue with {provider.name}
            </a>
          ))}
        </div>
      )}
      {notice && (
        <p className="runtime-notice" role="status">
          {notice}
        </p>
      )}
      <Card asChild>
        <article className="settings-card">
          <h3>Workspaces</h3>
          <Card asChild>
            <div className="team-list">
              {workspaces.map((workspace) => (
                <div className="team-row" key={workspace.id}>
                  <div>
                    <strong>{workspace.name}</strong>
                    <small>{workspace.region}</small>
                  </div>
                  {workspace.membership_id && (
                    <Button
                      variant="outline"
                      className="subtle-button"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await post('/workspaces/switch', {
                            membershipId: workspace.membership_id,
                          });
                          window.location.assign('/app');
                        }, '')
                      }
                    >
                      Open workspace
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
          {admin && (
            <details>
              <summary>Create workspace</summary>
              <form
                onSubmit={(e) =>
                  submit(
                    e,
                    (f) =>
                      post(base + '/workspaces', { name: f.get('name'), region: f.get('region') }),
                    'Workspace created.',
                  )
                }
              >
                <label>
                  Workspace name
                  <Input name="name" required minLength={2} maxLength={80} />
                </label>
                <label>
                  Data region
                  <NativeSelect name="region">
                    {org.allowed_regions.map((region) => (
                      <option key={region}>{region}</option>
                    ))}
                  </NativeSelect>
                </label>
                <p className="muted">
                  The deployment, database, and object storage must support the requested region.
                </p>
                <Button size="sm" className="primary small" disabled={busy}>
                  Create workspace
                </Button>
              </form>
            </details>
          )}
        </article>
      </Card>
      {owner && (
        <Card asChild>
          <article className="settings-card">
            <h3>Organization policies</h3>
            <form
              key={org.version}
              onSubmit={(e) =>
                submit(
                  e,
                  (f) =>
                    api(base, {
                      method: 'PATCH',
                      body: JSON.stringify({
                        name: f.get('name'),
                        allowedDomains: String(f.get('allowedDomains') ?? '')
                          .split(',')
                          .map((v) => v.trim())
                          .filter(Boolean),
                        allowedRegions: f.getAll('regions'),
                        requireMfa: f.get('requireMfa') === 'on',
                        requireSso: f.get('requireSso') === 'on',
                        sessionHours: Number(f.get('sessionHours')),
                        version: org.version,
                      }),
                    }),
                  'Organization policies updated.',
                )
              }
            >
              <label>
                Organization name
                <Input name="name" defaultValue={org.name} required minLength={2} maxLength={80} />
              </label>
              <label>
                Allowed member email domains
                <Input
                  name="allowedDomains"
                  defaultValue={org.allowed_domains.join(', ')}
                  placeholder="example.com, subsidiary.com"
                />
                <small>
                  Verify domains below first. Leave empty to allow invited members from any domain.
                  Guests can use external addresses.
                </small>
              </label>
              <fieldset>
                <legend>Allowed data regions</legend>
                {regions.map((region) => (
                  <label className="checkbox-label" key={region}>
                    <Input
                      type="checkbox"
                      name="regions"
                      value={region}
                      defaultChecked={org.allowed_regions.includes(region)}
                    />
                    {region}
                  </label>
                ))}
              </fieldset>
              <label className="checkbox-label">
                <Input type="checkbox" name="requireMfa" defaultChecked={org.require_mfa} />
                Require two-factor authentication
              </label>
              <label className="checkbox-label">
                <Input type="checkbox" name="requireSso" defaultChecked={org.require_sso} />
                Require enterprise single sign-on
              </label>
              <label>
                Session lifetime in hours
                <Input
                  name="sessionHours"
                  type="number"
                  min={1}
                  max={168}
                  required
                  defaultValue={org.session_hours}
                />
              </label>
              <p className="muted">
                Enable MFA and sign in through your configured provider before requiring them
                organization-wide.
              </p>
              <Button size="sm" className="primary small" disabled={busy}>
                Save organization policies
              </Button>
            </form>
          </article>
        </Card>
      )}
      {admin && (
        <Card asChild>
          <article className="settings-card">
            <h3>Domain ownership</h3>
            <Card asChild>
              <div className="team-list">
                {domains.map((domain) => (
                  <div className="team-row" key={domain.id}>
                    <div>
                      <strong>{domain.domain}</strong>
                      <small>
                        {domain.verified_at ? 'Verified through DNS' : 'Awaiting DNS verification'}
                      </small>
                    </div>
                    <Button
                      variant="outline"
                      className="subtle-button"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          () => post(base + '/domains/' + domain.id + '/verify', {}),
                          'Domain verified.',
                        )
                      }
                    >
                      Check DNS
                    </Button>
                    {owner && (
                      <Button
                        variant="outline"
                        className="subtle-button"
                        disabled={busy}
                        onClick={() =>
                          void action(
                            () => api(base + '/domains/' + domain.id, { method: 'DELETE' }),
                            'Domain removed.',
                          )
                        }
                      >
                        Remove domain
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </Card>
            {owner && (
              <form
                onSubmit={(e) =>
                  submit(
                    e,
                    async (f) => {
                      setProof(await post(base + '/domains', { domain: f.get('domain') }));
                    },
                    'Add the TXT record below to your DNS, then check verification.',
                  )
                }
              >
                <label>
                  Domain to verify
                  <Input name="domain" required maxLength={254} placeholder="example.com" />
                </label>
                <Button variant="outline" className="subtle-button" disabled={busy}>
                  Claim domain
                </Button>
              </form>
            )}
            {proof && (
              <div className="runtime-notice">
                <label>
                  TXT record name
                  <Input readOnly value={proof.name} />
                </label>
                <label>
                  TXT record value
                  <Textarea readOnly value={proof.value} rows={2} />
                </label>
              </div>
            )}
          </article>
        </Card>
      )}
      {admin && (
        <Card asChild>
          <article className="settings-card">
            <h3>Organization members</h3>
            <p className="muted">
              Invite people from Team first, then assign additional workspaces and organization
              responsibilities here.
            </p>
            <Card asChild>
              <div className="team-list">
                {members.map((member) => (
                  <div className="team-row" key={member.account_id}>
                    <div>
                      <strong>{member.name}</strong>
                      <small>
                        {member.email} · {member.role} · {member.status}
                      </small>
                    </div>
                    <Button
                      variant="outline"
                      className="subtle-button"
                      disabled={busy}
                      onClick={() => setSelectedMember(member)}
                    >
                      Manage organization member
                    </Button>
                  </div>
                ))}
              </div>
            </Card>
            {selectedMember && (
              <div className="member-access-editor">
                <h4>Manage {selectedMember.name}</h4>
                {selectedMember.status === 'suspended' && (
                  <>
                    <p className="muted">
                      Restore organization membership, then explicitly assign workspaces. Previous
                      sessions and private shares stay revoked.
                    </p>
                    <Button
                      variant="outline"
                      className="subtle-button"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await post(
                            base + '/members/' + selectedMember.account_id + '/reactivate',
                            {
                              version: selectedMember.version,
                            },
                          );
                          setSelectedMember(null);
                        }, 'Organization membership restored. Assign workspace access when ready.')
                      }
                    >
                      Restore organization member
                    </Button>
                  </>
                )}
                {selectedMember.status === 'active' && (
                  <form
                    onSubmit={(e) =>
                      submit(
                        e,
                        async (f) => {
                          await post(base + '/members', {
                            accountId: selectedMember.account_id,
                            ...(selectedMember.role === 'owner' ? {} : { role: f.get('role') }),
                            workspaceIds: f.getAll('workspaceIds'),
                          });
                          setSelectedMember(null);
                        },
                        'Organization access updated.',
                      )
                    }
                  >
                    {selectedMember.role !== 'owner' && (
                      <label>
                        Organization role
                        <NativeSelect name="role" defaultValue={selectedMember.role}>
                          <option value="member">Member</option>
                          {owner && <option value="admin">Administrator</option>}
                        </NativeSelect>
                      </label>
                    )}
                    <fieldset>
                      <legend>Add workspace access</legend>
                      {workspaces.map((space) => (
                        <label className="checkbox-label" key={space.id}>
                          <Input type="checkbox" name="workspaceIds" value={space.id} />
                          {space.name}
                        </label>
                      ))}
                    </fieldset>
                    <Button size="sm" className="primary small" disabled={busy}>
                      Save organization access
                    </Button>
                  </form>
                )}
                {owner && selectedMember.status === 'active' && (
                  <form
                    onSubmit={(e) =>
                      submit(
                        e,
                        async () => {
                          await post(base + '/transfer-ownership', {
                            accountId: selectedMember.account_id,
                            version: org.version,
                          });
                          setSelectedMember(null);
                        },
                        'Organization ownership transferred.',
                      )
                    }
                  >
                    <p className="muted">
                      Ownership transfer makes this person an owner and changes your organization
                      role to administrator.
                    </p>
                    <Button variant="outline" className="subtle-button" disabled={busy}>
                      Transfer organization ownership
                    </Button>
                  </form>
                )}
                {selectedMember.role !== 'owner' && selectedMember.status === 'active' && (
                  <form
                    onSubmit={(e) =>
                      submit(
                        e,
                        async (f) => {
                          await post(base + '/members/' + selectedMember.account_id + '/offboard', {
                            version: selectedMember.version,
                            ...(f.get('successor')
                              ? { successorAccountId: f.get('successor') }
                              : {}),
                          });
                          setSelectedMember(null);
                        },
                        'Member offboarded from every organization workspace.',
                      )
                    }
                  >
                    <label>
                      Offboarding successor
                      <NativeSelect name="successor">
                        <option value="">Unassign tasks; no successor</option>
                        {members
                          .filter(
                            (m) =>
                              m.account_id !== selectedMember.account_id && m.status === 'active',
                          )
                          .map((m) => (
                            <option key={m.account_id} value={m.account_id}>
                              {m.name}
                            </option>
                          ))}
                      </NativeSelect>
                    </label>
                    <p className="muted">
                      Offboarding revokes sessions and shares, cancels pending agent work, pauses
                      recurring work, and transfers assigned work. History and attribution remain.
                      Transfer ownership first when required.
                    </p>
                    <Button variant="outline" className="subtle-button" disabled={busy}>
                      Offboard organization member
                    </Button>
                  </form>
                )}
                <Button
                  variant="link"
                  className="text-button"
                  onClick={() => setSelectedMember(null)}
                >
                  Close member editor
                </Button>
              </div>
            )}
          </article>
        </Card>
      )}
      <Card asChild>
        <article className="settings-card">
          <h3>Federated login & enterprise SSO</h3>
          <Card asChild>
            <div className="team-list">
              {providers.map((provider) => (
                <div className="team-row" key={provider.id}>
                  <div>
                    <strong>{provider.name}</strong>
                    <small>
                      {provider.protocol.toUpperCase()} ·{' '}
                      {provider.enabled ? 'Enabled' : 'Disabled'}
                    </small>
                    <details>
                      <summary>Connection settings</summary>
                      <label>
                        Provider callback URL
                        <Input
                          readOnly
                          value={`${browserOrigin}/api/v1/auth/federation/${provider.id}/callback`}
                        />
                      </label>
                      {provider.protocol === 'saml' && (
                        <label>
                          Service provider entity ID
                          <Input
                            readOnly
                            value={`${browserOrigin}/api/v1/auth/federation/${provider.id}/callback/metadata`}
                          />
                        </label>
                      )}
                      <p className="muted">Issuer: {provider.configuration.issuer}</p>
                    </details>
                  </div>
                  {provider.enabled && (
                    <a
                      className="subtle-button"
                      href={`/api/v1/auth/federation/${provider.id}/start?link=true`}
                    >
                      Link & sign in
                    </a>
                  )}
                  {owner && provider.enabled && (
                    <Button
                      variant="outline"
                      className="subtle-button"
                      disabled={busy}
                      onClick={() =>
                        void action(
                          () => api(base + '/providers/' + provider.id, { method: 'DELETE' }),
                          'Provider disabled and its sessions revoked.',
                        )
                      }
                    >
                      Disable provider
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
          {owner && (
            <details>
              <summary>Configure identity provider</summary>
              <form
                onSubmit={(e) =>
                  submit(
                    e,
                    async (f) => {
                      const common = {
                        protocol,
                        jitProvisioning: f.get('jitProvisioning') === 'on',
                        name: f.get('name'),
                        workspaceId: f.get('workspaceId'),
                      };
                      const result = await post<{ callbackUrl: string; entityId: string }>(
                        base + '/providers',
                        protocol === 'oidc'
                          ? {
                              ...common,
                              issuer: f.get('issuer'),
                              clientId: f.get('clientId'),
                              clientSecret: f.get('clientSecret'),
                            }
                          : {
                              ...common,
                              entryPoint: f.get('entryPoint'),
                              issuer: f.get('issuer'),
                              idpCert: f.get('idpCert'),
                            },
                      );
                      setNotice(
                        `Provider saved. Callback: ${result.callbackUrl}${protocol === 'saml' ? ' · Entity ID: ' + result.entityId : ''}`,
                      );
                    },
                    'Provider saved. Register its callback URL with your identity provider.',
                  )
                }
              >
                <label>
                  Protocol
                  <NativeSelect
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value as 'oidc' | 'saml')}
                  >
                    <option value="oidc">OpenID Connect</option>
                    <option value="saml">SAML 2.0</option>
                  </NativeSelect>
                </label>
                <label>
                  Provider name
                  <Input name="name" required minLength={2} maxLength={80} />
                </label>
                <label>
                  Default workspace
                  <NativeSelect name="workspaceId" required>
                    {workspaces.map((space) => (
                      <option key={space.id} value={space.id}>
                        {space.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <label className="checkbox-label">
                  <Input name="jitProvisioning" type="checkbox" />
                  Allow provisioning from verified organization domains
                </label>
                <p className="muted">
                  When disabled, people must first accept an invitation or receive a SCIM workspace
                  grant. Linking an identity never grants membership by itself.
                </p>
                <label>
                  {protocol === 'oidc' ? 'OIDC issuer URL' : 'IdP entity ID'}
                  <Input name="issuer" required type={protocol === 'oidc' ? 'url' : 'text'} />
                </label>
                {protocol === 'oidc' ? (
                  <>
                    <label>
                      Client ID
                      <Input name="clientId" required autoComplete="off" />
                    </label>
                    <label>
                      Client secret
                      <Input name="clientSecret" type="password" required autoComplete="off" />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      IdP sign-in URL
                      <Input name="entryPoint" type="url" required />
                    </label>
                    <label>
                      IdP signing certificate
                      <Textarea name="idpCert" rows={8} required />
                    </label>
                  </>
                )}
                <p className="muted">
                  Your operator must allow provider hostnames. OIDC uses PKCE, state, nonce, and
                  signed ID tokens. SAML requires signed responses and assertions. Existing accounts
                  link explicitly.
                </p>
                <Button size="sm" className="primary small" disabled={busy || !workspaces.length}>
                  Save identity provider
                </Button>
              </form>
            </details>
          )}
        </article>
      </Card>
      {owner && (
        <Card asChild>
          <article className="settings-card">
            <h3>SCIM provisioning</h3>
            <p className="muted">
              Use an expiring token to manage organization users and map provisioning groups to
              workspaces.
            </p>
            <label>
              SCIM base URL
              <Input readOnly value={`${browserOrigin}/api/scim/v2/${org.id}`} />
            </label>
            <Card asChild>
              <div className="team-list">
                {tokens.map((key) => (
                  <div className="team-row" key={key.id}>
                    <div>
                      <strong>{key.label}</strong>
                      <small>
                        {key.revoked_at
                          ? 'Revoked'
                          : 'Expires ' + new Date(key.expires_at).toLocaleDateString()}
                      </small>
                    </div>
                    {!key.revoked_at && (
                      <Button
                        variant="outline"
                        className="subtle-button"
                        disabled={busy}
                        onClick={() =>
                          void action(
                            () => api(base + '/scim/tokens/' + key.id, { method: 'DELETE' }),
                            'Provisioning token revoked.',
                          )
                        }
                      >
                        Revoke token
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </Card>
            <form
              onSubmit={(e) =>
                submit(
                  e,
                  async (f) => {
                    setCredential(
                      await post(base + '/scim/tokens', {
                        label: f.get('label'),
                        expiresInDays: Number(f.get('days')),
                      }),
                    );
                  },
                  'Save this token now. It will not be shown again.',
                )
              }
            >
              <label>
                Token label
                <Input name="label" required minLength={2} maxLength={80} />
              </label>
              <label>
                Expires in days
                <Input name="days" type="number" min={1} max={365} defaultValue={90} required />
              </label>
              <Button variant="outline" className="subtle-button" disabled={busy}>
                Create provisioning token
              </Button>
            </form>
            {credential && (
              <div className="runtime-notice">
                <label>
                  One-time provisioning token
                  <Textarea readOnly value={credential.token} rows={2} />
                </label>
                <Button
                  variant="outline"
                  className="subtle-button"
                  onClick={() => setCredential(null)}
                >
                  I saved this token
                </Button>
              </div>
            )}
          </article>
        </Card>
      )}
      {admin && groups.length > 0 && (
        <Card asChild>
          <article className="settings-card">
            <h3>Provisioning group mappings</h3>
            {groups.map((group) => (
              <form
                key={group.id + group.version}
                onSubmit={(e) =>
                  submit(
                    e,
                    (f) =>
                      api(base + '/scim/groups/' + group.id, {
                        method: 'PUT',
                        body: JSON.stringify({
                          workspaceId: f.get('workspaceId') || null,
                          version: group.version,
                        }),
                      }),
                    'Group mapping updated.',
                  )
                }
              >
                <label>
                  {group.display_name}
                  <NativeSelect name="workspaceId" defaultValue={group.workspace_id ?? ''}>
                    <option value="">No workspace mapping</option>
                    {workspaces.map((space) => (
                      <option key={space.id} value={space.id}>
                        {space.name}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
                <Button variant="outline" className="subtle-button" disabled={busy}>
                  Save group mapping
                </Button>
              </form>
            ))}
          </article>
        </Card>
      )}
    </>
  );
}
