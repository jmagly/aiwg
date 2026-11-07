// Local OpenBao KV v2 fixture; all credential values exist only in memory.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export async function openBaoHttpFixture() {
  const token = randomUUID();
  const vaultToken = randomUUID();
  const operations: string[] = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    operations.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/auth/approle/login') {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.statusCode = body.role_id === 'fixture-role' && body.secret_id === 'fixture-secret' ? 200 : 403;
      res.end(JSON.stringify({ auth: { client_token: vaultToken } }));
    } else if (req.headers['x-vault-token'] !== vaultToken) {
      res.writeHead(403).end('{}');
    } else if (req.url === '/v1/auth/token/revoke-self') {
      res.writeHead(204).end();
    } else if (req.url === '/v1/kv_internal/data/typesafe/jev/api-key') {
      res.statusCode = status;
      res.end(JSON.stringify(status === 200 ? { data: { data: { token } } } : { errors: [token] }));
    } else res.writeHead(404).end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = `https://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return { addr, token, vaultToken, operations, fail: (code: number) => { status = code; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
