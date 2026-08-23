import { en } from './en';
import { language } from './locale';
import { ru } from './ru';
import type { Messages } from './shape';

/**
 * Every word the reader sees, already in their language.
 *
 * Bound once, at module load. A component reads `m.inspector.tabs.links`; so does the sync
 * engine and so does the store, and none of them needs a hook to do it.
 */
export const m: Messages = language() === 'en' ? en : ru;
