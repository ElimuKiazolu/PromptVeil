import { describe, expect, it } from 'vitest';
import {
  derivedNamePairs,
  emailNameParts,
} from '@/src/core/names/email-parts.ts';

// Made-up addresses on reserved domains (RFC 2606).
describe('emailNameParts', () => {
  it('splits a local part at dots, underscores, hyphens and plus signs', () => {
    expect(emailNameParts('lee_park@example.com')).toEqual(['lee', 'park']);
    expect(emailNameParts('lee.park@example.com')).toEqual(['lee', 'park']);
    expect(emailNameParts('lee-park@example.com')).toEqual(['lee', 'park']);
    expect(emailNameParts('Lee.Park+news@example.com')).toEqual([
      'Lee',
      'Park',
      'news',
    ]);
  });

  it('keeps digits (they are removed when pairing) and drops empty pieces', () => {
    expect(emailNameParts('kai_hale92@example.org')).toEqual(['kai', 'hale92']);
    expect(emailNameParts('2024.kai@example.org')).toEqual(['2024', 'kai']);
    expect(emailNameParts('.kai..hale@example.org')).toEqual(['kai', 'hale']);
  });
});

describe('derivedNamePairs', () => {
  it('pairs name-like pieces by position', () => {
    expect(
      derivedNamePairs(['kai', 'hale37'], 'lee_park52@gmail.example.com'),
    ).toEqual([
      { standIn: 'kai', real: 'lee' },
      { standIn: 'hale', real: 'park' },
    ]);
  });

  it('skips different piece counts, short pieces, common words and equal pieces', () => {
    expect(derivedNamePairs(['kai', 'hale'], 'leepark@example.com')).toEqual(
      [],
    );
    expect(derivedNamePairs(['k', 'hale'], 'l.park@example.com')).toEqual([
      { standIn: 'hale', real: 'park' },
    ]);
    expect(
      derivedNamePairs(['info', 'hale'], 'sales.park@example.com'),
    ).toEqual([{ standIn: 'hale', real: 'park' }]);
    expect(derivedNamePairs(['team'], 'team@example.com')).toEqual([]);
    expect(derivedNamePairs(['2024', 'kai'], '1990.lee@example.com')).toEqual([
      { standIn: 'kai', real: 'lee' },
    ]);
  });
});
