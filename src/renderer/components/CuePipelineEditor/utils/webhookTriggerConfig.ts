/**
 * The `webhook` block on a subscription, as the pipeline editor stores it on a
 * trigger node (`webhook_*` config keys) and writes it back to YAML.
 *
 * `webhook.received` triggers always carry one. GitHub triggers may carry one
 * to take webhook deliveries alongside polling, and must keep it through an
 * editor save even though most never set it.
 */

import type { CueSubscription } from '../../../../shared/cue';
import type { TriggerNodeData } from '../../../../shared/cue-pipeline-types';

type TriggerConfig = TriggerNodeData['config'];

/** Copy a subscription's `webhook` block onto a trigger node's config. */
export function applyWebhookToTriggerConfig(
	webhook: CueSubscription['webhook'],
	config: TriggerConfig
): void {
	// A literal `secret` is hydrated (and re-emitted on save) purely so the
	// editor doesn't strip a hand-written one off disk. The panel shows it
	// read-only; new triggers always get `secret_env`.
	if (webhook?.secret != null) config.webhook_secret = webhook.secret;
	if (webhook?.path != null) config.webhook_path = webhook.path;
	if (webhook?.secret_env != null) config.webhook_secret_env = webhook.secret_env;
	if (webhook?.signature_header != null) config.webhook_signature_header = webhook.signature_header;
}

/** True when a trigger node carries any webhook setting. */
export function hasWebhookTriggerConfig(config: TriggerConfig): boolean {
	return Boolean(
		config.webhook_path ||
		config.webhook_secret_env ||
		config.webhook_secret ||
		config.webhook_signature_header
	);
}

/** Build the `webhook` block from a trigger node's config. */
export function webhookFromTriggerConfig(
	config: TriggerConfig
): NonNullable<CueSubscription['webhook']> {
	const webhook: NonNullable<CueSubscription['webhook']> = {};
	if (config.webhook_path) webhook.path = config.webhook_path;
	// `secret` and `secret_env` are mutually exclusive in the schema, so emit
	// the literal only when the trigger has no env var - that's the
	// hand-written-YAML case being preserved rather than encouraged.
	if (config.webhook_secret_env) {
		webhook.secret_env = config.webhook_secret_env;
	} else if (config.webhook_secret) {
		webhook.secret = config.webhook_secret;
	}
	if (config.webhook_signature_header) webhook.signature_header = config.webhook_signature_header;
	return webhook;
}
