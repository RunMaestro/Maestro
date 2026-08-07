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
import type { MessageHandlerContext, WebClientMessage } from './types';

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

export function armDispatchCallback(
	ctx: MessageHandlerContext,
	message: WebClientMessage,
	target: { agentId: string; tabId: string; prompt: string; isNewTab: boolean }
): { callbackId?: string; error?: string } {
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

	const rawTimeoutSeconds =
		typeof message.callbackTimeout === 'number' ? message.callbackTimeout : undefined;
	const timeoutMs =
		rawTimeoutSeconds && rawTimeoutSeconds > 0
			? Math.min(rawTimeoutSeconds * 1000, MAX_CALLBACK_TIMEOUT_MS)
			: DEFAULT_CALLBACK_TIMEOUT_MS;

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
		});
		return { callbackId: entry.callbackId };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
