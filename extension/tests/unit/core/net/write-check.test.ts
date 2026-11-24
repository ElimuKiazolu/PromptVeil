import { describe, expect, it, vi } from 'vitest';
import { createDetection } from '@/src/core/detect/bundle.ts';
import type { Yielder } from '@/src/core/detect/schedule.ts';
import {
  checkUserTexts,
  CONTEXT_CHARS,
  paragraphWindows,
} from '@/src/core/net/write-check.ts';
import { needsMasking } from '@/src/core/pipeline.ts';
import type { Detection, EntityType } from '@/src/shared/entities.ts';

const immediate: Yielder = { now: () => 0, yieldNow: () => Promise.resolve() };

const TYPES = new Set<EntityType>([
  'EMAIL',
  'PHONE',
  'CARD',
  'BANK',
  'SECRET',
  'NATIONAL_ID',
  'IP',
  'CRYPTO',
  'DOB',
]);

function runtime() {
  return createDetection(
    {
      homeRegions: ['GB'],
      preferredRegions: [],
      entityTypes: TYPES,
      idPacks: {},
      keepCity: true,
      maskPrivateIps: false,
    },
    immediate,
  );
}

function checker(issued: readonly string[] = []) {
  const detection = runtime();
  const scan = vi.fn((text: string) => detection.scan(text));
  return {
    scan,
    check: (texts: readonly string[]) =>
      checkUserTexts(texts, {
        scan,
        needsMasking: (found: Detection) =>
          needsMasking(found, TYPES, (value) => issued.includes(value)),
        isMaskedType: (found: Detection) => TYPES.has(found.type),
      }),
  };
}

describe('paragraphWindows', () => {
  it('splits at blank lines and keeps context on both sides', () => {
    const first = 'a'.repeat(100);
    const second = 'b'.repeat(10);
    const windows = paragraphWindows(`${first}\n\n${second}\n \n\nc`);
    expect(windows).toHaveLength(3);
    const [one, two] = windows;
    if (one === undefined || two === undefined) throw new Error('missing');
    expect(one.text.slice(one.start, one.end)).toBe(first);
    expect(two.text.slice(two.start, two.end)).toBe(second);
    // The second keeps CONTEXT_CHARS of the text before it.
    expect(two.start).toBe(CONTEXT_CHARS);
    expect(two.text.slice(0, two.start)).toBe(
      `${first}\n\n`.slice(-CONTEXT_CHARS),
    );
  });

  it('gives one window for text without blank lines', () => {
    expect(paragraphWindows('one\ntwo')).toEqual([
      { text: 'one\ntwo', start: 0, end: 7 },
    ]);
    expect(paragraphWindows('')).toEqual([]);
  });
});

describe('checkUserTexts', () => {
  it('blocks a confirmed value that is not a stand-in', async () => {
    const { check } = checker();
    // Ofcom drama number (format example), NINO and IBAN documentation examples.
    for (const text of [
      'Write to sam_lee@example.com about it',
      'Call me on 07400 123456 tomorrow',
      'My NI number is AB 12 34 56 C',
      'IBAN GB82 WEST 1234 5698 7654 32',
    ]) {
      expect(await check([text])).toMatchObject({ block: true, possible: 0 });
    }
  });

  it('counts the blocking values by kind, each distinct value once', async () => {
    const { check } = checker(['olivia.hughes@example.net']);
    const result = await check([
      'Write to sam_lee@example.com or ops@example.org.\n\nAgain: sam_lee@example.com',
      'Call 07400 123456, NI AB 12 34 56 C, olivia.hughes@example.net',
    ]);
    expect(result.items).toEqual([
      { type: 'EMAIL', subtype: null, count: 2 },
      { type: 'PHONE', subtype: null, count: 1 },
      { type: 'NATIONAL_ID', subtype: 'UK_NINO', count: 1 },
    ]);
  });

  it('passes text with no personal data, and issued stand-ins', async () => {
    const { check } = checker(['olivia.hughes@example.net']);
    expect(await check(['Dear team, the plan is below.'])).toEqual({
      block: false,
      possible: 0,
      items: [],
    });
    expect(await check(['Reply to olivia.hughes@example.net'])).toEqual({
      block: false,
      possible: 0,
      items: [],
    });
  });

  it('counts "possible" values without blocking', async () => {
    const { check } = checker();
    // A bare digit run valid only as a foreign number (home GB) is possible:
    // libphonenumber's French mobile example.
    expect(await check(['see 0612345678 later'])).toEqual({
      block: false,
      possible: 1,
      items: [],
    });
  });

  it('keeps context across a paragraph boundary', async () => {
    const { check } = checker();
    // A date of birth needs its birth word, here in the paragraph before it
    // (the P5.4 spec example).
    expect(await check(['Date of birth:\n\n14/07/1986'])).toEqual({
      block: true,
      possible: 0,
      items: [{ type: 'DOB', subtype: null, count: 1 }],
    });
    expect(await check(['Meeting 14/07/1986'])).toEqual({
      block: false,
      possible: 0,
      items: [],
    });
  });

  it('changes only the edited paragraph windows, so the rest is cached', async () => {
    const { check, scan } = checker();
    const paragraphs = Array.from({ length: 12 }, (_v, i) =>
      `Paragraph ${String(i)} of a long document. `.repeat(4),
    );
    await check([paragraphs.join('\n\n')]);
    const before = new Set(scan.mock.calls.map(([text]) => text));
    expect(before.size).toBe(12);
    paragraphs[5] = `${paragraphs[5] ?? ''}x`;
    scan.mockClear();
    await check([paragraphs.join('\n\n')]);
    const changed = scan.mock.calls.filter(([text]) => !before.has(text));
    // The edited paragraph and its neighbours' context windows.
    expect(changed.length).toBeLessThanOrEqual(3);
  });

  it('counts a value once, in the paragraph it starts in', async () => {
    const detections: Detection[] = [];
    const scan = vi.fn(() => Promise.resolve(detections));
    const result = await checkUserTexts(['a\n\nb'], {
      scan,
      needsMasking: () => true,
      isMaskedType: () => true,
    });
    expect(result).toEqual({ block: false, possible: 0, items: [] });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('rejects when the scanner fails (the caller blocks)', async () => {
    await expect(
      checkUserTexts(['text'], {
        scan: () => Promise.reject(new Error('down')),
        needsMasking: () => false,
        isMaskedType: () => false,
      }),
    ).rejects.toThrow('down');
  });

  it('costs little per keystroke on a long saved document', async () => {
    const { check } = checker();
    const paragraphs = Array.from({ length: 20 }, (_v, i) =>
      `Section ${String(i)}: the quarterly figures and next steps for the team. `.repeat(
        3,
      ),
    );
    await check([paragraphs.join('\n\n')]);
    const timings: number[] = [];
    for (let k = 0; k < 20; k += 1) {
      paragraphs[k % 20] = `${paragraphs[k % 20] ?? ''}${String(k)}`;
      const started = performance.now();
      await check([paragraphs.join('\n\n')]);
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    const median = timings[10] ?? Infinity;
    // Generous bound for CI; the measured value is reported in the summary.
    expect(median).toBeLessThan(50);
  });
});
