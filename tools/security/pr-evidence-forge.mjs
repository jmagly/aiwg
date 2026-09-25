/** Read-only GitHub/Gitea API adapter for pr-evidence-receipt.mjs. */
const MAX_RESPONSE_BYTES = 2_000_000;
const encodePath = value => String(value).split('/').map(encodeURIComponent).join('/');

async function boundedResponse(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('Forge response exceeds bound');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) throw new Error('Forge response exceeds bound');
    return bytes;
  }
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_RESPONSE_BYTES) throw new Error('Forge response exceeds bound');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function pagination(response, items, page, pageSize, provider, totalCount) {
  const totalHeader = response.headers.get(provider === 'gitea' ? 'x-total' : 'x-total-count');
  const total = Number.isSafeInteger(Number(totalHeader)) && totalHeader !== null ? Number(totalHeader) : totalCount;
  const hasMore = response.headers.get('x-hasmore');
  const link = response.headers.get('link') ?? '';
  const linkedNext = /<[^>]+[?&]page=(\d+)[^>]*>;\s*rel="next"/.exec(link);
  const ambiguous = provider === 'gitea' && hasMore === null && total === undefined && items.length === pageSize;
  const nextPage = hasMore === 'true' ? page + 1 : hasMore === 'false' ? null
    : linkedNext ? Number(linkedNext[1]) : total !== undefined && page * pageSize < total ? page + 1 : null;
  return { items, nextPage, complete: !ambiguous && nextPage === null &&
    (total === undefined || total === (page - 1) * pageSize + items.length), totalCount: total };
}

export function createForgePrAdapter({ provider, apiBaseUrl, token, fetchImpl = fetch,
  canonicalBase, graphqlUrl } = {}) {
  if (!['github', 'gitea'].includes(provider)) throw new Error('provider must be github or gitea');
  if (!apiBaseUrl || !/^https?:\/\//.test(apiBaseUrl)) throw new Error('Trusted API base URL is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (canonicalBase?.source !== 'trusted-base') throw new Error('Trusted canonical-base context is required');
  const base = apiBaseUrl.replace(/\/$/, '');
  const ghGraphql = graphqlUrl ?? (base === 'https://api.github.com' ? 'https://api.github.com/graphql'
    : base.replace(/\/api\/v3$/, '/api/graphql'));
  let head = '';
  let headRepository = '';
  let currentBody = '';
  const cursors = new Map([[1, null]]);
  const reviewIds = [];
  const reviewCommentCursors = new Map([[1, { reviewIndex: 0, reviewPage: 1 }]]);
  const request = async (path, body) => {
    const url = body ? ghGraphql : `${base}${path}`;
    const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', headers: {
      accept: 'application/json', ...(token ? { authorization: provider === 'github' ? `Bearer ${token}` : `token ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const bytes = await boundedResponse(response);
    if (!response.ok) throw new Error(`Forge read failed: HTTP ${response.status}`);
    return { response, bytes, json: () => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  };
  const repoPath = identity => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(identity?.repository ?? '') ||
      !Number.isSafeInteger(identity?.number) || identity.number < 1) throw new Error('Invalid PR identity');
    return `/repos/${identity.repository.split('/').map(encodeURIComponent).join('/')}`;
  };
  return {
    async getPullRequest(identity) {
      const prefix = repoPath(identity);
      const { json } = await request(`${prefix}/pulls/${identity.number}`);
      const pr = json();
      head = pr.head?.sha ?? '';
      headRepository = pr.head?.repo?.full_name ?? identity.repository;
      if (!/^[\w.-]+\/[\w.-]+$/.test(headRepository)) throw new Error('Invalid head repository');
      currentBody = pr.body ?? '';
      return { head, base: pr.base?.sha, title: pr.title ?? '', body: currentBody,
        canonicalBase, expected: { files: pr.changed_files, comments: pr.comments, commits: pr.commits } };
    },
    /** Merge state of the PR. `mergeCommitSha` is set only once merged (GitHub reports a test merge before). */
    async getPullState(identity) {
      const prefix = repoPath(identity);
      const { json } = await request(`${prefix}/pulls/${identity.number}`);
      const pr = json();
      if (!['open', 'closed'].includes(pr.state) || typeof pr.merged !== 'boolean') throw new Error('Invalid pull request state');
      const mergeSha = typeof pr.merge_commit_sha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pr.merge_commit_sha) ? pr.merge_commit_sha : null;
      return { state: pr.state, merged: pr.merged, mergedAt: pr.merged_at ?? null,
        mergeCommitSha: pr.merged ? mergeSha : null, base: { ref: pr.base?.ref ?? null, sha: pr.base?.sha ?? null } };
    },
    async list(kind, identity, page, pageSize) {
      const prefix = repoPath(identity);
      if (kind === 'bodyHistory') {
        if (provider !== 'github') throw new Error('Gitea does not expose original PR body history');
        if (!cursors.has(page)) throw new Error('Missing GraphQL page cursor');
        const [owner, name] = identity.repository.split('/');
        const query = `query($owner:String!,$name:String!,$number:Int!,$first:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){lastEditedAt userContentEdits(first:$first,after:$after){totalCount nodes{id diff editedAt} pageInfo{hasNextPage endCursor}}}}}`;
        const { json } = await request('', { query, variables: { owner, name, number: identity.number,
          first: pageSize, after: cursors.get(page) } });
        const result = json();
        if (result.errors?.length) throw new Error('GraphQL body-history query failed');
        const pr = result.data?.repository?.pullRequest;
        const edits = pr?.userContentEdits;
        if (!edits || !Array.isArray(edits.nodes)) throw new Error('Body history unavailable');
        if (edits.pageInfo?.hasNextPage) cursors.set(page + 1, edits.pageInfo.endCursor);
        const nodes = edits.nodes.map(item => ({ id: item.id, at: item.editedAt, body: item.diff ?? '', kind: 'edit-diff' }));
        // GitHub exposes edit diffs, not a reconstructed original body. With
        // no edits, the current body is also the original.
        if (page === 1 && edits.totalCount === 0 && pr.lastEditedAt === null) {
          nodes.push({ id: 'original', at: null, body: currentBody, kind: 'original' });
        }
        const nextPage = edits.pageInfo?.hasNextPage ? page + 1 : null;
        return { items: nodes, nextPage, complete: nextPage === null,
          totalCount: edits.totalCount === 0 ? 1 : edits.totalCount,
          originalAvailable: edits.totalCount === 0 && pr.lastEditedAt === null };
      }
      if (kind === 'reviewComments' && provider === 'gitea') {
        const cursor = reviewCommentCursors.get(page);
        if (!cursor) throw new Error('Missing review-comment page cursor');
        if (cursor.reviewIndex >= reviewIds.length) return { items: [], nextPage: null, complete: true, totalCount: 0 };
        const reviewId = reviewIds[cursor.reviewIndex];
        const { response, json } = await request(`${prefix}/pulls/${identity.number}/reviews/${reviewId}/comments?page=${cursor.reviewPage}&limit=${pageSize}`);
        const raw = json();
        if (!Array.isArray(raw)) throw new Error('Invalid review comments response');
        const items = raw.map(item => ({ id: item.id, body: item.body ?? '', at: item.created_at,
          path: item.path, head: item.commit_id }));
        const hasMoreHeader = response.headers.get('x-hasmore');
        if (hasMoreHeader === null && raw.length === pageSize) throw new Error('Review comment pagination unavailable');
        const hasMore = hasMoreHeader === 'true';
        const next = hasMore ? { reviewIndex: cursor.reviewIndex, reviewPage: cursor.reviewPage + 1 }
          : { reviewIndex: cursor.reviewIndex + 1, reviewPage: 1 };
        const nextPage = next.reviewIndex < reviewIds.length ? page + 1 : null;
        if (nextPage) reviewCommentCursors.set(nextPage, next);
        return { items, nextPage, complete: nextPage === null };
      }
      const paths = {
        comments: `${prefix}/issues/${identity.number}/comments`,
        reviews: `${prefix}/pulls/${identity.number}/reviews`,
        reviewComments: provider === 'github' ? `${prefix}/pulls/${identity.number}/comments` : null,
        checks: provider === 'github' ? `${prefix}/commits/${head}/check-runs` : `${prefix}/commits/${head}/statuses`,
        commits: `${prefix}/pulls/${identity.number}/commits`,
        files: `${prefix}/pulls/${identity.number}/files`,
      };
      if (!paths[kind]) throw new Error(`Unknown PR collection '${kind}'`);
      const suffix = `?page=${page}&per_page=${pageSize}${kind === 'checks' && provider === 'github' ? '&filter=all' : ''}`;
      const { response, json } = await request(`${paths[kind]}${suffix}`);
      const data = json();
      const raw = kind === 'checks' && provider === 'github' ? data.check_runs : data;
      if (!Array.isArray(raw)) throw new Error('Invalid forge list response');
      const items = raw.map(item => {
        if (kind === 'reviews') {
          if (provider === 'gitea' && item.id !== undefined) reviewIds.push(item.id);
          return { id: item.id, body: item.body ?? '', state: item.state,
            reviewerId: item.user?.login, head: item.commit_id };
        }
        if (kind === 'reviewComments') return { id: item.id, body: item.body ?? '', at: item.created_at,
          path: item.path, head: item.commit_id };
        if (kind === 'checks') return { id: item.id, name: item.name ?? item.context,
          conclusion: item.conclusion ?? item.state, head: item.head_sha ?? item.sha ?? head };
        if (kind === 'commits') return { sha: item.sha };
        if (kind === 'files') return { path: item.filename, status: item.status === 'deleted' ? 'removed' : item.status };
        return { id: item.id, body: item.body ?? '', at: item.created_at };
      });
      return pagination(response, items, page, pageSize, provider,
        kind === 'checks' && provider === 'github' ? data.total_count : undefined);
    },
    async getFile(identity, path, revision) {
      repoPath(identity);
      if (revision !== head) throw new Error('File request does not match frozen head');
      const prefix = `/repos/${headRepository.split('/').map(encodeURIComponent).join('/')}`;
      if (provider === 'github') {
        const { json } = await request(`${prefix}/contents/${encodePath(path)}?ref=${encodeURIComponent(revision)}`);
        const data = json();
        if (data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') return { binary: true };
        const bytes = Buffer.from(data.content.replace(/\s/g, ''), 'base64');
        try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
        catch { return { binary: true }; }
      }
      const { bytes } = await request(`${prefix}/raw/${encodePath(path)}?ref=${encodeURIComponent(revision)}`);
      if (bytes.includes(0)) return { binary: true };
      try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
      catch { return { binary: true }; }
    },
  };
}
