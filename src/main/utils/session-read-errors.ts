/**
 * Shared classifier for failures reading a provider transcript off disk.
 *
 * Lives here rather than next to any one caller because the same boundary is
 * hit from three layers - the storage implementations (`src/main/storage/`),
 * the per-provider IPC handlers, and the global stats loops. `src/main/storage`
 * cannot import from `src/main/ipc/handlers` without creating a require cycle
 * (handlers -> agents -> storage), so the predicate needs a dependency-free home.
 */

/**
 * Node fs error codes we expect when reading a provider transcript we merely
 * discovered on disk. The file belongs to the agent CLI, not to us: it can be
 * unreadable (restrictive umask, a `~/.claude` tree owned by another user),
 * deleted between the directory listing and the read, or briefly locked on
 * Windows. These are environmental, never a Maestro bug, so we keep the local
 * warn but skip Sentry to avoid telemetry noise (MAESTRO-W9, MAESTRO-YG/YH/YJ).
 * Same shape as the `RangeError` carve-out at the call sites: classify the
 * expected boundary, log it locally, and let everything else report.
 */
const EXPECTED_SESSION_READ_ERROR_CODES = new Set([
	'EACCES',
	'EPERM',
	'ENOENT',
	'ENOTDIR',
	'EISDIR',
	'EBUSY',
]);

export function isExpectedSessionReadError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return typeof code === 'string' && EXPECTED_SESSION_READ_ERROR_CODES.has(code);
}
