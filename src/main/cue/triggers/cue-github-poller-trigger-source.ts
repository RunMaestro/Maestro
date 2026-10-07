/**
 * Trigger source for `github.pull_request`, `github.issue`, and `github.label`
 * subscriptions.
 *
 * Polls through `createCueGitHubPoller`. A subscription with a `webhook` block
 * also takes GitHub webhook deliveries on the shared Cue webhook listener, and
 * the poller then keeps running at a slower rate as a reconcile. Both paths
 * decide and record items through `cue-github-items.ts`, so a change that
 * arrives both ways fires once. Every event goes through the centralized
 * `passesFilter` helper and the SusFactor guard before it is emitted.
 */

import { normalizeWebhookPath } from '../../../shared/cue';
import { isCueActive } from '../cue-active-state';
import { DEFAULT_MAX_NOTIFICATIONS } from '../cue-github-items';
import { createCueGitHubPoller } from '../cue-github-poller';
import { GITHUB_SIGNATURE_HEADER, handleGitHubWebhookDelivery } from '../cue-github-webhook';
import { extractGitHubScorableText, guardGitHubEvent } from '../cue-susfactor';
import type { CueEvent } from '../cue-types';
import {
	buildCueWebhookUrl,
	CueWebhookUnavailableError,
	registerCueWebhook,
} from '../cue-webhook-server';
import {
	createCueGuardedEmitter,
	isFinalEmitOutcome,
	type CueEmitOutcome,
} from './cue-guarded-emit';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';
import { resolveWebhookSecret } from './cue-webhook-trigger-source';

const DEFAULT_GITHUB_POLL_MINUTES = 5;

/**
 * Poll interval when webhooks deliver changes as they happen. The poll is then
 * only a reconcile for deliveries that never arrived (a tunnel outage, a
 * webhook added after the fact), so it can run far less often.
 */
export const DEFAULT_GITHUB_RECONCILE_MINUTES = 30;

export function createCueGitHubPollerTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	const subscribedEvent = ctx.subscription.event;
	if (
		subscribedEvent !== 'github.pull_request' &&
		subscribedEvent !== 'github.issue' &&
		subscribedEvent !== 'github.label'
	) {
		return null;
	}
	// A typed copy: closures below do not keep the narrowing above.
	const eventType: 'github.pull_request' | 'github.issue' | 'github.label' = subscribedEvent;

	if (!ctx.subscription.repo) {
		return null;
	}

	const subscriptionId = `${ctx.session.id}:${ctx.subscription.name}`;
	const webhook = ctx.subscription.webhook;

	let cleanup: (() => void) | null = null;
	let pollNowFn: (() => void) | null = null;
	// Filter, SusFactor and emit for both the poller and webhook deliveries;
	// its settle() is what the drain waits on.
	const emitter = createCueGuardedEmitter(ctx);
	let getPollerRepo: (() => string | null) | null = null;
	let unregisterWebhook: (() => void) | null = null;

	/** Filter, score, then emit one event, whichever source produced it. */
	function dispatch(event: CueEvent, onOutcome: (outcome: CueEmitOutcome) => void): void {
		void emitter.emit(event, {
			label: eventType,
			scorableText: extractGitHubScorableText(event.payload),
			guard: guardGitHubEvent,
			onOutcome,
		});
	}

	/** Register on the shared webhook listener, or explain why not. */
	function startWebhook(): void {
		if (!webhook) return;
		const path = normalizeWebhookPath(webhook.path || ctx.subscription.name);
		const resolved = resolveWebhookSecret(webhook);
		if (!path || resolved.secret === null) {
			ctx.onLog(
				'error',
				`[CUE] "${ctx.subscription.name}" GitHub webhook not started: ` +
					(path
						? 'no secret resolved' +
							('reason' in resolved && resolved.reason ? ` (${resolved.reason})` : '')
						: 'the webhook path has no letters or digits') +
					' - polling continues'
			);
			return;
		}
		const secret = resolved.secret;

		const rawCap = ctx.subscription.max_notifications ?? DEFAULT_MAX_NOTIFICATIONS;
		unregisterWebhook = registerCueWebhook({
			id: subscriptionId,
			path,
			secret,
			signatureHeader: webhook.signature_header || GITHUB_SIGNATURE_HEADER,
			onLog: ctx.onLog,
			onDelivery: async (delivery, accepted) => {
				// The listener has no view of the engine's enabled flag. Not
				// running means not taken: a 503, so the sender retries.
				if (!ctx.enabled()) throw new CueWebhookUnavailableError();
				const result = handleGitHubWebhookDelivery(
					{
						eventType,
						triggerName: ctx.subscription.name,
						subscriptionId,
						repo: ctx.subscription.repo ?? getPollerRepo?.() ?? null,
						ghState: ctx.subscription.gh_state,
						labelTarget: ctx.subscription.gh_label_target,
						watchLabels: ctx.subscription.gh_labels,
						retriggerOnComments: ctx.subscription.retrigger_on_comments === true,
						cap: rawCap <= 0 ? Infinity : rawCap,
					},
					delivery
				);
				if (result.note) {
					ctx.onLog('info', `[CUE] "${ctx.subscription.name}" webhook: ${result.note}`);
				}
				if (result.needsSeed || result.pollNow) pollNowFn?.();
				// The delivery is answered once its event has reached the run
				// manager (or was deliberately dropped), and the change and the
				// delivery id are recorded as handled in that same step.
				let remaining = result.events.length;
				let allFinal = true;
				const outcomes = await Promise.all(
					result.events.map(
						(event) =>
							new Promise<CueEmitOutcome>((resolve) =>
								dispatch(event, (outcome) => {
									if (isFinalEmitOutcome(outcome)) result.reservation?.commit();
									else {
										allFinal = false;
										result.reservation?.release();
									}
									// The last outcome records the delivery id, inside the
									// work the drain waits on.
									if (--remaining === 0 && allFinal) accepted();
									resolve(outcome);
								})
							)
					)
				);
				if (outcomes.includes('not-running')) throw new CueWebhookUnavailableError();
				if (!outcomes.every(isFinalEmitOutcome)) throw new Error('dispatch failed');
			},
		});
		ctx.onLog(
			'cue',
			`[CUE] "${ctx.subscription.name}" listening for GitHub webhooks at ${buildCueWebhookUrl(path)}`
		);
	}

	return {
		start() {
			if (cleanup) return; // idempotent
			cleanup = createCueGitHubPoller({
				eventType,
				repo: ctx.subscription.repo,
				pollMinutes:
					ctx.subscription.poll_minutes ??
					(webhook ? DEFAULT_GITHUB_RECONCILE_MINUTES : DEFAULT_GITHUB_POLL_MINUTES),
				projectRoot: ctx.session.projectRoot,
				triggerName: ctx.subscription.name,
				subscriptionId,
				ghState: ctx.subscription.gh_state,
				labelTarget: ctx.subscription.gh_label_target,
				watchLabels: ctx.subscription.gh_labels,
				retriggerOnComments: ctx.subscription.retrigger_on_comments === true,
				maxNotifications: ctx.subscription.max_notifications,
				onLog: (level, message) => ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message),
				isActive: isCueActive,
				onEvent: dispatch,
				onReady: (handle) => {
					pollNowFn = handle.pollNow;
					getPollerRepo = handle.getRepo;
				},
			});
			startWebhook();
		},

		stop() {
			if (cleanup) {
				cleanup();
				cleanup = null;
			}
			if (unregisterWebhook) {
				unregisterWebhook();
				unregisterWebhook = null;
			}
			pollNowFn = null;
			getPollerRepo = null;
		},

		nextTriggerAt() {
			// GitHub pollers fire whenever a matching PR/issue appears upstream -
			// no predictable next-fire time.
			return null;
		},

		pollNow() {
			pollNowFn?.();
		},

		settle() {
			return emitter.settle();
		},
	};
}
