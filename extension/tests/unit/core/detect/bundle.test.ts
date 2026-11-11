import { describe, expect, it } from 'vitest';
import {
  DETECTION_API_VERSION,
  createDetection,
} from '@/src/core/detect/bundle.ts';
import { createCheckpoint, type Yielder } from '@/src/core/detect/schedule.ts';

const immediate: Yielder = { now: () => 0, yieldNow: () => Promise.resolve() };

describe('detection module entry', () => {
  it('has the interface version the content script checks', () => {
    expect(DETECTION_API_VERSION).toBe(3);
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

  it('gives the vault normal form of a detection', async () => {
    const runtime = createDetection(
      {
        homeRegions: ['GB'],
        preferredRegions: [],
        entityTypes: new Set(['EMAIL', 'PHONE']),
        idPacks: {},
      },
      immediate,
    );
    // Ofcom drama range number, written nationally.
    const [email, phone] = await runtime.analyse(
      'Dana.Whitfield@Example.COM or 07400 123456',
    );
    if (email === undefined || phone === undefined) throw new Error('missed');
    expect(runtime.normalise(email)).toBe('dana.whitfield@example.com');
    expect(runtime.normalise(phone)).toBe('+447400123456');
    runtime.dispose();
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

describe('stand-in engine in the detection module', () => {
  it('gives deterministic stand-ins for a seed and attempt', () => {
    const runtime = createDetection(
      {
        homeRegions: [],
        preferredRegions: [],
        entityTypes: new Set(['EMAIL']),
        idPacks: {},
      },
      immediate,
    );
    const request = {
      type: 'EMAIL' as const,
      subtype: null,
      country: null,
      value: 'dana.whitfield@example.com',
      normalised: 'dana.whitfield@example.com',
      dateOffsetDays: 30,
      number: 4,
      now: 0,
    };
    const seed = new Uint8Array(32).fill(7);
    const first = runtime.standIn(request, seed, 0);
    expect(first?.value).toMatch(/^standin\.4\.[a-z0-9]{4}@example\.net$/u);
    expect(runtime.standIn(request, seed, 0)).toEqual(first);
    expect(runtime.standIn(request, seed, 1)?.value).toMatch(/^standin\.5\./u);
  });
});
