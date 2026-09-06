/**
 * Answers `remote:readTerminalTab` requests from the CLI / web bridge by reading
 * the tab's xterm scrollback out of the per-session `TerminalView` ref map that
 * `MainPanel` already keeps.
 *
 * This is the read half of `send-terminal`. The write path lives in
 * `useAppRemoteEventListeners` because it only needs session state; this one has
 * to live wherever `terminalViewRefs` does, since the scrollback exists only
 * inside the mounted xterm instance and nowhere in the store.
 *
 * A tab whose TerminalView was never mounted has no buffer to read. That answers
 * ok:false with an actionable message rather than an empty string - a successful
 * empty read would tell an agent "the command printed nothing", which is a lie
 * that is worse than an error.
 */

import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { TerminalViewHandle } from '../../components/TerminalView';
import { useSessionStore } from '../../stores/sessionStore';
import { resolveTerminalTab, getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';
import { captureException } from '../../utils/sentry';

/**
 * Hard cap on lines returned in one read, regardless of what the caller asked
 * for. A `tail -f` tab can hold a lot of scrollback, and the whole point of this
 * command is to feed an agent's context - shipping megabytes across IPC to blow
 * that context is worse than useless.
 */
export const MAX_TERMINAL_READ_LINES = 5000;

/** Tail-truncate to the last `tail` lines, reporting the pre-truncation total. */
export function tailLines(content: string, tail?: number): { content: string; totalLines: number } {
	const lines = content.split('\n');
	const totalLines = lines.length;
	const limit = Math.min(tail ?? MAX_TERMINAL_READ_LINES, MAX_TERMINAL_READ_LINES);
	if (totalLines <= limit) return { content, totalLines };
	return { content: lines.slice(totalLines - limit).join('\n'), totalLines };
}

export function useRemoteTerminalBufferResponder(
	terminalViewRefs: MutableRefObject<Map<string, TerminalViewHandle>>
): void {
	useEffect(() => {
		// Defensive: tests mock `window.maestro` without this bridge, and an older
		// preload bundle won't have it either.
		const bridge = window.maestro?.process;
		if (!bridge?.onRemoteReadTerminalTab) return;

		const off = bridge.onRemoteReadTerminalTab((sessionId, payload, responseChannel) => {
			const ack = (
				success: boolean,
				result?: {
					error?: string;
					tabId?: string;
					tabName?: string;
					cwd?: string;
					state?: string;
					content?: string;
					totalLines?: number;
				}
			) => bridge.sendRemoteReadTerminalTabResponse(responseChannel, success, result);

			const sessions = useSessionStore.getState().sessions;
			const resolved = resolveTerminalTab(sessions, sessionId, payload.tabRef);
			if (!resolved) {
				// Same diagnosis ladder as the write path, so `read-terminal` and
				// `send-terminal` explain an unresolvable tab identically.
				const session = sessions.find((s) => s.id === sessionId);
				if (!session) {
					ack(false, { error: 'Agent not found' });
				} else if (payload.tabRef) {
					ack(false, { error: `No terminal tab matching "${payload.tabRef}"` });
				} else if ((session.terminalTabs || []).length === 0) {
					ack(false, {
						error: 'No terminal tab is open for this agent. Use open-terminal first.',
					});
				} else {
					ack(false, {
						error: 'Several terminal tabs are open and none is active. Pass --tab to pick one.',
					});
				}
				return;
			}

			const { session: owner, tab } = resolved;
			const index = (owner.terminalTabs || []).findIndex((t) => t.id === tab.id);
			const tabName = getTerminalTabDisplayName(tab, index);
			const meta = { tabId: tab.id, tabName, cwd: tab.cwd || owner.cwd || '', state: tab.state };

			const view = terminalViewRefs.current.get(owner.id);
			if (!view) {
				// TerminalViews stay mounted for every agent whose terminals have been
				// on screen once, so this is the "never visited since launch" case.
				ack(false, {
					...meta,
					error: `Terminal "${tabName}" has no live buffer yet. Select the agent in Maestro once so its terminals mount, then read again.`,
				});
				return;
			}

			let content = '';
			try {
				content = view.getTerminalBuffer(tab.id) ?? '';
			} catch (err) {
				void captureException(err instanceof Error ? err : new Error(String(err)), {
					extra: { context: 'useRemoteTerminalBufferResponder', tabId: tab.id, sessionId },
				});
				ack(false, { ...meta, error: `Failed to read terminal "${tabName}"` });
				return;
			}

			const tailed = tailLines(content, payload.tail);
			ack(true, { ...meta, content: tailed.content, totalLines: tailed.totalLines });
		});
		return off;
	}, [terminalViewRefs]);
}
