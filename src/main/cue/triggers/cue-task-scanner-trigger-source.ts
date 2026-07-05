/**
 * Trigger source for `task.pending` subscriptions.
 *
 * Thin wrapper around `createCueTaskScanner` that adapts its callback shape
 * to the {@link CueTriggerSource} interface and routes events through the
 * centralized `passesFilter` helper before emitting.
 *
 * Unlike the `file.changed` and `github.*` sources, the task scanner is
 * intentionally NOT gated on the Cue visibility flag (`isCueActive`). A
 * `task.pending` subscription is the unattended-automation case the feature
 * exists for: the app window is usually backgrounded while a queue drains, so
 * pausing the scan while hidden stalls exactly the workflow the user wants
 * running. The scan itself is a cheap 1-minute poll of a single glob, so the
 * CPU cost of keeping it live while hidden is negligible. See issue #1164.
 */

import { createCueTaskScanner } from '../cue-task-scanner';
import { passesFilter } from './cue-trigger-filter';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

const DEFAULT_TASK_POLL_MINUTES = 1;

export function createCueTaskScannerTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	const watchGlob = ctx.subscription.watch;
	if (!watchGlob) return null;

	let cleanup: (() => void) | null = null;

	return {
		start() {
			if (cleanup) return; // idempotent
			cleanup = createCueTaskScanner({
				watchGlob,
				pollMinutes: ctx.subscription.poll_minutes ?? DEFAULT_TASK_POLL_MINUTES,
				projectRoot: ctx.session.projectRoot,
				triggerName: ctx.subscription.name,
				onLog: (level, message) => ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message),
				// Deliberately no `isActive` gate (see the file header): task.pending
				// must keep scanning while the window is hidden.
				onEvent: (event) => {
					if (!ctx.enabled()) return;
					if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

					ctx.onLog(
						'cue',
						`[CUE] "${ctx.subscription.name}" triggered (task.pending: ${event.payload.taskCount} task(s) in ${event.payload.filename})`
					);
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
			// Task scanners poll on a fixed interval but the next *fire* depends
			// on whether any matching files have pending tasks (not predictable).
			return null;
		},
	};
}
