import { describe, expect, it } from 'vitest';
import { DEFAULT_CONCURRENCY, mapWithConcurrency, sleep } from '../src/blackboard/util.js';

describe('mapWithConcurrency', () => {
  it('preserves input order regardless of completion order', async () => {
    // Later items finish first, so a naive implementation would reorder them.
    const out = await mapWithConcurrency([50, 30, 10, 0], async (ms, i) => {
      await sleep(ms);
      return i;
    });
    expect(out).toEqual([0, 1, 2, 3]);
  });

  it('never exceeds the requested width', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await sleep(5);
        inFlight -= 1;
      },
      3,
    );
    expect(peak).toBeLessThanOrEqual(3);
    expect(inFlight).toBe(0);
  });

  it('runs every item exactly once', async () => {
    const seen: number[] = [];
    await mapWithConcurrency(Array.from({ length: 25 }, (_, i) => i), async (n) => {
      seen.push(n);
    }, 4);
    expect(seen.sort((a, b) => a - b)).toEqual(Array.from({ length: 25 }, (_, i) => i));
  });

  it('is genuinely concurrent, not serialized', async () => {
    const started = Date.now();
    await mapWithConcurrency(Array.from({ length: 8 }, () => 40), (ms) => sleep(ms), 4);
    // Serial would be ~320ms; two waves of four should land far below that.
    expect(Date.now() - started).toBeLessThan(240);
  });

  it('handles an empty list and a width larger than the input', async () => {
    expect(await mapWithConcurrency([], async (x) => x)).toEqual([]);
    expect(await mapWithConcurrency([1, 2], async (x) => x * 2, 99)).toEqual([2, 4]);
  });

  it('propagates a rejection instead of hanging', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });

  it('keeps the default width small enough to stay a personal tool', () => {
    expect(DEFAULT_CONCURRENCY).toBeGreaterThan(1);
    expect(DEFAULT_CONCURRENCY).toBeLessThanOrEqual(6);
  });
});
