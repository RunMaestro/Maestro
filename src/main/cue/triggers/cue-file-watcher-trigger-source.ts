/**
 * Trigger source for `file.changed` subscriptions.
 *
 * Thin wrapper around `createCueFileWatcher` that adapts its callback shape
 * to the {@link CueTriggerSource} interface and routes events through the
 * centralized `passesFilter` helper before emitting.
 */

import { createCueFileWatcher } from '../cue-file-watcher';
import { passesFilter } from './cue-trigger-filter';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

const DEFAULT_FILE_DEBOUNCE_MS = 5000;

export function createCueFileWatcherTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	const watchGlob = ctx.subscription.watch;
	if (!watchGlob) return null;

	let cleanup: (() => void) | null = null;

	return {
		start() {
			if (cleanup) return; // idempotent
			cleanup = createCueFileWatcher({
				watchGlob,
				projectRoot: ctx.session.projectRoot,
				debounceMs: DEFAULT_FILE_DEBOUNCE_MS,
				triggerName: ctx.subscription.name,
				onLog: (level, message) => ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message),
				onEvent: (event) => {
					if (!ctx.enabled()) return;
					if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

					ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (file.changed)`);
					ctx.emit(event);
				},
			});
		},

		stop() {
			if (cleanup) {
				cleanup();
				cleanup = null;
			}
		},

		nextTriggerAt() {
			// File watchers fire on demand — there is no scheduled "next" time.
			return null;
		},
	};
}
