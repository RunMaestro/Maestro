/**
 * Wire shape for the `message_pin_command` message: the CLI half of message
 * pins (`maestro-cli tab pins ...`).
 *
 * Pins live on the tab in the renderer that owns the agent, so the CLI reads
 * and changes them through that renderer, with the same functions the pin
 * button and the pin panel call. One message with an `action` (the
 * `closed_tab_command` pattern), so every verb names its tab the same way.
 *
 * Lives in `shared/` because all three processes need it: the CLI builds the
 * request, main validates it on the way through, and the renderer answers it.
 */

import type { PinnableSource } from './messagePins';

/** The verbs a pin command can carry. */
export const MESSAGE_PIN_COMMAND_ACTIONS = ['list', 'add', 'remove', 'rename', 'show'] as const;

export type MessagePinCommandAction = (typeof MESSAGE_PIN_COMMAND_ACTIONS)[number];

/** Which message `add --last` pins: the person's or the agent's. */
export const MESSAGE_PIN_LAST_TARGETS = ['user', 'agent'] as const;

export type MessagePinLastTarget = (typeof MESSAGE_PIN_LAST_TARGETS)[number];

/** Narrow an unknown value to a pin action. */
export function isMessagePinCommandAction(value: unknown): value is MessagePinCommandAction {
	return (
		typeof value === 'string' &&
		MESSAGE_PIN_COMMAND_ACTIONS.includes(value as MessagePinCommandAction)
	);
}

/** One pin command, already validated. */
export interface MessagePinCommandRequest {
	action: MessagePinCommandAction;
	/** Agent that owns the tab. */
	sessionId: string;
	/** The AI tab whose pins are read or changed. */
	tabId: string;
	/** `add`: the message to pin, by transcript entry id (exact or unique prefix). */
	messageId?: string;
	/** `add`: pin the newest message of this kind instead of naming one. */
	last?: MessagePinLastTarget;
	/** `remove` / `rename`: the pin (exact id or unique prefix). */
	pinId?: string;
	/** `rename`: the new label. Empty clears it, so the pin shows its title. */
	label?: string;
}

/** One pin, flattened for the wire. */
export interface MessagePinSummary {
	id: string;
	/** What the pin panel shows: the person's label, else the title. */
	label: string;
	/** The automatic title taken from the message's first line. */
	title: string;
	/** True when the person renamed the pin. */
	renamed: boolean;
	source: PinnableSource;
	/** The message's timestamp (ms epoch). */
	timestamp: number;
	pinnedAt: number;
	/** The transcript entry the pin resolves to now, when it is loaded. */
	messageId: string | null;
	/** False when the message is older than what the tab has loaded. */
	loaded: boolean;
	/** Leading plain text of the message. */
	excerpt: string;
}

/** What the renderer answers a pin command with. */
export interface MessagePinCommandResult {
	success: boolean;
	error?: string;
	/** Every action: the tab's pins after the action, in transcript order. */
	pins?: MessagePinSummary[];
	/** `add` / `remove` / `rename`: the pin the action touched. */
	pin?: MessagePinSummary;
	/** `add`: the message was already pinned, so nothing changed. */
	alreadyPinned?: boolean;
}

/**
 * Narrow whatever the renderer sent back to a result. A malformed answer
 * becomes a failed command rather than a `success: undefined` the CLI would
 * report as done.
 */
export function normalizeMessagePinCommandResult(raw: unknown): MessagePinCommandResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid pin command response' };
	}
	const candidate = raw as Partial<MessagePinCommandResult>;
	if (candidate.success !== true) {
		return {
			success: false,
			error: typeof candidate.error === 'string' ? candidate.error : 'Pin command failed',
		};
	}
	return {
		success: true,
		...(Array.isArray(candidate.pins) ? { pins: candidate.pins } : {}),
		...(candidate.pin && typeof candidate.pin === 'object' ? { pin: candidate.pin } : {}),
		...(candidate.alreadyPinned === true ? { alreadyPinned: true } : {}),
	};
}

function trimmedString(value: unknown): string {
	return typeof value === 'string' ? value.trim() : '';
}

/**
 * Validate a raw `message_pin_command` message. Runs in main, between a CLI of
 * any version and the renderer, so the renderer never has to guess which
 * message or pin was meant.
 */
export function parseMessagePinCommandRequest(
	message: Record<string, unknown>
): { ok: true; request: MessagePinCommandRequest } | { ok: false; error: string } {
	const action = message.action;
	if (!isMessagePinCommandAction(action)) {
		return {
			ok: false,
			error: `Invalid or missing pin action. Must be one of: ${MESSAGE_PIN_COMMAND_ACTIONS.join(', ')}`,
		};
	}
	const sessionId = trimmedString(message.sessionId);
	if (!sessionId) return { ok: false, error: `Pin ${action} requires a sessionId` };
	const tabId = trimmedString(message.tabId);
	if (!tabId) return { ok: false, error: `Pin ${action} requires a tabId` };
	const base = { action, sessionId, tabId };

	if (action === 'list' || action === 'show') return { ok: true, request: base };

	if (action === 'add') {
		const messageId = trimmedString(message.messageId);
		const last = message.last;
		if (last !== undefined && !MESSAGE_PIN_LAST_TARGETS.includes(last as MessagePinLastTarget)) {
			return { ok: false, error: `last must be one of: ${MESSAGE_PIN_LAST_TARGETS.join(', ')}` };
		}
		if (messageId && last !== undefined) {
			return { ok: false, error: 'Name the message by id or by --last, not both' };
		}
		if (!messageId && last === undefined) {
			return { ok: false, error: 'Pin add needs a message id or --last <user|agent>' };
		}
		return {
			ok: true,
			request: {
				...base,
				...(messageId ? { messageId } : { last: last as MessagePinLastTarget }),
			},
		};
	}

	const pinId = trimmedString(message.pinId);
	if (!pinId) return { ok: false, error: `Pin ${action} requires a pin id` };
	if (action === 'remove') return { ok: true, request: { ...base, pinId } };

	if (message.label !== undefined && typeof message.label !== 'string') {
		return { ok: false, error: 'label must be a string' };
	}
	return {
		ok: true,
		request: { ...base, pinId, label: typeof message.label === 'string' ? message.label : '' },
	};
}
