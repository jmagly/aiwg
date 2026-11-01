#!/usr/bin/env node
// Publish the exact smoke-tested tarballs from this signed-tag workflow.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { verifyRegistryPackageIdentity } from './release-promotion.mjs';
import { smokeTarballs } from './release-candidate.mjs';
import { createGithubEvidenceTransport } from './github-evidence-transport.mjs';
import { importImpl } from '../_resolve-impl.mjs';
const { boundedSpawnSync } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');
import { SURFACES } from './release-candidate.mjs';
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const registry = 'https://registry.npmjs.org';
const workflowPath = '.github/workflows/npm-publish.yml';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function registryView(name, version, spawn, env) {
  const result = spawn('npm', ['view', `${name}@${version}`, '--json', '--registry', registry, '--prefer-online', '--fetch-retries=0', '--fetch-timeout=10000'], 'long',
    { env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  if (!result.error && result.status === 0) {
    try {
      const metadata = JSON.parse(result.stdout);
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error();
      return metadata;
    } catch { throw new Error(`Malformed registry metadata for ${name}`); }
  }
  if (!result.error && /\bE404\b/.test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)) return null;
  throw new Error(`Registry lookup failed for ${name}@${version}`);
}
function pageItems(page) {
  if (!page || page.complete !== true || !Array.isArray(page.items) || (page.totalCount !== undefined && page.totalCount !== page.items.length)) throw new Error('Incomplete retained artifact collection');
  return page.items;
}
async function extractedArtifact(client, repository, artifact, destination, spawn, legacy = false) {
  const { archivePath } = await client.downloadArtifact({ repository, artifactId: artifact.id, destination });
  if (artifact.digest && artifact.digest !== `sha256:${sha256(archivePath)}`) throw new Error('Retained archive digest mismatch');
  const extracted = path.join(destination, 'extracted'); fs.mkdirSync(extracted);
  const result = spawn('python3', ['-I', '-S', path.join(import.meta.dirname, 'extract-release-archive.py'), extracted, ...(legacy ? ['--legacy-stable-package'] : [])], 'long',
    { input: fs.readFileSync(archivePath), encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error('Retained archive extraction failed');
  return extracted;
}
function smokeRecords(directory, version) {
  const smoke = JSON.parse(fs.readFileSync(path.join(directory, 'installed-smoke.json'), 'utf8'));
  if (smoke.pass !== true || !Array.isArray(smoke.packages) || smoke.packages.length !== SURFACES.length) throw new Error('Missing installed smoke evidence');
  for (const surface of SURFACES) {
    const matches = smoke.packages.filter(x => x.package === surface.name && x.filename === `${surface.stem}-${version}.tgz` && x.installed_version === version && x.status === 'success');
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].sha256)) throw new Error(`Invalid smoke evidence for ${surface.name}`);
  }
  return smoke;
}

// Authenticated evidence may come from an earlier failed attempt or a separate
// tag-bound dispatch. A failed signing step does not invalidate successful smoke tests.
export async function retainedPackages({ client, repository, commit, tag, runId, attempt, destination, version, spawn = boundedSpawnSync }) {
  const runs = pageItems(await client.listWorkflowRuns({ repository, workflow: 'npm-publish.yml', branch: tag, commit }));
  const retained = [];
  // The earliest retained attempt supplied the bytes originally published.
  // Later attempts can contain rebuilt, smoke-tested bytes that never published.
  for (const run of [...runs].sort((a, b) => a.id - b.id)) {
    if (run.path !== workflowPath || run.head_sha !== commit || run.head_branch !== tag || !['push', 'workflow_dispatch'].includes(run.event)
      || run.repository?.full_name !== repository || run.head_repository?.full_name !== repository) throw new Error('Untrusted retained workflow identity');
    const artifacts = pageItems(await client.listRunArtifacts({ repository, runId: run.id }));
    for (const artifact of [...artifacts].sort((a, b) => a.id - b.id)) {
      const match = new RegExp(`^stable-packages-${run.id}-([1-9]\\d*)$`).exec(artifact.name);
      if (!match || (run.id === runId && Number(match[1]) >= attempt)) continue;
      if (artifact.expired === true) continue;
      if (artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== commit || artifact.expired !== false) throw new Error('Missing or mismatching retained package evidence');
      const jobs = pageItems(await client.listJobs({ repository, runId: run.id, attempt: Number(match[1]) }));
      const required = ['Verify workflow identity is tag-bound', 'Verify signed tag (#1299 / A9 gate)', 'Checkout release tag', 'Retain smoke-tested tarballs before publication'];
      const successful = (job, name) => job.steps?.filter(step => step.name === name && step.conclusion === 'success' && step.status === 'completed').length === 1;
      if (jobs.filter(job => job.name === 'Publish to npmjs.org with provenance' && job.run_id === run.id && job.head_sha === commit
        && required.every(name => successful(job, name))
        && (successful(job, 'Pack and smoke-test exact npm surfaces') || successful(job, 'Recover published registry tarballs'))).length !== 1) throw new Error('Untrusted retained smoke-test steps');
      const download = path.join(destination, String(artifact.id)); fs.mkdirSync(download);
      const directory = await extractedArtifact(client, repository, artifact, download, spawn, true);
      const smoke = fs.existsSync(path.join(directory, 'installed-smoke.json')) ? smokeRecords(directory, version) : null;
      retained.push({ directory, smoke, artifact_id: artifact.id });
      return retained;
    }
  }
  return retained;
}

async function registryBytes(metadata, fetchImpl) {
  let url; try { url = new URL(metadata?.dist?.tarball); } catch { throw new Error('Missing registry tarball URL'); }
  if (url.origin !== registry || url.username || url.password) throw new Error('Untrusted registry tarball URL');
  const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Registry tarball download returned HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > 384 * 1024 * 1024) throw new Error('Registry tarball exceeds size limit'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export async function prepareRecovery({ directory, version, repository, commit, tag, runId, attempt, client,
  spawn = boundedSpawnSync, env = process.env, fetchImpl = globalThis.fetch, smoke = smokeTarballs }) {
  if (tag !== `v${version}` || !/^[a-f0-9]{40}$/.test(commit ?? '') || !/^\d{4}\.\d+\.\d+$/.test(version)) throw new Error('Invalid recovery tag/commit identity');
  const metadata = SURFACES.map(surface => registryView(surface.name, version, spawn, env));
  if (metadata.every(item => item === null)) return { recovered: false };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-stable-recovery-'));
  try {
    const retained = await retainedPackages({ client, repository, commit, tag, runId, attempt, destination: temp, version, spawn });
    const stage = path.join(temp, 'packages'); fs.mkdirSync(stage);
    for (const [index, surface] of SURFACES.entries()) {
      const filename = `${surface.stem}-${version}.tgz`, file = path.join(stage, filename);
      const originals = retained.filter(item => fs.existsSync(path.join(item.directory, filename)));
      if (metadata[index]) {
        fs.writeFileSync(file, await registryBytes(metadata[index], fetchImpl));
        verifyRegistryPackageIdentity({ file, packageName: surface.name, version, metadata: metadata[index] });
      } else if (originals.length) fs.copyFileSync(path.join(originals[0].directory, filename), file);
      else throw new Error(`Partially published release lacks retained smoke-tested bytes for ${surface.name}`);
      const digest = sha256(file);
      for (const original of retained) {
        if ((original.smoke && original.smoke.packages.find(item => item.package === surface.name).sha256 !== digest)
          || (fs.existsSync(path.join(original.directory, filename)) && sha256(path.join(original.directory, filename)) !== digest)) throw new Error(`Registry package identity mismatch with retained smoke-tested artifact for ${surface.name}@${version}`);
      }
    }
    // Legacy incomplete retention still constrains every available byte/hash.
    // Independently smoke-test downloaded files when complete original proof is absent.
    const originalSmoke = retained.find(item => item.smoke)?.smoke;
    if (originalSmoke) fs.writeFileSync(path.join(stage, 'installed-smoke.json'), JSON.stringify(originalSmoke));
    else await smoke({ output: stage, spawn, env });
    validateInputs(stage, version);
    fs.mkdirSync(directory, { recursive: true });
    for (const entry of fs.readdirSync(stage)) fs.copyFileSync(path.join(stage, entry), path.join(directory, entry));
    return { recovered: true, artifacts: retained.map(item => item.artifact_id), published: SURFACES.filter((_, index) => metadata[index]).map(item => item.name) };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

// Upload-artifact only errors if *none* of its paths match. Verify the actual
// retained ZIP, including all four smoke-bound digests, before npm can publish.
export async function verifyRetention({ directory, version, repository, runId, attempt, client, spawn = boundedSpawnSync }) {
  const packages = validateInputs(directory, version);
  const artifacts = pageItems(await client.listRunArtifacts({ repository, runId })).filter(item => item.name === `stable-packages-${runId}-${attempt}` && item.expired === false && item.workflow_run?.id === runId);
  if (artifacts.length !== 1) throw new Error('Missing retained stable package artifact');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-retention-check-'));
  try {
    const retained = await extractedArtifact(client, repository, artifacts[0], temp, spawn);
    const actual = validateInputs(retained, version);
    for (const item of packages) if (actual.find(x => x.name === item.name)?.sha256 !== item.sha256) throw new Error(`Retained package mismatch for ${item.name}`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export function validateInputs(directory, version) {
  if (!/^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('Invalid stable version');
  const smoke = JSON.parse(fs.readFileSync(path.join(directory, 'installed-smoke.json'), 'utf8'));
  if (smoke.pass !== true || !Array.isArray(smoke.packages) || smoke.packages.length !== SURFACES.length) throw new Error('Missing installed smoke evidence');
  return SURFACES.map(surface => {
    const filename = `${surface.stem}-${version}.tgz`;
    const matches = smoke.packages.filter(x => x.package === surface.name && x.filename === filename && x.installed_version === version && x.status === 'success');
    if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(matches[0].sha256)) throw new Error(`Invalid smoke evidence for ${surface.name}`);
    const file = path.join(directory, filename), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || sha256(file) !== matches[0].sha256) throw new Error(`Tarball changed for ${surface.name}`);
    return { name: surface.name, filename, file, sha256: matches[0].sha256 };
  });
}
export async function publish({ directory, version, receipt, spawn = boundedSpawnSync, env = process.env, sleep = pause, knownPublished = [] }) {
  const packages = validateInputs(directory, version);
  if (!Array.isArray(knownPublished) || knownPublished.some(name => !SURFACES.some(item => item.name === name))) throw new Error('Invalid known-published package identities');
  const record = { schema: 'aiwg-direct-stable-publication/v1', version, packages: [], complete: false };
  const fd = fs.openSync(receipt, 'wx', 0o600);
  const save = () => { const b = Buffer.from(JSON.stringify(record, null, 2) + '\n'); fs.ftruncateSync(fd, 0); fs.writeSync(fd, b, 0, b.length, 0); fs.fsyncSync(fd); };
  const npm = args => spawn('npm', args, 'long', { env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  try {
    save();
    for (const item of packages) {
      validateInputs(directory, version);
      let metadata = registryView(item.name, version, spawn, env);
      if (!metadata && knownPublished.includes(item.name)) throw new Error(`Previously published registry package is unavailable: ${item.name}@${version}`);
      if (metadata) verifyRegistryPackageIdentity({ file: item.file, packageName: item.name, version, metadata });
      const result = metadata ? { status: 0 } : npm(['publish', item.file, '--ignore-scripts', '--access', 'public', '--tag', 'latest', '--registry', 'https://registry.npmjs.org', '--provenance']);
      const alreadyPublished = Boolean(metadata);
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      const conflict = /(?:EPUBLISHCONFLICT|cannot publish over the previously published versions|package version already exists|\b409\b)/i.test(output);
      if (result.error || (result.status !== 0 && !conflict)) throw new Error(`Publish failed for ${item.name}`);
      for (let attempt = 0; !alreadyPublished && attempt < (conflict ? 5 : 1); attempt++) {
        const view = npm(['view', `${item.name}@${version}`, '--json', '--registry', 'https://registry.npmjs.org']);
        if (!view.error && view.status === 0) { try { metadata = JSON.parse(view.stdout); } catch {} if (metadata) break; }
        if (conflict && attempt < 4) await sleep(3000);
      }
      // A confirmed publish may take time to become visible. An observed
      // identity mismatch remains fatal; a conflict must prove the whole identity.
      let identity = { package: item.name, version, sha256: item.sha256 };
      if ((metadata?.name && metadata.name !== item.name) || (metadata?.version && metadata.version !== version)) throw new Error(`Registry package identity mismatch for ${item.name}@${version}`);
      const bytes = fs.readFileSync(item.file);
      if ((metadata?.dist?.shasum && metadata.dist.shasum !== createHash('sha1').update(bytes).digest('hex')) ||
          (metadata?.dist?.integrity && metadata.dist.integrity !== `sha512-${createHash('sha512').update(bytes).digest('base64')}`)) {
        throw new Error(`Registry package identity mismatch for ${item.name}@${version}`);
      }
      if ((metadata?.name && metadata?.version && metadata?.dist?.shasum && metadata?.dist?.integrity) || conflict) {
        identity = verifyRegistryPackageIdentity({ file: item.file, packageName: item.name, version, metadata });
      }
      validateInputs(directory, version);
      const attestations = metadata?.dist?.attestations ?? null;
      const provenance = typeof attestations?.url === 'string' && attestations.url && attestations?.provenance?.predicateType === 'https://slsa.dev/provenance/v1' ? 'observed' : 'pending';
      const registryIdentity = metadata?.name && metadata?.version && metadata?.dist?.shasum && metadata?.dist?.integrity ? 'verified' : 'pending';
      if (registryIdentity === 'pending' || provenance === 'pending') console.warn(`::warning::Registry identity or provenance pending for ${item.name}@${version}; post-asset checks will retry.`);
      record.packages.push({ ...identity, attestations, registry_identity: registryIdentity, provenance, disposition: alreadyPublished || conflict ? 'already-published' : 'published' }); save();
    }
    record.complete = true; save(); return record;
  } finally { fs.closeSync(fd); }
}
export async function mirror({ directory, version, receipt, spawn = boundedSpawnSync, env = process.env }) {
  const registry = 'https://git.integrolabs.net/api/packages/roctinam/npm/';
  if (!/^\d{4}\.(?:[1-9]|1[0-2])\.(?:0|[1-9]\d*)$/.test(version)) throw new Error('Invalid stable version');
  const packages = SURFACES.map(({name, stem}) => {
    const filename = `${stem}-${version}.tgz`, file = path.join(directory, filename), st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error(`Invalid public tarball ${name}`);
    return {name, filename, file, sha256:sha256(file)};
  });
  const verifyFiles = () => { for (const item of packages) if (sha256(item.file) !== item.sha256) throw new Error(`Tarball changed: ${item.name}`); };
  const npm = args => spawn('npm', args, 'long', { env, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  // All four public artifacts must already exist and match before any local publication.
  for (const item of packages) {
    const result = npm(['view', `${item.name}@${version}`, '--json', '--registry', 'https://registry.npmjs.org']);
    if (result.error || result.status !== 0) throw new Error(`Public package unavailable: ${item.name}`);
    const metadata = JSON.parse(result.stdout);
    verifyRegistryPackageIdentity({file:item.file, packageName:item.name, version, metadata});
    if (!metadata?.dist?.attestations?.url || metadata.dist.attestations?.provenance?.predicateType !== 'https://slsa.dev/provenance/v1') throw new Error(`Missing public provenance: ${item.name}`);
  }
  const record = { schema:'aiwg-direct-stable-mirror/v1', version, packages:[], complete:false };
  const fd = fs.openSync(receipt, 'wx', 0o600);
  const save = () => { const b=Buffer.from(JSON.stringify(record,null,2)+'\n'); fs.ftruncateSync(fd,0); fs.writeSync(fd,b,0,b.length,0); fs.fsyncSync(fd); };
  try {
    save();
    for (const item of packages) {
      verifyFiles();
      const result = npm(['publish',item.file,'--ignore-scripts','--access','public','--tag','latest','--registry',registry]);
      const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      if (result.error || (result.status !== 0 && !/(?:EPUBLISHCONFLICT|cannot publish over the previously published versions|package version already exists|\b409\b)/i.test(output))) throw new Error(`Mirror publish failed for ${item.name}`);
      let metadata;
      for(let i=0;i<5;i++){const view=npm(['view',`${item.name}@${version}`,'--json','--registry',registry]);if(!view.error && view.status===0){metadata=JSON.parse(view.stdout);break;}await new Promise(resolve=>setTimeout(resolve,3000));}
      const identity=verifyRegistryPackageIdentity({file:item.file,packageName:item.name,version,metadata});
      verifyFiles();
      const tag=npm(['dist-tag','add',`${item.name}@${version}`,'latest','--registry',registry]);
      if(tag.error || tag.status!==0)throw new Error(`Mirror tag failed for ${item.name}`);
      record.packages.push({...identity,disposition:result.status===0?'published':'already-published'});save();
    }
    record.complete=true;save();return record;
  } finally { fs.closeSync(fd); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { directory: {type:'string'}, version: {type:'string'}, receipt: {type:'string'}, mirror: {type:'boolean'}, prepare: {type:'boolean'}, 'verify-retention': {type:'boolean'}, 'already-published': {type:'string'} } });
    if (values.prepare || values['verify-retention']) {
      const options = { ...values, client: createGithubEvidenceTransport({ token: process.env.GH_TOKEN }),
        repository: process.env.GITHUB_REPOSITORY, commit: process.env.RELEASE_COMMIT, tag: process.env.RELEASE_TAG,
        runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT) };
      if (values.prepare) {
        const result = await prepareRecovery(options);
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `recovered=${result.recovered}\npublished_packages=${result.published?.join(',') ?? ''}\n`);
      } else await verifyRetention(options);
    } else if (values.mirror) await mirror(values); else await publish({ ...values, knownPublished: values['already-published']?.split(',').filter(Boolean) ?? [] });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
