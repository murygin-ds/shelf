import { fromUtf8, utf8 } from '@/crypto/bytes';

/**
 * A ZIP writer and reader, small enough to keep rather than to depend on.
 *
 * The archive this builds is the one the user unpacks in Finder or Explorer, so it stays
 * within what every unpacker has understood for twenty years: one deflate method, no Zip64,
 * no encryption. `CompressionStream` does the compressing, which is why this is a few
 * hundred bytes of framing rather than an implementation of deflate.
 */
export interface ZipEntry {
  /** Directories are named with a trailing slash and carry no data. */
  path: string;
  data: Uint8Array;
}

export type ZipFault =
  | 'not-a-zip'
  | 'zip64'
  | 'directory-damaged'
  | 'entry-misplaced'
  | 'entry-truncated'
  | 'method-unsupported'
  | 'entry-corrupt';

/**
 * An archive this reader will not take, with the cause as a value.
 *
 * The message names the entry and is written for a log; `reason` is what a caller matches on.
 */
export class ZipError extends Error {
  readonly reason: ZipFault;

  constructor(reason: ZipFault, message: string) {
    super(message);
    this.name = 'ZipError';
    this.reason = reason;
  }
}

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const STORED = 0;
const DEFLATED = 8;

/** 2.0: the floor for deflate, and what every writer stamps on a plain archive. */
const VERSION = 20;
/** Bit 11. Without it a Cyrillic folder name is read as CP437 mojibake. */
const UTF8_FLAG = 0x0800;
/** FILE_ATTRIBUTE_DIRECTORY, so an empty folder unpacks as a folder. */
const DIRECTORY_ATTRIBUTE = 0x10;

const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;

/** What a field holds when the real value only fits in a Zip64 record. */
const OVERFLOW_16 = 0xffff;
const OVERFLOW_32 = 0xffffffff;

export async function zip(entries: readonly ZipEntry[], modified = new Date()): Promise<Blob> {
  const stamp = dosStamp(modified);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const directory = entry.path.endsWith('/');
    const name = utf8(entry.path);
    const data = directory ? new Uint8Array(0) : entry.data;

    const packed = data.length === 0 ? data : await deflate(data);
    // Deflate that made the payload bigger — short files, random bytes — is stored instead.
    const compressed = packed.length < data.length;
    const payload = compressed ? packed : data;
    const method = compressed ? DEFLATED : STORED;
    const crc = crc32(data);

    parts.push(
      localHeader(name.length, method, stamp, crc, payload.length, data.length),
      name,
      payload,
    );

    central.push(
      centralHeader(name, method, stamp, crc, payload.length, data.length, offset, directory),
    );

    offset += LOCAL_HEADER + name.length + payload.length;
  }

  const size = central.reduce((total, record) => total + record.length, 0);
  const all = [...parts, ...central, endOfDirectory(central.length, size, offset)];

  // The DOM types want an array over a plain ArrayBuffer; a Uint8Array is only ever that here,
  // and handing the pieces to Blob rather than joining them keeps one copy out of memory.
  return new Blob(all as BlobPart[], { type: 'application/zip' });
}

/**
 * Reads every entry, directories included — they arrive with an empty payload and keep their
 * trailing slash.
 *
 * The central directory is the map, not the local headers: an archive rewritten by a system
 * tool may put the sizes in a data descriptor *after* the payload, and only the directory
 * holds them in a place that can be read before the bytes are.
 */
export async function unzip(archive: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(archive);
  const view = new DataView(archive);
  const eocd = findEndOfDirectory(view, bytes.length);

  const count = view.getUint16(eocd + 10, true);
  const directory = view.getUint32(eocd + 16, true);

  if (count === OVERFLOW_16 || directory === OVERFLOW_32) {
    throw new ZipError('zip64', 'the entry count only fits in a Zip64 record');
  }

  const files = new Map<string, Uint8Array>();
  let at = directory;

  for (let i = 0; i < count; i += 1) {
    if (at + CENTRAL_HEADER > bytes.length || view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new ZipError('directory-damaged', 'the central directory does not read');
    }

    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);

    const name = fromUtf8(bytes.subarray(at + CENTRAL_HEADER, at + CENTRAL_HEADER + nameLength));

    if (size === OVERFLOW_32 || packedSize === OVERFLOW_32 || local === OVERFLOW_32) {
      throw new ZipError('zip64', `“${name}” only fits in a Zip64 record`);
    }

    files.set(name, await readEntry(bytes, view, { local, method, packedSize, size, crc, name }));

    at += CENTRAL_HEADER + nameLength + extraLength + commentLength;
  }

  return files;
}

interface Entry {
  local: number;
  method: number;
  packedSize: number;
  size: number;
  crc: number;
  name: string;
}

async function readEntry(
  bytes: Uint8Array,
  view: DataView,
  entry: Entry,
): Promise<Uint8Array> {
  if (entry.local + LOCAL_HEADER > bytes.length || view.getUint32(entry.local, true) !== LOCAL_SIGNATURE) {
    throw new ZipError('entry-misplaced', `“${entry.name}” is not where the directory says`);
  }

  // The local header may carry different extra fields from the central one, so its own
  // lengths decide where the payload starts.
  const nameLength = view.getUint16(entry.local + 26, true);
  const extraLength = view.getUint16(entry.local + 28, true);
  const start = entry.local + LOCAL_HEADER + nameLength + extraLength;
  const raw = bytes.subarray(start, start + entry.packedSize);

  if (raw.length !== entry.packedSize) {
    throw new ZipError('entry-truncated', `“${entry.name}” is cut short`);
  }

  const data =
    entry.method === STORED
      ? raw
      : entry.method === DEFLATED
        ? await inflate(raw)
        : (() => {
            throw new ZipError(
              'method-unsupported',
              `“${entry.name}” uses a compression method Shelf does not read`,
            );
          })();

  if (data.length !== entry.size || crc32(data) !== entry.crc) {
    throw new ZipError('entry-corrupt', `“${entry.name}” is corrupt`);
  }

  return data;
}

/**
 * The end of central directory record, found by scanning back from the end: it is last, but
 * a trailing comment of up to 64 KiB can sit behind it.
 */
function findEndOfDirectory(view: DataView, length: number): number {
  const floor = Math.max(0, length - EOCD_SIZE - MAX_COMMENT);

  for (let at = length - EOCD_SIZE; at >= floor; at -= 1) {
    if (view.getUint32(at, true) !== EOCD_SIGNATURE) continue;

    // A Zip64 locator right before it means the real counts live in a record this does not
    // read, and the 32-bit fields here are only a placeholder.
    if (at >= 20 && view.getUint32(at - 20, true) === ZIP64_LOCATOR_SIGNATURE) {
      throw new ZipError('zip64', 'a Zip64 locator sits before the end of directory');
    }

    return at;
  }

  throw new ZipError('not-a-zip', 'no end of central directory record');
}

function localHeader(
  nameLength: number,
  method: number,
  stamp: DosStamp,
  crc: number,
  packedSize: number,
  size: number,
): Uint8Array {
  const head = new Uint8Array(LOCAL_HEADER);
  const view = new DataView(head.buffer);

  view.setUint32(0, LOCAL_SIGNATURE, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, UTF8_FLAG, true);
  view.setUint16(8, method, true);
  view.setUint16(10, stamp.time, true);
  view.setUint16(12, stamp.date, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, packedSize, true);
  view.setUint32(22, size, true);
  view.setUint16(26, nameLength, true);
  view.setUint16(28, 0, true);

  return head;
}

function centralHeader(
  name: Uint8Array,
  method: number,
  stamp: DosStamp,
  crc: number,
  packedSize: number,
  size: number,
  offset: number,
  directory: boolean,
): Uint8Array {
  const record = new Uint8Array(CENTRAL_HEADER + name.length);
  const view = new DataView(record.buffer);

  view.setUint32(0, CENTRAL_SIGNATURE, true);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, VERSION, true);
  view.setUint16(8, UTF8_FLAG, true);
  view.setUint16(10, method, true);
  view.setUint16(12, stamp.time, true);
  view.setUint16(14, stamp.date, true);
  view.setUint32(16, crc, true);
  view.setUint32(20, packedSize, true);
  view.setUint32(24, size, true);
  view.setUint16(28, name.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, directory ? DIRECTORY_ATTRIBUTE : 0, true);
  view.setUint32(42, offset, true);
  record.set(name, CENTRAL_HEADER);

  return record;
}

function endOfDirectory(count: number, size: number, offset: number): Uint8Array {
  const record = new Uint8Array(EOCD_SIZE);
  const view = new DataView(record.buffer);

  view.setUint32(0, EOCD_SIGNATURE, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  view.setUint16(20, 0, true);

  return record;
}

interface DosStamp {
  time: number;
  date: number;
}

/** MS-DOS date and time: two seconds of resolution, and nothing before 1980. */
function dosStamp(at: Date): DosStamp {
  const year = Math.max(1980, at.getFullYear());

  return {
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
  };
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  return through(data, new CompressionStream('deflate-raw'));
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  return through(data, new DecompressionStream('deflate-raw'));
}

async function through(data: Uint8Array, transform: TransformStream): Promise<Uint8Array> {
  const piped = new Blob([data as BlobPart]).stream().pipeThrough(transform);

  return new Uint8Array(await new Response(piped).arrayBuffer());
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let i = 0; i < 256; i += 1) {
    let value = i;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[i] = value >>> 0;
  }

  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;

  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);

  return (crc ^ 0xffffffff) >>> 0;
}
