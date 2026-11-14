import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PIPELINE_SETTINGS,
  effectiveHomeRegions,
  parsePipelineSettings,
  watchSettings,
  type SettingsChangesLike,
} from '@/src/content/settings.ts';
import { MASKABLE_TYPES } from '@/src/core/pipeline.ts';

type Listener = Parameters<SettingsChangesLike['addListener']>[0];

function changes() {
  const listeners = new Set<Listener>();
  return {
    api: {
      addListener: (listener: Listener) => listeners.add(listener),
      removeListener: (listener: Listener) => listeners.delete(listener),
    } satisfies SettingsChangesLike,
    fire(changed: Record<string, { newValue?: unknown }>, area = 'local') {
      for (const listener of listeners) listener(changed, area);
    },
    count: () => listeners.size,
  };
}

describe('parsePipelineSettings', () => {
  it('defaults to every maskable type and every pack', () => {
    expect([...DEFAULT_PIPELINE_SETTINGS.entityTypes].sort()).toEqual(
      [...MASKABLE_TYPES].sort(),
    );
    expect(DEFAULT_PIPELINE_SETTINGS.idPacks.GB).toBe(true);
    expect(DEFAULT_PIPELINE_SETTINGS.homeRegions).toEqual([]);
  });

  it('switches off only types set to false, and only maskable ones count', () => {
    const settings = parsePipelineSettings({
      entityTypes: { CARD: false, PHONE: true, PERSON: true, SECRET: 'no' },
    });
    expect(settings.entityTypes.has('CARD')).toBe(false);
    expect(settings.entityTypes.has('PHONE')).toBe(true);
    expect(settings.entityTypes.has('SECRET')).toBe(true);
    expect(settings.entityTypes.has('PERSON')).toBe(false);
  });

  it('falls back field by field on malformed values', () => {
    const settings = parsePipelineSettings({
      entityTypes: 'all',
      idPacks: { BR: false, XX: false, GB: 'yes' },
      homeRegions: ['GB', 'nope', 7, 'BR'],
    });
    expect(settings.entityTypes).toEqual(DEFAULT_PIPELINE_SETTINGS.entityTypes);
    expect(settings.idPacks).toEqual({ BR: false });
    expect(settings.homeRegions).toEqual(['GB', 'BR']);
  });

  it('takes home regions from the browser languages until they are set', () => {
    expect(effectiveHomeRegions(DEFAULT_PIPELINE_SETTINGS, ['FR'])).toEqual([
      'FR',
    ]);
    expect(
      effectiveHomeRegions(parsePipelineSettings({ homeRegions: ['IN'] }), [
        'FR',
      ]),
    ).toEqual(['IN']);
  });
});

describe('watchSettings', () => {
  it('reads the stored settings and follows later changes', async () => {
    const events = changes();
    const watcher = watchSettings(
      { get: () => Promise.resolve({ entityTypes: { CARD: false } }) },
      events.api,
    );
    expect((await watcher.ready()).entityTypes.has('CARD')).toBe(false);
    const seen: boolean[] = [];
    watcher.subscribe((settings) => {
      seen.push(settings.entityTypes.has('CARD'));
    });
    events.fire({ entityTypes: { newValue: { CARD: true } } });
    events.fire({ retentionDays: { newValue: 7 } });
    events.fire({ entityTypes: { newValue: { CARD: false } } }, 'sync');
    events.fire({ entityTypes: {} });
    expect(seen).toEqual([true, true]);
    watcher.dispose();
    expect(events.count()).toBe(0);
  });

  it('applies a change made while the first read runs', async () => {
    const events = changes();
    let resolve: (values: Record<string, unknown>) => void = () => undefined;
    const watcher = watchSettings(
      {
        get: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
      events.api,
    );
    events.fire({ idPacks: { newValue: { DE: false } } });
    resolve({ idPacks: { DE: true } });
    expect((await watcher.ready()).idPacks).toEqual({ DE: false });
  });

  it('uses the defaults when the read fails', async () => {
    const watcher = watchSettings(
      { get: () => Promise.reject(new Error('storage unavailable')) },
      changes().api,
    );
    expect(await watcher.ready()).toBe(DEFAULT_PIPELINE_SETTINGS);
  });
});
