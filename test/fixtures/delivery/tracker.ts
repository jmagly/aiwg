// Loopback-only tracker with mutable actors, PR state and reflected credential responses.
import { createServer, type Server } from 'node:http';
export interface Call { method: string; path: string; body: Record<string, any>; authorization?: string }
export async function fakeTracker() {
  const calls: Call[] = [];
  const state = { login: 'operator', head: '', title: 'Fixture change', prState: 'open', base: 'main', reflect: false, reject: false, onRead: undefined as (() => Promise<void>) | undefined };
  const server: Server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const call = { method: request.method!, path: request.url!, body: raw ? JSON.parse(raw) : {}, authorization: request.headers.authorization };
    calls.push(call);
    response.setHeader('Content-Type', 'application/json');
    if (state.reject) { response.writeHead(400); response.end(JSON.stringify({ error: request.headers.authorization })); return; }
    let result: unknown;
    if (request.url === '/user') result = { login: state.login };
    else if (request.url?.includes('/pulls/')) {
      if (request.method === 'GET') {
        if (state.onRead) await state.onRead();
        result = { number: 1, state: state.prState, title: state.title, head: { sha: state.head, ref: 'feature' }, base: { ref: state.base } };
      } else { if (request.method === 'PATCH') state.prState = 'closed'; result = { merged: true }; }
    } else if (request.url?.includes('/issues?')) result = [];
    else if (request.url?.includes('/labels?')) result = [{ id: 2, name: 'bug' }];
    else result = { number: 1, body: call.body.body, updated_at: '2026-01-01T00:00:00Z' };
    if (state.reflect && request.url !== '/user') result = { reflected: request.headers.authorization };
    response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { calls, state, url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeAllConnections();
  }) };
}
