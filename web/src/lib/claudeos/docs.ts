import { language } from '@/i18n';

import { en } from './docs.en';
import { ru } from './docs.ru';

/**
 * The prose a Claude vault is seeded with, in the reader's language.
 *
 * It lives apart from `claudeos.ts` because it is content, not interface: nothing here is a
 * label the dictionary could hold, and a document reads as one piece of writing or not at
 * all. Keeping it out of `src/i18n` also keeps the plan a pure function — `claudeos.ts` says
 * what the tree looks like, these modules say what is written in it.
 *
 * Both languages are imported statically. Seeding happens once and a lazy chunk would be the
 * honest shape, but `claudeOsPlan` and the three seeds are called synchronously from the
 * store, and an `import()` would turn all four into promises across files this change does
 * not own.
 */

/**
 * One document. Every one takes the same optional string — the vault name, a project name, a
 * month — so a test can walk the whole set and check what it finds without knowing which
 * document wanted an argument.
 */
export type Doc = (arg?: string) => string;

export interface ClaudeDocs {
  root: Doc;
  context: Doc;
  profile: Doc;
  environment: Doc;
  projects: Doc;
  project: Doc;
  decisions: Doc;
  skills: Doc;
  skill: Doc;
  memory: Doc;
  month: Doc;
  inbox: Doc;
}

export const docs: ClaudeDocs = language() === 'en' ? en : ru;
