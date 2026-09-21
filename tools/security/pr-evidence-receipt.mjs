import { createHash } from 'node:crypto';
import { assessThreat } from './threat-assessment.mjs';

const COLLECTIONS = ['bodyHistory', 'comments', 'reviews', 'reviewComments', 'checks', 'commits', 'files'];
const LIMITS = Object.freeze({ pages: 100, pageSize: 100, files: 1000, fileBytes: 262_144 });
const RANK = { proceed: 0, record: 1, flag: 2, 'require-authorization': 3, reject: 4 };
const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const isSha = value => typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value);
const omission = (surface, reason, nextStep) => ({ surface, reason, nextStep });

/**
 * Read-only adapter contract: getPullRequest(identity), list(kind, identity,
 * page, pageSize), getFile(identity, path, head). All returned content is data.
 * The adapter must obtain canonical-base context independently of the PR head.
 */
export async function collectPrEvidence(adapter, identity, requestedLimits = {}) {
  const limits = { ...LIMITS, ...requestedLimits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > LIMITS[name]) throw new Error(`Invalid ${name} collection limit`);
  }
  if (!adapter || typeof adapter.getPullRequest !== 'function' || typeof adapter.list !== 'function' || typeof adapter.getFile !== 'function') {
    throw new Error('A read-only PR adapter with getPullRequest, list, and getFile is required');
  }
  const startedAt = new Date().toISOString();
  const initial = await adapter.getPullRequest(identity);
  if (!isSha(initial?.head) || !isSha(initial?.base)) throw new Error('Immutable PR head and base revisions are required');
  const omissions = [];
  const collections = {};
  for (const kind of COLLECTIONS) {
    const items = [];
    let nextPage = 1;
    let pages = 0;
    let complete = false;
    const visited = new Set();
    while (nextPage !== null && pages < limits.pages) {
      if (!Number.isSafeInteger(nextPage) || nextPage < 1 || visited.has(nextPage)) {
        omissions.push(omission(kind, 'invalid-pagination', `Recollect ${kind} with a valid page cursor`));
        break;
      }
      visited.add(nextPage);
      try {
        const page = await adapter.list(kind, identity, nextPage, limits.pageSize);
        if (!page || !Array.isArray(page.items) || page.items.length > limits.pageSize) throw new Error('invalid page');
        items.push(...page.items);
        pages += 1;
        if (kind === 'bodyHistory' && page.originalAvailable === false &&
            !omissions.some(entry => entry.reason === 'original-body-unavailable')) {
          omissions.push(omission(kind, 'original-body-unavailable', 'Preserve available edit diffs and obtain the original body from an independent archive'));
        }
        if (page.nextPage === null && page.complete === true &&
            (page.totalCount === undefined || page.totalCount === items.length)) complete = true;
        else if (page.nextPage === null) omissions.push(omission(kind, 'unverified-end-or-count', `Recollect all ${kind} pages and verify total count`));
        nextPage = page.nextPage ?? null;
      } catch {
        omissions.push(omission(kind, 'inaccessible', `Restore access and recollect ${kind}`));
        break;
      }
    }
    if (nextPage !== null && pages >= limits.pages) omissions.push(omission(kind, 'page-limit', `Raise bounded page limit and recollect ${kind}`));
    collections[kind] = { items, pages, complete, sha256: sha(items) };
    if (Number.isSafeInteger(initial.expected?.[kind]) && initial.expected[kind] !== items.length) {
      omissions.push(omission(kind, 'forge-count-mismatch', `Reconcile expected ${initial.expected[kind]} ${kind} with ${items.length} collected`));
    }
  }
  const files = collections.files.items;
  if (!collections.commits.items.some(commit => commit?.sha === initial.head)) {
    omissions.push(omission('commits', 'head-absent-from-inventory', 'Recollect commits through the exact PR head'));
  }
  if (files.length > limits.files) omissions.push(omission('files', 'file-limit', 'Raise bounded file limit and recollect files'));
  const contents = [];
  const seenPaths = new Set();
  for (const file of files.slice(0, limits.files)) {
    const path = file?.path;
    if (typeof path !== 'string' || !path || path.startsWith('/') || path.includes('..')) {
      omissions.push(omission(String(path), 'invalid-path', 'Verify path inventory from the forge'));
      continue;
    }
    if (seenPaths.has(path)) {
      omissions.push(omission(path, 'duplicate-path-in-inventory', 'Recollect the changed-file inventory'));
      continue;
    }
    seenPaths.add(path);
    if (file.status === 'removed') {
      omissions.push(omission(path, 'removed-content-unassessed', 'Acquire and assess the deleted base-side patch as data'));
      continue;
    }
    try {
      const blob = await adapter.getFile(identity, path, initial.head);
      if (!blob || blob.binary === true || typeof blob.content !== 'string') {
        omissions.push(omission(path, 'binary-or-unavailable', `Inspect ${path} through an appropriate evidence tool`));
        continue;
      }
      const bytes = Buffer.byteLength(blob.content);
      if (bytes > limits.fileBytes) {
        omissions.push(omission(path, 'oversized', `Review ${path} in bounded chunks`));
        continue;
      }
      const total = blob.content === '' ? 0 : blob.content.split('\n').length;
      if (file.sha256 && file.sha256 !== sha(blob.content)) {
        omissions.push(omission(path, 'inventory-hash-mismatch', 'Recollect exact-head file inventory and content'));
        continue;
      }
      contents.push({ path, status: file.status, content: blob.content, sha256: sha(blob.content), bytes,
        lineCoverage: { assessed: total, total }, sourceRevision: initial.head });
    } catch {
      omissions.push(omission(path, 'inaccessible', `Restore blob access and recollect ${path}`));
    }
  }
  const final = await adapter.getPullRequest(identity);
  if (final?.head !== initial.head || final?.base !== initial.base) {
    omissions.push(omission('pr', 'head-or-base-changed-during-collection', 'Recollect against the new exact head and base'));
  }
  return { schemaVersion: '1', identity, acquiredAt: startedAt, completedAt: new Date().toISOString(),
    head: initial.head, base: initial.base, currentHead: final?.head, currentBase: final?.base,
    title: initial.title ?? '', body: initial.body ?? '', canonicalBase: initial.canonicalBase ?? null,
    collectionSource: 'read-only-adapter', collections, contents, omissions };
}

/** Build a deterministic receipt; policy comes only from the trusted caller. */
export function assessPrEvidence(snapshot, policy, options = {}) {
  if (!isSha(snapshot?.head) || !isSha(snapshot?.base)) throw new Error('Immutable PR revisions are required');
  const omissions = [...(snapshot.omissions ?? [])];
  if (snapshot.collectionSource !== 'read-only-adapter') {
    omissions.push(omission('collection', 'unverified-provenance', 'Collect through a trusted read-only forge adapter'));
  }
  const collections = snapshot.collections ?? {};
  for (const kind of COLLECTIONS) {
    if (collections[kind]?.complete !== true) omissions.push(omission(kind, 'collection-incomplete', `Complete ${kind} pagination`));
  }
  if (!snapshot.canonicalBase || snapshot.canonicalBase.revision !== snapshot.base ||
      snapshot.canonicalBase.source !== 'trusted-base') {
    omissions.push(omission('canonical-base', 'unverified', 'Acquire project context from the canonical base'));
  }
  if (snapshot.currentHead !== snapshot.head || snapshot.currentBase !== snapshot.base ||
      (options.currentHead && options.currentHead !== snapshot.head)) {
    omissions.push(omission('pr', 'stale-head-or-base', 'Recollect all evidence for the current exact revision'));
  }
  const assessed = [];
  const surfaces = [
    ['title', 'pull-request-title', snapshot.title ?? ''],
    ['body', 'pull-request-body', snapshot.body ?? ''],
  ];
  for (const [index, item] of (collections.bodyHistory?.items ?? []).entries()) {
    if (typeof item?.body === 'string') surfaces.push([`body-history:${index}`, 'pull-request-body', item.body]);
  }
  for (const kind of ['comments', 'reviews', 'reviewComments']) {
    for (const [index, item] of (collections[kind]?.items ?? []).entries()) {
      if (typeof item?.body === 'string') surfaces.push([`${kind}:${index}`, 'review-comment', item.body]);
    }
  }
  for (const file of snapshot.contents ?? []) {
    if (typeof file.content !== 'string') continue;
    if (file.sourceRevision !== snapshot.head || file.sha256 !== sha(file.content)) {
      omissions.push(omission(file.path, 'source-hash-or-revision-mismatch', 'Reacquire the exact-head file content'));
      continue;
    }
    // Source-controlled instructions remain text on a diff surface; they never
    // select policy, context, or authority for this assessment.
    surfaces.push([`file:${file.path}`, 'pull-request-diff-summary', file.content]);
  }
  for (const [id, surface, content] of surfaces) {
    const report = assessThreat({ surface, content, requestedAction: 'consume-as-data',
      source: { kind: 'pull-request-evidence', id, repository: snapshot.identity?.repository,
        revision: snapshot.head, contentHash: sha(content) } }, policy);
    assessed.push({ id, surface, sha256: sha(content), report });
    if (!report.assessed || !report.completeness.complete) omissions.push(omission(id, 'scanner-incomplete', 'Review scanner limits and reassess the full surface'));
  }
  const contentByPath = new Set((snapshot.contents ?? []).map(file => file.path));
  for (const item of collections.files?.items ?? []) {
    if (item?.status !== 'removed' && !contentByPath.has(item?.path)) {
      if (!omissions.some(entry => entry.surface === item?.path)) omissions.push(omission(item?.path ?? 'unknown', 'unassessed-file', 'Acquire and assess exact-head content'));
    }
  }
  const approvals = (collections.reviews?.items ?? []).filter(review => review.state === 'APPROVED' &&
    review.head === snapshot.head && typeof review.reviewerId === 'string' && review.reviewerId);
  const passingChecks = (collections.checks?.items ?? []).filter(check => check.head === snapshot.head &&
    check.conclusion === 'success' && typeof check.name === 'string' && check.name);
  const staleReviews = (collections.reviews?.items ?? []).filter(review => review.state === 'APPROVED' && review.head !== snapshot.head);
  const staleChecks = (collections.checks?.items ?? []).filter(check => check.conclusion === 'success' && check.head !== snapshot.head);
  const claims = {
    review: /\b(?:reviewed|approved|reviewed by|astra review)\b/i.test(snapshot.body ?? ''),
    tests: /\b(?:tests? pass(?:ed|ing)?|passing tests?|\d+ tests?)\b/i.test(snapshot.body ?? ''),
    security: /\b(?:security review|security audit|security approved)\b/i.test(snapshot.body ?? ''),
  };
  const verified = { reviews: approvals.map(item => ({ reviewerId: item.reviewerId, head: item.head, id: item.id })),
    checks: passingChecks.map(item => ({ name: item.name, head: item.head, id: item.id })),
    stale: { reviews: staleReviews.length, checks: staleChecks.length } };
  const active = assessed.flatMap(item => item.report.findings.filter(finding => !finding.suppressed)
    .map(finding => ({ sourceId: item.id, sourceHash: item.sha256, ...finding })));
  const highest = assessed.reduce((result, item) => RANK[item.report.decision.wouldAction] > RANK[result]
    ? item.report.decision.wouldAction : result, 'proceed');
  const relationship = snapshot.canonicalBase?.relationship;
  const scope = relationship?.verified === true && relationship.head === snapshot.head && relationship.base === snapshot.base
    ? { status: relationship.status, evidence: relationship.evidence ?? [] }
    : { status: 'unknown', evidence: [] };
  const origin = snapshot.origin?.exactMatch === true && snapshot.origin.head === snapshot.head &&
      typeof snapshot.origin.sourceUrl === 'string' && /^https?:\/\//.test(snapshot.origin.sourceUrl) &&
      typeof snapshot.origin.licenseEvidence === 'string' && snapshot.origin.licenseEvidence &&
      (snapshot.contents ?? []).some(file => file.sha256 === snapshot.origin.sourceHash)
    ? { status: 'exact-match-evidenced', sourceHash: snapshot.origin.sourceHash,
      sourceUrl: snapshot.origin.sourceUrl, licenseEvidence: snapshot.origin.licenseEvidence }
    : { status: 'unknown' };
  const complete = omissions.length === 0;
  const evidenceManifest = assessed.map(item => ({ sourceId: item.id, sha256: item.sha256, revision: snapshot.head }));
  for (const file of snapshot.contents ?? []) {
    const entry = evidenceManifest.find(item => item.sourceId === `file:${file.path}`);
    if (entry) entry.lineCoverage = file.lineCoverage;
  }
  const proposedAction = options.proposedAction ?? 'read-only-triage';
  const operational = proposedAction !== 'read-only-triage';
  const gate = operational && (!complete || highest !== 'proceed') ? 'manual-review-required'
    : operational ? 'separate-authorization-required' : 'read-only-triage';
  const receipt = { schemaVersion: '1', repository: snapshot.identity?.repository, number: snapshot.identity?.number,
    head: snapshot.head, base: snapshot.base, acquiredAt: snapshot.acquiredAt, completedAt: snapshot.completedAt,
    body: { current: { text: snapshot.body ?? '', sha256: sha(snapshot.body ?? '') },
      history: (collections.bodyHistory?.items ?? []).map(item => ({
        text: item.body ?? '', sha256: sha(item.body ?? ''), at: item.at ?? null, id: item.id ?? null,
        kind: item.kind ?? 'unknown',
      })) },
    collection: Object.fromEntries(COLLECTIONS.map(kind => [kind, {
      pages: collections[kind]?.pages ?? 0, count: collections[kind]?.items?.length ?? 0,
      complete: collections[kind]?.complete === true, sha256: collections[kind]?.sha256 ?? null,
    }])),
    paths: (collections.files?.items ?? []).map(item => ({ path: item.path, status: item.status,
      sourceHash: (snapshot.contents ?? []).find(file => file.path === item.path)?.sha256 ?? null,
      lineCoverage: (snapshot.contents ?? []).find(file => file.path === item.path)?.lineCoverage ?? null,
    })),
    completeness: { complete, omissions }, scopeTriage: scope, maliciousness: { status: 'unestablished', evidence: [] },
    codeOrigin: origin, claims, verified, assessed, activeFindings: active,
    evidenceManifest, nextAction: { proposed: proposedAction, gate, reason: complete ? highest : 'incomplete-evidence' },
    actionTrail: [
      { at: snapshot.acquiredAt, action: 'collect-read-only-evidence', head: snapshot.head, base: snapshot.base },
      { at: snapshot.completedAt, action: 'assess-read-only-evidence', head: snapshot.head,
        result: complete ? 'complete' : 'incomplete', omissionCount: omissions.length },
    ] };
  receipt.sha256 = sha(receipt);
  return receipt;
}
