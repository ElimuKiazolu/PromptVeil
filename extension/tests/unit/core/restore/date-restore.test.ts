import { describe, expect, it } from 'vitest';
import { createRestoreMatcher } from '@/src/core/restore/matcher.ts';
import type { StandInMapping } from '@/src/core/restore/types.ts';
import { variantsFor } from '@/src/core/restore/variants.ts';

// Fictional dates of birth and their stand-ins.

function mapping(
  standIn: string,
  real: string,
  normalised: string,
  order: string,
): StandInMapping {
  return {
    standIn,
    real,
    boundary: 'word',
    variants: variantsFor('DOB', standIn, normalised, [order]),
  };
}

function restore(mappings: StandInMapping[], text: string): string {
  const matcher = createRestoreMatcher(mappings);
  let out = text;
  for (const found of matcher.find(text).reverse()) {
    out = out.slice(0, found.start) + found.real + out.slice(found.end);
  }
  return out;
}

describe('restoring dates of birth', () => {
  const dmy = mapping('26/04/1990', '12/03/1990', '1990-03-12', 'DMY');

  it('builds date variants only with a stored order', () => {
    expect(dmy.variants).toEqual({
      kind: 'date',
      order: 'DMY',
      standInDate: '1990-04-26',
      realDate: '1990-03-12',
    });
    expect(variantsFor('DOB', '26/04/1990', '1990-03-12')).toBeUndefined();
    expect(variantsFor('DOB', '26/04/1990', '1990-03-12', ['XYZ'])).toBe(
      undefined,
    );
  });

  it.each([
    ['Born 26/04/1990.', 'Born 12/03/1990.'],
    ['Born 26 April 1990.', 'Born 12 March 1990.'],
    ['Born April 26, 1990.', 'Born March 12, 1990.'],
    ['Born 26th April 1990.', 'Born 12th March 1990.'],
    ['Born 1990-04-26.', 'Born 1990-03-12.'],
    ['Born 26.04.90.', 'Born 12.03.90.'],
    ['Born 04/26/1990.', 'Born 03/12/1990.'],
    ['Geboren am 26. April 1990.', 'Geboren am 12. März 1990.'],
    ['Née le 26 avril 1990.', 'Née le 12 mars 1990.'],
    ['Nacida el 26 de abril de 1990.', 'Nacida el 12 de marzo de 1990.'],
    ['1990年4月26日出生', '1990年3月12日出生'],
  ])('restores %s', (reply, restored) => {
    expect(restore([dmy], reply)).toBe(restored);
  });

  it('reads a date that could go either way only in the stand-in order', () => {
    // 5 June 1990 written day first.
    const june = mapping('05/06/1990', '20/04/1990', '1990-04-20', 'DMY');
    expect(restore([june], 'DOB 05/06/1990')).toBe('DOB 20/04/1990');
    expect(restore([june], 'DOB June 5, 1990')).toBe('DOB April 20, 1990');
    // Month first, this would be 6 May: not the stand-in.
    expect(restore([june], 'DOB 06/05/1990')).toBe('DOB 06/05/1990');
    // Month first with a stand-in written month first.
    const may = mapping('06/05/1990', '04/20/1990', '1990-04-20', 'MDY');
    expect(restore([may], 'DOB 06/05/1990')).toBe('DOB 04/20/1990');
    expect(restore([may], 'DOB 5 June 1990')).toBe('DOB 20 April 1990');
  });

  it('leaves other dates and longer numbers alone', () => {
    expect(restore([dmy], 'Due 27/04/1990, ref 126/04/1990')).toBe(
      'Due 27/04/1990, ref 126/04/1990',
    );
  });

  it('counts stand-in dates in any format for the leak check', () => {
    const matcher = createRestoreMatcher([dmy]);
    expect(
      matcher.countOccurrences('26/04/1990 and 26 April 1990 and 1990-04-26'),
    ).toBe(3);
    expect(matcher.countOccurrences('12/03/1990')).toBe(0);
  });
});
