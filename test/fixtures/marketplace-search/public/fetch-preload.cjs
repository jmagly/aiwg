// Offline built-CLI transport serving only the recorded public search fixtures.
const fs = require('node:fs');
const path = require('node:path');
globalThis.fetch = async function fixtureFetch(request) {
  if (process.env.AIWG_TEST_SEARCH_OFFLINE === '1') throw new Error('Unexpected network request in offline search');
  const url = new URL(request);
  const source = ({
    'registry.modelcontextprotocol.io': 'mcp-registry',
    'api.github.com': 'github',
    'skills.sh': 'skills.sh',
  })[url.hostname];
  if (!source) throw new Error('Unexpected public endpoint');
  return new Response(fs.readFileSync(path.join(__dirname, `${source}.json`), 'utf8'), { status: 200 });
};
