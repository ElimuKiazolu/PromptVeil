/** The script a name or other value is written in. */

export type Script =
  'latin' | 'han' | 'japanese' | 'hangul' | 'cyrillic' | 'arabic';

const HANGUL = /\p{Script=Hangul}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAN = /\p{Script=Han}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const ARABIC = /\p{Script=Arabic}/u;

/**
 * The script a value's letters are written in (the first match in this
 * order); Latin when it has no letters of the others.
 */
export function scriptOf(text: string): Script {
  if (HANGUL.test(text)) return 'hangul';
  if (KANA.test(text)) return 'japanese';
  if (HAN.test(text)) return 'han';
  if (CYRILLIC.test(text)) return 'cyrillic';
  if (ARABIC.test(text)) return 'arabic';
  return 'latin';
}
