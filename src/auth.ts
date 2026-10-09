import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHash } from 'node:crypto';
import { type Actor, Problem } from './model.js';
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
  const stored = await store.get('member', id);
  // An explicit disabled membership always overrides the bootstrap allowlist.
  if (stored) {
    if (!stored.data.active)
      throw new Problem(403, 'Dashboard access is disabled.');
    return {
      id,
      name: stored.data.title,
      roles: stored.data.roles,
      projectIds: stored.data.projectIds,
    };
  }
  if (
    (process.env.AUTH_ADMIN_SUBJECTS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .includes(payload.sub)
  )
    return {
      id,
      name:
        typeof payload.name === 'string' ? payload.name : 'Club administrator',
      roles: ['admin'],
      projectIds: [],
    };
  throw new Problem(403, 'Your account has not been granted dashboard access.');
}
