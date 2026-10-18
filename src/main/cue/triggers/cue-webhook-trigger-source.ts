/**
 * Trigger source for `webhook.received` subscriptions.
 *
 * Owns nothing of its own: it claims a path on the shared local webhook
 * listener (`cue-webhook-server`) and converts each authenticated delivery
 * into a `CueEvent`. The listener handles binding, routing, and auth; this
 * file only handles secret resolution and payload shaping; the filter check and
 * the SusFactor gate on GitHub text (`guardWebhookEvent` in `cue-susfactor.ts`)
 * run through the shared `cue-guarded-emit.ts`.
 *
 * There is no `nextTriggerAt()` - like file watchers, a webhook fires on
 * demand and has no schedule to report.
 */

import { normalizeWebhookPath } from '../../../shared/cue';
import { createCueEvent } from '../cue-types';
import { extractWebhookScorableText, guardWebhookEvent } from '../cue-susfactor';
import {
	buildCueWebhookUrl,
	CueWebhookUnavailableError,
	registerCueWebhook,
	type CueWebhookDelivery,
} from '../cue-webhook-server';
import { createCueGuardedEmitter, isFinalEmitOutcome } from './cue-guarded-emit';
import {
	describeSecretProblem,
	lookupSecret,
	type SecretLookupOptions,
} from '../../../shared/serverSecrets';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

/**
 * Resolve the subscription's shared secret. `secret_env` wins over a literal
 * `secret` so a project can commit the variable name and keep the value out of
 * git. The name is looked up the way every server secret is: a systemd
 * credential, then `/run/secrets/<NAME>`, then the environment
 * (`src/shared/serverSecrets.ts`). Returns the reason when nothing usable is
 * found, which leaves the subscription unregistered rather than listening
 * without authentication. Never logs the value. `options` is for tests.
 */
export function resolveWebhookSecret(
	webhook: {
		secret?: string;
		secret_env?: string;
	},
	options?: SecretLookupOptions
): { secret: string } | { secret: null; reason?: string } {
	if (webhook.secret_env) {
		const lookup = lookupSecret(webhook.secret_env, options);
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

	// Filter, SusFactor and emit; its settle() is what the drain waits on.
	const emitter = createCueGuardedEmitter(ctx);

	/**
	 * Take one delivery. The listener answers 2xx only once this resolves,
	 * which is after the event reached the run manager or was deliberately
	 * dropped (filter, SusFactor). Scoring therefore runs BEFORE the answer: a
	 * crash while scoring leaves the sender without a 2xx and the delivery
	 * unrecorded, so its retry is handled. A block is still answered 2xx and
	 * is visible only in Maestro (log, toast, cue_susfactor_blocks).
	 */
	async function handleDelivery(delivery: CueWebhookDelivery, accepted: () => void): Promise<void> {
		const event = createCueEvent('webhook.received', ctx.subscription.name, buildPayload(delivery));
		const label = delivery.event ? `webhook.received: ${delivery.event}` : 'webhook.received';
		const outcome = await emitter.emit(event, {
			label,
			scorableText: extractWebhookScorableText(event.payload),
			guard: guardWebhookEvent,
			onOutcome: (result) => {
				if (isFinalEmitOutcome(result)) accepted();
			},
		});
		if (outcome === 'blocked') {
			ctx.onLog(
				'error',
				`[CUE] "${ctx.subscription.name}" webhook delivery dropped by SusFactor (${label})`
			);
		}
		// The listener has no view of the engine's enabled flag: a delivery that
		// lands while Cue is off or stopping is not taken, and is answered 503.
		if (outcome === 'not-running') throw new CueWebhookUnavailableError();
		if (!isFinalEmitOutcome(outcome)) throw new Error('dispatch failed');
	}

	return {
		start() {
			if (unregister) return; // idempotent

			unregister = registerCueWebhook({
				id: `${ctx.session.id}:${ctx.subscription.name}`,
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

		settle() {
			return emitter.settle();
		},
	};
}
