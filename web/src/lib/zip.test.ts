import { describe, expect, it } from 'vitest';

import { fromUtf8, utf8 } from '@/crypto/bytes';

import { unzip, zip, type ZipEntry } from './zip';

const stamp = new Date('2026-08-17T10:30:00Z');

async function roundTrip(entries: ZipEntry[]): Promise<Map<string, string>> {
  const archive = await (await zip(entries, stamp)).arrayBuffer();
  const read = await unzip(archive);

  return new Map([...read].map(([path, data]) => [path, fromUtf8(data)]));
}

describe('the zip archive', () => {
  it('survives a round trip', async () => {
    const files = await roundTrip([
      { path: 'shelf.json', data: utf8('{"format":"shelf/vault"}') },
      { path: 'notes/Работа/Планы на квартал.md', data: utf8('# Планы\n\nтекст') },
      { path: 'notes/empty.md', data: new Uint8Array(0) },
    ]);

    expect(files.get('shelf.json')).toBe('{"format":"shelf/vault"}');
    expect(files.get('notes/Работа/Планы на квартал.md')).toBe('# Планы\n\nтекст');
    expect(files.get('notes/empty.md')).toBe('');
  });

  it('keeps a folder that has nothing in it', async () => {
    const files = await roundTrip([
      { path: 'notes/Пусто/', data: new Uint8Array(0) },
      { path: 'notes/Пусто/nested/', data: new Uint8Array(0) },
    ]);

    expect([...files.keys()]).toEqual(['notes/Пусто/', 'notes/Пусто/nested/']);
    expect(files.get('notes/Пусто/')).toBe('');
  });

  it('compresses what is worth compressing and stores the rest', async () => {
    const repetitive = utf8('shelf '.repeat(4000));
    const compressed = await (await zip([{ path: 'a.md', data: repetitive }], stamp)).arrayBuffer();
    const short = utf8('hi');
    const stored = await (await zip([{ path: 'a.md', data: short }], stamp)).arrayBuffer();

    expect(compressed.byteLength).toBeLessThan(repetitive.length / 4);
    // Nothing deflates to fewer than two bytes, so this one has to have gone in as it was.
    expect(stored.byteLength).toBe(short.length + 30 + 46 + 22 + 'a.md'.length * 2);

    expect(fromUtf8((await unzip(compressed)).get('a.md') ?? new Uint8Array())).toHaveLength(
      repetitive.length,
    );
    expect(fromUtf8((await unzip(stored)).get('a.md') ?? new Uint8Array())).toBe('hi');
  });

  it('reads the entries in the order they were written', async () => {
    const files = await roundTrip([
      { path: 'shelf.json', data: utf8('{}') },
      { path: 'notes/b.md', data: utf8('b') },
      { path: 'notes/a.md', data: utf8('a') },
    ]);

    expect([...files.keys()]).toEqual(['shelf.json', 'notes/b.md', 'notes/a.md']);
  });

  it('refuses a file that is not an archive', async () => {
    await expect(unzip(utf8('not a zip at all').buffer as ArrayBuffer)).rejects.toThrow(
      'not a zip archive',
    );
  });

  it('refuses an archive whose payload was tampered with', async () => {
    const archive = new Uint8Array(
      await (await zip([{ path: 'a.md', data: utf8('the original text') }], stamp)).arrayBuffer(),
    );

    // Past the local header and the name, so this lands in the payload rather than in framing.
    const payload = 30 + 'a.md'.length;
    archive[payload] = (archive[payload] ?? 0) ^ 0xff;

    await expect(unzip(archive.buffer as ArrayBuffer)).rejects.toThrow('corrupt');
  });

  it('says so plainly when the archive is Zip64', async () => {
    const archive = new Uint8Array(
      await (await zip([{ path: 'a.md', data: utf8('text') }], stamp)).arrayBuffer(),
    );

    // The count of entries only reads as 0xffff when the real one lives in a Zip64 record.
    const view = new DataView(archive.buffer);
    view.setUint16(archive.length - 22 + 10, 0xffff, true);

    await expect(unzip(archive.buffer as ArrayBuffer)).rejects.toThrow('Zip64');
  });
});
