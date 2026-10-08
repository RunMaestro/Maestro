/**
 * Shared rules for "show only the providers this machine can actually run".
 *
 * Most of the providers Maestro supports are not installed on any given machine,
 * so listing all of them buries the two or three a user can pick behind a wall of
 * dimmed rows. Both provider pickers (the wizard's tile strip and the New Agent
 * modal's list) hide the rest by default and offer one toggle to bring them back.
 *
 * The rules live here rather than in either picker so the two cannot drift on the
 * part that matters: what the count means, and when filtering is unsafe.
 */

/**
 * Narrow a provider list to the ones that are installed.
 *
 * Returns everything when `showAll` is set, and ALSO when nothing is installed:
 * filtering there leaves a picker with no rows, which means no way to reach the
 * per-provider settings that would point Maestro at a binary in a non-standard
 * place, and no way to proceed. An empty picker is a dead end, so the full list
 * stands in for it.
 */
export function filterToAvailableProviders<T>(
	providers: T[],
	isAvailable: (provider: T) => boolean,
	showAll: boolean,
	/**
	 * Keep this provider regardless. The SELECTED provider must survive the
	 * filter even when it is not installed - duplicating an agent whose provider
	 * is missing from this machine would otherwise hide the very row that shows
	 * what is selected, and the picker would look like it has no selection.
	 */
	isPinned?: (provider: T) => boolean
): T[] {
	if (showAll) return providers;
	const available = providers.filter(
		(provider) => isAvailable(provider) || isPinned?.(provider) === true
	);
	return available.length > 0 ? available : providers;
}

/**
 * Where detection ran, as a phrase that can follow "available".
 *
 * Both pickers can point at an SSH remote, so "locally" is a claim about the
 * wrong machine whenever one is selected - the counts describe whatever host was
 * probed, not this one.
 */
export function providerLocationLabel(remoteHost?: string | null): string {
	return remoteHost ? `on ${remoteHost}` : 'locally';
}
