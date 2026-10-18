/**
 * Wire shape for the `window_command` message - the CLI half of the multi-window
 * UI (`maestro-cli window`).
 *
 * Moving an agent or a whole group between windows is reachable by clicking (the
 * Left Bar context menus and the Cmd+K palette). This module is what makes the
 * same moves reachable from the CLI, and it lives in `shared/` because all three
 * processes need it: the CLI builds the request, the main process validates it
 * on the way through, and the PRIMARY window's renderer answers it through the
 * same `WindowContext` methods the menus call.
 *
 * One message with an `action` rather than one per verb, for the same reason as
 * `snooze_command`: the verbs differ only in what they name, and parallel
 * callbacks would be parallel chances to drift from the click path.
 */

/** The verbs a window command can carry. */
export const WINDOW_COMMAND_ACTIONS = ['list', 'move-agent', 'move-group'] as const;

export type WindowCommandAction = (typeof WINDOW_COMMAND_ACTIONS)[number];

/** Narrow an unknown value to a window command action. */
export function isWindowCommandAction(value: unknown): value is WindowCommandAction {
	return typeof value === 'string' && WINDOW_COMMAND_ACTIONS.includes(value as WindowCommandAction);
}

/**
 * The literal `to` that asks for a brand-new window. Any other `to` names an
 * existing window: `main`, its 1-based number, its id, or its custom name.
 */
export const NEW_WINDOW_TARGET = 'new';

/** One window command, already validated. */
export interface WindowCommandRequest {
	action: WindowCommandAction;
	/** `move-agent`: the agent id. `move-group`: the group id. */
	targetId?: string;
	/** Destination for a move: `new`, `main`, a window number, id, or name. */
	to?: string;
}

/** One open window, flattened for the wire. */
export interface WindowSummary {
	windowId: string;
	/** 1-based position in registry order (primary first), matching the Left Bar badge. */
	windowNumber: number;
	isMain: boolean;
	/** Display label: custom name, else "Main Window" / "Window N". */
	label: string;
	/** Top-level agents this window surfaces (worktree children ride along unlisted). */
	agents: Array<{ id: string; name: string }>;
}

/** What the renderer answers a window command with. */
export interface WindowCommandResult {
	success: boolean;
	error?: string;
	/** `list` only. */
	windows?: WindowSummary[];
	/** Moves only: the window the agents landed in. */
	windowId?: string;
	/** Moves only: that window's display label. */
	windowLabel?: string;
	/** Moves only: every agent id that moved, worktree children included. */
	movedAgentIds?: string[];
}

/**
 * Narrow whatever the renderer sent back to a result, so a malformed answer
 * becomes a failed command rather than a `success: undefined` the CLI reports
 * as done.
 */
export function normalizeWindowCommandResult(raw: unknown): WindowCommandResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid window response' };
	}
	const candidate = raw as Partial<WindowCommandResult>;
	if (candidate.success !== true) {
		return {
			success: false,
			error: typeof candidate.error === 'string' ? candidate.error : 'Window command failed',
		};
	}
	return {
		success: true,
		...(Array.isArray(candidate.windows) ? { windows: candidate.windows } : {}),
		...(typeof candidate.windowId === 'string' ? { windowId: candidate.windowId } : {}),
		...(typeof candidate.windowLabel === 'string' ? { windowLabel: candidate.windowLabel } : {}),
		...(Array.isArray(candidate.movedAgentIds) ? { movedAgentIds: candidate.movedAgentIds } : {}),
	};
}

/**
 * Validate a raw `window_command` message in the main process, between a CLI
 * that can be any version and a renderer that must never be handed a
 * half-formed move.
 */
export function parseWindowCommandRequest(
	message: Record<string, unknown>
): { ok: true; request: WindowCommandRequest } | { ok: false; error: string } {
	const action = message.action;
	if (!isWindowCommandAction(action)) {
		return {
			ok: false,
			error: `Invalid or missing window action. Must be one of: ${WINDOW_COMMAND_ACTIONS.join(', ')}`,
		};
	}
	if (action === 'list') return { ok: true, request: { action } };

	const targetId = typeof message.targetId === 'string' ? message.targetId.trim() : '';
	const to = typeof message.to === 'string' ? message.to.trim() : '';
	if (!targetId) {
		return {
			ok: false,
			error: `window ${action} requires ${action === 'move-group' ? 'a group id' : 'an agent id'}`,
		};
	}
	if (!to) return { ok: false, error: `window ${action} requires a destination (--to)` };
	return { ok: true, request: { action, targetId, to } };
}
