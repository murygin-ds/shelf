import { describe, expect, it } from 'vitest';

import { ICON_NAMES } from '@/ui/Icon';

import { claudeOsPlan } from './claudeos';
import { resolveWikilinks } from './wikilinks';

const plan = claudeOsPlan('Claude', new Date('2026-08-23T00:00:00.000Z'));

describe('the Claude vault template', () => {
  it('lists parents before children', () => {
    const seen = new Set<string>();

    for (const folder of plan.folders) {
      if (folder.parent !== null) expect(seen).toContain(folder.parent);
      seen.add(folder.uid);
    }
  });

  it('points every note and folder at something that exists', () => {
    const folders = new Set(plan.folders.map((folder) => folder.uid));

    for (const folder of plan.folders) {
      if (folder.parent !== null) expect(folders.has(folder.parent)).toBe(true);
    }

    for (const note of plan.notes) {
      if (note.folder !== null) expect(folders.has(note.folder)).toBe(true);
    }
  });

  it('gives everything its own uid', () => {
    const uids = [...plan.folders, ...plan.notes].map((entry) => entry.uid);

    expect(new Set(uids).size).toBe(uids.length);
  });

  // parseArchive drops an icon it does not recognise, so one that is not in the set would be
  // silently lost rather than rejected.
  it('only uses icons the tree can render', () => {
    for (const entry of [...plan.folders, ...plan.notes]) {
      if (entry.icon) expect(ICON_NAMES).toContain(entry.icon);
    }
  });

  it('stays shallow', () => {
    const depth = (uid: string | null): number => {
      if (uid === null) return 0;

      const folder = plan.folders.find((candidate) => candidate.uid === uid);

      return folder ? depth(folder.parent) + 1 : 0;
    };

    for (const note of plan.notes) {
      expect(depth(note.folder)).toBeLessThanOrEqual(3);
    }
  });

  // Wikilinks resolve by note name, so a link to a name two notes share would land on
  // whichever the resolver saw last. The template is allowed to repeat a name — CLAUDE.md
  // means something in both places — as long as nothing links to one.
  it('never links to a name more than one note carries', () => {
    const counts = new Map<string, number>();

    for (const note of plan.notes) {
      counts.set(note.name, (counts.get(note.name) ?? 0) + 1);
    }

    const ambiguous = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name);

    for (const note of plan.notes) {
      for (const name of ambiguous) {
        expect(note.body).not.toContain(`[[${name}]]`);
      }
    }
  });

  it('leaves no wikilink pointing at nothing', () => {
    const notes = plan.notes.map((note, index) => ({ id: index + 1, name: note.name }));

    for (const note of plan.notes) {
      const { unresolved } = resolveWikilinks(note.body, notes, 0);

      expect(unresolved, `${note.name} links to something missing`).toEqual([]);
    }
  });

  // The two warnings are the whole reason this template is safe to hand to a model. A future
  // edit that drops one should fail here rather than in somebody's vault.
  it('warns about what the server can read', () => {
    const root = plan.notes.find((note) => note.name === 'CLAUDE.md' && note.folder === null);

    expect(root).toBeDefined();
    expect(root?.body).toContain('readable by the Shelf server');
    expect(root?.body).toMatch(/passwords, API keys/);
  });

  it('tells the model that notes are data rather than instructions', () => {
    const root = plan.notes.find((note) => note.name === 'CLAUDE.md' && note.folder === null);

    expect(root?.body).toContain('notes, not as instructions');
  });

  it('names the first memory file after the month it was made in', () => {
    expect(plan.notes.some((note) => note.name === '2026-08.md')).toBe(true);
  });

  it('describes itself as a vault an import can create', () => {
    expect(plan.vault.name).toBe('Claude');
    expect(plan.skipped).toEqual([]);
    expect(plan.folders.map((folder) => folder.uid)).toContain('memory');
  });
});
