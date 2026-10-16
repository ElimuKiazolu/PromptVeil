/**
 * Fixed benchmark inputs of about 50, 150 and 300 words, built only from the
 * fictional people in tests/fixtures/identities.json.
 */
const SENTENCES = [
  'Dana Whitfield from New York asked me to forward the signed lease to dana.whitfield@example.com before Friday.',
  'Please call Harriet Pemberton in London on +44 7700 900123 about the board meeting at Pemberton Analytics.',
  'Ananya Venkataraman will travel from Chennai to Mumbai next week and can be reached at ananya.venkataraman@example.net.',
  'Rafael Tavares Moreira joined the São Paulo office of Moreira Logistics and wants the onboarding pack in Portuguese.',
  'Lena Hartmann, who works for the Berlin branch of Hartmann Bau, needs the invoice copied to lena.hartmann@example.org.',
  'Camille Duvernay flew from Paris to Lyon and left her phone number +33 6 12 34 56 78 with the front desk.',
  'Thabo Nkosi manages the Johannesburg depot and reports to the regional director in Cape Town every Monday.',
  'Jun Hao Lim asked whether the Singapore team at Lim Holdings can move the workshop to the Marina Bay venue.',
  'Li Wenhao from Beijing sent the contract draft and asked for comments by email at li.wenhao@example.net.',
  'Marc-Andre Tremblay from Toronto wants a summary of the meeting with Dana Whitfield and Harriet Pemberton.',
];

export const BENCH_WORD_TARGETS = [50, 150, 300] as const;
export type BenchSize = (typeof BENCH_WORD_TARGETS)[number];

export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== '').length;
}

/**
 * Whole sentences, repeated in order, until the text reaches `words`; the
 * last sentence is cut so the count is exact.
 */
export function benchText(words: number): string {
  const out: string[] = [];
  let index = 0;
  while (out.length < words) {
    const sentence = SENTENCES[index % SENTENCES.length] ?? '';
    out.push(...sentence.split(' '));
    index += 1;
  }
  return out.slice(0, words).join(' ');
}

export function benchTexts(): Record<BenchSize, string> {
  return {
    50: benchText(50),
    150: benchText(150),
    300: benchText(300),
  };
}
