import { parseSessionId } from './sessionIdParser';

export interface AiProcessContext {
	actualSessionId: string;
	tabId?: string;
}

/**
 * Returns AI process routing details for App-level log handling.
 * Non-AI sessions (terminal tabs, runCommand, batch, synopsis) return null.
 */
export function getAiProcessContext(sessionId: string): AiProcessContext | null {
	const parsed = parseSessionId(sessionId);
	if (parsed.type !== 'ai-tab' && parsed.type !== 'legacy-ai') {
		return null;
	}

	return {
		actualSessionId: parsed.actualSessionId,
		tabId: parsed.tabId ?? undefined,
	};
}
