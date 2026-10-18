/**
 * Group chat steering: hand a message to a round that is ALREADY RUNNING
 * instead of waiting for the room to go idle.
 *
 * Rides the same mechanism as tab steering (src/shared/chatSteering.ts): each
 * moderator and participant turn is its own maestro-p process with its own
 * steering socket, and `ProcessManager.steer()` types into it. What is
 * group-chat-specific is WHICH turn a message goes to, and that rule lives here
 * so the Steer button, the main process and `maestro-cli group-chat steer` all
 * apply the same one. A steer goes to exactly ONE turn:
 *
 *   1. The moderator's, when it is running. It is the router: a steer it
 *      absorbs can still change who it @mentions.
 *   2. Otherwise one working participant: the one the message @mentions, or
 *      the only one working when it mentions nobody. A mention of an idle or
 *      absent agent is a routing request only the moderator can act on, so
 *      that message stays queued for it.
 *
 * One turn, never a broadcast: participants run different jobs, so one message
 * typed into all of them would steer each off its own task. It also keeps the
 * answer exact: the message either reached that turn or it did not, with no
 * partial delivery to reconcile.
 *
 * Pure and renderer-safe: no Node imports.
 */

import {
	startsWithTuiCommandPrefix,
	steeringTextTooLong,
	STEERING_TOO_LONG_DETAIL,
	type QueueSteerResult,
	type SteeringResultFrame,
} from './chatSteering';
import { extractAllMentions, mentionMatches } from './group-chat-types';

/** The name a steer into the moderator's turn is recorded under. */
export const GROUP_CHAT_MODERATOR_STEER_TARGET = 'Moderator';

/** Why a group chat message cannot be steered into the running round right now. */
export type GroupChatSteerBlockedReason =
	| 'room-idle'
	| 'nothing-to-type'
	| 'has-images'
	| 'too-long'
	| 'command-prefix'
	| 'sending'
	| 'held'
	| 'steer-in-flight'
	| 'read-only'
	| 'no-running-turn'
	| 'mention-not-working'
	| 'ambiguous-target';

/** Each blocked reason as a sentence for the user. A Record so a new reason must be worded. */
export const GROUP_CHAT_STEER_BLOCKED_DETAILS: Record<GroupChatSteerBlockedReason, string> = {
	'room-idle': 'Nothing is running in this room, so there is nothing to steer.',
	'nothing-to-type': 'The message is empty.',
	'has-images':
		'Images cannot be typed into a running turn. The message sends when the round ends.',
	'too-long': `${STEERING_TOO_LONG_DETAIL}. It sends when the round ends.`,
	'command-prefix':
		'A message that starts with / or ! would run as a command in the running turn. It sends when the round ends.',
	sending: 'This message is already on its way to the moderator.',
	held: 'This message is held after a send or steer that may not have arrived. Resume the queue to send it.',
	'steer-in-flight': 'A message is being handed to this room already. Try again in a moment.',
	'read-only':
		'This message asks for read-only mode and the running round is not read-only. It sends when the round ends.',
	'no-running-turn': 'No turn in this room is running right now, so there is nothing to steer.',
	'mention-not-working':
		'The message @mentions an agent that is not working right now. The moderator routes it when the round ends.',
	'ambiguous-target':
		'More than one agent is working. @mention the one agent to steer, or the message sends when the round ends.',
};

/**
 * What can be decided about a message without knowing which processes run:
 * the room's state and the message itself. Main re-checks this and then the
 * facts only it holds (running turns, read-only round).
 */
export function groupChatSteerBlockedReason(input: {
	/** Whether anything in the room is running (any state but `idle`). */
	busy: boolean;
	text: string | undefined;
	images?: readonly string[];
	sending?: boolean;
	/** Held after a send or steer that may have arrived; only Resume releases it. */
	failed?: boolean;
}): GroupChatSteerBlockedReason | null {
	if (input.sending) return 'sending';
	// Steering a held item again could type it a second time. Resume is the way out.
	if (input.failed) return 'held';
	if (!input.busy) return 'room-idle';
	const text = input.text?.trim();
	if (!text) return 'nothing-to-type';
	if (input.images && input.images.length > 0) return 'has-images';
	if (steeringTextTooLong(text)) return 'too-long';
	// Also catches the room's own `!autorun` / `!commit` directives, which are for
	// the moderator to read, not for a TUI to run.
	if (startsWithTuiCommandPrefix(text)) return 'command-prefix';
	return null;
}

/** One turn a steer can be typed into. */
export interface GroupChatSteerTarget {
	/** Participant name, or {@link GROUP_CHAT_MODERATOR_STEER_TARGET}. */
	name: string;
	/** The turn's FULL process id (what `ProcessManager.steer` is keyed by). */
	processId: string;
}

/** The turns running in a room right now. */
export interface GroupChatRunningTurns {
	moderator?: string;
	participants: GroupChatSteerTarget[];
}

/** Which turn `text` goes to, by the rule in this file's header. */
export function pickGroupChatSteerTarget(
	text: string,
	running: GroupChatRunningTurns
):
	| { target: GroupChatSteerTarget }
	| {
			blocked: Extract<
				GroupChatSteerBlockedReason,
				'no-running-turn' | 'mention-not-working' | 'ambiguous-target'
			>;
	  } {
	if (running.moderator) {
		return { target: { name: GROUP_CHAT_MODERATOR_STEER_TARGET, processId: running.moderator } };
	}
	if (running.participants.length === 0) return { blocked: 'no-running-turn' };

	const mentions = extractAllMentions(text);
	if (mentions.length === 0) {
		return running.participants.length === 1
			? { target: running.participants[0] }
			: { blocked: 'ambiguous-target' };
	}

	const named = new Set<GroupChatSteerTarget>();
	for (const mention of mentions) {
		const matched = running.participants.filter((p) => mentionMatches(mention, p.name));
		if (matched.length === 0) return { blocked: 'mention-not-working' };
		for (const target of matched) named.add(target);
	}
	const [only, ...rest] = named;
	return rest.length === 0 ? { target: only } : { blocked: 'ambiguous-target' };
}

/** What a group chat steer did: the tab result, plus the turn that took it. */
export interface GroupChatSteerResult extends QueueSteerResult {
	/** The turn that took the message (delivered, absorbed or queued). */
	targets?: string[];
}

/**
 * One socket answer as a steer result. `delivered`, `absorbed` and `queued` all
 * mean the turn has the text. Anything else that is not a clean refusal means it
 * MIGHT (`unknown`, a socket-level `dropped`), so it is `unconfirmed`, never
 * `refused`: the caller holds the message rather than inviting a re-send that
 * could double it.
 */
export function groupChatSteerResult(
	target: GroupChatSteerTarget,
	frame: SteeringResultFrame
): GroupChatSteerResult {
	switch (frame.verdict) {
		case 'delivered':
			return { outcome: 'delivered', verdict: 'delivered', targets: [target.name] };
		case 'absorbed':
		case 'queued':
			return { outcome: 'settled', verdict: frame.verdict, targets: [target.name] };
		case 'refused':
			return {
				outcome: 'refused',
				verdict: 'refused',
				refusal: frame.refusal,
				detail: frame.detail,
			};
		default:
			return { outcome: 'unconfirmed', verdict: frame.verdict, detail: frame.detail };
	}
}

/** The `|steered:` field a steered user line carries in the chat log. */
export const STEERED_LOG_FIELD_PREFIX = 'steered:';

/** Serialize the targets for the log. Names are encoded: they may hold commas or pipes. */
export function formatSteeredLogField(targets: readonly string[]): string {
	return `${STEERED_LOG_FIELD_PREFIX}${targets.map(encodeURIComponent).join(',')}`;
}

/** Read a `|steered:` field back. Returns null for any other field. */
export function parseSteeredLogField(field: string): string[] | null {
	if (!field.startsWith(STEERED_LOG_FIELD_PREFIX)) return null;
	const names = field
		.slice(STEERED_LOG_FIELD_PREFIX.length)
		.split(',')
		.filter(Boolean)
		.map((name) => {
			try {
				return decodeURIComponent(name);
			} catch {
				return name;
			}
		});
	return names.length > 0 ? names : null;
}
