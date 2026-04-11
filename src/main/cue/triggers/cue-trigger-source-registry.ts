/**
 * Factory that maps a Cue event type to its trigger source implementation.
 *
 * Replaces the imperative if/else ladder that previously lived in
 * `cue-session-runtime-service.ts:131-146`. The runtime now iterates a
 * subscription list, calls `createTriggerSource(eventType, ctx)`, and pushes
 * the returned source onto the session's `triggerSources` array — no more
 * per-event-type setup functions.
 *
 * Returns `null` when:
 *  - the event type has no corresponding source (e.g. `agent.completed`,
 *    `app.startup` — those are handled directly by the runtime, not via a
 *    timer/watcher)
 *  - the subscription is missing required fields (e.g. `time.heartbeat`
 *    without `interval_minutes`, `file.changed` without `watch`)
 *
 * The runtime treats `null` as "no source needed" and continues silently.
 */

import type { CueEventType } from '../cue-types';
import { createCueFileWatcherTriggerSource } from './cue-file-watcher-trigger-source';
import { createCueGitHubPollerTriggerSource } from './cue-github-poller-trigger-source';
import { createCueHeartbeatTriggerSource } from './cue-heartbeat-trigger-source';
import { createCueScheduledTriggerSource } from './cue-scheduled-trigger-source';
import { createCueTaskScannerTriggerSource } from './cue-task-scanner-trigger-source';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

export function createTriggerSource(
	eventType: CueEventType,
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	switch (eventType) {
		case 'time.heartbeat':
			return createCueHeartbeatTriggerSource(ctx);
		case 'time.scheduled':
			return createCueScheduledTriggerSource(ctx);
		case 'file.changed':
			return createCueFileWatcherTriggerSource(ctx);
		case 'task.pending':
			return createCueTaskScannerTriggerSource(ctx);
		case 'github.pull_request':
		case 'github.issue':
			return createCueGitHubPollerTriggerSource(ctx);
		case 'agent.completed':
		case 'app.startup':
		case 'cli.trigger':
			// These are not timer/watcher-driven ��� the runtime handles them
			// directly via the completion service / startup loop / CLI command.
			return null;
		default: {
			const unsupported: never = eventType;
			console.warn(`[CUE] createTriggerSource: unsupported event type "${unsupported}"`);
			return null;
		}
	}
}
