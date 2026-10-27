import type { Permission } from '@opencode-ai/sdk';
import type {
	HarnessInteractionOpenRequest,
	HarnessInteractionResolution,
} from '../../shared/harness-control/types';

export interface OpencodeCurrentPermissionRequest {
	id: string;
	sessionID: string;
	permission: string;
	patterns: string[];
	metadata: Record<string, unknown>;
	always: string[];
	tool?: { messageID: string; callID: string };
}

export type OpencodePermissionRequest = Permission | OpencodeCurrentPermissionRequest;
export type OpencodePermissionResponse = 'once' | 'always' | 'reject';

/** Convert either OpenCode permission protocol into one owner-scoped broker request. */
export function opencodePermissionOpenRequest(
	permission: OpencodePermissionRequest,
	context: { sessionId: string; tabId?: string; spawnGeneration: number }
): HarnessInteractionOpenRequest {
	const current = 'permission' in permission;
	return {
		sessionId: context.sessionId,
		tabId: context.tabId,
		spawnGeneration: context.spawnGeneration,
		turnId: current ? permission.tool?.messageID : permission.messageID,
		toolCallId: current ? permission.tool?.callID : permission.callID,
		kind: 'permission',
		provider: 'opencode',
		title: current ? `OpenCode requests ${permission.permission} permission` : permission.title,
		toolName: current ? permission.permission : permission.type,
		input: {
			pattern: current ? permission.patterns : permission.pattern,
			always: current ? permission.always : undefined,
			metadata: permission.metadata,
		},
		options: [
			{ optionId: 'once', label: 'Allow once', kind: 'allow-once' },
			{ optionId: 'always', label: 'Always allow', kind: 'allow-always' },
			{ optionId: 'reject', label: 'Deny', kind: 'reject-once' },
		],
	};
}

/** Map a broker decision to OpenCode's once/always/reject reply vocabulary. */
export function opencodePermissionResponse(
	resolution: HarnessInteractionResolution
): OpencodePermissionResponse {
	if (resolution.outcome === 'selected') {
		if (resolution.optionId === 'once') return 'once';
		if (resolution.optionId === 'always') return 'always';
	}
	return 'reject';
}
