import Fastify from 'fastify';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { SignedXml } from 'xml-crypto';
export async function oidcFixture(browserOrigin = 'http://localhost:3000') {
  const keys = await generateKeyPair('RS256'),
    jwk = await exportJWK(keys.publicKey),
    app = Fastify();
  const codes = new Map<
    string,
    {
      nonce: string;
      challenge: string;
      email: string;
      subject: string;
      audience: string;
      issuer?: string;
      invalidSignature?: boolean;
    }
  >();
  let origin = '';
  let browserEmail = '';
  function issue(
    location: string,
    email: string,
    overrides: Partial<{
      nonce: string;
      subject: string;
      audience: string;
      issuer: string;
      invalidSignature: boolean;
    }> = {},
  ) {
    const authorization = new URL(location),
      value = randomUUID();
    codes.set(value, {
      email,
      nonce: authorization.searchParams.get('nonce')!,
      challenge: authorization.searchParams.get('code_challenge')!,
      subject: 'subject-' + email,
      audience: 'orbit-client',
      ...overrides,
    });
    return { code: value, state: authorization.searchParams.get('state')! };
  }
  app.get('/authorize', async (req, reply) => {
    const url = new URL(req.url, origin),
      redirect = new URL(url.searchParams.get('redirect_uri')!);
    if (!browserEmail || redirect.origin !== browserOrigin)
      return reply.code(400).send({ error: 'invalid_request' });
    const proof = issue(url.href, browserEmail);
    return reply
      .type('text/html')
      .send(
        `<form method="get" action="${redirect.origin}${redirect.pathname}"><input type="hidden" name="code" value="${proof.code}"><input type="hidden" name="state" value="${proof.state}"><button type="submit">Authorize Orbit</button></form>`,
      );
  });
  app.get('/.well-known/openid-configuration', async () => ({
    issuer: origin,
    authorization_endpoint: origin + '/authorize',
    token_endpoint: origin + '/token',
    jwks_uri: origin + '/jwks',
    response_types_supported: ['code'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
    code_challenge_methods_supported: ['S256'],
  }));
  app.get('/jwks', async () => ({ keys: [{ ...jwk, kid: 'test-key', use: 'sig', alg: 'RS256' }] }));
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );
  app.post('/token', async (req, reply) => {
    const body = req.body as Record<string, string>,
      code = codes.get(body.code!);
    codes.delete(body.code!);
    if (
      !code ||
      body.client_id !== 'orbit-client' ||
      body.client_secret !== 'test-client-secret' ||
      createHash('sha256')
        .update(body.code_verifier ?? '')
        .digest('base64url') !== code.challenge
    )
      return reply.code(400).send({ error: 'invalid_grant' });
    let id_token = await new SignJWT({
      email: code.email,
      email_verified: true,
      name: 'Federated user',
      nonce: code.nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(code.issuer ?? origin)
      .setAudience(code.audience)
      .setSubject(code.subject)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
    if (code.invalidSignature) {
      const parts = id_token.split('.'),
        signature = parts[2]!;
      parts[2] = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
      id_token = parts.join('.');
    }
    return { access_token: randomUUID(), token_type: 'Bearer', expires_in: 300, id_token };
  });
  origin = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    origin,
    close: () => app.close(),
    setBrowserUser: (email: string) => {
      browserEmail = email;
    },
    code(
      location: string,
      email: string,
      overrides: Partial<{
        nonce: string;
        subject: string;
        audience: string;
        issuer: string;
        invalidSignature: boolean;
      }> = {},
    ) {
      return issue(location, email, overrides);
    },
  };
}
export async function samlFixture() {
  const [key, certificate] = await Promise.all([
    readFile(new URL('./fixtures/saml-test-key.pem', import.meta.url), 'utf8'),
    readFile(new URL('./fixtures/saml-test-cert.pem', import.meta.url), 'utf8'),
  ]);
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
    );
  function sign(xml: string, id: string, localName: string) {
    const signature = new SignedXml({
      privateKey: key,
      publicCert: certificate,
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    });
    signature.addReference({
      xpath: `//*[@ID='${id}']`,
      transforms: [
        'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
        'http://www.w3.org/2001/10/xml-exc-c14n#',
      ],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    signature.computeSignature(xml, {
      location: {
        reference: `//*[local-name()='${localName}']/*[local-name()='Issuer']`,
        action: 'after',
      },
    });
    return signature.getSignedXml();
  }
  return {
    certificate,
    response(
      location: string,
      callback: string,
      email: string,
      options: { audience?: string; requestId?: string; expired?: boolean } = {},
    ) {
      const url = new URL(location),
        request = inflateRawSync(
          Buffer.from(url.searchParams.get('SAMLRequest')!, 'base64'),
        ).toString('utf8');
      const requestId = options.requestId ?? request.match(/\bID="([^"]+)"/)![1]!,
        now = Date.now(),
        issue = new Date(now).toISOString(),
        before = new Date(now - 60000).toISOString(),
        after = new Date(now + (options.expired ? -1000 : 300000)).toISOString(),
        responseId = '_' + randomUUID(),
        assertionId = '_' + randomUUID();
      const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${issue}"><saml:Issuer>https://idp.test</saml:Issuer><saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${escape(email)}</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${escape(callback)}" NotOnOrAfter="${after}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotBefore="${before}" NotOnOrAfter="${after}"><saml:AudienceRestriction><saml:Audience>${escape(options.audience ?? callback + '/metadata')}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issue}" SessionIndex="test-session"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement><saml:AttributeStatement><saml:Attribute Name="email"><saml:AttributeValue>${escape(email)}</saml:AttributeValue></saml:Attribute></saml:AttributeStatement></saml:Assertion>`;
      const signedAssertion = sign(assertion, assertionId, 'Assertion'),
        response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${issue}" Destination="${escape(callback)}" InResponseTo="${requestId}"><saml:Issuer>https://idp.test</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${signedAssertion.replace(/^<\?xml[^>]*\?>/, '')}</samlp:Response>`;
      return {
        SAMLResponse: Buffer.from(sign(response, responseId, 'Response')).toString('base64'),
        RelayState: url.searchParams.get('RelayState')!,
      };
    },
  };
}
