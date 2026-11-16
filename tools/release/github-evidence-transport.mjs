// Read-only GitHub evidence transport. Authentication is never sent to a redirect target.
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://api.github.com';
const MAX_ARCHIVE = 256 * 1024 * 1024;
const validRepo = repository => /^[\w.-]+\/[\w.-]+$/.test(repository ?? '');
const positive = value => Number.isSafeInteger(value) && value > 0;

export function createGithubEvidenceTransport({ token, approvalIssue, fetchImpl = globalThis.fetch } = {}) {
  if (typeof token !== 'string' || !token.trim() || (approvalIssue !== undefined && !positive(approvalIssue)) || typeof fetchImpl !== 'function') throw new Error('GitHub token and valid optional approval issue are required');
  const request = async (url, { binary = false, authenticated = true } = {}) => {
    const headers = { Accept: binary ? 'application/octet-stream' : 'application/vnd.github+json', 'User-Agent': 'aiwg-release-evidence', 'X-GitHub-Api-Version': '2022-11-28' };
    if (authenticated) headers.Authorization = `Bearer ${token}`;
    try { return await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(120000) }); }
    catch { throw new Error('GitHub evidence request failed'); }
  };
  const apiResponse = async pathname => {
    const response = await request(`${API}${pathname}`);
    if (!response.ok) throw new Error(`GitHub evidence API returned HTTP ${response.status}`);
    return { data: await response.json(), serverDate: response.headers.get('date') };
  };
  const api = async pathname => (await apiResponse(pathname)).data;
  const collection = async (pathname, field) => {
    const items = []; let total;
    for (let page = 1; page <= 1000; page++) {
      const response = await api(`${pathname}${pathname.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = field ? response?.[field] : response;
      if (!Array.isArray(batch)) throw new Error('Malformed GitHub collection');
      if (field) {
        if (!Number.isSafeInteger(response.total_count) || response.total_count < 0 || (total !== undefined && total !== response.total_count)) throw new Error('Inconsistent GitHub collection count');
        total = response.total_count;
      }
      items.push(...batch);
      if (batch.length < 100) {
        if (total !== undefined && total !== items.length) throw new Error('Incomplete GitHub collection');
        return { items, complete: true, ...(total === undefined ? {} : { totalCount: total }) };
      }
    }
    throw new Error('GitHub collection pagination limit exceeded');
  };
  const repoPath = repository => {
    if (!validRepo(repository)) throw new Error('Invalid GitHub repository');
    return `/repos/${repository}`;
  };
  return {
    async getAuthenticatedIdentity() {
      const { data, serverDate } = await apiResponse('/user');
      return { ...data, server_date: serverDate };
    },
    getWorkflow: ({ repository, workflowId }) => { if (!positive(workflowId)) throw new Error('Invalid workflow ID'); return api(`${repoPath(repository)}/actions/workflows/${workflowId}`); },
    getRun: ({ repository, runId }) => { if (!positive(runId)) throw new Error('Invalid run ID'); return api(`${repoPath(repository)}/actions/runs/${runId}`); },
    listWorkflowRuns: ({ repository, workflow, branch, commit }) => {
      if (workflow !== 'npm-publish.yml' || !/^v\d{4}\.\d+\.\d+$/.test(branch ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Invalid stable workflow identity');
      return collection(`${repoPath(repository)}/actions/workflows/${workflow}/runs?branch=${encodeURIComponent(branch)}&head_sha=${commit}`, 'workflow_runs');
    },
    listRunArtifacts: ({ repository, runId }) => { if (!positive(runId)) throw new Error('Invalid run ID'); return collection(`${repoPath(repository)}/actions/runs/${runId}/artifacts`, 'artifacts'); },
    listJobs: ({ repository, runId, attempt }) => { if (!positive(runId) || !positive(attempt)) throw new Error('Invalid run attempt'); return collection(`${repoPath(repository)}/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs'); },
    getArtifact: ({ repository, artifactId }) => { if (!positive(artifactId)) throw new Error('Invalid artifact ID'); return api(`${repoPath(repository)}/actions/artifacts/${artifactId}`); },
    compareCommits: ({ repository, base, head }) => {
      if (!/^[a-f0-9]{40}$/.test(base ?? '') || !/^[a-f0-9]{40}$/.test(head ?? '')) throw new Error('Invalid commit comparison identity');
      return api(`${repoPath(repository)}/compare/${base}...${head}`);
    },
    async getWorkflowSource({ repository, path: sourcePath, commit }) {
      if (!/^[a-f0-9]{40}$/.test(commit ?? '') || sourcePath !== '.github/workflows/release-candidate.yml') throw new Error('Invalid workflow source identity');
      const data = await api(`${repoPath(repository)}/contents/${sourcePath}?ref=${commit}`);
      if (data?.encoding !== 'base64' || typeof data.content !== 'string' || data.path !== sourcePath || data.type !== 'file') throw new Error('Invalid GitHub workflow source');
      return { repository, path: sourcePath, commit, content: Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8') };
    },
    async listApprovals({ repository }) {
      if (!positive(approvalIssue)) throw new Error('Approval issue is required');
      const page = await collection(`${repoPath(repository)}/issues/${approvalIssue}/comments`);
      const approvals = page.items.filter(item => { try { return ['aiwg-release-comparison-approval/v1', 'aiwg-release-comparison-approval/v2', 'aiwg-stable-release-approval/v1'].includes(JSON.parse(item.body)?.schema); } catch { return false; } });
      return { items: approvals.map(item => ({ id: item.id, html_url: item.html_url, actor: item.user, created_at: item.created_at, updated_at: item.updated_at, body: item.body })), complete: true, totalCount: approvals.length };
    },
    async downloadArtifact({ repository, artifactId, destination }) {
      if (!positive(artifactId)) throw new Error('Invalid artifact ID');
      // The zip endpoint accepts only the JSON media type and answers with a redirect
      // to the archive; any other Accept returns HTTP 415 (#3716).
      let response = await request(`${API}${repoPath(repository)}/actions/artifacts/${artifactId}/zip`);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); let target;
        try { target = new URL(location); } catch { throw new Error('Invalid artifact redirect'); }
        if (target.protocol !== 'https:' || !(target.hostname === 'github.com' || target.hostname.endsWith('.githubusercontent.com') || target.hostname.endsWith('.blob.core.windows.net')) || target.username || target.password) throw new Error('Untrusted artifact redirect');
        response = await request(target.href, { binary: true, authenticated: false });
      }
      if (!response.ok) throw Object.assign(new Error(`GitHub artifact download returned HTTP ${response.status}`), { status: response.status });
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_ARCHIVE) throw new Error('GitHub artifact exceeds archive size limit');
      const chunks = []; let size = 0;
      if (!response.body) throw new Error('GitHub artifact response has no body');
      for await (const chunk of response.body) { size += chunk.length; if (size > MAX_ARCHIVE) throw new Error('GitHub artifact exceeds archive size limit'); chunks.push(chunk); }
      fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
      const archivePath = path.join(destination, 'candidate.zip');
      fs.writeFileSync(archivePath, Buffer.concat(chunks), { flag: 'wx', mode: 0o600 });
      return { archivePath };
    },
  };
}
