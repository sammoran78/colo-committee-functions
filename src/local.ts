import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
try {
  const settings = JSON.parse(await readFile('local.settings.json', 'utf8'));
  for (const [k, v] of Object.entries(settings.Values || {}))
    process.env[k] ??= String(v);
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
}
process.env.NODE_ENV ??= 'development';
process.env.STORE_MODE ??= 'file';
process.env.AUTH_MODE ??= 'development';
// The development host is deliberately local-only and cannot connect to Cosmos.
if (
  process.env.STORE_MODE !== 'file' ||
  process.env.AUTH_MODE !== 'development'
)
  throw new Error(
    'Use Azure Functions Core Tools for authenticated Cosmos development. This local host supports file mode only.',
  );
const { handle } = await import('./api.js');
const { getStore } = await import('./store.js');
const { seedLocal } = await import('./seed.js');
const store = await getStore();
if (process.env.SEED_DEMO !== 'false') await seedLocal(store);
createServer(async (req, res) => {
  try {
    if (
      !['127.0.0.1:7071', 'localhost:7071'].includes(req.headers.host || '')
    ) {
      res.writeHead(403);
      res.end('Local host required');
      return;
    }
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 11 * 1024 * 1024) {
        res.writeHead(413);
        res.end('Request too large');
        return;
      }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers))
      if (v) headers.set(k, Array.isArray(v) ? v.join(',') : v);
    const request = new Request('http://127.0.0.1:7071' + req.url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method || 'GET')
        ? undefined
        : Buffer.concat(chunks),
    });
    const response = await handle(request, store);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500);
    res.end('Local request failed.');
  }
}).listen(7071, '127.0.0.1', () =>
  console.log('Club API at http://127.0.0.1:7071/api — LOCAL FILE DATA ONLY'),
);
