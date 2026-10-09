import type { Session } from '../../../types';

/**
 * Resolve which window currently surfaces an agent. Returns the owning window's
 * id/number when ANOTHER window owns the agent, or null when THIS window owns it
 * (or there is no multi-window context). Structurally matches
 * `WindowContext.getSessionWindow` so the command builders stay context-free.
 */
export type GetSessionWindow = (
	sessionId: string
) => { windowId: string; windowNumber: number } | null;

interface MakeAgentJumpActionArgs {
	session: Session;
	setActiveSessionId: (id: string) => void;
	revealJumpTarget: (session: Session) => void;
	/**
	 * Multi-window: optional resolver for which window owns the agent. When the
	 * agent lives in another window, jumping focuses that window instead of
	 * yanking the agent into this one (single-window-per-agent). Null-safe:
	 * omitted outside a `WindowProvider` (single-window app / web / tests), where
	 * every jump switches locally as before.
	 */
	getSessionWindow?: GetSessionWindow;
}

/**
 * Build the select/Enter handler shared by every Command-K agent-switch command
 * (the "Jump to: X" main-mode list and the dedicated agents-mode switcher).
 * Mirrors the Left Bar's per-row select handler (`SessionList.tsx`) so palette
 * and sidebar agent selection behave identically across windows. The handler is
 * synchronous and deterministic - keyboard reliability is non-negotiable.
 */
export function makeAgentJumpAction({
	session,
	setActiveSessionId,
	revealJumpTarget,
	getSessionWindow,
}: MakeAgentJumpActionArgs): () => void {
	return () => {
		// Agent lives in another window: focus that window instead of stealing it.
		const otherWindow = getSessionWindow?.(session.id);
		if (otherWindow) {
			void window.maestro.windows.focusWindow(otherWindow.windowId);
			return;
		}
		setActiveSessionId(session.id);
		revealJumpTarget(session);
	};
}
