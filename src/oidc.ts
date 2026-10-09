import { Problem } from './model.js';

function httpsUrl(value: string | undefined, name: string) {
  try {
    const url = new URL(value || '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw new Error();
    return url;
  } catch {
    throw new Problem(503, `Configure ${name} as an HTTPS URL.`);
  }
}

function settings() {
  if (process.env.AUTH_TOKEN_EXCHANGE !== 'enabled')
    throw new Problem(404, 'The sign-in exchange is not enabled.');
  const issuer = httpsUrl(process.env.AUTH_ISSUER, 'AUTH_ISSUER');
  const authorization = httpsUrl(
    process.env.AUTH_AUTHORIZATION_ENDPOINT,
    'AUTH_AUTHORIZATION_ENDPOINT',
  );
  const token = httpsUrl(
    process.env.AUTH_TOKEN_ENDPOINT,
    'AUTH_TOKEN_ENDPOINT',
  );
  const jwks = httpsUrl(process.env.AUTH_JWKS_URI, 'AUTH_JWKS_URI');
  const api = httpsUrl(
    process.env.AUTH_PUBLIC_API_BASE_URL,
    'AUTH_PUBLIC_API_BASE_URL',
  );
  const redirect = httpsUrl(process.env.AUTH_REDIRECT_URI, 'AUTH_REDIRECT_URI');
  if ([authorization, token, jwks].some((url) => url.origin !== issuer.origin))
    throw new Problem(
      503,
      'The configured identity endpoints must belong to the configured issuer origin.',
    );
  const clientId = process.env.AUTH_CLIENT_ID?.trim();
  if (!clientId) throw new Problem(503, 'Configure AUTH_CLIENT_ID.');
  return {
    issuer: process.env.AUTH_ISSUER!,
    authorization,
    token,
    jwks,
    api,
    redirect,
    clientId,
  };
}

export function signInMetadata() {
  const s = settings();
  return {
    issuer: s.issuer,
    authorization_endpoint: s.authorization.href,
    token_endpoint: s.api.href.replace(/\/$/, '') + '/auth/token',
    jwks_uri: s.jwks.href,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    subject_types_supported: ['public'],
    scopes_supported: ['openid', 'profile', 'email'],
    id_token_signing_alg_values_supported: ['RS256', 'ES256'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  };
}

// Only exchanges codes for this registered dashboard; never proxies arbitrary URLs or grants.
export async function exchangeCode(
  request: Request,
  send: typeof fetch = fetch,
) {
  const s = settings();
  if (request.headers.get('origin') !== s.redirect.origin)
    throw new Problem(403, 'Use the registered dashboard to complete sign-in.');
  if (
    request.headers.get('content-type')?.split(';')[0] !==
    'application/x-www-form-urlencoded'
  )
    throw new Problem(400, 'Send an encoded authorization-code request.');
  const raw = await request.text();
  if (Buffer.byteLength(raw) > 8192)
    throw new Problem(413, 'Sign-in request is too large.');
  const params = new URLSearchParams(raw);
  const keys = [
    'grant_type',
    'client_id',
    'redirect_uri',
    'code',
    'code_verifier',
  ];
  if (
    [...params.keys()].some((key) => !keys.includes(key)) ||
    keys.some((key) => params.getAll(key).length !== 1)
  )
    throw new Problem(400, 'Invalid sign-in request fields.');
  if (
    params.get('grant_type') !== 'authorization_code' ||
    params.get('client_id') !== s.clientId ||
    params.get('redirect_uri') !== s.redirect.href
  )
    throw new Problem(
      400,
      'The sign-in client, redirect URI or grant does not match this dashboard.',
    );
  if (
    !/^[A-Za-z0-9._~-]{43,128}$/.test(params.get('code_verifier') || '') ||
    !params.get('code') ||
    params.get('code')!.length > 4096
  )
    throw new Problem(
      400,
      'A valid authorization code and PKCE verifier are required.',
    );
  // A confidential provider can optionally use this server-only credential.
  if (process.env.AUTH_CLIENT_SECRET)
    params.set('client_secret', process.env.AUTH_CLIENT_SECRET);
  let response: Response;
  try {
    response = await send(s.token.href, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    throw new Problem(
      503,
      'The club sign-in provider could not be reached. Try signing in again.',
    );
  }
  if (!response.ok)
    throw new Problem(
      response.status >= 500 ? 503 : 400,
      'The sign-in code was rejected. Start sign-in again.',
    );
  let data: Record<string, unknown>;
  try {
    const body = await response.text();
    if (Buffer.byteLength(body) > 65536) throw new Error();
    data = JSON.parse(body);
    if (
      !data ||
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      typeof data.id_token !== 'string' ||
      !data.id_token ||
      typeof data.token_type !== 'string' ||
      data.token_type.toLowerCase() !== 'bearer' ||
      typeof data.expires_in !== 'number' ||
      data.expires_in <= 0
    )
      throw new Error();
  } catch {
    throw new Problem(
      503,
      'The club sign-in provider returned an invalid token response.',
    );
  }
  // Retain only the fields used by the browser; do not expose secrets or refresh tokens.
  return {
    access_token: data.access_token,
    id_token: data.id_token,
    token_type: 'Bearer',
    expires_in: data.expires_in,
    ...(typeof data.scope === 'string' ? { scope: data.scope } : {}),
  };
}
