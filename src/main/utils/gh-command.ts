import { resolveGhPath } from './cliDetection';
import { getSettingsStore } from '../stores/getters';
import { isInitialized } from '../stores/instances';

/**
 * Resolve the gh binary to invoke.
 *
 * Honours the user's configured Settings > GitHub CLI (gh) Path, falling back to
 * auto-detection. Every gh call that should respect that setting must go
 * through here: a bare 'gh' literal silently ignores it, which is the whole
 * reason it exists for installs where gh is not on the expanded PATH.
 */
export async function resolveConfiguredGhCommand(): Promise<string> {
	// Guard on the predicate rather than catching. The stores genuinely are not
	// initialised in every context (unit tests, early startup), and falling back
	// to auto-detection there is correct, but a blanket catch would also swallow
	// a real store failure and silently run some other binary.
	if (!isInitialized()) {
		return resolveGhPath();
	}

	const configured = getSettingsStore().get('ghPath');
	const customPath =
		typeof configured === 'string' && configured.trim() ? configured.trim() : undefined;
	return resolveGhPath(customPath);
}
