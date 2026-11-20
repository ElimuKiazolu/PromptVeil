/**
 * The open-data credits shipped with the extension
 * (public/licenses/OPEN-DATA-CREDITS.txt), written from opendata/sources.json
 * by npm run generate:wordlists; P10's About page shows them.
 */
import type { Sources } from './sources.ts';

/** The licence text shipped in public/licenses/ for each licence. */
const LICENCE_FILES: Readonly<Record<string, string>> = {
  'Open Government Licence v3.0': 'OGL-3.0.txt',
  'Creative Commons Attribution 4.0 International': 'CC-BY-4.0.txt',
  'Singapore Open Data Licence version 1.0': 'SODL-1.0.txt',
  'Unicode License V3': 'Unicode-3.0.txt',
  'CC0 1.0 Universal (public domain dedication)': 'CC0-1.0.txt',
};

export function creditsText(sources: Sources): string {
  const lines = [
    'Open data in the stand-in word lists',
    '',
    'The names, places and street names PromptVeil uses for stand-ins come from',
    'the sources below. They are selected and shortened (most frequent or most',
    'populous first), not otherwise changed.',
    '',
    'Faker (https://fakerjs.dev): name, company and address lists of every',
    'locale. MIT License, see Faker-MIT.txt.',
  ];
  for (const source of sources.sources) {
    const retrieved = source.files
      .map((file) => file.retrieved ?? '')
      .filter((date) => date !== '')
      .sort()
      .at(-1);
    if (retrieved === undefined) {
      throw new Error(`${source.id} has not been retrieved`);
    }
    const licenceFile = LICENCE_FILES[source.licence];
    if (licenceFile === undefined) {
      throw new Error(`no licence file for ${source.licence}`);
    }
    lines.push(
      '',
      `${source.title}, ${source.publisher}`,
      source.page,
      `Used for: ${source.use}.`,
      `Retrieved: ${retrieved}.`,
      `${source.attribution.replace('{retrieved}', retrieved)}.`,
      `Licence: ${source.licence} (${source.licenceUrl}), see ${licenceFile}.`,
    );
  }
  return `${lines.join('\n')}\n`;
}
