import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { signInMetadata, exchangeCode } from '../src/oidc.js';
import { authenticate } from '../src/auth.js';
import { FileStore } from '../src/store.js';
import { handle } from '../src/api.js';

const origin = 'https://dashboard.example';
const configured = {
  AUTH_TOKEN_EXCHANGE: 'enabled',
  AUTH_ISSUER: 'https://wordpress.example/oidc',
  AUTH_AUTHORIZATION_ENDPOINT: 'https://wordpress.example/oidc/authorize',
  AUTH_TOKEN_ENDPOINT: 'https://wordpress.example/oidc/token',
  AUTH_JWKS_URI: 'https://wordpress.example/oidc/jwks',
  AUTH_PUBLIC_API_BASE_URL: 'https://functions.example/api',
  AUTH_REDIRECT_URI: origin + '/auth/callback',
  AUTH_CLIENT_ID: 'dashboard-client',
  AUTH_CLIENT_SECRET: 'server-only-test-secret',
  ALLOWED_ORIGINS: origin,
};
async function withConfig(work: () => Promise<void>) {
  const previous = { ...process.env };
  Object.assign(process.env, configured);
  try {
    await work();
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
}
const request = (
  changes: Record<string, string> = {},
  requestOrigin = origin,
) =>
  new Request('https://functions.example/api/auth/token', {
    method: 'POST',
    headers: {
      origin: requestOrigin,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: 'dashboard-client',
      redirect_uri: origin + '/auth/callback',
      code: 'one-time-code',
      code_verifier: 'v'.repeat(43),
      ...changes,
    }),
  });

test('metadata uses only configured endpoints and never exposes the client secret', () =>
  withConfig(async () => {
    const metadata = signInMetadata();
    assert.equal(
      metadata.token_endpoint,
      'https://functions.example/api/auth/token',
    );
    assert.equal(metadata.issuer, configured.AUTH_ISSUER);
    assert.ok(
      !JSON.stringify(metadata).includes(configured.AUTH_CLIENT_SECRET),
    );
    process.env.AUTH_TOKEN_ENDPOINT = 'https://untrusted.example/token';
    assert.throws(() => signInMetadata(), /issuer origin/);
    process.env.AUTH_TOKEN_EXCHANGE = 'disabled';
    assert.throws(() => signInMetadata(), /not enabled/);
  }));

test('code exchange forwards PKCE, keeps a secret on the server and strips refresh tokens', () =>
  withConfig(async () => {
    let calls = 0;
    const send = (async (url, options) => {
      calls++;
      assert.equal(String(url), configured.AUTH_TOKEN_ENDPOINT);
      assert.equal(options?.redirect, 'error');
      const body = new URLSearchParams(String(options?.body));
      assert.equal(body.get('code_verifier'), 'v'.repeat(43));
      assert.equal(body.get('client_secret'), configured.AUTH_CLIENT_SECRET);
      return new Response(
        JSON.stringify({
          access_token: 'test-access-token',
          id_token: 'test-id-token',
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: 'private-refresh',
          client_secret: configured.AUTH_CLIENT_SECRET,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const result = await exchangeCode(request(), send);
    assert.equal(calls, 1);
    assert.equal(result.access_token, 'test-access-token');
    assert.ok(!('refresh_token' in result));
    assert.ok(!JSON.stringify(result).includes(configured.AUTH_CLIENT_SECRET));
  }));

test('exchange rejects unregistered origins, clients, redirects, grants and missing PKCE before contacting WordPress', () =>
  withConfig(async () => {
    const send = (async () => {
      assert.fail('Invalid requests must not be forwarded');
    }) as typeof fetch;
    for (const changes of [
      { client_id: 'another-client' },
      { redirect_uri: 'https://attacker.example/callback' },
      { grant_type: 'password' },
      { code_verifier: '' },
      { client_secret: 'browser-secret' },
    ])
      await assert.rejects(exchangeCode(request(changes), send));
    await assert.rejects(
      exchangeCode(request({}, 'https://attacker.example'), send),
      /registered dashboard/,
    );
    const duplicate = request();
    const body = await duplicate.text();
    await assert.rejects(
      exchangeCode(
        new Request(duplicate.url, {
          method: 'POST',
          headers: duplicate.headers,
          body: body + '&client_id=another-client',
        }),
        send,
      ),
      /request fields/,
    );
  }));

test('provider errors are sanitized and optional secrets are not required for PKCE', () =>
  withConfig(async () => {
    delete process.env.AUTH_CLIENT_SECRET;
    const send = (async (_url, options) => {
      assert.ok(
        !new URLSearchParams(String(options?.body)).has('client_secret'),
      );
      return new Response('sensitive upstream diagnostics', { status: 400 });
    }) as typeof fetch;
    await assert.rejects(
      exchangeCode(request(), send),
      (error) =>
        error instanceof Error &&
        error.message.includes('code was rejected') &&
        !error.message.includes('sensitive'),
    );
  }));

test('public sign-in routes expose metadata without opening data routes or relaxing CORS', () =>
  withConfig(async () => {
    process.env.AUTH_MODE = 'oidc';
    process.env.AUTH_AUDIENCE = 'dashboard-client';
    const store = new FileStore();
    const metadata = await handle(
      new Request('https://functions.example/api/auth/configuration', {
        headers: { origin },
      }),
      store,
    );
    assert.equal(metadata.status, 200);
    assert.equal(metadata.headers.get('cache-control'), 'no-store');
    assert.equal(metadata.headers.get('access-control-allow-origin'), origin);
    assert.equal((await metadata.json()).issuer, configured.AUTH_ISSUER);
    const denied = await handle(
      new Request('https://functions.example/api/me', { headers: { origin } }),
      store,
    );
    assert.equal(denied.status, 401);
    const foreign = await handle(
      new Request('https://functions.example/api/auth/configuration', {
        headers: { origin: 'https://untrusted.example' },
      }),
      store,
    );
    assert.equal(foreign.status, 403);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null);
    process.env.AUTH_TOKEN_EXCHANGE = 'disabled';
    const disabled = await handle(
      new Request('https://functions.example/api/auth/configuration'),
      store,
    );
    assert.equal(disabled.status, 404);
  }));

test('API verifies signed access tokens, expiry, scope and membership; ID tokens cannot replace access tokens', () =>
  withConfig(async () => {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }],
        }),
        { headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;
    process.env.AUTH_MODE = 'oidc';
    process.env.AUTH_AUDIENCE = 'dashboard-client';
    process.env.AUTH_REQUIRED_SCOPE = 'openid';
    process.env.AUTH_ADMIN_SUBJECTS = '7';
    const sign = (
      claims: Record<string, unknown>,
      expires = true,
      overrides: {
        issuer?: string;
        audience?: string;
        expiration?: string;
      } = {},
    ) => {
      let jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setSubject('7')
        .setIssuer(overrides.issuer || configured.AUTH_ISSUER)
        .setAudience(overrides.audience || 'dashboard-client')
        .setIssuedAt();
      if (expires) jwt = jwt.setExpirationTime(overrides.expiration || '5m');
      return jwt.sign(privateKey);
    };
    const headers = (token: string) =>
      new Headers({ authorization: 'Bearer ' + token });
    try {
      const actor = await authenticate(
        headers(await sign({ scope: 'openid profile' })),
        new FileStore(),
      );
      assert.equal(actor.roles[0], 'admin');
      await assert.rejects(
        authenticate(
          headers(await sign({ name: 'ID token' })),
          new FileStore(),
        ),
        /access token/,
      );
      await assert.rejects(
        authenticate(
          headers(await sign({ scope: 'openid' }, false)),
          new FileStore(),
        ),
        /invalid or has expired/,
      );
      for (const overrides of [
        { issuer: 'https://untrusted.example' },
        { audience: 'another-client' },
        { expiration: '-1m' },
      ]) {
        await assert.rejects(
          authenticate(
            headers(await sign({ scope: 'openid' }, true, overrides)),
            new FileStore(),
          ),
          /invalid or has expired/,
        );
      }
      const parts = (await sign({ scope: 'openid' })).split('.');
      const signature = Buffer.from(parts[2], 'base64url');
      signature[0] ^= 1;
      parts[2] = signature.toString('base64url');
      await assert.rejects(
        authenticate(headers(parts.join('.')), new FileStore()),
        /invalid or has expired/,
      );
      process.env.AUTH_ADMIN_SUBJECTS = '';
      await assert.rejects(
        authenticate(headers(await sign({ scope: 'openid' })), new FileStore()),
        /not been granted/,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));
