/**
 * Vault failures. The message carries only the code, never a value; callers
 * on the send path treat every VaultError as "block the send" (fail closed).
 */

export type VaultErrorCode =
  /** IndexedDB is missing or the database could not be opened. */
  | 'unavailable'
  /** An old connection did not close in time for a version upgrade. */
  | 'blocked'
  /** The database is newer than this code (downgrade). */
  | 'version-too-new'
  /** A migration step failed; the upgrade was rolled back. */
  | 'upgrade-failed'
  /** Keys are missing while encrypted records exist. */
  | 'keys-lost'
  /** Authentication of a ciphertext failed (wrong key, IV, data or record). */
  | 'decrypt-failed'
  /** A stored record does not have the expected shape. */
  | 'corrupt-record'
  /** A unique index rejected a write. */
  | 'constraint'
  /** The conversation a mapping belongs to does not exist. */
  | 'no-conversation'
  /** Storage quota exceeded. */
  | 'quota'
  /** A transaction was aborted. */
  | 'aborted'
  /** The connection was closed. */
  | 'closed';

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, options?: { cause?: unknown }) {
    super(`vault: ${code}`, options);
    this.name = 'VaultError';
    this.code = code;
  }
}

/** Maps a platform error (DOMException names) to a VaultError. */
export function toVaultError(
  error: unknown,
  fallback: VaultErrorCode,
): VaultError {
  if (error instanceof VaultError) return error;
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? error.name
      : null;
  switch (name) {
    case 'ConstraintError':
      return new VaultError('constraint', { cause: error });
    case 'QuotaExceededError':
      return new VaultError('quota', { cause: error });
    case 'VersionError':
      return new VaultError('version-too-new', { cause: error });
    case 'AbortError':
      return new VaultError('aborted', { cause: error });
    case 'InvalidStateError':
      return new VaultError('closed', { cause: error });
    default:
      return new VaultError(fallback, { cause: error });
  }
}
