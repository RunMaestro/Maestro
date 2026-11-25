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

	// The dispatched turn's reply, for {{DISPATCH_OUTPUT}}. `data` carries the
	// same display text the renderer appends to the tab's transcript.
	processManager.on('data', (sessionId: string, data: string) => {
		if (typeof data !== 'string') return;
		getDispatchCallbackRegistry()?.noteData(sessionId, data);
	});

	processManager.on('exit', (sessionId: string, code: number) => {
		getDispatchCallbackRegistry()?.noteExit(sessionId, code ?? null);
	});
}
