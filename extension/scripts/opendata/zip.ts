/**
 * A small ZIP reader for the open-data downloads (stored and deflated
 * entries, no ZIP64): enough for GeoNames, OS Open Names, Unihan and XLSX
 * files, without a dependency.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  read(): Buffer;
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

export function readZip(zip: Buffer): ZipEntry[] {
  let end = -1;
  for (
    let at = zip.length - 22;
    at >= Math.max(0, zip.length - 65_557);
    at -= 1
  ) {
    if (zip.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(at) !== DIRECTORY_ENTRY) {
      throw new Error('bad zip directory');
    }
    const method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    entries.push({
      name,
      read() {
        if (zip.readUInt32LE(local) !== LOCAL_HEADER) {
          throw new Error(`bad zip entry ${name}`);
        }
        const start =
          local +
          30 +
          zip.readUInt16LE(local + 26) +
          zip.readUInt16LE(local + 28);
        const data = zip.subarray(start, start + compressed);
        if (method === 0) return Buffer.from(data);
        if (method === 8) return inflateRawSync(data);
        throw new Error(`zip method ${method.toString()} in ${name}`);
      },
    });
  }
  return entries;
}

/** The entry with this name, or the only one ending with it. */
export function zipEntry(entries: readonly ZipEntry[], name: string): ZipEntry {
  const found =
    entries.find((entry) => entry.name === name) ??
    entries.find((entry) => entry.name.endsWith(`/${name}`));
  if (found === undefined) throw new Error(`no ${name} in the zip file`);
  return found;
}
