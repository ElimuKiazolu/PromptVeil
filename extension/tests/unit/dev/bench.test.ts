import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countEntities } from '@/src/dev/bench/entities.ts';
import { percentile, summarise } from '@/src/dev/bench/stats.ts';
import { TARGETS, checkTargets } from '@/src/dev/bench/targets.ts';
import {
  BENCH_WORD_TARGETS,
  benchText,
  benchTexts,
  wordCount,
} from '@/src/dev/bench/texts.ts';

describe('benchmark texts', () => {
  it.each(BENCH_WORD_TARGETS)('has exactly %i words', (size) => {
    expect(wordCount(benchTexts()[size])).toBe(size);
  });

  it('is the same every time', () => {
    expect(benchText(300)).toBe(benchText(300));
  });

  it('uses only the fictional identities and example domains', () => {
    const identities = JSON.parse(
      readFileSync(resolve('tests/fixtures/identities.json'), 'utf8'),
    ) as { name: { value: string }; email: { value: string } }[];
    const text = benchText(300);
    const knownEmails = identities.map((i) => i.email.value);
    for (const email of text.match(/\S+@\S+\.[a-z]+/g) ?? []) {
      expect(knownEmails).toContain(email.replace(/[.,]$/, ''));
    }
    const names = identities.map((i) => i.name.value.split(' ')[0] ?? '');
    expect(names.filter((first) => text.includes(first)).length).toBe(
      names.length,
    );
  });
});

describe('percentile and summarise', () => {
  it('uses the nearest rank', () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(10);
    expect(percentile(values, 95)).toBe(19);
    expect(percentile(values, 100)).toBe(20);
    expect(percentile([7], 95)).toBe(7);
  });

  it('does not depend on input order', () => {
    expect(percentile([5, 1, 4, 2, 3], 50)).toBe(3);
  });

  it('rejects empty input and out-of-range percentiles', () => {
    expect(() => percentile([], 50)).toThrow(RangeError);
    expect(() => percentile([1], 101)).toThrow(RangeError);
  });

  it('summarises runs', () => {
    expect(summarise([30, 10, 20])).toEqual({
      runs: 3,
      p50: 20,
      p95: 30,
      min: 10,
      max: 30,
    });
  });
});

describe('countEntities', () => {
  it('counts entities by type from IOB tags', () => {
    expect(
      countEntities([
        { entity: 'B-PER', index: 1 },
        { entity: 'I-PER', index: 2 },
        { entity: 'B-LOC', index: 5 },
        { entity: 'B-PER', index: 8 },
        { entity: 'B-ORG', index: 10 },
        { entity: 'I-ORG', index: 11 },
      ]),
    ).toEqual({ PER: 2, LOC: 1, ORG: 1 });
  });

  it('starts a new entity at an I- tag that does not continue', () => {
    expect(
      countEntities([
        { entity: 'I-PER', index: 3 },
        { entity: 'I-LOC', index: 4 },
        { entity: 'I-LOC', index: 7 },
      ]),
    ).toEqual({ PER: 1, LOC: 2 });
  });

  it('orders tokens by position and ignores other labels', () => {
    expect(
      countEntities([
        { entity: 'I-PER', index: 2 },
        { entity: 'O', index: 3 },
        { entity: 'B-PER', index: 1 },
      ]),
    ).toEqual({ PER: 1 });
  });
});

describe('checkTargets', () => {
  it('passes figures within the targets', () => {
    const checks = checkTargets({
      loadMs: 1200,
      p95At300WordsMs: 900,
      modelBytes: 65_772_734,
      memoryBytes: 200 * 1024 * 1024,
    });
    expect(checks.map((c) => c.pass)).toEqual([true, true, true, true]);
  });

  it('fails figures over the targets', () => {
    const checks = checkTargets({
      loadMs: TARGETS.loadMs + 1,
      p95At300WordsMs: TARGETS.p95At300WordsMs + 1,
      modelBytes: 80 * 1024 * 1024,
      memoryBytes: 400 * 1024 * 1024,
    });
    expect(checks.map((c) => c.pass)).toEqual([false, false, false, false]);
  });

  it('leaves RAM to the Task Manager when the page cannot measure it', () => {
    const ram = checkTargets({
      loadMs: 1,
      p95At300WordsMs: 1,
      modelBytes: 1,
      memoryBytes: null,
    }).at(-1);
    expect(ram?.pass).toBeNull();
    expect(ram?.measured).toContain('Task Manager');
  });
});
