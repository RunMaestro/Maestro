import type { ToolType } from '../../../../../types';
import { getAgentDisplayName } from '../../../../../../shared/agentMetadata';

export function getConversationProviderName(selectedAgent: ToolType | null): string | undefined {
	if (selectedAgent === 'claude-code') {
		return 'Claude';
	}
	return selectedAgent ? getAgentDisplayName(selectedAgent) : undefined;
}
