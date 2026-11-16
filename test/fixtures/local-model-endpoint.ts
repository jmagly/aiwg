// Synthetic OpenAI-compatible server; never serves inference or contacts another host.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
export async function localModelEndpoint() {
  const requests: Array<{ path: string; authorization?: string }> = [];
  const state = { status: 200, ids: ['synthetic-model'], hang: false, redirect: '', invalid: false };
  const server = createServer((request, response) => {
    requests.push({ path: request.url!, authorization: request.headers.authorization });
    if (state.hang) return;
    response.statusCode = state.status;
    if (state.redirect) response.setHeader('location', state.redirect);
    response.setHeader('content-type', 'application/json');
    response.end(state.invalid ? '{broken' : JSON.stringify({ data: state.ids.map(id => ({ id, object: 'model' })) }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  return { endpoint, requests, state, close };
}
