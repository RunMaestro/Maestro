/**
 * Cue domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: get_cue_subscriptions,
 * toggle_cue_subscription, set_cue_subscription_gate,
 * set_cue_subscription_injection_screen, get_cue_activity,
 * trigger_cue_subscription,
 * cue_pipeline_list, cue_pipeline_get, cue_pipeline_set, cue_pipeline_remove.
 */

import { logger } from '../../../utils/logger';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';
import {
	cueGateConditionProblem,
	parseCueGateOnUnavailable,
	type CueGateSetting,
} from '../../../../shared/cue/gate';
import {
	CUE_INJECTION_SCREEN_MODES,
	cueInjectionThresholdProblem,
	parseCueInjectionScreenMode,
	type CueInjectionScreenSetting,
} from '../../../../shared/cue/injection-screen';

/**
 * Handle get_cue_subscriptions message - fetch Cue subscriptions
 */
export function handleGetCueSubscriptions(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string | undefined;

	if (!ctx.callbacks.getCueSubscriptions) {
		ctx.sendError(client, 'Cue subscriptions not available');
		return;
	}

	ctx.callbacks
		.getCueSubscriptions(sessionId)
		.then((subscriptions) => {
			ctx.send(client, {
				type: 'cue_subscriptions',
				subscriptions,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to get Cue subscriptions: ${error.message}`);
		});
}

/**
 * Handle toggle_cue_subscription message - enable/disable a subscription
 */
export function handleToggleCueSubscription(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const subscriptionId = message.subscriptionId as string;
	const enabled = message.enabled as boolean;

	if (!subscriptionId) {
		ctx.sendError(client, 'Missing subscriptionId', { requestId: message.requestId });
		return;
	}

	if (typeof enabled !== 'boolean') {
		ctx.sendError(client, 'Missing or invalid enabled flag', { requestId: message.requestId });
		return;
	}

	if (!ctx.callbacks.toggleCueSubscription) {
		ctx.sendError(client, 'Cue toggle not available', { requestId: message.requestId });
		return;
	}

	ctx.callbacks
		.toggleCueSubscription(subscriptionId, enabled)
		.then((success) => {
			ctx.send(client, {
				type: 'toggle_cue_subscription_result',
				success,
				subscriptionId,
				enabled,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to toggle Cue subscription: ${error.message}`, {
				requestId: message.requestId,
			});
		});
}

/**
 * Handle set_cue_subscription_gate message - set or remove a subscription's
 * gate. `gate: null` removes it; `gate: "<condition>"` sets it, with an
 * optional `gateOnUnavailable` (`run` | `skip`).
 *
 * The message is checked here, before the engine is asked: the bridge is the
 * boundary, and a frame that is neither a removal nor a usable condition is
 * refused by name instead of being read as one of them. `gate` absent is NOT
 * a removal: a caller that dropped the field must not erase a gate.
 */
export function handleSetCueSubscriptionGate(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const subscriptionId = message.subscriptionId;
	if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
		ctx.sendError(client, 'Missing subscriptionId', { requestId: message.requestId });
		return;
	}

	let gate: CueGateSetting | null;
	if (message.gate === null) {
		gate = null;
	} else if (typeof message.gate === 'string') {
		const problem = cueGateConditionProblem(message.gate);
		if (problem) {
			ctx.sendError(client, problem, { requestId: message.requestId });
			return;
		}
		gate = { condition: message.gate };
		if (message.gateOnUnavailable !== undefined) {
			const onUnavailable = parseCueGateOnUnavailable(message.gateOnUnavailable);
			if (!onUnavailable) {
				ctx.sendError(client, 'Invalid gateOnUnavailable: must be "run" or "skip"', {
					requestId: message.requestId,
				});
				return;
			}
			gate.onUnavailable = onUnavailable;
		}
	} else {
		ctx.sendError(client, 'Missing gate: pass a condition, or null to remove the gate', {
			requestId: message.requestId,
		});
		return;
	}

	if (!ctx.callbacks.setCueSubscriptionGate) {
		ctx.sendError(client, 'Cue gate editing is not available', { requestId: message.requestId });
		return;
	}

	ctx.callbacks
		.setCueSubscriptionGate(subscriptionId, gate)
		.then((result) => {
			ctx.send(client, {
				type: 'set_cue_subscription_gate_result',
				success: result.ok,
				subscriptionId,
				...(result.ok ? { updated: result.updated } : { error: result.error }),
				gate: gate ? gate.condition.trim() : null,
				...(gate?.onUnavailable ? { gateOnUnavailable: gate.onUnavailable } : {}),
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to set the Cue gate: ${error.message}`, {
				requestId: message.requestId,
			});
		});
}

/**
 * Handle set_cue_subscription_injection_screen message - set a subscription's
 * prompt-injection screen: `mode` (`auto` | `on` | `off`) and an optional
 * `threshold` (above 0, at most 1).
 *
 * `mode` is required. A frame without it is refused instead of being read as
 * `auto`: that would turn off a screen someone set to `on`, on a caller's
 * dropped field.
 */
export function handleSetCueSubscriptionInjectionScreen(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const subscriptionId = message.subscriptionId;
	if (typeof subscriptionId !== 'string' || subscriptionId.length === 0) {
		ctx.sendError(client, 'Missing subscriptionId', { requestId: message.requestId });
		return;
	}

	const mode = parseCueInjectionScreenMode(message.mode);
	if (!mode) {
		ctx.sendError(client, `Invalid mode: must be one of ${CUE_INJECTION_SCREEN_MODES.join(', ')}`, {
			requestId: message.requestId,
		});
		return;
	}
	const setting: CueInjectionScreenSetting = { mode };
	if (message.threshold !== undefined) {
		const problem = cueInjectionThresholdProblem(message.threshold);
		if (problem) {
			ctx.sendError(client, problem, { requestId: message.requestId });
			return;
		}
		setting.threshold = message.threshold as number;
	}

	if (!ctx.callbacks.setCueSubscriptionInjectionScreen) {
		ctx.sendError(client, 'Cue injection screen editing is not available', {
			requestId: message.requestId,
		});
		return;
	}

	ctx.callbacks
		.setCueSubscriptionInjectionScreen(subscriptionId, setting)
		.then((result) => {
			ctx.send(client, {
				type: 'set_cue_subscription_injection_screen_result',
				success: result.ok,
				subscriptionId,
				...(result.ok ? { updated: result.updated } : { error: result.error }),
				mode: setting.mode,
				...(setting.threshold !== undefined ? { threshold: setting.threshold } : {}),
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to set the Cue injection screen: ${error.message}`, {
				requestId: message.requestId,
			});
		});
}

/**
 * Handle get_cue_activity message - fetch Cue activity log
 */
export function handleGetCueActivity(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string | undefined;
	const limit = (message.limit as number) ?? 50;

	if (!ctx.callbacks.getCueActivity) {
		ctx.sendError(client, 'Cue activity not available', { requestId: message.requestId });
		return;
	}

	ctx.callbacks
		.getCueActivity(sessionId, limit)
		.then((entries) => {
			ctx.send(client, {
				type: 'cue_activity',
				entries,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			ctx.sendError(client, `Failed to get Cue activity: ${error.message}`, {
				requestId: message.requestId,
			});
		});
}

/**
 * Handle trigger_cue_subscription message - manually trigger a Cue subscription
 */
export function handleTriggerCueSubscription(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const subscriptionName = message.subscriptionName;
	const prompt = message.prompt;

	if (typeof subscriptionName !== 'string' || subscriptionName.trim() === '') {
		ctx.sendError(client, 'Missing subscriptionName');
		return;
	}
	if (prompt !== undefined && typeof prompt !== 'string') {
		ctx.sendError(client, 'Invalid prompt: must be a string when provided');
		return;
	}

	if (!ctx.callbacks.triggerCueSubscription) {
		ctx.sendError(client, 'Cue trigger not available');
		return;
	}

	const rawSourceAgentId = message.sourceAgentId;
	if (rawSourceAgentId !== undefined && typeof rawSourceAgentId !== 'string') {
		ctx.sendError(client, 'Invalid sourceAgentId: must be a string when provided');
		return;
	}
	const sourceAgentId = rawSourceAgentId as string | undefined;

	ctx.callbacks
		.triggerCueSubscription(subscriptionName, prompt as string | undefined, sourceAgentId)
		.then((success) => {
			ctx.send(client, {
				type: 'trigger_cue_subscription_result',
				success,
				subscriptionName,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Failed to trigger Cue subscription: ${err.message}`, 'WebSocket');
			ctx.sendError(client, `Failed to trigger Cue subscription: ${err.message}`);
		});
}

/**
 * Handle cue_pipeline_list - return all named pipeline entries from
 * the on-disk cue-pipeline-layout.json. Pipelines are returned as
 * opaque JSON objects so the CLI doesn't need to share the editor's
 * full type tree to round-trip them.
 */
export function handleCuePipelineList(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	if (!ctx.callbacks.listCuePipelines) {
		ctx.sendError(client, 'Cue pipeline list not available');
		return;
	}
	ctx.callbacks
		.listCuePipelines()
		.then(({ pipelines }) => {
			ctx.send(client, {
				type: 'cue_pipeline_list_result',
				pipelines,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Failed to list Cue pipelines: ${err.message}`, 'WebSocket');
			ctx.sendError(client, `Failed to list Cue pipelines: ${err.message}`);
		});
}

/**
 * Handle cue_pipeline_get - fetch a single pipeline entry by name or
 * id. Missing entries respond with `pipeline: null` rather than an
 * error so scripts can treat "not found" as a normal value.
 */
export function handleCuePipelineGet(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const identifier = message.identifier;
	if (typeof identifier !== 'string' || identifier.length === 0) {
		ctx.sendError(client, 'Missing identifier (pipeline name or id)');
		return;
	}
	if (!ctx.callbacks.getCuePipeline) {
		ctx.sendError(client, 'Cue pipeline get not available');
		return;
	}

	ctx.callbacks
		.getCuePipeline(identifier)
		.then((pipeline) => {
			ctx.send(client, {
				type: 'cue_pipeline_get_result',
				pipeline,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Failed to get Cue pipeline: ${err.message}`, 'WebSocket');
			ctx.sendError(client, `Failed to get Cue pipeline: ${err.message}`);
		});
}

/**
 * Handle cue_pipeline_set - add or replace a pipeline entry. The
 * callback returns a structured result so the CLI can map error codes
 * (already_exists / not_found / invalid_input / …) to non-zero exit
 * codes without parsing free-form messages.
 */
export function handleCuePipelineSet(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const identifier = message.identifier;
	const pipeline = message.pipeline;
	const policyRaw = message.policy;
	if (typeof identifier !== 'string' || identifier.length === 0) {
		ctx.sendError(client, 'Missing identifier (pipeline name or id)');
		return;
	}
	if (policyRaw !== 'add' && policyRaw !== 'replace') {
		ctx.sendError(client, 'Invalid policy: must be "add" or "replace"');
		return;
	}
	if (pipeline === undefined || pipeline === null) {
		ctx.sendError(client, 'Missing pipeline payload');
		return;
	}
	if (!ctx.callbacks.setCuePipeline) {
		ctx.sendError(client, 'Cue pipeline set not available');
		return;
	}

	ctx.callbacks
		.setCuePipeline(identifier, pipeline, policyRaw)
		.then((result) => {
			ctx.send(client, {
				type: 'cue_pipeline_set_result',
				result,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Failed to set Cue pipeline: ${err.message}`, 'WebSocket');
			ctx.sendError(client, `Failed to set Cue pipeline: ${err.message}`);
		});
}

/**
 * Handle cue_pipeline_remove - delete a pipeline entry by name or id.
 */
export function handleCuePipelineRemove(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const identifier = message.identifier;
	if (typeof identifier !== 'string' || identifier.length === 0) {
		ctx.sendError(client, 'Missing identifier (pipeline name or id)');
		return;
	}
	if (!ctx.callbacks.removeCuePipeline) {
		ctx.sendError(client, 'Cue pipeline remove not available');
		return;
	}

	ctx.callbacks
		.removeCuePipeline(identifier)
		.then((result) => {
			ctx.send(client, {
				type: 'cue_pipeline_remove_result',
				result,
				requestId: message.requestId,
				timestamp: Date.now(),
			});
		})
		.catch((error) => {
			const err = error instanceof Error ? error : new Error(String(error));
			logger.error(`Failed to remove Cue pipeline: ${err.message}`, 'WebSocket');
			ctx.sendError(client, `Failed to remove Cue pipeline: ${err.message}`);
		});
}
