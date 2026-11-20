/**
 * Reads a bundled word-list file (public/data/, web-accessible on
 * chatgpt.com with a per-session URL) for the stand-in engine. The files
 * are part of the extension package: nothing is fetched from the network.
 * A missing or unreadable file rejects, which blocks the send.
 */
import type { PublicPath } from 'wxt/browser';

/** Every word-list file; the names are LOCALES' ids and the name index. */
export const WORD_LIST_PATHS = {
  names: '/data/names.json',
  en_US: '/data/en_US.json',
  en_GB: '/data/en_GB.json',
  en_CA: '/data/en_CA.json',
  en_AU: '/data/en_AU.json',
  en_IN: '/data/en_IN.json',
  en_ZA: '/data/en_ZA.json',
  en_NG: '/data/en_NG.json',
  en_SG: '/data/en_SG.json',
  de: '/data/de.json',
  fr: '/data/fr.json',
  es: '/data/es.json',
  es_MX: '/data/es_MX.json',
  it: '/data/it.json',
  pt_BR: '/data/pt_BR.json',
  nl: '/data/nl.json',
  pl: '/data/pl.json',
  sv: '/data/sv.json',
  tr: '/data/tr.json',
  id_ID: '/data/id_ID.json',
  zh_Latn: '/data/zh_Latn.json',
  ru: '/data/ru.json',
  zh_CN: '/data/zh_CN.json',
  ja: '/data/ja.json',
  ko: '/data/ko.json',
  ar: '/data/ar.json',
} as const satisfies Record<string, PublicPath>;

export class WordListLoadError extends Error {
  constructor() {
    super('word-list-load');
    this.name = 'WordListLoadError';
  }
}

function pathOf(name: string): PublicPath | null {
  return Object.hasOwn(WORD_LIST_PATHS, name)
    ? WORD_LIST_PATHS[name as keyof typeof WORD_LIST_PATHS]
    : null;
}

export async function loadWordList(name: string): Promise<unknown> {
  const path = pathOf(name);
  if (path === null) throw new WordListLoadError();
  const response = await fetch(browser.runtime.getURL(path));
  if (!response.ok) throw new WordListLoadError();
  const data: unknown = await response.json();
  return data;
}
