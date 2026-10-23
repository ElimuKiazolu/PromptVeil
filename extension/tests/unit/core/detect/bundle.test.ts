import { describe, expect, it } from 'vitest';
import {
  DETECTION_API_VERSION,
  createDetection,
} from '@/src/core/detect/bundle.ts';
import { createCheckpoint, type Yielder } from '@/src/core/detect/schedule.ts';

const immediate: Yielder = { now: () => 0, yieldNow: () => Promise.resolve() };

describe('detection module entry', () => {
  it('has the interface version the content script checks', () => {
    expect(DETECTION_API_VERSION).toBe(1);
  });

  it('detects with the configured types and packs, honouring idPacks', async () => {
    const runtime = createDetection(
      {
        homeRegions: ['GB'],
        preferredRegions: [],
        entityTypes: new Set(['EMAIL', 'NATIONAL_ID']),
        idPacks: { BR: false },
      },
      immediate,
    );
    // UK NI number (common documentation example) and a CPF (python-stdnum
    // example) whose pack is switched off.
    const detections = await runtime.analyse(
      'dana@example.com, NI AB 12 34 56 C, CPF 390.533.447-05',
    );
    expect(detections.map((d) => [d.type, d.subtype])).toEqual([
      ['EMAIL', null],
      ['NATIONAL_ID', 'UK_NINO'],
    ]);
    await runtime.prepare('draft dana@example.com');
    runtime.clear();
    runtime.dispose();
    await expect(runtime.analyse('x')).rejects.toThrow();
  });

  it('warms up through the checkpoint', async () => {
    const runtime = createDetection(
      {
        homeRegions: [],
        preferredRegions: [],
        entityTypes: new Set(['PHONE']),
        idPacks: {},
      },
      immediate,
    );
    let yields = 0;
    let clock = 0;
    await runtime.warmUp(
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
