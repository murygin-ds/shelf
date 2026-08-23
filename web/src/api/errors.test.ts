import { ArchiveError } from '@/lib/archive';
import { describe as group, expect, it } from 'vitest';

import { m } from '@/i18n';

import { ApiError, OfflineError } from './client';
import { describe } from './errors';
import { ErrorCode, ErrorReason, REASON_KEY } from './types';

function apiError(
  status: number,
  code: string,
  reason?: string,
  message = 'the server wrote this for a log, in English, naming internals',
  retryAfter?: number,
): ApiError {
  return new ApiError(
    status,
    code,
    message,
    reason === undefined ? undefined : { [REASON_KEY]: reason },
    'req-1',
    retryAfter,
  );
}

/** (status, code, reason) → the sentence, one row per rung of the ladder. */
const TABLE: Array<[name: string, cause: ApiError, want: string]> = [
  [
    'a reason the dictionary knows wins over its code',
    apiError(409, ErrorCode.Conflict, ErrorReason.AlreadyMember),
    m.errors.byReason.already_member ?? '',
  ],
  [
    'a reason the dictionary knows wins over its status',
    apiError(404, 'a_code_from_a_later_server', ErrorReason.NotFound),
    m.errors.byReason.not_found ?? '',
  ],
  [
    'a reason this build has never heard of falls through to the code',
    apiError(409, ErrorCode.Conflict, 'invented_by_a_later_server'),
    m.errors.byCode.conflict ?? '',
  ],
  [
    'no reason at all falls through to the code',
    apiError(401, ErrorCode.Unauthorized),
    m.errors.byCode.unauthorized ?? '',
  ],
  [
    'a code this build has never heard of falls through to the status',
    apiError(403, 'invented_by_a_later_server', 'invented_too'),
    m.errors.byStatus[403] ?? '',
  ],
  [
    'a status with no row of its own lands on the last rung',
    apiError(418, 'invented_by_a_later_server'),
    m.errors.unknown,
  ],
  [
    'the two refresh failures do not share a sentence',
    apiError(401, ErrorCode.Unauthorized, ErrorReason.RefreshReused),
    m.errors.byReason.refresh_token_reused ?? '',
  ],
];

group('describe', () => {
  for (const [name, cause, want] of TABLE) {
    it(name, () => {
      expect(want).not.toBe('');
      expect(describe(cause)).toBe(want);
    });
  }

  it('answers a lost network before it reaches any table', () => {
    expect(describe(new OfflineError())).toBe(m.errors.offline);
  });

  it('reads a wrapped key that will not open as a wrong passphrase', () => {
    expect(describe(new DOMException('operation-specific reason', 'OperationError'))).toBe(
      m.errors.badPassphrase,
    );
  });

  it('says how long to wait when the server said so', () => {
    expect(describe(apiError(429, ErrorCode.TooManyRequests, undefined, 'slow down', 150))).toBe(
      m.errors.retryIn(3),
    );
  });

  it('prefers the countdown over the reason a rate limit carries', () => {
    const cause = apiError(429, ErrorCode.TooManyRequests, ErrorReason.RateLimited, 'slow', 60);

    expect(describe(cause)).toBe(m.errors.retryIn(1));
  });

  it('falls back to the reason when the rate limit came without a Retry-After', () => {
    expect(describe(apiError(429, ErrorCode.TooManyRequests, ErrorReason.RateLimited))).toBe(
      m.errors.byReason.rate_limited ?? '',
    );
  });

  it('has nothing to say about a value that is not an error at all', () => {
    expect(describe(undefined)).toBe(m.errors.unknown);
    expect(describe('a string thrown from somewhere')).toBe(m.errors.unknown);
    expect(describe(new TypeError('cannot read properties of null'))).toBe(m.errors.unknown);
  });

  /**
   * The invariant the whole file exists for. `cause.message` is written by the server for a
   * log: English by design, phrased for a developer, and often naming internals. No rung of
   * the ladder may leak it, including the ones taken when nothing matched.
   */
  it('never puts the server’s own message on screen', () => {
    const leak = 'pgx: relation "vault_members" does not exist';

    const causes: unknown[] = [
      apiError(409, ErrorCode.Conflict, ErrorReason.VersionConflict, leak),
      apiError(409, ErrorCode.Conflict, 'invented_by_a_later_server', leak),
      apiError(403, 'invented_by_a_later_server', undefined, leak),
      apiError(418, 'invented_by_a_later_server', 'invented_too', leak),
      apiError(429, ErrorCode.TooManyRequests, undefined, leak, 120),
      new OfflineError(),
      new DOMException(leak, 'OperationError'),
      new Error(leak),
      leak,
    ];

    for (const cause of causes) expect(describe(cause)).not.toContain('vault_members');
  });
});

group('an error this app raised itself', () => {
  // The import modal used to answer «something went wrong» for a file that was simply not
  // an archive, because the only thing carrying the detail was the English Error message
  // that describe() refuses to show. The typed reason is what closes that.
  it('is described by the reason it carries', () => {
    const wrongFile = new ArchiveError('too-new', 'this archive was written by a newer version');

    expect(describe(wrongFile)).toBe(m.errors.byReason['too-new']);
    expect(describe(wrongFile)).not.toContain('newer version');
  });

  it('falls through when the reason means nothing here', () => {
    const odd = Object.assign(new Error('boom'), { reason: 'never-heard-of-it' });

    expect(describe(odd)).toBe(m.errors.unknown);
  });

  it('ignores a reason that is not a string', () => {
    const odd = Object.assign(new Error('boom'), { reason: 42 });

    expect(describe(odd)).toBe(m.errors.unknown);
  });
});
