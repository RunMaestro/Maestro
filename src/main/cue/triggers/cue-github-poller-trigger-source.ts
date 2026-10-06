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
import { guardGitHubEvent } from '../cue-susfactor';
import { DEFAULT_CUE_SETTINGS, type CueEvent } from '../cue-types';
import { buildCueWebhookUrl, registerCueWebhook } from '../cue-webhook-server';
import { passesFilter } from './cue-trigger-filter';
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
	let getPollerRepo: (() => string | null) | null = null;
	let unregisterWebhook: (() => void) | null = null;

	/** Filter, score, then emit one event, whichever source produced it. */
	function dispatch(event: CueEvent): void {
		if (!ctx.enabled()) return;
		if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

		// SusFactor is the only async gate in this path, and the poller
		// ignores onEvent's return value, so the emit is deferred into the
		// promise rather than made to block the poll loop. The guard never
		// rejects and fails open, so a 0DIN outage degrades to today's
		// behaviour instead of stalling the subscription.
		const settings = ctx.registry.get(ctx.session.id)?.config.settings;
		void guardGitHubEvent({
			event,
			sessionId: ctx.session.id,
			subscriptionId,
			subscriptionName: ctx.subscription.name,
			enabled: settings?.susfactor_enabled !== false,
			threshold: settings?.susfactor_threshold ?? DEFAULT_CUE_SETTINGS.susfactor_threshold ?? 0.95,
			onLog: (level, message) => ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message),
		}).then((allowed) => {
			if (!allowed) return;
			ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (${eventType})`);
			ctx.emit(event);
		});
	}

	/** Register on the shared webhook listener, or explain why not. */
	function startWebhook(): void {
		if (!webhook) return;
		const path = normalizeWebhookPath(webhook.path || ctx.subscription.name);
		const secret = resolveWebhookSecret(webhook);
		if (!path || !secret) {
			ctx.onLog(
				'error',
				`[CUE] "${ctx.subscription.name}" GitHub webhook not started: ` +
					(path
						? `no secret resolved${webhook.secret_env ? ` (env var "${webhook.secret_env}" is unset or empty)` : ''}`
						: 'the webhook path has no letters or digits') +
					' - polling continues'
			);
			return;
		}

		const rawCap = ctx.subscription.max_notifications ?? DEFAULT_MAX_NOTIFICATIONS;
		unregisterWebhook = registerCueWebhook({
			path,
			secret,
			signatureHeader: webhook.signature_header || GITHUB_SIGNATURE_HEADER,
			onLog: ctx.onLog,
			onDelivery: (delivery) => {
				// The listener has no view of the engine's enabled flag.
				if (!ctx.enabled()) return;
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
				for (const event of result.events) dispatch(event);
				if (result.needsSeed) pollNowFn?.();
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
	};
}
