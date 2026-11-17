import { describe, expect, it } from 'vitest';
import {
  fitsPrompt,
  issueRelations,
  issueStandIns,
  promptView,
  type CommitEntry,
  type IssueVault,
} from '@/src/core/pipeline.ts';
import type { Detection } from '@/src/shared/entities.ts';
import type { MaskItem } from '@/src/shared/vault-protocol.ts';
import { testEngine } from '../word-lists.ts';

// Names and addresses: the fixture identities' and made-up ones.
const item = (type: MaskItem['type'], value: string): MaskItem => ({
  type,
  subtype: null,
  country: null,
  value,
  normalised: value.toLowerCase(),
});

function detection(value: string, start: number, type: Detection['type']) {
  return {
    type,
    subtype: null,
    country: null,
    value,
    start,
    end: start + value.length,
    confidence: 1,
    validated: true,
    source: 'rule' as const,
    status: 'confirmed' as const,
    alternatives: [],
  };
}

/** A vault where every value is new and every stand-in is stored. */
function recordingVault(): IssueVault & { commits: CommitEntry[][] } {
  const commits: CommitEntry[][] = [];
  return {
    commits,
    prepare: (items) =>
      Promise.resolve({
        dateOffsetDays: 30,
        values: items.map((_, index) => ({
          kind: 'new' as const,
          seed: new Uint8Array(32).fill(index + 1),
          number: index + 1,
        })),
      }),
    commit: (entries) => {
      commits.push([...entries]);
      return Promise.resolve({
        values: entries.map((entry) => ({
          kind: 'inserted' as const,
          standIn: entry.standIn,
        })),
        missing: 0,
      });
    },
  };
}

const engine = testEngine();

describe('linked values in one send', () => {
  it('issues persons before their emails and builds the address from the stand-in', async () => {
    const person = item('PERSON', 'Harriet Pemberton');
    const address = item('EMAIL', 'harriet.pemberton@example.org');
    const other = item('EMAIL', 'info@acme.example');
    const items = [address, person, other];
    const text =
      'Harriet Pemberton, harriet.pemberton@example.org, info@acme.example';
    const view = promptView(text, [], items);
    const vault = recordingVault();
    const standIns = await issueStandIns(items, vault, {
      standIn: engine.standIn,
      relations: issueRelations(items, [], view),
      fits: (masked, standIn) => fitsPrompt(view, masked.type, standIn),
      now: 0,
    });
    // Stage 0: the person and the unrelated address; stage 1: the linked one.
    expect(
      vault.commits.map((entries) => entries.map((e) => e.item.value)),
    ).toEqual([[person.value, other.value], [address.value]]);
    const [personStandIn] = standIns.slice(1, 2);
    const [given, family] = (personStandIn ?? '').toLowerCase().split(' ');
    expect(standIns[0]).toBe(
      `${given ?? ''}.${family ?? ''}@${(standIns[0] ?? '').split('@')[1] ?? ''}`,
    );
    const linked = vault.commits[1]?.[0];
    expect(linked?.parent).toBe(personStandIn);
    const stored = vault.commits[0]?.[0];
    expect(stored?.variants).toEqual(personStandIn?.split(' '));
    expect(stored?.locale).toMatch(/^en_/u);
    expect(vault.commits[0]?.[1]?.parent).toBeNull();
  });

  it("links an address to a person from earlier in the conversation, and keeps each real domain's stand-in domain", async () => {
    const issued = [
      {
        type: 'PERSON' as const,
        real: 'Robin Hale',
        standIn: 'Ellis Morgan',
      },
      {
        type: 'EMAIL' as const,
        real: 'office@hale.example',
        standIn: 'office@example.net',
      },
    ];
    const items = [
      item('EMAIL', 'robin.hale@hale.example'),
      item('EMAIL', 'accounts@hale.example'),
      item('EMAIL', 'a.b@other.example'),
      item('EMAIL', 'c.d@other.example'),
    ];
    const view = promptView('', [], items, issued);
    const vault = recordingVault();
    const standIns = await issueStandIns(items, vault, {
      standIn: engine.standIn,
      relations: issueRelations(items, issued, view),
      fits: () => true,
      now: 0,
    });
    expect(standIns[0]).toBe('ellis.morgan@example.net');
    expect(vault.commits[0]?.[0]?.parent).toBe('Ellis Morgan');
    expect(standIns[1]).toMatch(/^accounts@example\.net$/u);
    // Two addresses at one new domain share a stand-in domain.
    expect(standIns[2]?.split('@')[1]).toBe(standIns[3]?.split('@')[1]);
  });
});

describe('name parts and TR-S3', () => {
  const standIn = (value: string, parts: string[]) => ({
    value,
    normalised: value.toLowerCase(),
    reserved: false,
    locale: 'en_GB',
    parts,
  });

  it("refuses a stand-in part equal to a real name's part or a word of the prompt", () => {
    const text =
      'Ask Olivia Grant and Harriet Pemberton about the Hughes file.';
    const items = [
      item('PERSON', 'Olivia Grant'),
      item('PERSON', 'Harriet Pemberton'),
    ];
    const view = promptView(
      text,
      [
        detection('Olivia Grant', 4, 'PERSON'),
        detection('Harriet Pemberton', 21, 'PERSON'),
      ],
      items,
      [{ type: 'PERSON', real: 'Dana Whitfield', standIn: 'Mia Lowe' }],
    );
    const fits = (value: string) =>
      fitsPrompt(view, 'PERSON', standIn(value, value.split(' ')));
    // A real part of another person in the prompt.
    expect(fits('Olivia Hughes')).toBe(false);
    // A word of the rest of the prompt.
    expect(fits('Ellis Hughes')).toBe(false);
    // A real part from earlier in the conversation, and a stand-in's part.
    expect(fits('Dana Morgan')).toBe(false);
    expect(fits('Mia Morgan')).toBe(false);
    expect(fits('Ellis Morgan')).toBe(true);
  });

  it('keeps two stand-ins of one send from sharing a part', async () => {
    const items = [
      item('PERSON', 'Harriet Pemberton'),
      item('PERSON', 'Harriet Hale'),
    ];
    const view = promptView('', [], items);
    const standIns = await issueStandIns(items, recordingVault(), {
      standIn: engine.standIn,
      relations: issueRelations(items, [], view),
      fits: (masked, value) => fitsPrompt(view, masked.type, value),
      now: 0,
    });
    const [a, b] = standIns.map((name) => name.split(' '));
    expect(a?.some((part) => b?.includes(part))).toBe(false);
  });
});
