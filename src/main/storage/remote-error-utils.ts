/**
 * Shared helpers for classifying remote-fs (SSH) failures.
 *
 * Used by session storages that read agent transcripts over SSH so expected
 * not-found / permission misses stay quiet while unexpected failures can be
 * reported to Sentry.
 */

/** True when a remote-fs error is a benign not-found/permission miss vs unexpected SSH failure. */
export function isExpectedRemoteError(error?: string): boolean {
	if (!error) return false;
	const lower = error.toLowerCase();
	return (
		lower.includes('not found') ||
		lower.includes('not accessible') ||
		lower.includes('no such file') ||
		lower.includes('permission denied') ||
		lower.includes('does not exist')
	);
}
