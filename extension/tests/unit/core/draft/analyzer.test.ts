import { describe, expect, it, vi } from 'vitest';
import {
  DraftAnalyzerDisposedError,
  createDraftAnalyzer,
  type Analyse,
} from '@/src/core/draft/analyzer.ts';
import type { Checkpoint, Yielder } from '@/src/core/detect/schedule.ts';
import {
  clearRuleCaches,
  rulesAnalysis,
  warmUpRules,
} from '@/src/core/detect/rules/analysis.ts';

/** A yielder whose yields wait until the test releases them. */
function manualYielder() {
  let clock = 0;
  const waiting: (() => void)[] = [];
  const yielder: Yielder = {
    // Every reading advances 10 ms, so each checkpoint yields.
    now: () => (clock += 10),
    yieldNow: () =>
      new Promise<void>((resolve) => {
        waiting.push(resolve);
      }),
  };
  const releaseAll = async (): Promise<void> => {
    for (let round = 0; round < 50 && waiting.length > 0; round += 1) {
      for (const resolve of waiting.splice(0)) resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  };
  return { yielder, waiting, releaseAll };
}

/** Upper-cases the text after `steps` checkpoints. */
function steppedAnalysis(steps: number) {
  const calls: string[] = [];
  const analyse: Analyse<string> = async (text, checkpoint: Checkpoint) => {
    calls.push(text);
    for (let i = 0; i < steps; i += 1) {
      const pending = checkpoint();
      if (pending !== undefined) await pending;
    }
    return text.toUpperCase();
  };
  return { analyse, calls };
}

const immediate: Yielder = { now: () => 0, yieldNow: () => Promise.resolve() };

describe('createDraftAnalyzer', () => {
  it('reuses the pre-pass result at Send', async () => {
    const { analyse, calls } = steppedAnalysis(0);
    const analyzer = createDraftAnalyzer({ analyse, yielder: immediate });
    await analyzer.prepare('draft');
    await expect(analyzer.analyse('draft')).resolves.toBe('DRAFT');
    expect(calls).toEqual(['draft']);
  });

  it('joins a pre-pass still running for the same text', async () => {
    const { yielder, releaseAll } = manualYielder();
    const { analyse, calls } = steppedAnalysis(3);
    const analyzer = createDraftAnalyzer({ analyse, yielder });
    void analyzer.prepare('same');
    const send = analyzer.analyse('same');
    await releaseAll();
    await expect(send).resolves.toBe('SAME');
    expect(calls).toEqual(['same']);
  });

  it('cancels an older pre-pass when the draft changes', async () => {
    const { yielder, releaseAll } = manualYielder();
    const { analyse, calls } = steppedAnalysis(3);
    const analyzer = createDraftAnalyzer({ analyse, yielder });
    const first = analyzer.prepare('first');
    const second = analyzer.prepare('second');
    await releaseAll();
    // A cancelled pre-pass ends quietly.
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(calls).toEqual(['first', 'second']);
    // The newer draft is cached; the cancelled one runs again at Send.
    await expect(analyzer.analyse('second')).resolves.toBe('SECOND');
    const send = analyzer.analyse('first');
    await releaseAll();
    await expect(send).resolves.toBe('FIRST');
    expect(calls).toEqual(['first', 'second', 'first']);
  });

  it('never cancels a run a Send is waiting for', async () => {
    const { yielder, releaseAll } = manualYielder();
    const { analyse } = steppedAnalysis(3);
    const analyzer = createDraftAnalyzer({ analyse, yielder });
    void analyzer.prepare('sent');
    const send = analyzer.analyse('sent');
    void analyzer.prepare('typed after send');
    await releaseAll();
    await expect(send).resolves.toBe('SENT');
  });

  it('runs a Send for new text at once', async () => {
    const { analyse, calls } = steppedAnalysis(1);
    const analyzer = createDraftAnalyzer({ analyse, yielder: immediate });
    await expect(analyzer.analyse('new')).resolves.toBe('NEW');
    expect(calls).toEqual(['new']);
  });

  it('keeps a bounded number of results, most recent last out', async () => {
    const { analyse, calls } = steppedAnalysis(0);
    const analyzer = createDraftAnalyzer({
      analyse,
      yielder: immediate,
      cacheSize: 2,
    });
    await analyzer.analyse('a');
    await analyzer.analyse('b');
    await analyzer.analyse('a');
    await analyzer.analyse('c');
    await analyzer.analyse('a');
    await analyzer.analyse('b');
    expect(calls).toEqual(['a', 'b', 'c', 'b']);
  });

  it('passes analysis failures to the Send, and reports them from a pre-pass', async () => {
    const analyzer = createDraftAnalyzer<string>({
      analyse: () => Promise.reject(new Error('rules failed')),
      yielder: immediate,
    });
    await expect(analyzer.analyse('x')).rejects.toThrow('rules failed');
    await expect(analyzer.prepare('y')).rejects.toThrow('rules failed');
  });

  it('clear() forgets results and cancels runs, and calls onClear', async () => {
    const { yielder, releaseAll } = manualYielder();
    const { analyse, calls } = steppedAnalysis(2);
    const onClear = vi.fn();
    const analyzer = createDraftAnalyzer({ analyse, yielder, onClear });
    const send = analyzer.analyse('pending');
    analyzer.clear();
    await releaseAll();
    await expect(send).rejects.toThrow();
    expect(onClear).toHaveBeenCalledTimes(1);
    const fresh = createDraftAnalyzer({ analyse, yielder: immediate, onClear });
    await fresh.analyse('kept');
    fresh.clear();
    await fresh.analyse('kept');
    expect(calls.filter((text) => text === 'kept')).toHaveLength(2);
  });

  it('refuses all work after dispose()', async () => {
    const { analyse } = steppedAnalysis(0);
    const onClear = vi.fn();
    const analyzer = createDraftAnalyzer({
      analyse,
      yielder: immediate,
      onClear,
    });
    analyzer.dispose();
    expect(onClear).toHaveBeenCalledTimes(1);
    await expect(analyzer.analyse('x')).rejects.toBeInstanceOf(
      DraftAnalyzerDisposedError,
    );
    await expect(analyzer.prepare('x')).rejects.toBeInstanceOf(
      DraftAnalyzerDisposedError,
    );
  });
});

describe('rules analysis', () => {
  it('detects with the configured rules through the analyzer', async () => {
    const analyzer = createDraftAnalyzer({
      analyse: rulesAnalysis({
        homeRegions: ['GB'],
        preferredRegions: [],
        entityTypes: new Set(['EMAIL', 'PHONE']),
        packs: [],
      }),
      yielder: immediate,
      onClear: clearRuleCaches,
    });
    const detections = await analyzer.analyse(
      'dana@example.com, 020 7946 0018',
    );
    expect(detections.map((d) => [d.type, d.value])).toEqual([
      ['EMAIL', 'dana@example.com'],
      ['PHONE', '020 7946 0018'],
    ]);
    analyzer.dispose();
  });

  it('warms up in slices', async () => {
    let yields = 0;
    let clock = 0;
    const { createCheckpoint } = await import('@/src/core/detect/schedule.ts');
    await warmUpRules(
      createCheckpoint({
        now: () => (clock += 3),
        yieldNow: () => {
          yields += 1;
          return Promise.resolve();
        },
      }),
    );
    expect(yields).toBeGreaterThan(10);
  });
});
