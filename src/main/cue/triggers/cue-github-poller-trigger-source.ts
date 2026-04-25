/**
 * Trigger source for `github.pull_request` and `github.issue` subscriptions.
 *
 * Thin wrapper around `createCueGitHubPoller` that adapts its callback shape
 * to the {@link CueTriggerSource} interface and routes events through the
 * centralized `passesFilter` helper before emitting.
 */

import { createCueGitHubPoller } from '../cue-github-poller';
import { passesFilter } from './cue-trigger-filter';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

const DEFAULT_GITHUB_POLL_MINUTES = 5;

export function createCueGitHubPollerTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	const eventType = ctx.subscription.event;
	if (eventType !== 'github.pull_request' && eventType !== 'github.issue') {
		return null;
	}

	if (!ctx.subscription.repo) {
		return null;
	}

	let cleanup: (() => void) | null = null;

	return {
		start() {
			if (cleanup) return; // idempotent
			cleanup = createCueGitHubPoller({
				eventType,
				repo: ctx.subscription.repo,
				pollMinutes: ctx.subscription.poll_minutes ?? DEFAULT_GITHUB_POLL_MINUTES,
				projectRoot: ctx.session.projectRoot,
				triggerName: ctx.subscription.name,
				subscriptionId: `${ctx.session.id}:${ctx.subscription.name}`,
				ghState: ctx.subscription.gh_state,
				onLog: (level, message) => ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message),
				onEvent: (event) => {
					if (!ctx.enabled()) return;
					if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

					ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (${eventType})`);
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
			// GitHub pollers fire whenever a matching PR/issue appears upstream —
			// no predictable next-fire time.
			return null;
		},
	};
}
