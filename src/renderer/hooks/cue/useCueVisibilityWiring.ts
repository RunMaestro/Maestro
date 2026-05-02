/**
 * useCueVisibilityWiring.ts
 *
 * Forwards the renderer's visibilitychange events to the main-process Cue
 * scanner subsystem so it can pause expensive background work (file walks,
 * gh CLI fetches, file-event dispatch) while the app is hidden.
 *
 * Mounts once in App.tsx. The hook is fire-and-forget: failures to invoke
 * `cue:setActive` are logged at debug level — the worst case is the
 * scanners stay running, which is the pre-existing behavior.
 *
 * See CLAUDE-PERFORMANCE.md§"Visibility-Aware Operations" and PR-B 1.4.
 */

import { useEffect } from 'react';
import { useEventListener } from '../utils/useEventListener';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

function notifyMain(active: boolean): void {
	const cue = window.maestro?.cue;
	if (!cue || typeof cue.setActive !== 'function') return;
	cue.setActive(active).catch((err: unknown) => {
		logger.debug('[Cue] setActive IPC failed', undefined, err);
		// Fail-soft locally (worst case scanners stay running, which is the
		// pre-existing behavior) but surface to Sentry — repeated failures
		// would otherwise be invisible. Per CLAUDE.md §"Error Handling & Sentry".
		captureException(err instanceof Error ? err : new Error(String(err)), {
			extra: { operation: 'cue.setActive', active },
		});
	});
}

export function useCueVisibilityWiring(): void {
	// Seed the main process with the current visibility state on mount.
	// Without this, a renderer that starts up while the window is hidden
	// would leave Cue active until the first visibilitychange event fires.
	useEffect(() => {
		notifyMain(!document.hidden);
	}, []);

	useEventListener(
		'visibilitychange',
		() => {
			notifyMain(!document.hidden);
		},
		{ target: document }
	);
}
