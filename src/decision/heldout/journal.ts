import { lstat, mkdir, open, readdir, readFile, realpath, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { heldoutDigest, HeldoutError, heldoutRequest, heldoutReservationMicros, heldoutReservationTokens, validateHeldoutAttempt, validateHeldoutBundle, checkHeldoutSchema, HELDOUT_CAP_USD, HELDOUT_PORTFOLIO_CAP_USD } from './contract.js';
import type { Digest, HeldoutApproval, HeldoutAttempt, HeldoutBundle, HeldoutEvent, HeldoutSummary } from './types.js';

export const heldoutRunsRoot = (root: string): string => join(root, 'research', 'qualification', 'heldout', 'runs');
const baselineRoot = (root: string): string => join(root, 'research', 'qualification', 'heldout', 'baselines');
interface HeldoutBaseline {
  schemaVersion: 'decision-heldout-baseline/v1'; scope: string; usdMicros: number; approvalDigest: Digest; counterGenesisDigest: Digest;
  budget: HeldoutApproval['budget'] | null;
}
const counterRoot = (root: string): string => dirname(heldoutRunsRoot(root));
interface SpendCharge {
  study: string; runId: string; rowId: string; requestId: string; ordinal: number;
  reservedUsdMicros: number; reservedTokens: number; accountedUsdMicros: number | null;
  disposition: NonNullable<HeldoutAttempt['result']>['disposition'] | null;
}
interface SpendEvent {
  schemaVersion: 'decision-heldout-spend-event/v1'; sequence: number; previous: Digest | null;
  charge: SpendCharge | null; totalUsdMicros: number; digest: Digest;
}
interface SpendCounter { events: SpendEvent[]; studies: Map<string, number>; blocked: boolean }
const chargeKey = (charge: SpendCharge) => `${charge.study}/${charge.runId}/${charge.rowId}/${charge.requestId}/${charge.ordinal}`;
const repair = () => new HeldoutError('spend-counter-operator-repair-required');
const baselineDigests = (baselines: Map<string, HeldoutBaseline>): Record<string, Digest> =>
  Object.fromEntries([...baselines].map(([scope, baseline]) => [scope, heldoutDigest(baseline)]));
async function counterHead(root: string, event: SpendEvent, baselines: Map<string, HeldoutBaseline>): Promise<void> {
  const dir = counterRoot(root), temporary = join(dir, 'spend-head.next.json');
  const head = { schemaVersion: 'decision-heldout-spend-head/v2', sequence: event.sequence, digest: event.digest,
    baselineDigests: baselineDigests(baselines) };
  checkHeldoutSchema('SpendHead', head);
  await writeHeldoutFile(temporary, head);
  await rename(temporary, join(dir, 'spend-head.json'));
  const directory = await open(dir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
/** The independent head binds baselines and detects valid-prefix truncation after all run files disappear. */
async function readCounter(root: string, baselines: Map<string, HeldoutBaseline>): Promise<SpendCounter> {
  const dir = counterRoot(root), path = join(dir, 'spend-counter.jsonl');
  const names = await readdir(dir);
  if (!names.includes('spend-counter.jsonl') && !baselines.size && !names.includes('spend-head.json')
    && !names.includes('spend-head.next.json')) return { events: [], studies: new Map(), blocked: false };
  try {
    if (names.includes('spend-head.next.json')) throw repair();
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_000_000) throw repair();
    const bytes = await readFile(path, 'utf8');
    if (!bytes.endsWith('\n')) throw repair();
    const events: SpendEvent[] = [], studies = new Map<string, number>(), latest = new Map<string, SpendCharge>();
    let total = 0;
    for (const line of bytes.slice(0, -1).split('\n')) {
      const event = JSON.parse(line) as SpendEvent;
      checkHeldoutSchema('SpendEvent', event);
      const { digest, ...payload } = event;
      if (event.sequence !== events.length + 1 || event.previous !== (events.at(-1)?.digest ?? null)
        || digest !== heldoutDigest(payload) || (events.length === 0) !== (event.charge === null)) throw repair();
      const charge = event.charge;
      if (charge) {
        const key = chargeKey(charge), prior = latest.get(key);
        if (charge.accountedUsdMicros === null ? prior || charge.disposition !== null
          : !prior || prior.accountedUsdMicros !== null || charge.disposition === null
            || charge.reservedTokens !== prior.reservedTokens || charge.reservedUsdMicros !== prior.reservedUsdMicros || charge.accountedUsdMicros < charge.reservedUsdMicros) throw repair();
        const delta = charge.accountedUsdMicros === null ? charge.reservedUsdMicros : charge.accountedUsdMicros - charge.reservedUsdMicros;
        total += delta; studies.set(charge.study, (studies.get(charge.study) ?? 0) + delta); latest.set(key, charge);
      }
      if (event.totalUsdMicros !== total || !Number.isSafeInteger(total)) throw repair();
      events.push(event);
    }
    const head = await readHeldoutFile(join(dir, 'spend-head.json')) as { sequence: number; digest: Digest; baselineDigests: Record<string, Digest> };
    checkHeldoutSchema('SpendHead', head);
    if (head.sequence !== events.length || head.digest !== events.at(-1)?.digest
      || heldoutDigest(head.baselineDigests) !== heldoutDigest(baselineDigests(baselines))
      || [...baselines.values()].some(b => b.counterGenesisDigest !== events[0].digest)) throw repair();
    if (!baselines.has('portfolio') || [...studies.keys()].some(study => !baselines.has(study))) throw repair();
    return { events, studies, blocked: [...latest.values()].some(c => c.disposition === null || c.disposition === 'stop') };
  } catch { throw repair(); }
}
/** Caller holds the global dispatch lock. Never rewrite or refund a counter entry. */
export async function appendHeldoutSpend(root: string, attempt: HeldoutAttempt): Promise<void> {
  const baselines = await readBaselines(root), counter = await readCounter(root, baselines);
  const charge: SpendCharge = { study: attempt.study, runId: attempt.runId, rowId: attempt.rowId, requestId: attempt.requestId,
    ordinal: attempt.ordinal, reservedUsdMicros: attempt.reservedUsdMicros, reservedTokens: attempt.reservedTokens,
    accountedUsdMicros: attempt.result?.accountedUsdMicros ?? null, disposition: attempt.result?.disposition ?? null };
  validateHeldoutAttempt(attempt);
  const prior = [...counter.events].reverse().find(event => event.charge && chargeKey(event.charge) === chargeKey(charge))?.charge;
  if (attempt.result ? !prior || prior.accountedUsdMicros !== null || prior.reservedUsdMicros !== charge.reservedUsdMicros || prior.reservedTokens !== charge.reservedTokens
    || attempt.result.accountedUsdMicros < attempt.reservedUsdMicros : prior) throw repair();
  const delta = attempt.result ? attempt.result.accountedUsdMicros - attempt.reservedUsdMicros : attempt.reservedUsdMicros;
  const payload = { schemaVersion: 'decision-heldout-spend-event/v1' as const, sequence: counter.events.length + 1,
    previous: counter.events.at(-1)!.digest, charge, totalUsdMicros: counter.events.at(-1)!.totalUsdMicros + delta };
  const event: SpendEvent = { ...payload, digest: heldoutDigest(payload) };
  checkHeldoutSchema('SpendEvent', event);
  const file = await open(join(counterRoot(root), 'spend-counter.jsonl'), 'a');
  try { await file.writeFile(JSON.stringify(event) + '\n'); await file.sync(); } finally { await file.close(); }
  await counterHead(root, event, baselines);
}
async function readBaselines(root: string): Promise<Map<string, HeldoutBaseline>> {
  await heldoutDirectory(baselineRoot(root));
  const baselines = new Map<string, HeldoutBaseline>();
  for (const name of await readdir(baselineRoot(root))) {
    const baseline = await readHeldoutFile(join(baselineRoot(root), name)) as HeldoutBaseline;
    checkHeldoutSchema('Baseline', baseline);
    if (name !== `${baseline.scope}.json`) throw new HeldoutError('baseline-path');
    baselines.set(baseline.scope, baseline);
  }
  return baselines;
}
function checkBaselineApproval(baselines: Map<string, HeldoutBaseline>, approval: HeldoutApproval): void {
  for (const [scope, usd] of [[approval.study, approval.priorStudySpendUsd], ['portfolio', approval.priorPortfolioSpendUsd]] as const) {
    if (baselines.has(scope) && baselines.get(scope)!.usdMicros !== Math.ceil(usd * 1_000_000)) throw new HeldoutError('baseline-changed');
  }
  const study = baselines.get(approval.study);
  if (study && heldoutDigest(study.budget) !== heldoutDigest(approval.budget)) throw new HeldoutError('budget-changed');
}
/** Called under the global dispatch lock, after checking existing journals. Floors and study budgets are recorded once. */
export async function reconcileHeldoutBaseline(root: string, approval: HeldoutApproval): Promise<{ study: Digest; portfolio: Digest }> {
  const baselines = await readBaselines(root);
  const counter = await readCounter(root, baselines);
  checkBaselineApproval(baselines, approval);
  let head = counter.events.at(-1);
  if (!head) {
    const payload = { schemaVersion: 'decision-heldout-spend-event/v1' as const, sequence: 1, previous: null, charge: null, totalUsdMicros: 0 };
    head = { ...payload, digest: heldoutDigest(payload) };
    await writeHeldoutFile(join(counterRoot(root), 'spend-counter.jsonl'), head);
  }
  const genesis = counter.events[0]?.digest ?? head.digest;
  let changed = false;
  for (const [scope, usd] of [[approval.study, approval.priorStudySpendUsd], ['portfolio', approval.priorPortfolioSpendUsd]] as const) {
    const usdMicros = Math.ceil(usd * 1_000_000), baseline = baselines.get(scope);
    if (!baseline) {
      const recorded: HeldoutBaseline = { schemaVersion: 'decision-heldout-baseline/v1', scope, usdMicros,
        approvalDigest: heldoutDigest(approval), counterGenesisDigest: genesis, budget: scope === 'portfolio' ? null : approval.budget };
      await writeHeldoutFile(join(baselineRoot(root), `${scope}.json`), recorded);
      baselines.set(scope, recorded); changed = true;
    }
  }
  // Publish only after every baseline is durable. A partial update fails closed on the next read.
  if (changed) await counterHead(root, head, baselines);
  const recorded = await readBaselines(root);
  return { study: heldoutDigest(recorded.get(approval.study)!), portfolio: heldoutDigest(recorded.get('portfolio')!) };
}
/** Reject symlinked journal ancestors as well as leaves: spend cannot be redirected to another root. */
export async function heldoutDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (await realpath(path) !== resolve(path)) throw new HeldoutError('artifact-symlink');
}
export async function writeHeldoutFile(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  const directory = await open(dirname(path), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
export async function readHeldoutFile(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_000_000) throw new HeldoutError('artifact-file');
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}
export async function readHeldoutJournal(run: string): Promise<HeldoutEvent[]> {
  if (await realpath(run) !== resolve(run)) throw new HeldoutError('artifact-symlink');
  const entries = (await readdir(run)).filter(name => /^\d{8}\.json$/.test(name)).sort();
  const events: HeldoutEvent[] = [];
  const pending = new Map<string, HeldoutAttempt>();
  const seen = new Set<string>();
  for (const name of entries) {
    const event = await readHeldoutFile(join(run, name)) as HeldoutEvent;
    checkHeldoutSchema('Event', event);
    const { digest, ...payload } = event;
    if (Object.keys(event).sort().join(',') !== 'attempt,digest,previous,schemaVersion,sequence'
      || event.sequence !== events.length + 1 || name !== `${String(event.sequence).padStart(8, '0')}.json`
      || event.previous !== (events.at(-1)?.digest ?? null) || digest !== heldoutDigest(payload)) throw new HeldoutError('journal-chain');
    validateHeldoutAttempt(event.attempt);
    const attempt = event.attempt, key = `${attempt.rowId}/${attempt.requestId}/${attempt.ordinal}`;
    if (!attempt.result) {
      if (seen.has(key)) throw new HeldoutError('duplicate-reservation');
      seen.add(key);
      pending.set(key, attempt);
    } else {
      const reservation = pending.get(key);
      if (!reservation || heldoutDigest({ ...attempt, result: null }) !== heldoutDigest(reservation)) throw new HeldoutError('unreserved-result');
      pending.delete(key);
      const trace = await readHeldoutFile(join(run, `trace-${event.sequence - 1}.json`));
      if (heldoutDigest(trace) !== attempt.result.traceDigest) throw new HeldoutError('trace-digest');
    }
    events.push(event);
  }
  return events;
}
export async function appendHeldoutEvent(run: string, events: HeldoutEvent[], attempt: HeldoutAttempt): Promise<void> {
  validateHeldoutAttempt(attempt);
  const payload = { schemaVersion: 'decision-heldout-event/v1' as const, sequence: events.length + 1, previous: events.at(-1)?.digest ?? null, attempt: structuredClone(attempt) };
  const event: HeldoutEvent = { ...payload, digest: heldoutDigest(payload) };
  await writeHeldoutFile(join(run, `${String(event.sequence).padStart(8, '0')}.json`), event);
  events.push(event);
}
export interface HeldoutPriorRun { runId: string; evidenceDigest: Digest; corpusDigest: Digest; study: string; source: 'injected-transport' | 'provider' }
export async function heldoutEvidenceDigest(run: string, events: HeldoutEvent[]): Promise<Digest> {
  return heldoutDigest({ frozenDigest: heldoutDigest(await readHeldoutFile(join(run, 'frozen.json'))),
    journalDigest: events.at(-1)?.digest ?? heldoutDigest([]) });
}
export interface HeldoutScan {
  studyUsdMicros: number; portfolioUsdMicros: number; studyCalls: number; studyReservedTokens: number; counterBlocked: boolean; attempts: HeldoutAttempt[]; journalDigests: Digest[]; runs: HeldoutPriorRun[];
}
/** Count reservations, including crashes and failed requests; successful small usage never refunds spend. */
export async function scanHeldoutSpend(root: string, study: string, approval?: HeldoutApproval): Promise<HeldoutScan> {
  const runs = heldoutRunsRoot(root);
  await heldoutDirectory(runs);
  const baselines = await readBaselines(root);
  if (approval) {
    if (approval.study !== study) throw new HeldoutError('baseline-study');
    checkBaselineApproval(baselines, approval);
  }
  const counter = await readCounter(root, baselines);
  const result: HeldoutScan = { studyUsdMicros: baselines.get(study)?.usdMicros ?? 0,
    portfolioUsdMicros: baselines.get('portfolio')?.usdMicros ?? 0, studyCalls: 0, studyReservedTokens: 0, counterBlocked: counter.blocked, attempts: [], journalDigests: [], runs: [] };
  for (const { charge } of counter.events) if (charge?.study === study && charge.accountedUsdMicros === null) {
    result.studyCalls++; result.studyReservedTokens += charge.reservedTokens;
  }
  for (const name of (await readdir(runs)).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new HeldoutError('run-path');
    const run = join(runs, name);
    const frozen = await readHeldoutFile(join(run, 'frozen.json')) as { approval: { runId: string; study: string }; digest: Digest;
      bundle: HeldoutBundle; baselineDigests: { study: Digest; portfolio: Digest }; priorRuns: HeldoutPriorRun[]; source: 'injected-transport' | 'provider' };
    checkHeldoutSchema('Frozen', frozen);
    if (frozen.approval?.runId !== name || !['D17', 'D29'].includes(frozen.approval.study)
      || frozen.digest !== heldoutDigest(frozen.bundle)) throw new HeldoutError('frozen-inputs');
    validateHeldoutBundle(frozen.bundle, heldoutDigest(frozen.bundle.approval));
    const approval = frozen.bundle.approval;
    if (baselines.get(approval.study)?.usdMicros !== Math.ceil(approval.priorStudySpendUsd * 1_000_000)
      || baselines.get('portfolio')?.usdMicros !== Math.ceil(approval.priorPortfolioSpendUsd * 1_000_000)) throw new HeldoutError('baseline-mismatch');
    if (frozen.baselineDigests.study !== heldoutDigest(baselines.get(approval.study)!)
      || frozen.baselineDigests.portfolio !== heldoutDigest(baselines.get('portfolio')!)) throw new HeldoutError('baseline-mismatch');
    if (frozen.bundle.approval.runId !== name || frozen.bundle.approval.study !== frozen.approval.study) throw new HeldoutError('frozen-run');
    for (const prior of frozen.priorRuns) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(prior.runId) || prior.runId === name) throw new HeldoutError('prior-run');
      const path = join(runs, prior.runId);
      if (await heldoutEvidenceDigest(path, await readHeldoutJournal(path)) !== prior.evidenceDigest) throw new HeldoutError('prior-evidence');
    }
    const events = await readHeldoutJournal(run);
    await validateHeldoutJournal(frozen.bundle, events);
    if ((await readdir(run)).includes('summary.json')) {
      const summary = await readHeldoutFile(join(run, 'summary.json')) as HeldoutSummary;
      checkHeldoutSchema('Summary', summary);
      if (summary.evidenceDigest !== await heldoutEvidenceDigest(run, events)) throw new HeldoutError('truncated-journal');
    }
    result.runs.push({ runId: name, evidenceDigest: await heldoutEvidenceDigest(run, events), corpusDigest: frozen.bundle.approval.corpusDigest, study: frozen.approval.study, source: frozen.source });
    const latest = new Map<string, HeldoutAttempt>();
    for (const { attempt } of events) {
      if (attempt.runId !== name || attempt.study !== frozen.approval.study) throw new HeldoutError('journal-run');
      const key = `${attempt.rowId}/${attempt.requestId}/${attempt.ordinal}`;
      if (!attempt.result) {
        result.portfolioUsdMicros += attempt.reservedUsdMicros;
        if (attempt.study === study) result.studyUsdMicros += attempt.reservedUsdMicros;
      } else {
        if (attempt.result.accountedUsdMicros < attempt.reservedUsdMicros) throw new HeldoutError('reservation-refund');
        const extra = attempt.result.accountedUsdMicros - attempt.reservedUsdMicros;
        result.portfolioUsdMicros += extra;
        if (attempt.study === study) result.studyUsdMicros += extra;
      }
      latest.set(key, attempt);
    }
    result.attempts.push(...latest.values());
    if (events.length) result.journalDigests.push(events.at(-1)!.digest);
  }
  result.studyUsdMicros = Math.max(result.studyUsdMicros, (baselines.get(study)?.usdMicros ?? 0) + (counter.studies.get(study) ?? 0));
  result.portfolioUsdMicros = Math.max(result.portfolioUsdMicros, (baselines.get('portfolio')?.usdMicros ?? 0) + (counter.events.at(-1)?.totalUsdMicros ?? 0));
  // A first-run preview includes its proposed baseline without writing it or reusing a max floor.
  if (approval && !baselines.has(study)) result.studyUsdMicros += Math.ceil(approval.priorStudySpendUsd * 1_000_000);
  if (approval && !baselines.has('portfolio')) result.portfolioUsdMicros += Math.ceil(approval.priorPortfolioSpendUsd * 1_000_000);
  return result;
}

/** Replay enforces the same membership, phase and reservation pins as dispatch. */
export async function validateHeldoutJournal(bundle: HeldoutBundle, events: readonly HeldoutEvent[]): Promise<void> {
  for (const { attempt } of events) {
    if (attempt.runId !== bundle.approval.runId || attempt.study !== bundle.approval.study) throw new HeldoutError('journal-run');
    const approved = bundle.approval;
    const row = bundle.corpus.rows.find(row => row.id === attempt.rowId);
    const request = row?.requests.find(request => request.id === attempt.requestId);
    if (!row || !request) throw new HeldoutError('journal-pins');
    const planned = await heldoutRequest(bundle.corpus, bundle.preregistration, approved, row, request);
    if (attempt.corpusDigest !== approved.corpusDigest || attempt.preregistrationDigest !== approved.preregistrationDigest
      || attempt.approvalDigest !== heldoutDigest(approved) || attempt.requestDigest !== planned.requestDigest
      || attempt.reservedUsdMicros !== heldoutReservationMicros(approved, planned.estimatedTokens)
      || attempt.reservedTokens !== heldoutReservationTokens(bundle.preregistration, planned.estimatedTokens)) throw new HeldoutError('journal-pins');
  }
}
/** Every mode shares fixed thresholds; admission checks the approval against its durable study baseline. */
export function heldoutCollectionAllowance(approval: HeldoutApproval, prior: HeldoutScan) {
  const studyRemaining = HELDOUT_CAP_USD[approval.study] * 1_000_000 - prior.studyUsdMicros;
  const portfolioRemaining = HELDOUT_PORTFOLIO_CAP_USD * 1_000_000 - prior.portfolioUsdMicros;
  const studySpent = prior.studyUsdMicros - Math.ceil(approval.priorStudySpendUsd * 1_000_000);
  const portfolioSpent = prior.portfolioUsdMicros - Math.ceil(approval.priorPortfolioSpendUsd * 1_000_000);
  return { calls: Math.floor(approval.budget.calls * 0.8) - prior.studyCalls,
    tokens: Math.floor(approval.budget.tokens * 0.8) - prior.studyReservedTokens,
    usdMicros: Math.min(Math.floor(approval.budget.usd * 800_000) - studySpent,
      Math.floor((studyRemaining + studySpent) * 0.8) - studySpent,
      Math.floor((portfolioRemaining + portfolioSpent) * 0.8) - portfolioSpent) };
}
