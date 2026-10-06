/**
 * Trigger source for `webhook.received` subscriptions.
 *
 * Owns nothing of its own: it claims a path on the shared local webhook
 * listener (`cue-webhook-server`) and converts each authenticated delivery
 * into a `CueEvent`. The listener handles binding, routing, and auth; this
 * file only handles secret resolution, payload shaping, the filter check, and
 * the SusFactor gate on GitHub text (`guardWebhookEvent` in `cue-susfactor.ts`).
 *
 * There is no `nextTriggerAt()` - like file watchers, a webhook fires on
 * demand and has no schedule to report.
 */

import { normalizeWebhookPath } from '../../../shared/cue';
import { createCueEvent, DEFAULT_CUE_SETTINGS } from '../cue-types';
import { extractWebhookScorableText, guardWebhookEvent, wouldScoreText } from '../cue-susfactor';
import {
	buildCueWebhookUrl,
	registerCueWebhook,
	type CueWebhookDelivery,
} from '../cue-webhook-server';
import { passesFilter } from './cue-trigger-filter';
import { describeSecretProblem, lookupSecret } from '../../../shared/serverSecrets';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

/**
 * Resolve the subscription's shared secret. `secret_env` wins over a literal
 * `secret` so a project can commit the variable name and keep the value out of
 * git. The name is looked up the way every server secret is: a systemd
 * credential, then `/run/secrets/<NAME>`, then the environment
 * (`src/shared/serverSecrets.ts`). Returns the reason when nothing usable is
 * found, which leaves the subscription unregistered rather than listening
 * without authentication. Never logs the value.
 */
export function resolveWebhookSecret(webhook: {
	secret?: string;
	secret_env?: string;
}): { secret: string } | { secret: null; reason?: string } {
	if (webhook.secret_env) {
		const lookup = lookupSecret(webhook.secret_env);
		if (lookup.status === 'found') return { secret: lookup.value };
		if (lookup.status === 'missing') {
			return {
				secret: null,
				reason: `"${webhook.secret_env}" is not set in $CREDENTIALS_DIRECTORY, /run/secrets or the environment`,
			};
		}
		return {
			secret: null,
			reason: describeSecretProblem({ name: webhook.secret_env, ...lookup }),
		};
	}
	if (webhook.secret && webhook.secret.length > 0) return { secret: webhook.secret };
	return { secret: null };
}

/**
 * Flatten a delivery into the event payload.
 *
 * Everything a filter might want lives at a stable key, and `matchesFilter`
 * resolves dot-notation, so `filter: { "body.action": opened }` and
 * `filter: { webhook_event: pull_request }` both work without the payload
 * needing per-vendor shaping.
 */
function buildPayload(delivery: CueWebhookDelivery): Record<string, unknown> {
	return {
		path: delivery.path,
		webhook_event: delivery.event,
		delivery_id: delivery.deliveryId,
		received_at: delivery.receivedAt,
		headers: delivery.headers,
		body: delivery.body,
		raw_body: delivery.rawBody,
	};
}

export function createCueWebhookTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	const webhook = ctx.subscription.webhook;
	if (!webhook) return null;

	// Falling back to the subscription name keeps the common case config-free:
	// `event: webhook.received` plus a secret is enough to get a working URL.
	const path = normalizeWebhookPath(webhook.path || ctx.subscription.name);
	if (!path) return null;

	const resolved = resolveWebhookSecret(webhook);
	if (resolved.secret === null) {
		ctx.onLog(
			'error',
			`[CUE] "${ctx.subscription.name}" webhook not started: no secret resolved` +
				('reason' in resolved && resolved.reason ? ` (${resolved.reason})` : '')
		);
		return null;
	}
	const secret = resolved.secret;

	const signatureHeader = webhook.signature_header;
	let unregister: (() => void) | null = null;

	function handleDelivery(delivery: CueWebhookDelivery): void {
		// The listener has no view of the engine's enabled flag, so gate here -
		// a delivery that lands while Cue is off must not dispatch a run.
		if (!ctx.enabled()) return;

		const event = createCueEvent('webhook.received', ctx.subscription.name, buildPayload(delivery));

		if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

		const label = delivery.event ? `webhook.received: ${delivery.event}` : 'webhook.received';
		const emitEvent = () => {
			ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (${label})`);
			ctx.emit(event);
		};

		// SusFactor, read exactly as the GitHub poller reads it. A delivery with
		// nothing to score (scoring off, no token, no GitHub text) emits at once.
		const settings = ctx.registry.get(ctx.session.id)?.config.settings;
		const enabled = settings?.susfactor_enabled !== false;
		const threshold =
			settings?.susfactor_threshold ?? DEFAULT_CUE_SETTINGS.susfactor_threshold ?? 0.95;
		if (!wouldScoreText(enabled, extractWebhookScorableText(event.payload))) {
			emitEvent();
			return;
		}

		// Scoring runs AFTER the listener has answered 202: the sender has
		// already been told the delivery was accepted, so a block is visible
		// only in Maestro (log, toast, cue_susfactor_blocks), never to the
		// sender. Fire-and-forget, so every failure is caught here rather than
		// surfacing as an unhandled rejection; the guard itself fails open.
		void (async () => {
			try {
				const allowed = await guardWebhookEvent({
					event,
					sessionId: ctx.session.id,
					subscriptionId: `${ctx.session.id}:${ctx.subscription.name}`,
					subscriptionName: ctx.subscription.name,
					enabled,
					threshold,
					onLog: (level, message) => ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message),
				});
				if (!allowed) {
					ctx.onLog(
						'error',
						`[CUE] "${ctx.subscription.name}" webhook delivery dropped by SusFactor (${label})`
					);
					return;
				}
				// Cue may have been switched off while the score was in flight.
				if (!ctx.enabled()) return;
				emitEvent();
			} catch (err) {
				ctx.onLog(
					'error',
					`[CUE] "${ctx.subscription.name}" webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`
				);
			}
		})();
	}

	return {
		start() {
			if (unregister) return; // idempotent

			unregister = registerCueWebhook({
				path,
				secret,
				signatureHeader,
				onDelivery: handleDelivery,
				onLog: ctx.onLog,
			});

			ctx.onLog(
				'cue',
				`[CUE] "${ctx.subscription.name}" listening for webhooks at ${buildCueWebhookUrl(path)}`
			);
		},

		stop() {
			if (unregister) {
				unregister();
				unregister = null;
			}
		},

		nextTriggerAt() {
			return null;
		},
	};
}
