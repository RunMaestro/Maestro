// Quick Chat commands - drive the hotkey-summoned floating chat window from the
// CLI. Every verb rides the `quick_chat` WS message to the same main-process
// controller the window's own buttons call, so `quick-chat send` is the exact
// path typing in the window takes.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import { parseCliBool } from '../utils/parse';
import {
	describeQuickChatRoute,
	validateQuickChatBoundsRequest,
	type QuickChatBoundsRequest,
	type QuickChatFontScaleRequest,
	type QuickChatStatus,
} from '../../shared/quickChat';
import { FONT_SCALE_MAX, FONT_SCALE_MIN } from '../../shared/scaleRange';

export interface QuickChatOptions {
	json?: boolean;
	/** `bounds` only: raw flag values, parsed here. */
	x?: string;
	y?: string;
	width?: string;
	height?: string;
}

interface QuickChatResponse {
	type: string;
	success: boolean;
	error?: string;
	status?: QuickChatStatus;
}

export type QuickChatAction =
	| 'show'
	| 'hide'
	| 'toggle'
	| 'status'
	| 'send'
	| 'new'
	| 'keep'
	| 'pin'
	| 'font'
	| 'agent'
	| 'reveal'
	| 'stop'
	| 'new-tab'
	| 'bounds';

const FONT_STEP_UP = new Set(['in', 'up', 'bigger', 'larger', '+']);
const FONT_STEP_DOWN = new Set(['out', 'down', 'smaller', '-']);
const FONT_RESET = new Set(['reset', 'normal', 'default']);

/**
 * `quick-chat font <size>`: `in` / `out` step it like Cmd+= / Cmd+-, `reset`
 * goes back to normal, and a number sets it: `120%`, `120`, or `1.2` all mean
 * 120%. Throws on anything else, so a typo never resizes the text.
 */
export function parseQuickChatFontArg(arg: string): QuickChatFontScaleRequest {
	const word = arg.trim().toLowerCase();
	if (FONT_STEP_UP.has(word)) return { step: 1 };
	if (FONT_STEP_DOWN.has(word)) return { step: -1 };
	if (FONT_RESET.has(word)) return { reset: true };
	const percent = word.endsWith('%');
	const value = Number(percent ? word.slice(0, -1) : word);
	if (word === '' || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Unknown text size "${arg}". Use in, out, reset, or a size such as 120%`);
	}
	// A bare number above the largest multiplier can only be a percentage.
	const scale = percent || value > FONT_SCALE_MAX ? value / 100 : value;
	if (scale < FONT_SCALE_MIN || scale > FONT_SCALE_MAX) {
		throw new Error(
			`Text size must be between ${FONT_SCALE_MIN * 100}% and ${FONT_SCALE_MAX * 100}%`
		);
	}
	return { scale };
}

function fail(message: string, options: QuickChatOptions): void {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

/** Human-readable summary of the window and the chat in it. */
function printStatus(status: QuickChatStatus): void {
	const { snapshot } = status;
	console.log(
		`Quick Chat: ${status.enabled ? 'on' : 'off'}, window ${status.visible ? 'open' : 'closed'}`
	);
	const hotkey = status.hotkey.length > 0 ? status.hotkey.join('+') : 'none';
	console.log(`Hotkey: ${hotkey}${status.hotkeyRegistered ? '' : ' (not registered)'}`);
	if (status.bounds) {
		const { x, y, width, height } = status.bounds;
		console.log(`Window: ${width}x${height} at ${x},${y}`);
	}
	console.log(`Pinned: ${status.pinned ? 'yes, floats above other windows' : 'no'}`);
	console.log(`Text size: ${Math.round(status.fontScale * 100)}%`);
	console.log(
		`Agent: ${snapshot.agentName ?? 'none'}${snapshot.agentId ? ` (${snapshot.agentId})` : ''}`
	);
	console.log(
		`Chat: ${snapshot.tabId ? `tab ${snapshot.tabId}` : 'not started'}, ${snapshot.persistent ? 'kept as a tab' : 'ephemeral'}${snapshot.busy ? ', working' : ''}`
	);
	for (const message of snapshot.messages) {
		const who = message.role === 'user' ? 'You' : message.role === 'error' ? 'Error' : 'Agent';
		// A message the user sent names where it went, and its id is what
		// `reveal <id>` and `new-tab <id>` take.
		const route = message.route
			? ` [${message.id}] (${describeQuickChatRoute(message.route)})`
			: '';
		console.log(`\n${who}${route}: ${message.text}`);
	}
}

export async function quickChat(
	action: QuickChatAction,
	args: { text?: string; state?: string; agent?: string; messageId?: string },
	options: QuickChatOptions
): Promise<void> {
	const message: Record<string, unknown> = { type: 'quick_chat', action };
	if (action === 'send') {
		if (!args.text?.trim()) {
			fail('message cannot be empty', options);
			return;
		}
		message.text = args.text;
	}
	if (action === 'keep' || action === 'pin') {
		// A bare `pin` / `keep` means on. Anything else must be a real on/off
		// word: a typo such as `pin of` must not silently pin.
		let on = true;
		if (args.state !== undefined) {
			try {
				on = parseCliBool(args.state, action);
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error), options);
				return;
			}
		}
		message[action === 'keep' ? 'persistent' : 'pinned'] = on;
	}
	if ((action === 'reveal' || action === 'new-tab') && args.messageId) {
		message.messageId = args.messageId;
	}
	if (action === 'font' && args.state !== undefined) {
		try {
			message.fontScale = parseQuickChatFontArg(args.state);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options);
			return;
		}
	}
	if (action === 'bounds') {
		const request: QuickChatBoundsRequest = {};
		for (const key of ['x', 'y', 'width', 'height'] as const) {
			const raw = options[key];
			if (raw !== undefined) request[key] = Number(raw);
		}
		const invalid = validateQuickChatBoundsRequest(request);
		if (invalid) {
			fail(invalid, options);
			return;
		}
		Object.assign(message, request);
	}
	if (action === 'agent') {
		try {
			message.agentId = resolveAgentId(args.agent ?? '');
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options);
			return;
		}
	}

	try {
		const result = await withMaestroClient((client) =>
			client.sendCommand<QuickChatResponse>(message, 'quick_chat_result')
		);
		if (options.json) {
			console.log(
				JSON.stringify({ success: result.success, error: result.error, ...result.status })
			);
			if (!result.success) process.exit(1);
			return;
		}
		if (!result.success) {
			fail(result.error || `quick-chat ${action} failed`, options);
			return;
		}
		if (action === 'font' && result.status) {
			console.log(`Text size: ${Math.round(result.status.fontScale * 100)}%`);
		} else if (
			(action === 'status' ||
				action === 'bounds' ||
				action === 'pin' ||
				action === 'send' ||
				action === 'new-tab') &&
			result.status
		) {
			printStatus(result.status);
		} else console.log(`Quick Chat: ${action} done`);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options);
	}
}
