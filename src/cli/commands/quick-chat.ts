// Quick Chat commands - drive the hotkey-summoned floating chat window from the
// CLI. Every verb rides the `quick_chat` WS message to the same main-process
// controller the window's own buttons call, so `quick-chat send` is the exact
// path typing in the window takes.

import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import { parseCliBool } from '../utils/parse';
import { readCliImageFile } from '../utils/imageFiles';
import {
	describeQuickChatRoute,
	parseQuickChatTabChoice,
	validateQuickChatBoundsRequest,
	type QuickChatBoundsRequest,
	type QuickChatFontScaleRequest,
	type QuickChatNextTarget,
	type QuickChatRecentSummary,
	type QuickChatStatus,
} from '../../shared/quickChat';
import { FONT_SCALE_MAX, FONT_SCALE_MIN } from '../../shared/scaleRange';
import { formatRelativeTime } from '../../shared/formatters';
import { asThinkingMode, type ThinkingMode } from '../../shared/types';

export interface QuickChatOptions {
	json?: boolean;
	/** `send` only: image files sent with the message, like a paste in the window. */
	image?: string[];
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
	/** `history` only. */
	recents?: QuickChatRecentSummary[];
}

export type QuickChatAction =
	| 'show'
	| 'hide'
	| 'toggle'
	| 'return'
	| 'status'
	| 'send'
	| 'new'
	| 'keep'
	| 'pin'
	| 'thinking'
	| 'tab'
	| 'font'
	| 'agent'
	| 'reveal'
	| 'stop'
	| 'new-tab'
	| 'steer'
	| 'history'
	| 'recall'
	| 'bounds';

/** Largest image `send --image` takes: well past any screenshot, short of a video still dump. */
const MAX_QUICK_CHAT_IMAGE_BYTES = 20 * 1024 * 1024;

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

/** What `quick-chat status` and `quick-chat thinking` say about each thinking mode. */
const THINKING_DESCRIPTIONS: Record<ThinkingMode, string> = {
	off: 'hidden',
	on: 'shown while a reply is written',
	sticky: 'kept above each answer',
};

/**
 * `quick-chat thinking <mode>`: `off`, `on` (shown until the answer arrives),
 * `sticky` (kept), or `cycle` to step the way the window's button does. Throws
 * on anything else, so a typo never changes the mode.
 */
export function parseQuickChatThinkingArg(arg: string): ThinkingMode | 'cycle' {
	const word = arg.trim().toLowerCase();
	if (word === 'cycle') return 'cycle';
	const mode = asThinkingMode(word);
	if (!mode) throw new Error(`Unknown thinking mode "${arg}". Use off, on, sticky, or cycle`);
	return mode;
}

/** Where the next message goes, in words. */
export function describeQuickChatNextTarget(next: QuickChatNextTarget): string {
	if (next.kind === 'new') return 'a new tab';
	if (next.kind === 'auto') return 'any tab (Maestro finds the one that fits)';
	return `tab "${next.name}" (${next.tabId})${next.chosen ? ', chosen' : ''}`;
}

function fail(message: string, options: QuickChatOptions): void {
	if (options.json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

/** The recent chats, numbered as `quick-chat recall` takes them. */
export function printRecents(
	recents: QuickChatRecentSummary[],
	currentChatId: string | null
): void {
	if (recents.length === 0) {
		console.log('No recent chats yet');
		return;
	}
	recents.forEach((recent, index) => {
		const count = `${recent.messageCount} message${recent.messageCount === 1 ? '' : 's'}`;
		const mark = recent.id === currentChatId ? ' (in the window now)' : '';
		console.log(`${index + 1}. ${recent.title}${mark}`);
		console.log(
			`   ${recent.agentName || recent.agentId}, ${count}, ${formatRelativeTime(recent.updatedAt)}  [${recent.id}]`
		);
	});
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
	console.log(`Thinking: ${snapshot.thinking}, ${THINKING_DESCRIPTIONS[snapshot.thinking]}`);
	console.log(`Next message goes to: ${describeQuickChatNextTarget(snapshot.next)}`);
	if (snapshot.tabs.length > 0) {
		console.log('Tabs (pass an id to `quick-chat tab`):');
		for (const tab of snapshot.tabs) {
			const notes = [tab.inChat ? 'this chat' : '', tab.busy ? 'working' : ''].filter(Boolean);
			console.log(`  ${tab.id}  ${tab.name}${notes.length ? ` (${notes.join(', ')})` : ''}`);
		}
	}
	console.log(
		`Agent: ${snapshot.agentName ?? 'none'}${snapshot.agentId ? ` (${snapshot.agentId})` : ''}`
	);
	console.log(
		`Chat: ${snapshot.tabId ? `tab ${snapshot.tabId}` : 'not started'}, ${snapshot.persistent ? 'kept as a tab' : 'ephemeral'}${snapshot.busy ? ', working' : ''}`
	);
	for (const message of snapshot.messages) {
		const who = {
			user: 'You',
			assistant: 'Agent',
			thinking: 'Agent (thinking)',
			error: 'Error',
		}[message.role];
		// A message the user sent names where it went, and its id is what
		// `reveal <id>`, `new-tab <id>` and `steer <id>` take.
		const route = message.route
			? ` [${message.id}] (${describeQuickChatRoute(message.route)})`
			: '';
		const count = message.images?.length ?? 0;
		const images = count > 0 ? ` [${count} image${count === 1 ? '' : 's'}]` : '';
		console.log(`\n${who}${route}${images}: ${message.text}`);
	}
}

export async function quickChat(
	action: QuickChatAction,
	args: { text?: string; state?: string; agent?: string; messageId?: string; chatId?: string },
	options: QuickChatOptions
): Promise<void> {
	const message: Record<string, unknown> = { type: 'quick_chat', action };
	if (action === 'send') {
		const imagePaths = options.image ?? [];
		if (!args.text?.trim() && imagePaths.length === 0) {
			fail('message cannot be empty', options);
			return;
		}
		message.text = args.text ?? '';
		if (imagePaths.length > 0) {
			try {
				message.images = imagePaths.map(
					(input) => readCliImageFile(input, MAX_QUICK_CHAT_IMAGE_BYTES).dataUrl
				);
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error), options);
				return;
			}
		}
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
	if ((action === 'reveal' || action === 'new-tab' || action === 'steer') && args.messageId) {
		message.messageId = args.messageId;
	}
	if (action === 'recall') {
		if (!args.chatId?.trim()) {
			fail('Give a chat number from `quick-chat history`, its id, or an id prefix', options);
			return;
		}
		message.chatId = args.chatId.trim();
	}
	if (action === 'tab' && args.state !== undefined) {
		const choice = parseQuickChatTabChoice(args.state);
		if (!choice) {
			fail('Give a tab id, new, or auto', options);
			return;
		}
		message.tab = args.state.trim();
	}
	if (action === 'thinking' && args.state !== undefined) {
		try {
			message.mode = parseQuickChatThinkingArg(args.state);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options);
			return;
		}
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
			const payload =
				action === 'history' ? { recents: result.recents ?? [] } : { ...result.status };
			console.log(JSON.stringify({ success: result.success, error: result.error, ...payload }));
			if (!result.success) process.exit(1);
			return;
		}
		if (!result.success) {
			fail(result.error || `quick-chat ${action} failed`, options);
			return;
		}
		if (action === 'history') {
			printRecents(result.recents ?? [], result.status?.snapshot.chatId ?? null);
		} else if (action === 'font' && result.status) {
			console.log(`Text size: ${Math.round(result.status.fontScale * 100)}%`);
		} else if (action === 'tab' && result.status) {
			console.log(
				`Next message goes to: ${describeQuickChatNextTarget(result.status.snapshot.next)}`
			);
		} else if (action === 'thinking' && result.status) {
			const mode = result.status.snapshot.thinking;
			console.log(`Thinking: ${mode}, ${THINKING_DESCRIPTIONS[mode]}`);
		} else if (
			(action === 'status' ||
				action === 'bounds' ||
				action === 'pin' ||
				action === 'send' ||
				action === 'new-tab' ||
				action === 'steer' ||
				action === 'recall') &&
			result.status
		) {
			printStatus(result.status);
		} else console.log(`Quick Chat: ${action} done`);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options);
	}
}
