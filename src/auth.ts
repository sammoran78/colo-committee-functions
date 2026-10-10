import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import { type Actor, type Entry, Problem } from './model.js';
import type { Store } from './store.js';
export const localActor: Actor = {
  id: 'local-admin',
  name: 'Local administrator',
  roles: [
    'admin',
    'committee',
    'inventory',
    'escuela',
    'communications',
    'treasurer',
  ],
  projectIds: [],
};
export function memberId(issuer: string, subject: string) {
  return (
    'member-' +
    createHash('sha256')
      .update(issuer + '\n' + subject)
      .digest('hex')
      .slice(0, 40)
  );
}
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
export async function authenticate(
  headers: Headers,
  store: Store,
): Promise<Actor> {
  if (process.env.AUTH_MODE === 'development') {
    if (
      process.env.STORE_MODE !== 'file' ||
      process.env.WEBSITE_INSTANCE_ID ||
      process.env.NODE_ENV === 'production'
    )
      throw new Problem(
        503,
        'Development authentication is not permitted here.',
      );
    return localActor;
  }
  const issuer = process.env.AUTH_ISSUER,
    audience = process.env.AUTH_AUDIENCE,
    uri = process.env.AUTH_JWKS_URI;
  if (!issuer || !audience || !uri)
    throw new Problem(503, 'Staff sign-in has not been configured.');
  const token = headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token)
    throw new Problem(401, 'Sign in with an authorised staff account.');
  let payload;
  try {
    jwks ??= createRemoteJWKSet(new URL(uri));
    ({ payload } = await jwtVerify(token, jwks, {
      issuer,
      audience,
      algorithms: ['RS256', 'ES256'],
      requiredClaims: ['sub', 'iat', 'exp'],
    }));
  } catch {
    throw new Problem(401, 'Your session is invalid or has expired.');
  }
  if (!payload.sub) throw new Problem(401, 'The token has no subject.');
  const requiredScope = process.env.AUTH_REQUIRED_SCOPE?.trim();
  if (
    requiredScope &&
    (typeof payload.scope !== 'string' ||
      !payload.scope.split(/\s+/).includes(requiredScope))
  )
    throw new Problem(
      401,
      'Use an access token with the required dashboard scope.',
    );
  const id = memberId(issuer, payload.sub);
  let stored = await store.get('member', id);
  const bootstrap = (process.env.AUTH_ADMIN_SUBJECTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(payload.sub);
  // Registration never grants roles except to an explicitly configured bootstrap admin.
  // Opt in after approving the additional one-time Cosmos write per new identity.
  if (!stored && process.env.AUTH_REGISTER_SIGN_INS === 'enabled') {
    let name = typeof payload.name === 'string' ? payload.name : '';
    let email = typeof payload.email === 'string' ? payload.email : '';
    const endpoint = process.env.AUTH_USERINFO_ENDPOINT;
    if (endpoint) {
      const url = new URL(endpoint);
      if (
        url.protocol !== 'https:' ||
        url.origin !== new URL(issuer).origin ||
        url.username ||
        url.password ||
        url.hash ||
        url.search
      )
        throw new Problem(
          503,
          'Configure AUTH_USERINFO_ENDPOINT as an HTTPS URL on the issuer origin.',
        );
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/json',
          },
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (response.ok) {
          const body = await response.text();
          if (Buffer.byteLength(body) <= 65536) {
            const profile = JSON.parse(body);
            if (profile.sub === payload.sub) {
              name =
                typeof profile.name === 'string'
                  ? profile.name
                  : typeof profile.preferred_username === 'string'
                    ? profile.preferred_username
                    : name;
              email = typeof profile.email === 'string' ? profile.email : email;
            }
          }
        }
      } catch {
        // Identity was already verified. A profile outage must not grant access or prevent registration.
      }
    }
    const at = new Date().toISOString();
    const entry: Entry = {
      id,
      kind: 'member',
      application: 'colo-committee',
      schemaVersion: 1,
      version: 1,
      createdAt: at,
      updatedAt: at,
      createdBy: id,
      data: {
        title:
          name.trim().slice(0, 200) ||
          (bootstrap ? 'Club administrator' : 'WordPress user ' + payload.sub),
        email: email.trim().slice(0, 320),
        issuer,
        subject: payload.sub,
        roles: bootstrap ? ['admin'] : [],
        active: bootstrap,
        projectIds: [],
        classification: 'restricted',
        description: '',
        requestedAt: at,
      },
      history: [
        {
          at,
          by: id,
          action: bootstrap
            ? 'Bootstrap administrator registered'
            : 'Staff access requested',
        },
      ],
      receipts: {},
    };
    try {
      stored = await store.create(entry);
    } catch (error) {
      if (
        (error instanceof Problem && error.status === 409) ||
        (error as { code?: number }).code === 409
      ) {
        stored = await store.get('member', id);
        if (!stored) throw error;
      } else throw error;
    }
  }
  // An explicit disabled membership always overrides the bootstrap allowlist.
  if (stored) {
    if (!stored.data.active)
      throw new Problem(
        403,
        stored.data.roles.length
          ? 'Dashboard access is disabled.'
          : 'Your staff registration is awaiting administrator approval.',
      );
    return {
      id,
      name: stored.data.title,
      roles: stored.data.roles,
      projectIds: stored.data.projectIds,
    };
  }
  if (bootstrap)
    return {
      id,
      name:
        typeof payload.name === 'string' ? payload.name : 'Club administrator',
      roles: ['admin'],
      projectIds: [],
    };
  throw new Problem(403, 'Your account has not been granted dashboard access.');
}
