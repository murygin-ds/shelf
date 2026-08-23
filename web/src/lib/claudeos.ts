import type { ImportFolder, ImportNote, ImportPlan } from './archive';
import { AREAS, ROOT_DOC } from './claudeos-contract';
import { docs } from './claudeos/docs';

/**
 * The tree a Claude vault starts with.
 *
 * It exists because a connector with nothing in it is a connector nobody uses: a model asked
 * to "remember this" has to be told where memory lives, and a person setting one up should
 * not have to invent a filing system before the first useful conversation.
 *
 * This is data, not UI, and it is a pure function on purpose — the sealing, the ordering and
 * the progress reporting all belong to `transfer.importVault`, which already does them for
 * an archive. Building a second write path here would mean a second place for a ciphertext
 * to end up bound to the wrong slot.
 *
 * What the documents say is in `claudeos/docs.ts`, one module per language. The shape below
 * is the same in every language: folder names and file names are paths a model walks, and
 * `claudeview.ts` reads the vault back by matching them.
 */

/**
 * Builds the plan. `at` decides the name of the first memory file, so the vault opens with a
 * month that is the current one rather than one somebody has to notice is wrong.
 */
export function claudeOsPlan(vaultName: string, at: Date = new Date()): ImportPlan {
  const month = at.toISOString().slice(0, 7);

  const folders: ImportFolder[] = [
    folder(AREAS.context, null, AREAS.context, 'book'),
    folder(AREAS.projects, null, AREAS.projects, 'target'),
    folder(AREAS.skills, null, AREAS.skills, 'bulb'),
    folder(AREAS.memory, null, AREAS.memory, 'db'),
    folder(AREAS.inbox, null, AREAS.inbox, 'inbox'),
  ];

  const notes: ImportNote[] = [
    note(ROOT_DOC, null, ROOT_DOC, docs.root(vaultName), 'book', ['claude']),
    note('context.md', AREAS.context, 'context.md', docs.context()),
    note('profile.md', AREAS.context, 'profile.md', docs.profile()),
    note('environment.md', AREAS.context, 'environment.md', docs.environment()),
    note('projects.md', AREAS.projects, 'projects.md', docs.projects()),
    note('skills.md', AREAS.skills, 'skills.md', docs.skills()),
    note('memory.md', AREAS.memory, 'memory.md', docs.memory()),
    note(`${month}.md`, AREAS.memory, `${month}.md`, docs.month(month)),
    note('inbox.md', AREAS.inbox, 'inbox.md', docs.inbox()),
  ];

  return {
    vault: { name: vaultName, icon: 'claude' },
    exportedAt: at.toISOString(),
    folders,
    notes,
    skipped: [],
  };
}

function folder(uid: string, parent: string | null, name: string, icon: string): ImportFolder {
  return { uid, parent, name, icon, tags: [] };
}

function note(
  uid: string,
  folder: string | null,
  name: string,
  body: string,
  icon?: string,
  tags: string[] = [],
): ImportNote {
  return { uid, folder, name, ...(icon ? { icon } : {}), tags, body };
}

/** What a new project starts as. Written by the view, and by the template it came from. */
export function projectSeed(name?: string): string {
  return docs.project(name);
}

/** What a new project's decision log starts as. */
export function decisionsSeed(): string {
  return docs.decisions();
}

/** What a new skill starts as. */
export function skillSeed(name?: string): string {
  return docs.skill(name);
}
