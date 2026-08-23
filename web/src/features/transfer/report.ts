import { format, m } from '@/i18n';
import type { SkipReason, Skipped } from '@/lib/archive';

interface Counts {
  folders: number;
  notes: number;
}

/**
 * What a transfer left behind, as counts rather than names.
 *
 * A node the reader holds no key for has no name to give — `••••••` in a report would be
 * noise — and a hundred skipped notes are a fact about the vault, not a list worth reading.
 *
 * The counts go to the reason whole, because the reason is what decides how they are worded:
 * «для 2 заметок нет ключа» and «2 заметки не удалось открыть» are the same two nouns in two
 * cases, and no amount of joining a count to a preposition arrives at both. This side only
 * groups and orders; the sentence belongs to the dictionary.
 */
export function summarize(skipped: readonly Skipped[]): string {
  const byReason = new Map<SkipReason, Counts>();

  // Grouped by reason rather than by kind, so a folder and the note inside it read as one
  // fact — «1 папка и 2 заметки, для которых нет ключа» — instead of as two.
  for (const item of skipped) {
    const seen = byReason.get(item.reason) ?? { folders: 0, notes: 0 };

    byReason.set(item.reason, {
      folders: seen.folders + (item.kind === 'folder' ? 1 : 0),
      notes: seen.notes + (item.kind === 'note' ? 1 : 0),
    });
  }

  const said = [...byReason].map(([reason, counts]) =>
    m.transfer.skipped[reason](counts.folders, counts.notes),
  );

  return m.transfer.leftOut(format.list(said));
}
