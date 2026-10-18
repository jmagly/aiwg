import { manageOmpMcp } from '../../src/mcp/omp-config.mjs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runOmpTeam } from './omp-teams.mjs';
import { OmpRpcClient, waitForOmpProcessCleanup, warmAndConnectOmpRpcClient } from './omp-transport.mjs';

// #2999: the pinned binary's first RPC start in this job competes with whatever else the shared
// runner is doing (e.g. a concurrent default-lane test job) for memory/CPU. The strict 30s
// default readiness wait (`OmpRpcClient`'s `timeoutMs`) stays the interactive default everywhere
// else; this conformance tool's first start alone gets a larger, explicit `readyTimeoutMs` budget
// -- never `timeoutMs`, which would also widen this client's later command/prompt deadlines --
// justified by the observed failure (CI run 78994: the wait ran ~33s, just past the 30s default,
// under one concurrent job). `firstStartMs`/`warmedMs`/`warmup` are recorded in the report so a
// startup regression is visible as a number trending toward this budget, not only as a timeout.
const FIRST_START_READY_TIMEOUT_MS = 60000;

/** Credential-free native OMP MCP lifecycle with deterministic loopback model. */
export async function runOmpMcpConformance({ binary = process.env.AIWG_OMP_BIN || 'omp', outputFile } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'aiwg-omp-mcp-'));
  const httpMethods = []; const modelCalls = []; let client; let cancellationStarted; const cancellationObserved = new Promise(resolveCancel => { cancellationStarted = resolveCancel; });
  const tool = { name: 'echo', description: 'Echo local conformance evidence', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } };
  const mcpResult = request => request.method === 'initialize' ? { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'aiwg-local-fixture', version: '1' } } : request.method === 'tools/list' ? { tools: [tool] } : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'MCP_VERIFIED:' + request.params.arguments.text }] } : {};
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/mcp' && req.method === 'GET') { res.writeHead(405).end(); return; }
      if (req.url === '/mcp' && req.method === 'DELETE') { httpMethods.push('disconnect'); res.writeHead(200).end(); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4 * 1024 * 1024) throw new Error('Fixture request exceeded bound'); }
      const request = JSON.parse(body);
      if (req.url === '/mcp') {
        httpMethods.push(request.method);
        if (request.id === undefined) { res.writeHead(202).end(); return; }
        res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'aiwg-fixture' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: mcpResult(request) })); return;
      }
      const text = (request.messages ?? []).map(m => typeof m.content === 'string' ? m.content : (m.content ?? []).map(part => part.text ?? '').join('\n')).join('\n');
      if (text.includes('AIWG_CANCEL_WORKER') && !(request.tools ?? []).some(t => t.function?.name === 'task')) { cancellationStarted(); req.on('close', () => res.destroy()); return; }
      const agentMatch = text.match(/using agent "([^"]+)" and name "([^"]+)"/);
      const names = (request.tools ?? []).map(t => t.function?.name).filter(n => n?.includes('echo') || (n === 'task' && agentMatch));
      const called = new Set((request.messages ?? []).flatMap(m => (m.tool_calls ?? []).map(t => t.function.name)));
      const remaining = names.filter(n => !called.has(n));
      modelCalls.push({ allTools: (request.tools ?? []).map(t => t.function?.name), agentMatch: Boolean(agentMatch), tools: names, remaining, promptExpanded: text.includes('AIWG_PROMPT_EXPANDED VALUE') });
      const delta = remaining.length ? { role: 'assistant', tool_calls: remaining.map((name, index) => ({ index, id: 'fixture-' + index, type: 'function', function: { name, arguments: JSON.stringify(name === 'task' ? { agent: agentMatch[1], name: agentMatch[2], task: 'Return deterministic local worker evidence. Do not spawn children.' } : { text: 'verified' }) } })) } : { role: 'assistant', content: 'Local MCP conformance completed.' };
      if (request.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const payload of [{ id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta, finish_reason: null }] }, { id: 'fixture', object: 'chat.completion.chunk', model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: remaining.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }]) res.write('data: ' + JSON.stringify(payload) + '\n\n');
        res.end('data: [DONE]\n\n');
      } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, message: delta, finish_reason: remaining.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); }
    } catch { res.writeHead(400).end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  try {
    const home = join(root, 'home'); const cwd = join(root, 'project'); const agent = join(home, '.omp', 'agent');
    await mkdir(agent, { recursive: true }); await mkdir(join(cwd, '.omp', 'prompts'), { recursive: true });
    await writeFile(join(cwd, '.omp', 'prompts', 'conformance-prompt.md'), '---\ndescription: Local expansion test\n---\nAIWG_PROMPT_EXPANDED $1\n');
    await writeFile(join(agent, 'models.yml'), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'fixture-not-a-secret', api: 'openai-completions', models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    await writeFile(join(agent, 'config.yml'), JSON.stringify({ modelRoles: { default: 'fixture/fixture', smol: 'fixture/fixture', slow: 'fixture/fixture' }, mnemopi: { enabled: false }, tools: { xdev: false }, disabledProviders: ['claude', 'codex', 'pi', 'cursor', 'windsurf', 'gemini', 'opencode', 'claude-plugins'], marketplace: { autoUpdate: false } }));
    const trace = join(root, 'stdio-trace.jsonl'); const fixture = join(root, 'stdio.cjs');
    await writeFile(fixture, `const fs=require('fs');const log=x=>fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(x)+'\\n');log({pid:process.pid,parentPid:process.ppid,startTime:process.platform==='linux'?fs.readFileSync('/proc/self/stat','utf8').split(') ').pop().trim().split(/\\s+/)[19]:undefined});const tool=${JSON.stringify(tool)};require('readline').createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);log({method:r.method});if(r.id===undefined)return;const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'aiwg-stdio',version:'1'}}:r.method==='tools/list'?{tools:[tool]}:r.method==='tools/call'?{content:[{type:'text',text:'MCP_VERIFIED:'+r.params.arguments.text}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});process.on('SIGTERM',()=>{log({method:'disconnect'});process.exit(0)});process.stdin.on('end',()=>{log({method:'disconnect'});process.exit(0)});`);
    const serverDefinitions = { fixture_disabled: { enabled: false, type: 'stdio', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(join(root, 'disabled-launched'))},'started')`] }, fixture_shadow: { type: 'stdio', command: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(join(root, 'shadow-launched'))},'started')`] }, fixture_stdio: { type: 'stdio', command: process.execPath, args: [fixture] }, fixture_http: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } };
    await manageOmpMcp(join(agent, 'mcp.json'), Object.entries(serverDefinitions).map(([name, config]) => ({ name, ...config })));
    await writeFile(join(cwd, '.omp', 'mcp.json'), JSON.stringify({ mcpServers: { fixture_shadow: { enabled: false } } }));
    const env = { PATH: process.env.PATH ?? '', TMPDIR: root, NO_COLOR: '1', PI_CONFIG_DIR: relative(homedir(), join(root, 'config')), PI_CODING_AGENT_DIR: agent };
    const firstStart = await warmAndConnectOmpRpcClient({ binary, cwd, env, args: ['--no-extensions', '--no-session', '--model', 'fixture/fixture', '--thinking', 'off'], readyTimeoutMs: FIRST_START_READY_TIMEOUT_MS });
    client = firstStart.client;
    const startupTiming = { warmup: firstStart.warmup, warmedMs: firstStart.warmedMs, firstStartMs: firstStart.readyMs, firstStartReadyTimeoutMs: FIRST_START_READY_TIMEOUT_MS };
    const state = await client.command('get_state');
    const nativeTools = state.dumpTools.map(t => t.name).filter(n => n.includes('echo'));
    const result = await client.prompt('Call each fixture echo tool once with text verified. Report completion.');
    const expansion = await client.prompt('/conformance-prompt VALUE');
    const promptExpanded = expansion.success && modelCalls.some(call => call.promptExpanded);
    const teamStart = modelCalls.length;
    const nativeTeam = await runOmpTeam({ cwd, model: 'fixture/fixture', maxParallel: 2, tasks: [
      { id: 'research', agent: 'researcher', role: 'reasoning', prompt: 'Inspect deterministic evidence', ownership: ['research.md'], tools: ['read'] },
      { id: 'sdlc', agent: 'architect', role: 'coding', prompt: 'Assess deterministic evidence', ownership: ['design.md'], tools: ['read'] },
    ], clientFactory: options => new OmpRpcClient({ ...options, binary, env, timeoutMs: 30000 }) });
    const teamAllowlistVerified = modelCalls.slice(teamStart).every(call => call.allTools.every(name => ['task', 'read'].includes(name)));
    const controller = new AbortController();
    const cancelledRun = runOmpTeam({ cwd, outputDir: join(cwd, '.aiwg', 'cancel-results'), model: 'fixture/fixture', maxParallel: 1, signal: controller.signal, tasks: [{ id: 'cancelled', agent: 'researcher', prompt: 'AIWG_CANCEL_WORKER', tools: ['read'], ownership: [] }], clientFactory: options => new OmpRpcClient({ ...options, binary, env, timeoutMs: 30000 }) });
    const cancelReached = await Promise.race([cancellationObserved.then(() => true), new Promise(resolveTimeout => setTimeout(() => resolveTimeout(false), 15000))]);
    controller.abort(); const cancellation = await cancelledRun;
    const nativeCancelled = cancelReached && cancellation.results[0].status === 'cancelled';
    const profileAgent = join(root, 'config', 'profiles', 'conformance', 'agent');
    const defaultAgent = join(root, 'config', 'agent');
    await mkdir(profileAgent, { recursive: true }); await mkdir(defaultAgent, { recursive: true });
    for (const file of ['config.yml', 'models.yml']) await writeFile(join(profileAgent, file), await readFile(join(agent, file)));
    await writeFile(join(profileAgent, 'mcp.json'), JSON.stringify({ mcpServers: { fixture_profile: { type: 'http', url: `http://127.0.0.1:${port}/mcp` } } }));
    await writeFile(join(defaultAgent, 'mcp.json'), JSON.stringify({ mcpServers: { fixture_default: { type: 'stdio', command: process.execPath, args: [fixture] } } }));
    const profileClient = new OmpRpcClient({ binary, cwd, env, args: ['--profile', 'conformance', '--no-extensions', '--no-session'], timeoutMs: 10000 });
    let profileTools;
    try { await profileClient.connect(); profileTools = (await profileClient.command('get_state')).dumpTools.map(t => t.name).filter(name => name.includes('echo')); } finally { await profileClient.close(); }
    const profileIsolated = profileTools.length === 1 && profileTools[0] === 'mcp__fixture_profile_echo';
    const disabledSuppressed = await readFile(join(root, 'disabled-launched')).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
    const projectOverrideSuppressed = await readFile(join(root, 'shadow-launched')).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error; });
    await client.close();
    const stdio = (await readFile(trace, 'utf8')).trim().split('\n').map(JSON.parse);
    const processes = stdio.filter(event => event.pid);
    const cleanup = await waitForOmpProcessCleanup(processes);
    const childAlive = !cleanup.complete;
    const report = { binary, sourceVersion: '18.1.10', runtimeVersion: spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, env, killSignal: 'SIGKILL' }).stdout.trim(), credentialFree: true, configGeneratedBy: 'src/mcp/omp-config.mjs manageOmpMcp', model: 'deterministic loopback fixture (not a hosted model)', startupTiming, nativeTools, profileTools, profileIsolated, disabledSuppressed, projectOverrideSuppressed, promptExpanded, teamAllowlistVerified, nativeCancelled, cancellation: { reachedWorker: cancelReached, status: cancellation.results[0].status, error: cancellation.results[0].error }, disabledAndShadowedAbsent: nativeTools.every(name => !/disabled|shadow/.test(name)), nativeTeam: nativeTeam.results.map(task => ({ id: task.id, parentId: task.parentId, role: task.role, ownership: task.ownership, requestedModel: task.model, status: task.status, error: task.error, result: task.result })), resultSuccess: result.success, httpMethods, stdioMethods: stdio.filter(e => e.method).map(e => e.method), childAlive, checkedSubprocesses: processes.length, subprocesses: processes, cleanup, modelCalls, pass: profileIsolated && disabledSuppressed && projectOverrideSuppressed && nativeCancelled && teamAllowlistVerified && promptExpanded && nativeTeam.results.every(task => task.status === 'completed') && result.success && nativeTools.length === 2 && httpMethods.includes('tools/call') && stdio.some(e => e.method === 'tools/call') && !childAlive };
    if (outputFile) { await mkdir(resolve(outputFile, '..'), { recursive: true }); await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n'); }
    return report;
  } finally { if (client) await client.close(); await new Promise(resolveClose => server.close(resolveClose)); await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runOmpMcpConformance({ binary: process.argv[2], outputFile: process.argv[3] }).then(report => { console.log(JSON.stringify(report, null, 2)); if (!report.pass) process.exitCode = 1; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
