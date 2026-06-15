import type { ToolType } from '../../../../../types';

export function getConversationProviderName(selectedAgent: ToolType | null): string | undefined {
	if (selectedAgent === 'claude-code') {
		return 'Claude';
	}
	if (selectedAgent === 'opencode') {
		return 'OpenCode';
	}
	if (selectedAgent === 'codex') {
		return 'Codex';
	}
	return selectedAgent || undefined;
}
