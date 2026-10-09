import { ZodError } from 'zod';
import { kinds, type Kind, Problem } from './model.js';
import { getStore, type Store } from './store.js';
import { authenticate } from './auth.js';
import { Service } from './service.js';
import { upload, download } from './files.js';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
export async function handle(
  request: Request,
  providedStore?: Store,
): Promise<Response> {
  const response = await dispatch(request, providedStore);
  const origin = request.headers.get('origin');
  const allowed = (
    process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173'
  )
    .split(',')
    .map((s) => s.trim());
  if (origin && allowed.includes(origin)) {
    response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set(
      'Access-Control-Allow-Methods',
      'GET, POST, PUT, OPTIONS',
    );
    response.headers.set(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, If-Match, Idempotency-Key, X-File-Name',
    );
  }
  return response;
}
async function dispatch(
  request: Request,
  providedStore?: Store,
): Promise<Response> {
  try {
    const u = new URL(request.url);
    const segments = u.pathname
      .replace(/^\/api\/?/, '')
      .split('/')
      .filter(Boolean);
    const origin = request.headers.get('origin');
    const allowed = (
      process.env.ALLOWED_ORIGINS ||
      'http://localhost:5173,http://127.0.0.1:5173'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (origin && !allowed.includes(origin))
      throw new Problem(403, 'Origin is not allowed.');
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204 });
    if (segments[0] === 'health') return json({ status: 'ok' });
    const store = providedStore || (await getStore());
    const actor = await authenticate(request.headers, store);
    const service = new Service(store, actor);
    if (segments[0] === 'me' && request.method === 'GET')
      return json({
        actor,
        mode: process.env.STORE_MODE === 'file' ? 'local' : 'azure',
        ai: 'rules-only',
        messaging: 'manual',
      });
    if (segments[0] === 'people' && request.method === 'GET')
      return json(await service.people());
    if (
      segments[0] === 'assistant' &&
      segments[1] === 'review' &&
      request.method === 'POST'
    )
      return json(await service.review());
    if (!['records', 'files'].includes(segments[0]))
      throw new Problem(404, 'Endpoint not found.');
    const kind = segments[1] as Kind;
    if (!kinds.includes(kind)) throw new Problem(404, 'Unknown record type.');
    const id = segments[2];
    if (id && !/^[a-zA-Z0-9_-]{1,100}$/.test(id))
      throw new Problem(400, 'Invalid record ID.');
    if (segments[0] === 'files' && id) {
      if (request.method === 'POST')
        return json(await upload(service, kind, id, request), 201);
      if (request.method === 'GET' && segments[3])
        return download(service, kind, id, segments[3]);
    }
    if (segments[0] === 'records') {
      if (request.method === 'GET')
        return json(
          id
            ? await service.get(kind, id)
            : await service.list(
                kind,
                u.searchParams.get('cursor') || undefined,
              ),
        );
      const raw = await request.text();
      if (Buffer.byteLength(raw) > 1024 * 1024)
        throw new Problem(413, 'Record requests must be under 1 MB.');
      const body = JSON.parse(raw);
      if (!body || typeof body !== 'object' || Array.isArray(body))
        throw new Problem(400, 'Send a JSON object.');
      if (request.method === 'POST' && !id)
        return json(await service.create(kind, body), 201);
      const version = Number(request.headers.get('if-match'));
      if (!Number.isSafeInteger(version) || version < 1)
        throw new Problem(
          428,
          'Send the current record version using If-Match.',
        );
      if (request.method === 'PUT' && id)
        return json(await service.update(kind, id, body, version));
      if (request.method === 'POST' && id && segments[3])
        return json(
          await service.command(
            kind,
            id,
            segments[3],
            body,
            version,
            request.headers.get('idempotency-key') || '',
          ),
        );
    }
    throw new Problem(405, 'Method not allowed.');
  } catch (e) {
    if (e instanceof Problem) return json({ error: e.message }, e.status);
    if (e instanceof ZodError)
      return json(
        {
          error: e.issues
            .map((i) => `${i.path.join('.') || 'Record'}: ${i.message}`)
            .join('; '),
        },
        400,
      );
    if (e instanceof SyntaxError)
      return json({ error: 'Invalid JSON request.' }, 400);
    console.error(
      'Request failed',
      e instanceof Error ? e.message : 'Unknown error',
    );
    return json(
      {
        error:
          'The service could not complete this request. Check configuration or try again.',
      },
      503,
    );
  }
}
