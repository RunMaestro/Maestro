import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type {
	HarnessInteractionOpenRequest,
	HarnessInteractionOptionKind,
	HarnessInteractionResolution,
} from '../../../harness-control/types';

const OPTION_KINDS: Record<string, HarnessInteractionOptionKind> = {
	allow_once: 'allow-once',
	allow_always: 'allow-always',
	reject_once: 'reject-once',
	reject_always: 'reject-always',
};

/** Convert ACP tool-call permission options without losing their stable protocol IDs. */
export function acpPermissionOpenRequest(
	request: RequestPermissionRequest,
	context: { sessionId: string; tabId?: string; spawnGeneration: number; provider: string }
): HarnessInteractionOpenRequest {
	return {
		sessionId: context.sessionId,
		tabId: context.tabId,
		spawnGeneration: context.spawnGeneration,
		toolCallId: request.toolCall.toolCallId,
		kind: 'permission',
		provider: context.provider,
		title: request.toolCall.title ?? `${context.provider} requests permission`,
		toolName: request.toolCall.name ?? request.toolCall.kind ?? 'tool',
		input: { toolCall: request.toolCall },
		options: request.options.map((option) => ({
			optionId: option.optionId,
			label: option.name,
			kind: OPTION_KINDS[option.kind] ?? 'choice',
		})),
	};
}

/** Resolve the exact ACP option selected by the owner, defaulting cancellation to reject. */
export function acpPermissionResponse(
	resolution: HarnessInteractionResolution
): RequestPermissionResponse {
	if (resolution.outcome === 'selected') {
		return { outcome: { outcome: 'selected', optionId: resolution.optionId } };
	}
	return { outcome: { outcome: 'cancelled' } };
}
