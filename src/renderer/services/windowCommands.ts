/**
 * Answers `maestro-cli window` (the `window_command` message) in the primary
 * window's renderer.
 *
 * Every move goes through the SAME `WindowContext` methods the Left Bar menus
 * and the Cmd+K palette call, so a scripted move gets the same unit resolution
 * (worktrees ride with their parent), the same primary-window guard, and the
 * same registry transfers as a click. This module only resolves the CLI's names
 * (`main`, a window number, an id, or a custom name) and shapes the reply.
 */

import type { WindowContextValue, WindowMoveResult } from '../contexts/WindowContext';
import { useSessionStore } from '../stores/sessionStore';
import {
	NEW_WINDOW_TARGET,
	type WindowCommandRequest,
	type WindowCommandResult,
	type WindowSummary,
} from '../../shared/windowCommands';
import {
	buildWindowMoveTargets,
	resolveOwningWindowId,
	type WindowMoveTarget,
} from '../utils/windowTargets';

type WindowCommandContext = Pick<
	WindowContextValue,
	| 'windows'
	| 'moveSessionToNewWindow'
	| 'moveSessionToWindow'
	| 'moveGroupToNewWindow'
	| 'moveGroupToWindow'
>;

/**
 * Resolve a CLI destination to an existing window: `main`, a 1-based window
 * number, an exact window id, or a custom name (case-insensitive). `null` when
 * nothing matches.
 */
export function resolveWindowDestination(
	to: string,
	targets: WindowMoveTarget[]
): WindowMoveTarget | null {
	const wanted = to.trim();
	if (wanted.toLowerCase() === 'main') return targets.find((t) => t.isMain) ?? null;
	if (/^\d+$/.test(wanted)) {
		const n = Number(wanted);
		return targets.find((t) => t.windowNumber === n) ?? null;
	}
	return (
		targets.find((t) => t.windowId === wanted) ??
		targets.find((t) => t.customName?.toLowerCase() === wanted.toLowerCase()) ??
		null
	);
}

function describeDestinations(targets: WindowMoveTarget[]): string {
	return [NEW_WINDOW_TARGET, ...targets.map((t) => (t.isMain ? 'main' : String(t.windowNumber)))]
		.map((v) => `"${v}"`)
		.join(', ');
}

/** Every open window with the top-level agents it surfaces. */
export function summarizeWindows(windows: WindowContextValue['windows']): WindowSummary[] {
	const sessions = useSessionStore.getState().sessions.filter((s) => !s.parentSessionId);
	return buildWindowMoveTargets(windows, '').map((target) => ({
		windowId: target.windowId,
		windowNumber: target.windowNumber,
		isMain: target.isMain,
		label: target.label,
		agents: sessions
			.filter((s) => resolveOwningWindowId(windows, s.id) === target.windowId)
			.map((s) => ({ id: s.id, name: s.name })),
	}));
}

function toResult(result: WindowMoveResult, windowLabel: string): WindowCommandResult {
	if (result.error) return { success: false, error: result.error };
	return {
		success: true,
		...(result.windowId ? { windowId: result.windowId } : {}),
		windowLabel,
		movedAgentIds: result.movedAgentIds ?? [],
	};
}

export async function runRemoteWindowCommand(
	request: WindowCommandRequest,
	ctx: WindowCommandContext
): Promise<WindowCommandResult> {
	if (ctx.windows.length === 0) {
		return { success: false, error: 'Multi-window is not available in this Maestro client' };
	}
	if (request.action === 'list') {
		return { success: true, windows: summarizeWindows(ctx.windows) };
	}

	const targetId = request.targetId ?? '';
	const to = request.to ?? '';
	const { sessions, groups } = useSessionStore.getState();
	if (request.action === 'move-agent' && !sessions.some((s) => s.id === targetId)) {
		return { success: false, error: `Agent not found: ${targetId}` };
	}
	if (request.action === 'move-group' && !groups.some((g) => g.id === targetId)) {
		return { success: false, error: `Group not found: ${targetId}` };
	}

	if (to.toLowerCase() === NEW_WINDOW_TARGET) {
		const result =
			request.action === 'move-group'
				? await ctx.moveGroupToNewWindow(targetId)
				: await ctx.moveSessionToNewWindow(targetId);
		return toResult(result, 'New Window');
	}

	const targets = buildWindowMoveTargets(ctx.windows, '');
	const destination = resolveWindowDestination(to, targets);
	if (!destination) {
		return {
			success: false,
			error: `No window matches "${to}". Use one of: ${describeDestinations(targets)}, a window id, or a window name`,
		};
	}
	const result =
		request.action === 'move-group'
			? await ctx.moveGroupToWindow(targetId, destination.windowId)
			: await ctx.moveSessionToWindow(targetId, destination.windowId);
	return toResult(result, destination.label);
}
