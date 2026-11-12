// Window commands - the CLI half of the multi-window UI: the Left Bar's "Move to
// Window" menus on an agent and on a group, and the matching Cmd+K commands.
// Every verb rides the one `window_command` message, answered by the primary
// window through the same WindowContext methods the menus call.

import {
	sendSimpleCommand,
	failCommand,
	resolveAgentOrFail,
	type SimpleResult,
} from '../services/session-command';
import { resolveGroupId } from '../services/storage';
import { formatSuccess } from '../output/formatter';
import type { WindowCommandRequest, WindowSummary } from '../../shared/windowCommands';

export interface WindowOptions {
	to?: string;
	json?: boolean;
}

interface WindowResponse extends SimpleResult {
	windows?: WindowSummary[];
	windowId?: string;
	windowLabel?: string;
	movedAgentIds?: string[];
}

async function sendWindow(request: WindowCommandRequest, json?: boolean): Promise<WindowResponse> {
	try {
		const result = (await sendSimpleCommand(
			{ type: 'window_command', ...request },
			'window_command_result'
		)) as WindowResponse;
		if (!result.success) failCommand(result.error || 'Window command failed', json);
		return result;
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
}

export async function windowList(options: WindowOptions): Promise<void> {
	const result = await sendWindow({ action: 'list' }, options.json);
	const windows = result.windows ?? [];
	if (options.json) {
		console.log(JSON.stringify({ success: true, windows }, null, 2));
		return;
	}
	for (const win of windows) {
		const destination = win.isMain ? 'main' : String(win.windowNumber);
		console.log(`${win.label}  (--to ${destination}, id ${win.windowId})`);
		if (win.agents.length === 0) console.log('  (no agents)');
		for (const agent of win.agents) console.log(`  ${agent.name}  ${agent.id}`);
	}
}

function requireDestination(options: WindowOptions): string {
	const to = options.to?.trim();
	if (!to) {
		return failCommand(
			'Missing --to. Pass "new", "main", a window number, a window id, or a window name (see `window list`)',
			options.json
		);
	}
	return to;
}

function reportMove(result: WindowResponse, subject: string, options: WindowOptions): void {
	const moved = result.movedAgentIds ?? [];
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				windowId: result.windowId,
				windowLabel: result.windowLabel,
				movedAgentIds: moved,
			})
		);
		return;
	}
	console.log(
		formatSuccess(
			moved.length === 0
				? `${subject} is already in ${result.windowLabel}`
				: `Moved ${subject} to ${result.windowLabel} (${moved.length} agent${moved.length === 1 ? '' : 's'})`
		)
	);
}

export async function windowMoveAgent(agentId: string, options: WindowOptions): Promise<void> {
	const to = requireDestination(options);
	const resolved = resolveAgentOrFail(agentId, options.json);
	const result = await sendWindow({ action: 'move-agent', targetId: resolved, to }, options.json);
	reportMove(result, `agent ${resolved}`, options);
}

export async function windowMoveGroup(groupId: string, options: WindowOptions): Promise<void> {
	const to = requireDestination(options);
	let resolved: string;
	try {
		resolved = resolveGroupId(groupId);
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
	const result = await sendWindow({ action: 'move-group', targetId: resolved, to }, options.json);
	reportMove(result, `group ${resolved}`, options);
}
