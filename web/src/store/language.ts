import { type Language, language, setLanguage } from '@/i18n';

import { useSession } from './session';
import { useWorkspace } from './workspace';

/**
 * Change the language the interface speaks.
 *
 * `m` is bound when its module first loads, so the new dictionary reaches the screen only
 * through a reload — and a reload takes with it whatever is typed and not yet sealed. The
 * open note goes out first for the same reason read-only mode flushes it before freezing:
 * after the reload nothing remembers the keystrokes, and there is nowhere for them to land.
 *
 * The write happens before the save rather than after it, so a save that never comes back —
 * offline, or a body the server refuses — still leaves the choice made for the next load.
 */
export function switchLanguage(next: Language): void {
  if (next === language()) return;

  setLanguage(next);

  const { identity } = useSession.getState();

  void useWorkspace
    .getState()
    .saveNote(identity ?? undefined)
    .finally(() => window.location.reload());
}
