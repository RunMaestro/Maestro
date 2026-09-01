/**
 * Trigger source for `github.pull_request` and `github.issue` subscriptions.
 *
 * Thin wrapper around `createCueGitHubPoller` that adapts its callback shape
 * to the {@link CueTriggerSource} interface and routes events through the
 * centralized `passesFilter` helper before emitting.
 */

import { isCueActive } from '../cue-active-state';
import { createCueGitHubPoller } from '../cue-github-poller';
import { guardGitHubEvent } from '../cue-susfactor';
import { DEFAULT_CUE_SETTINGS } from '../cue-types';
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
	let pollNowFn: (() => void) | null = null;

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
				retriggerOnComments: ctx.subscription.retrigger_on_comments === true,
				maxNotifications: ctx.subscription.max_notifications,
				onLog: (level, message) => ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message),
				isActive: isCueActive,
				onEvent: (event) => {
					if (!ctx.enabled()) return;
					if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

					// SusFactor is the only async gate in this path, and the poller
					// ignores onEvent's return value, so the emit is deferred into
					// the promise rather than made to block the poll loop. The
					// guard never rejects and fails open, so a 0DIN outage degrades
					// to today's behaviour instead of stalling the subscription.
					const settings = ctx.registry.get(ctx.session.id)?.config.settings;
					void guardGitHubEvent({
						event,
						sessionId: ctx.session.id,
						subscriptionId: `${ctx.session.id}:${ctx.subscription.name}`,
						subscriptionName: ctx.subscription.name,
						enabled: settings?.susfactor_enabled !== false,
						threshold:
							settings?.susfactor_threshold ?? DEFAULT_CUE_SETTINGS.susfactor_threshold ?? 0.95,
						onLog: (level, message) => ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message),
					}).then((allowed) => {
						if (!allowed) return;
						ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (${eventType})`);
						ctx.emit(event);
					});
				},
				onReady: (handle) => {
					pollNowFn = handle.pollNow;
				},
			});
		},

		stop() {
			if (cleanup) {
				cleanup();
				cleanup = null;
			}
			pollNowFn = null;
		},

		nextTriggerAt() {
			// GitHub pollers fire whenever a matching PR/issue appears upstream -
			// no predictable next-fire time.
			return null;
		},

		pollNow() {
			pollNowFn?.();
		},
	};
}
