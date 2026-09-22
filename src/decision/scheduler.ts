export interface ScheduledWork<T> {
  value: T;
  /** Opaque scheduling lane. It is used for fairness and is never emitted. */
  lane: string;
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
  worker: (value: T, index: number) => Promise<R>,
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
    const pump = (): void => {
      if (options.signal?.aborted || (options.deadlineEpochMs !== undefined && now() >= options.deadlineEpochMs)) finishWaiting();
      while (active < concurrency) {
        const index = take();
        if (index === undefined) break;
        active += 1;
        void worker(work[index]!.value, index).then(
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
