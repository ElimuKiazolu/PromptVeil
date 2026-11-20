/**
 * Reads the cell text of an XLSX workbook's sheets (shared and inline
 * strings, numbers as written), enough for the ONS baby-names tables.
 */
import { readZip, zipEntry, type ZipEntry } from './zip.ts';

export interface Sheet {
  readonly name: string;
  /** Rows of cells; a missing cell is ''. */
  readonly rows: readonly (readonly string[])[];
}

const unescape = (text: string): string =>
  text
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#(\d+);/gu, (_m, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/gu, '&');

/** The text of every <t> element inside `xml`, joined. */
const textOf = (xml: string): string =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/gu)]
    .map((match) => unescape(match[1] ?? ''))
    .join('');

function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/u.exec(reference)?.[0] ?? 'A';
  let index = 0;
  for (const letter of letters)
    index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

const text = (entries: readonly ZipEntry[], name: string): string =>
  zipEntry(entries, name).read().toString('utf8');

export function readXlsx(file: Buffer): Sheet[] {
  const entries = readZip(file);
  const shared = entries.some((entry) => entry.name === 'xl/sharedStrings.xml')
    ? [
        ...text(entries, 'xl/sharedStrings.xml').matchAll(
          /<si>([\s\S]*?)<\/si>/gu,
        ),
      ].map((match) => textOf(match[1] ?? ''))
    : [];
  const relations = new Map(
    [
      ...text(entries, 'xl/_rels/workbook.xml.rels').matchAll(
        /<Relationship\s[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/gu,
      ),
    ].map((match) => [match[1] ?? '', match[2] ?? '']),
  );
  const sheets: Sheet[] = [];
  for (const match of text(entries, 'xl/workbook.xml').matchAll(
    /<sheet\s[^>]*?name="([^"]+)"[^>]*?r:id="([^"]+)"/gu,
  )) {
    const target = relations.get(match[2] ?? '') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    const xml = text(entries, path);
    const rows: string[][] = [];
    for (const row of xml.matchAll(/<row\s[^>]*>([\s\S]*?)<\/row>/gu)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? '').matchAll(
        /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu,
      )) {
        const attributes = cell[1] ?? '';
        const body = cell[2] ?? '';
        const reference = /r="([A-Z]+\d+)"/u.exec(attributes)?.[1] ?? 'A1';
        const type = /t="([^"]+)"/u.exec(attributes)?.[1] ?? 'n';
        const value = /<v>([\s\S]*?)<\/v>/u.exec(body)?.[1] ?? '';
        cells[columnIndex(reference)] =
          type === 's'
            ? (shared[Number(value)] ?? '')
            : type === 'inlineStr'
              ? textOf(body)
              : unescape(value);
      }
      rows.push(Array.from({ length: cells.length }, (_, i) => cells[i] ?? ''));
    }
    sheets.push({ name: unescape(match[1] ?? ''), rows });
  }
  return sheets;
}
