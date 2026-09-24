import { describe, expect, it } from 'vitest';
import { runBoundedFair } from '../../../src/decision/scheduler.js';

/** Barrier-controlled scheduler suite; no clocks, sleeps or external transport. */
describe('CNC deterministic concurrency and ordering contract', () => {
  it.each([1, 2, 3])('CNC-ORDER-%i: limits active 1/N/N+1 tasks and restores input order after reverse completion', async ceiling => {
    const pending = new Map<number, () => void>();
    const started: number[] = [];
    const finished: number[] = [];
    let active = 0;
    let maximum = 0;
    const work = Array.from({ length: ceiling + 1 }, (_, value) => ({ value, lane: `lane-${value}` }));
    const running = runBoundedFair(work, ceiling, async value => {
      active++;
      maximum = Math.max(maximum, active);
      started.push(value);
      await new Promise<void>(resolve => pending.set(value, resolve));
      finished.push(value);
      active--;
      return `item-${value}`;
    });
    expect(started).toEqual(Array.from({ length: ceiling }, (_, index) => index));
    // Release highest in-flight first, forcing the scheduler to admit N+1.
    for (let value = ceiling - 1; value >= 0; value--) {
      pending.get(value)!();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(started).toEqual(Array.from({ length: ceiling + 1 }, (_, index) => index));
    pending.get(ceiling)!();
    expect(await running).toEqual(work.map(item => `item-${item.value}`));
    if (ceiling > 1) expect(finished).not.toEqual(work.map(item => item.value));
    expect(maximum).toBe(ceiling);
  });
});
