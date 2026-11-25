// Loopback-only OpenAI-compatible judge fixture for offline tests.
import { createServer } from 'node:http';
export async function fakeHttp(mode = 'ok') {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    requests.push({ body: JSON.parse(body), authorization: req.headers.authorization });
    if (mode === 'error') { res.writeHead(503); res.end(`synthetic outage ${req.headers.authorization}`); return; }
    if (mode === 'empty') { res.end(); return; }
    if (mode === 'disconnected') { res.writeHead(200); res.write('{\"choices\":['); setTimeout(() => res.destroy(), 20); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'observed-model', usage: { total_tokens: 17, ...(mode === 'unknown' ? {} : { cost: mode === 'over-budget' ? 0.1 : 0.01 }) },
      choices: [{ finish_reason: mode === 'partial' ? 'length' : 'stop', message: { content: JSON.stringify({ label: 'CANNOT_ASSESS', evidence: [], rationale: 'Synthetic missing evidence', critical_flags: [], secondary_flags: [] }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/chat/completions`, requests,
    close: () => new Promise(resolve => server.close(resolve)) };
}
