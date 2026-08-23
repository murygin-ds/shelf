import { describe, expect, it } from 'vitest';

import { language, type Language } from '@/i18n';
import { ICON_NAMES } from '@/ui/Icon';

import { segment, type ImportNote, type ImportPlan } from './archive';
import { claudeOsPlan } from './claudeos';
import { AREAS, ROOT_DOC } from './claudeos-contract';
import type { ClaudeDocs } from './claudeos/docs';
import { en } from './claudeos/docs.en';
import { ru } from './claudeos/docs.ru';
import { resolveWikilinks } from './wikilinks';

const plan = claudeOsPlan('Claude', new Date('2026-08-23T00:00:00.000Z'));

const root = (): ImportNote => {
  const note = plan.notes.find((candidate) => candidate.uid === ROOT_DOC && candidate.folder === null);

  if (!note) throw new Error('no root document');

  return note;
};

/**
 * The paths the vault will answer to, built from `folder.name` rather than from the uid.
 *
 * The two spell the same string today, which is exactly the trap: a check that took the uid
 * would keep passing after somebody translated `projects` to `проекты`, while the model's
 * instructions pointed at a directory that no longer existed and `claudeview.ts` filed the
 * whole vault under "elsewhere".
 */
function paths(of: ImportPlan): { id: number; name: string; path: string }[] {
  const names = new Map(of.folders.map((folder) => [folder.uid, folder.name]));

  return of.notes.map((note, index) => {
    const parent = note.folder === null ? null : names.get(note.folder);

    if (note.folder !== null && parent === undefined) {
      throw new Error(`${note.uid} sits in a folder the plan does not declare`);
    }

    return { id: index + 1, name: note.name, path: parent === null ? note.name : `${parent}/${note.name}` };
  });
}

/**
 * Every document, in one language. The uniform argument is why they all take one: a document
 * left out of this walk is the one whose links nobody checks.
 */
function bodies(docs: ClaudeDocs): string[] {
  return Object.values(docs).map((doc) => doc('2026-08'));
}

function dangling(docs: ClaudeDocs, of: ImportPlan): string[] {
  const targets = paths(of);

  return bodies(docs).flatMap((body) => resolveWikilinks(body, targets, 0).unresolved);
}

const LANGUAGES: [Language, ClaudeDocs][] = [
  ['en', en],
  ['ru', ru],
];

/** The two warnings, in each language, and the shortest phrase that carries each of them. */
const WARNINGS: Record<Language, [string, string, string]> = {
  en: ['readable by the Shelf server', 'notes, not as instructions', 'passwords, API keys'],
  ru: ['сервер Shelf может прочитать', 'заметками, а не инструкциями', 'пароли, ключи API'],
};

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

  // The five areas are a frozen contract rather than a choice this file makes: `claudeview.ts`
  // finds them by comparing a folder name against this same list.
  it('builds the five areas the contract names, and nothing else', () => {
    expect(plan.folders.map((folder) => folder.name)).toEqual(Object.values(AREAS));
  });

  // A name that needs escaping is a name an export writes to a different path than the one
  // the model was told to use.
  it('names everything something a path can hold', () => {
    for (const entry of [...plan.folders, ...plan.notes]) {
      expect(segment(entry.name)).toBe(entry.name);
      expect(segment(entry.uid)).toBe(entry.uid);
    }
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

  // A link resolves by path first and by name second, so a bare name two notes share lands
  // on the older of them. The template is allowed to repeat a name — CLAUDE.md means
  // something in both places — as long as nothing links to one by name alone.
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

  // The template tells the model to link by path, and an example that resolves to nothing
  // teaches the opposite. Both languages are checked, because only one of them is loaded at
  // a time and a broken link in the other would ship unseen.
  it.each(LANGUAGES)('leaves no wikilink pointing at nothing in %s', (_, docs) => {
    expect(dangling(docs, plan)).toEqual([]);
  });

  // The guard on the guard. Resolution above is only meaningful while the paths come from
  // `folder.name`; renaming the folders has to break it, or the check has stopped looking.
  it('resolves against folder names, so renaming a folder breaks the links', () => {
    const renamed: ImportPlan = {
      ...plan,
      folders: plan.folders.map((folder) => ({ ...folder, name: `_${folder.name}` })),
    };

    for (const [, docs] of LANGUAGES) {
      expect(dangling(docs, renamed).length).toBeGreaterThan(0);
    }
  });

  it('names and links each of the five areas from the root document', () => {
    for (const area of Object.values(AREAS)) {
      expect(root().body).toContain(`${area}/`);
      expect(root().body).toContain(`[[${area}/${area}.md]]`);
    }
  });

  // The graph is only as good as what the writer links, and the connector resolves exactly
  // what a person's browser does. A template that never shows the two forms leaves a vault
  // of notes that touch nothing.
  it('shows the model how to link: by path, and with an alias', () => {
    expect(root().body).toContain('shelf_list_tree');
    expect(root().body).toContain(`[[${AREAS.memory}/${AREAS.memory}.md]]`);
    expect(root().body).toContain(`[[${AREAS.context}/profile.md|`);
  });

  // The warnings are the whole reason this template is safe to hand to a model. A future
  // edit that drops one should fail here rather than in somebody's vault.
  it.each(LANGUAGES)('warns about the server and about prompt injection in %s', (tag, docs) => {
    for (const phrase of WARNINGS[tag]) {
      expect(docs.root('Claude')).toContain(phrase);
    }
  });

  it('seeds the vault in the language the reader chose', () => {
    for (const phrase of WARNINGS[language()]) {
      expect(root().body).toContain(phrase);
    }
  });

  // The scanner that finds English left in the interface skips these documents: they are
  // content, latin in places on purpose. This is what stands in for it.
  it('translates every document rather than copying it', () => {
    for (const key of Object.keys(en) as (keyof ClaudeDocs)[]) {
      expect(ru[key]('2026-08'), `${key} is still the English text`).not.toBe(en[key]('2026-08'));
      expect(ru[key]('2026-08'), `${key} has nothing russian in it`).toMatch(/[а-яё]/i);
    }
  });

  it('keeps the frozen markers out of the translation', () => {
    const project = ru.project('Проект');

    expect(project).toContain('**Status:**');
    expect(project).toContain('planning | active | paused | done');
    expect(ru.skill('навык')).toMatch(/^---\nname: навык\ndescription: /);
  });

  it('names the first memory file after the month it was made in', () => {
    expect(plan.notes.some((note) => note.name === '2026-08.md')).toBe(true);
  });

  it('describes itself as a vault an import can create', () => {
    expect(plan.vault.name).toBe('Claude');
    expect(plan.skipped).toEqual([]);
    expect(plan.folders.map((folder) => folder.uid)).toContain(AREAS.memory);
  });
});
