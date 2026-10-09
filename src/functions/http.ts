import { app } from '@azure/functions';
import { handle } from '../api.js';
app.http('clubApi', {
  route: '{*path}',
  methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  authLevel: 'anonymous',
  handler: async (req) => {
    const request = new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method)
        ? undefined
        : await req.arrayBuffer(),
    });
    const response = await handle(request);
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: new Uint8Array(await response.arrayBuffer()),
    };
  },
});
