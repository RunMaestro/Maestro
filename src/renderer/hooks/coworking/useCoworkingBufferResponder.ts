/**
 * Handles `coworking:requestBuffer` events from main and answers them via the
 * per-session `TerminalView` ref map already kept by `MainPanel`. The hook
 * never assumes a particular ref shape; it just calls `getTerminalBuffer` on
 * the matching ref and ships back what it returns. When the session's
 * TerminalView ref isn't mounted, it answers with ok:false (not an empty
 * string) so the main side surfaces a clear "terminal not live" error.
 *
 * `sessionId` is always set - the bridge binds each MCP connection to its
 * caller's Maestro session at handshake, so reads are always scoped.
 */

import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { TerminalViewHandle } from '../../components/TerminalView';
import { captureException } from '../../utils/sentry';

export function useCoworkingBufferResponder(
	terminalViewRefs: MutableRefObject<Map<string, TerminalViewHandle>>
): void {
	useEffect(() => {
		// Same defensive guard as the registry-sync hook: bail when the coworking
		// bridge is absent (tests that mock `window.maestro` without it, older
		// preload bundles).
		const bridge = window.maestro?.coworking;
		if (!bridge) return;
		const off = bridge.onRequestBuffer((tabUuid, sessionId, responseChannel) => {
			const view = terminalViewRefs.current.get(sessionId);
			if (!view) {
				// The session's TerminalView isn't mounted (e.g. its agent isn't the
				// focused one), so there's no live buffer to read. Signal failure via
				// ok:false so readTerminal surfaces a clear "terminal not live" error
				// instead of reporting a false, successful empty read.
				bridge.sendBufferResponse(responseChannel, '', false);
				return;
			}
			let content = '';
			try {
				content = view.getTerminalBuffer(tabUuid) ?? '';
			} catch (err) {
				// `getTerminalBuffer` shouldn't throw under normal conditions - if it does,
				// degrading to empty content is acceptable for the agent UX, but capture
				// the error so we can see it in production instead of silently swallowing.
				void captureException(err instanceof Error ? err : new Error(String(err)), {
					extra: { context: 'useCoworkingBufferResponder', tabUuid, sessionId },
				});
				content = '';
			}
			bridge.sendBufferResponse(responseChannel, content);
		});
		return off;
	}, [terminalViewRefs]);
}
