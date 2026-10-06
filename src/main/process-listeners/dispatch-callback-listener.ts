/**
 * Feeds process spawn/exit into the dispatch-callback registry.
 *
 * Kept as its own listener rather than folded into exit-listener.ts because the
 * correlation is exact-match on composite ids the registry itself minted
 * (`{agentId}-ai-{tabId}`). Group-chat, batch, synopsis and terminal session ids
 * can never match a registered key, so this path needs none of the group-chat
 * containment machinery that makes exit-listener.ts load-bearing.
 */

import type { ProcessManager } from '../process-manager';
import { getDispatchCallbackRegistry } from '../dispatch-callbacks';

export function setupDispatchCallbackListener(processManager: ProcessManager): void {
	processManager.on('spawn', (config: { sessionId?: string }) => {
		const sessionId = config?.sessionId;
		if (!sessionId) return;
		getDispatchCallbackRegistry()?.noteSpawn(sessionId);
	});

	processManager.on('exit', (sessionId: string, code: number) => {
		getDispatchCallbackRegistry()?.noteExit(sessionId, code ?? null);
	});
}
