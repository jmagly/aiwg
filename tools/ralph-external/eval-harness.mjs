/**
 * Eval-Harness Runner for External Ralph Loop (LFD Track 3 — #1776)
 *
 * Runs an LFD-style score/lint/probe/status harness against an iteration and
 * produces an EvalHarnessResult. The load-bearing guarantee is **holdout
 * isolation**: the optimizing agent only ever sees VOID-safe, aggregate
 * feedback — never the forbidden fields (holdout case ids/answers, oracle
 * traces, detailed lint findings, fixture membership). Detailed diagnostics
 * are written to a private, non-optimizer-readable path.
 *
 * A lint violation with `void_on_violation` produces status `void`, which the
 * analytics record and best-output selection treat as "not a valid candidate"
 * (excluded unless a human override accepts it) — this is what stops the
 * optimizer from being rewarded for gaming the metric.
 *
 * @implements @agentic/code/frameworks/sdlc-complete/schemas/flows/iteration-analytics.yaml (EvalHarnessContract, EvalHarnessResult)
 * @implements @agentic/code/addons/agent-loop/schemas/iteration-analytics-output.yaml (EvalHarnessResult)
 * @issue #1776 (#1585 Track 3)
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

/**
 * Fields that MUST NEVER reach the optimizing agent. The default set matches
 * the schema's diagnostics_policy.forbidden_optimizer_fields.
 */
export const DEFAULT_FORBIDDEN_OPTIMIZER_FIELDS = [
  'holdout_case_ids',
  'holdout_answers',
  'oracle_traces',
  'detailed_lint_findings',
  'fixture_membership',
];

/**
 * Only these keys are ever allowed in optimizer-visible feedback. Anything a
 * harness instrument emits outside this allowlist is dropped — an allowlist,
 * not a denylist, so a new forbidden field can't leak by omission.
 */
const OPTIMIZER_FEEDBACK_ALLOWLIST = [
  'score',
  'pass_count',
  'total_count',
  'status',
  'void_reason',
];

/**
 * Map an eval-harness status to the analytics verification_status vocabulary.
 * @param {string} status - pass|fail|void|error
 * @returns {'passed'|'failed'|'void'}
 */
export function statusToVerification(status) {
  switch (status) {
    case 'pass': return 'passed';
    case 'void': return 'void';
    case 'fail':
    case 'error':
    default: return 'failed';
  }
}

/**
 * Build the optimizer-visible feedback from a raw instrument payload, stripping
 * every field not on the allowlist. This is the mechanical isolation core —
 * pure and directly testable (#1776 holdout-leakage).
 *
 * @param {Object} raw - Raw aggregate payload from an instrument
 * @param {string[]} [forbidden] - Forbidden field names (for audit)
 * @returns {{feedback: Object, leaked: string[]}} sanitized feedback + any forbidden keys that were present in the raw input
 */
export function buildOptimizerFeedback(raw = {}, forbidden = DEFAULT_FORBIDDEN_OPTIMIZER_FIELDS) {
  const feedback = {};
  for (const key of OPTIMIZER_FEEDBACK_ALLOWLIST) {
    if (raw[key] !== undefined && raw[key] !== null) {
      feedback[key] = raw[key];
    }
  }
  // Audit: which forbidden fields were present in the raw input (they are now
  // stripped, but we record that they were seen so leakage_audit can flag a
  // harness that tried to surface them).
  const leaked = forbidden.filter((f) => raw[f] !== undefined);
  return { feedback, leaked };
}

export class EvalHarness {
  /**
   * @param {Object} contract - EvalHarnessContract (score/lint/probe/status/diagnostics_policy)
   * @param {Object} [opts]
   * @param {string} [opts.workingDir] - CWD for instrument commands
   * @param {string} [opts.executionMode] - 'holdout-isolated' enforces strict isolation
   * @param {Object} [opts.runner] - Injectable command runner {run(cmd,{cwd}) -> {code, stdout}} (tests)
   */
  constructor(contract, opts = {}) {
    this.contract = contract || {};
    this.workingDir = opts.workingDir || process.cwd();
    this.executionMode = opts.executionMode || 'default';
    this.forbiddenFields =
      this.contract.diagnostics_policy?.forbidden_optimizer_fields ||
      DEFAULT_FORBIDDEN_OPTIMIZER_FIELDS;
    // Injectable for tests; defaults to execSync capturing exit code + stdout.
    this._run = opts.runner?.run || ((cmd, o) => {
      try {
        const stdout = execSync(cmd, { cwd: o.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { code: 0, stdout };
      } catch (err) {
        return { code: err.status ?? 1, stdout: (err.stdout || '').toString() + (err.stderr || '').toString() };
      }
    });
  }

  /**
   * Parse an instrument's stdout as JSON when possible, else wrap the raw text.
   * @private
   */
  _parse(stdout) {
    const trimmed = (stdout || '').trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed
        : { raw_text: trimmed };
    } catch {
      return { raw_text: trimmed };
    }
  }

  /**
   * Run the harness for one iteration.
   *
   * @param {Object} params
   * @param {string} params.iterationDir - Directory to write the private diagnostics into
   * @param {boolean} [params.humanOverride=false] - Accept a VOID result as valid (rare, audited)
   * @returns {EvalHarnessResult}
   */
  run({ iterationDir, humanOverride = false } = {}) {
    const raw = {};          // full, private aggregate (never returned to optimizer)
    const privateDiagnostics = { instruments: {} };

    // 1. Lint — a violation VOIDs the iteration when void_on_violation.
    let voided = false;
    let voidReason = null;
    if (this.contract.lint?.command) {
      const r = this._run(this.contract.lint.command, { cwd: this.workingDir });
      const parsed = this._parse(r.stdout);
      privateDiagnostics.instruments.lint = { code: r.code, ...parsed };
      const violated = r.code !== 0 || parsed.violation === true;
      if (violated && this.contract.lint.void_on_violation !== false) {
        voided = true;
        voidReason = parsed.void_reason || 'lint violation';
      }
    }

    // 2. Score — aggregate pass/total/score.
    let scoreError = false;
    if (this.contract.score?.command) {
      const r = this._run(this.contract.score.command, { cwd: this.workingDir });
      const parsed = this._parse(r.stdout);
      privateDiagnostics.instruments.score = { code: r.code, ...parsed };
      scoreError = r.code !== 0 || !this._validScorePayload(parsed);
      if (!scoreError) {
        if (typeof parsed.score === 'number') raw.score = parsed.score;
        if (typeof parsed.pass_count === 'number') raw.pass_count = parsed.pass_count;
        if (typeof parsed.total_count === 'number') raw.total_count = parsed.total_count;
      }
      // Carry through any forbidden fields the harness emitted so the leakage
      // audit can catch a misconfigured harness — they are stripped below.
      for (const f of this.forbiddenFields) {
        if (parsed[f] !== undefined) raw[f] = parsed[f];
      }
    }

    // 3. Probe (optional) — generalization/memorization/integrity signal.
    if (this.contract.probe?.command) {
      const r = this._run(this.contract.probe.command, { cwd: this.workingDir });
      privateDiagnostics.instruments.probe = { code: r.code, ...this._parse(r.stdout) };
    }

    // 4. Status (optional) — burn-rate / best-iteration context (private).
    if (this.contract.status?.command) {
      const r = this._run(this.contract.status.command, { cwd: this.workingDir });
      privateDiagnostics.instruments.status = { code: r.code, ...this._parse(r.stdout) };
    }

    // Determine result status.
    let status;
    if (voided) {
      status = 'void';
      raw.status = 'void';
      raw.void_reason = voidReason;
    } else if (scoreError) {
      status = 'error';
      raw.status = 'error';
    } else if (raw.total_count > 0) {
      status = raw.pass_count === raw.total_count ? 'pass' : 'fail';
    } else if (typeof raw.score === 'number') {
      status = raw.score > 0 ? 'pass' : 'fail';
    } else {
      status = 'error';
    }
    if (!voided) raw.status = status;

    // Build VOID-safe optimizer feedback (strip forbidden + non-allowlisted).
    const { feedback, leaked } = buildOptimizerFeedback(raw, this.forbiddenFields);

    // Write private diagnostics to a non-optimizer-readable path.
    let privateRef = null;
    if (iterationDir) {
      privateRef = this.contract.diagnostics_policy?.private_human
        || join(iterationDir, 'eval-harness-private.json');
      mkdirSync(dirname(privateRef), { recursive: true });
      writeFileSync(privateRef, JSON.stringify(privateDiagnostics, null, 2));
    }

    // Leakage audit: optimizer feedback must contain none of the forbidden
    // fields. `leaked` records forbidden fields the harness emitted (now
    // stripped) — a non-empty list means the harness tried to surface them.
    const feedbackLeaks = this.forbiddenFields.filter((f) => feedback[f] !== undefined);
    const leakageAudit = {
      checked: true,
      result: feedbackLeaks.length === 0 ? 'pass' : 'fail',
    };

    return {
      status,
      optimizer_feedback: feedback,
      private_diagnostics_ref: privateRef,
      leakage_audit: leakageAudit,
      // Non-schema internal fields (harness bookkeeping; safe under
      // additionalProperties). human_override records an accepted VOID.
      human_override: status === 'void' ? humanOverride : false,
      _forbidden_fields_seen: leaked,
    };
  }

  _validScorePayload(parsed) {
    if (!parsed || typeof parsed !== 'object' || typeof parsed.raw_text === 'string') return false;
    const hasScore = parsed.score !== undefined;
    const hasPass = parsed.pass_count !== undefined;
    const hasTotal = parsed.total_count !== undefined;
    if (!hasScore && !hasPass && !hasTotal) return false;
    if (hasScore && (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score) || parsed.score < 0 || parsed.score > 100)) return false;
    if (hasPass !== hasTotal) return false;
    if (hasPass) {
      if (!Number.isInteger(parsed.pass_count) || parsed.pass_count < 0 || !Number.isInteger(parsed.total_count) || parsed.total_count <= 0 || parsed.pass_count > parsed.total_count) return false;
    }
    return true;
  }
}
