/**
 * Shared `dispatch --notify-on-complete` arming logic for the Commands, Tabs,
 * and Queue domains. Ported from WebSocketMessageHandler.ts (PR #1328) during
 * the messageHandlers.ts -> messageHandlers/ decomposition.
 *
 * Correlation is `(targetAgentId, tabId)` - a specific tab, established at
 * dispatch time - which is why the CLI requires `--new-tab` or `--tab`
 * alongside `--notify-on-complete`.
 */

import {
	getDispatchCallbackRegistry,
	DEFAULT_CALLBACK_TIMEOUT_MS,
	MAX_CALLBACK_TIMEOUT_MS,
} from '../../../dispatch-callbacks';
import { getAutoRunStateTracker } from '../../../autorun/autorun-state-tracker';
import { logger } from '../../../utils/logger';
import type { MessageHandlerContext, WebClientMessage } from './types';

const LOG_CONTEXT = 'DispatchCallback';

/** `--callback-timeout` seconds from the message, clamped, or the default. */
function callbackTimeoutMs(message: WebClientMessage): number {
	const rawTimeoutSeconds =
		typeof message.callbackTimeout === 'number' ? message.callbackTimeout : undefined;
	return rawTimeoutSeconds && rawTimeoutSeconds > 0
		? Math.min(rawTimeoutSeconds * 1000, MAX_CALLBACK_TIMEOUT_MS)
		: DEFAULT_CALLBACK_TIMEOUT_MS;
}

/**
 * The Auto Run a dispatch should report back to: the CLI read it from
 * `MAESTRO_CALLER_AUTORUN_ID` and sent it as `autoRunId`, beside the caller
 * agent. Undefined for every other dispatch, and for one that also asked for
 * `--notify-on-complete`, which names its own destination.
 */
export function readAutoRunCallbackRequest(
	message: WebClientMessage
): { autoRunId: string; callerAgentId: string } | undefined {
	if (typeof message.notifyOnComplete === 'string' && message.notifyOnComplete) return undefined;
	const autoRunId = typeof message.autoRunId === 'string' ? message.autoRunId.trim() : '';
	const callerAgentId =
		typeof message.fromSessionId === 'string' ? message.fromSessionId.trim() : '';
	return autoRunId && callerAgentId ? { autoRunId, callerAgentId } : undefined;
}

/** Whether this dispatch asks for any completion tracking at all. */
export function wantsDispatchCallback(message: WebClientMessage): boolean {
	return (
		(typeof message.notifyOnComplete === 'string' && message.notifyOnComplete !== '') ||
		readAutoRunCallbackRequest(message) !== undefined
	);
}

/**
 * Arm tracking for a dispatch made inside an Auto Run task. Never refuses the
 * dispatch: when the run cannot track it, the hand-off still happens and the CLI
 * reports it as untracked. Two cases end there. The caller agent has no Auto Run
 * running, which means the command came from a process the task left behind (a
 * daemon inherits the env), and its run is over. Or the tab already carries a
 * callback, which the registry allows only once per tab.
 */
function armAutoRunDelegation(
	ctx: MessageHandlerContext,
	message: WebClientMessage,
	request: { autoRunId: string; callerAgentId: string },
	target: {
		agentId: string;
		tabId: string;
		prompt: string;
		isNewTab: boolean;
		pendingAdmissionId?: string;
	}
): { callbackId?: string; error?: string } {
	const registry = getDispatchCallbackRegistry();
	if (!registry) return {};
	if (getAutoRunStateTracker().getRunningSince(request.callerAgentId) === undefined) {
		logger.info(
			`Auto Run ${request.autoRunId} is not running on ${request.callerAgentId}; dispatch left untracked`,
			LOG_CONTEXT
		);
		return {};
	}
	if (registry.hasArmedFor(target.agentId, target.tabId)) {
		logger.info(
			`Tab ${target.tabId} already has a dispatch callback; Auto Run ${request.autoRunId} cannot track it`,
			LOG_CONTEXT
		);
		return {};
	}
	const targetName = ctx.callbacks.getSessions?.()?.find((s) => s.id === target.agentId)?.name;
	try {
		const entry = registry.register({
			targetAgentId: target.agentId,
			targetTabId: target.tabId,
			...(targetName ? { targetName } : {}),
			callerAgentId: request.callerAgentId,
			autoRunId: request.autoRunId,
			timeoutMs: callbackTimeoutMs(message),
			prompt: target.prompt,
			armFromRecentSpawn: target.isNewTab,
			pendingAdmissionId: target.pendingAdmissionId,
		});
		return { callbackId: entry.callbackId };
	} catch (error) {
		// The cap on armed callbacks. The work is still handed over; say why it is untracked.
		logger.warn(
			`Auto Run ${request.autoRunId} could not track a dispatch: ${error instanceof Error ? error.message : String(error)}`,
			LOG_CONTEXT
		);
		return {};
	}
}

export function validateCallbackRequest(
	ctx: MessageHandlerContext,
	message: WebClientMessage,
	target: { agentId: string; tabId?: string }
): { error?: string } {
	const callerAgentId =
		typeof message.notifyOnComplete === 'string' ? message.notifyOnComplete : '';
	if (!callerAgentId) return {};

	if (!getDispatchCallbackRegistry()) {
		return { error: 'Dispatch callbacks are not available in this build' };
	}

	if (!ctx.callbacks.getSessionDetail?.(callerAgentId)) {
		return { error: `Callback agent not found: ${callerAgentId}` };
	}

	const callerTabId = typeof message.callbackTab === 'string' ? message.callbackTab : undefined;

	// A callback that wakes the very tab it is waiting on is an infinite
	// self-poke. The CLI rejects the obvious form; this is the server-side
	// backstop for direct websocket callers. With no target tab id yet (the
	// pre-dispatch pass for `--new-tab`) only the no-caller-tab form is
	// decidable: a tab that does not exist yet can never equal an existing one.
	if (
		callerAgentId === target.agentId &&
		(!callerTabId || (target.tabId !== undefined && callerTabId === target.tabId))
	) {
		return { error: 'Callback agent/tab cannot be the dispatch target itself' };
	}

	return {};
}

/**
 * Register a validated completion callback for the target and return its ID or an error.
 * Pending admissions defer spawn arming, and an already armed target cannot receive a second
 * callback.
 */
export function armDispatchCallback(
	ctx: MessageHandlerContext,
	message: WebClientMessage,
	target: {
		agentId: string;
		tabId: string;
		prompt: string;
		isNewTab: boolean;
		pendingAdmissionId?: string;
	}
): { callbackId?: string; error?: string } {
	const autoRun = readAutoRunCallbackRequest(message);
	if (autoRun) return armAutoRunDelegation(ctx, message, autoRun, target);

	const callerAgentId =
		typeof message.notifyOnComplete === 'string' ? message.notifyOnComplete : '';
	if (!callerAgentId) return {};

	const invalid = validateCallbackRequest(ctx, message, target);
	if (invalid.error) return invalid;

	// Non-null by the check above; re-read rather than thread it through.
	const registry = getDispatchCallbackRegistry();
	if (!registry) return { error: 'Dispatch callbacks are not available in this build' };

	const callerTabId = typeof message.callbackTab === 'string' ? message.callbackTab : undefined;

	if (registry.hasArmedFor(target.agentId, target.tabId)) {
		return {
			error: `A dispatch callback is already armed for tab ${target.tabId} (CALLBACK_ALREADY_ARMED)`,
		};
	}

	const timeoutMs = callbackTimeoutMs(message);

	const targetName = ctx.callbacks.getSessions?.()?.find((s) => s.id === target.agentId)?.name;

	try {
		const entry = registry.register({
			targetAgentId: target.agentId,
			targetTabId: target.tabId,
			...(targetName ? { targetName } : {}),
			callerAgentId,
			...(callerTabId ? { callerTabId } : {}),
			...(typeof message.callbackPrompt === 'string' && message.callbackPrompt
				? { callbackPrompt: message.callbackPrompt }
				: {}),
			timeoutMs,
			prompt: target.prompt,
			armFromRecentSpawn: target.isNewTab,
			pendingAdmissionId: target.pendingAdmissionId,
		});
		return { callbackId: entry.callbackId };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
