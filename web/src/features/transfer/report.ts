import { ApiError } from '@/api/client';
import type { Skipped } from '@/lib/archive';

/**
 * What a transfer left behind, as counts rather than names.
 *
 * A node the reader holds no key for has no name to give — `••••••` in a report would be
 * noise — and a hundred skipped notes are a fact about the vault, not a list worth reading.
 */
export function summarize(skipped: readonly Skipped[]): string {
  const byReason = new Map<string, Map<string, number>>();

  for (const item of skipped) {
    const kinds = byReason.get(item.reason) ?? new Map<string, number>();

    kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
    byReason.set(item.reason, kinds);
  }

  // Grouped by reason rather than by kind, so a folder and the note inside it read as one
  // fact — "1 folder and 2 notes you hold no key for" — instead of as two.
  const said = [...byReason].map(([reason, kinds]) => {
    const counted = [...kinds].map(([kind, count]) => `${count} ${count === 1 ? kind : `${kind}s`}`);

    return `${counted.join(' and ')} ${REASONS[reason] ?? reason}`;
  });

  return `Left out: ${said.join('; ')}.`;
}

const REASONS: Record<string, string> = {
  locked: 'you hold no key for',
  'no-key': 'that would not open',
  missing: 'that were not in the archive',
  'too-large': 'too large to write',
  'too-deep': 'nested deeper than Shelf allows',
  orphaned: 'whose folder was not in the archive',
};

export function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message || `HTTP ${cause.status}`;
  if (cause instanceof Error) return cause.message || cause.name;

  return 'something went wrong';
}
