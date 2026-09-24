export interface ScheduledWork<T> {
  value: T;
  /** Opaque scheduling lane. It is used for fairness and is never emitted. */
  lane: string;
}

/**
 * Lets a running worker give its permit back while it waits on something that
 * is not scheduled work, such as a retry backoff. The worker regains a permit,
 * ahead of work that has not started, before `suspend` resolves.
 */
export interface SchedulerSlot {
  suspend<V>(during: () => Promise<V>): Promise<V>;
}

export class SchedulerWaitError extends Error {
  constructor(readonly reason: 'cancelled' | 'deadline-exceeded') {
    super(`scheduler wait ${reason}`);
  }
}

/**
 * Deterministic-output, round-robin scheduler. Work may complete in any order,
 * but returned slots always match input order. A lane can consume at most one
 * newly assigned permit per round, preventing a busy lane from draining the
 * queue ahead of other eligible lanes.
 */
export async function runBoundedFair<T, R>(
  work: ScheduledWork<T>[],
  concurrency: number,
  worker: (value: T, index: number, slot: SchedulerSlot) => Promise<R>,
  options: { signal?: AbortSignal; deadlineEpochMs?: number; now?: () => number } = {},
): Promise<Array<R | SchedulerWaitError>> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError('scheduler concurrency must be a positive integer');
  const now = options.now ?? Date.now;
  const results = new Array<R | SchedulerWaitError>(work.length);
  const lanes = new Map<string, number[]>();
  const order: string[] = [];
  work.forEach((item, index) => {
    let queue = lanes.get(item.lane);
    if (!queue) { queue = []; lanes.set(item.lane, queue); order.push(item.lane); }
    queue.push(index);
  });
  let cursor = 0;
  let active = 0;
  let remaining = work.length;
  const resuming: Array<() => void> = [];
  if (!remaining) return results;

  return await new Promise((resolve, reject) => {
    const take = (): number | undefined => {
      if (!order.length) return undefined;
      for (let checked = 0; checked < order.length; checked += 1) {
        const position = cursor % order.length;
        cursor = (position + 1) % order.length;
        const queue = lanes.get(order[position]!)!;
        const index = queue.shift();
        if (index !== undefined) return index;
      }
      return undefined;
    };
    const finishWaiting = (): void => {
      const reason = options.signal?.aborted ? 'cancelled' : 'deadline-exceeded';
      let index: number | undefined;
      while ((index = take()) !== undefined) {
        results[index] = new SchedulerWaitError(reason);
        remaining -= 1;
      }
    };
    const slot: SchedulerSlot = {
      suspend: async during => {
        active -= 1;
        pump();
        try {
          return await during();
        } finally {
          // Suspended work re-enters before unstarted work so a backoff cannot be
          // starved. After cancellation or deadline it resumes at once; the worker
          // then observes the interruption and starts no new adapter call.
          await new Promise<void>(resume => {
            if (active < concurrency || interrupted()) { active += 1; resume(); }
            else resuming.push(() => { active += 1; resume(); });
          });
        }
      },
    };
    const interrupted = (): boolean => Boolean(options.signal?.aborted)
      || (options.deadlineEpochMs !== undefined && now() >= options.deadlineEpochMs);
    const pump = (): void => {
      if (interrupted()) {
        finishWaiting();
        while (resuming.length) resuming.shift()!();
      }
      while (active < concurrency && resuming.length) resuming.shift()!();
      while (active < concurrency) {
        const index = take();
        if (index === undefined) break;
        active += 1;
        void worker(work[index]!.value, index, slot).then(
          value => { results[index] = value; },
          error => {
            if (error instanceof SchedulerWaitError) results[index] = error;
            else reject(error);
          },
        ).finally(() => {
          active -= 1;
          remaining -= 1;
          if (remaining === 0) resolve(results);
          else pump();
        });
      }
      if (remaining === 0) resolve(results);
    };
    pump();
  });
}
