/**
 * Human-readable titles for agent error types.
 * Used for toast notifications and history entries.
 */

import type { AgentError } from '../../../../types';

export function getErrorTitleForType(type: AgentError['type']): string {
	switch (type) {
		case 'auth_expired':
			return 'Authentication Required';
		case 'token_exhaustion':
			return 'Context Limit Reached';
		case 'rate_limited':
			return 'Rate Limit Exceeded';
		case 'network_error':
			return 'Connection Error';
		case 'agent_crashed':
			return 'Agent Error';
		case 'permission_denied':
			return 'Permission Denied';
		case 'session_not_found':
			return 'Session Not Found';
		default:
			return 'Error';
	}
}
