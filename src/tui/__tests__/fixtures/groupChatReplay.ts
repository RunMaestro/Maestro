import {
	makeGroupChatLine,
	type GroupChatEvent,
	type GroupChatParticipant,
	type GroupChatRecord,
} from '../../../shared/maestro-lib';

export const RECORDED_CHAT_ID = '5f1c2a9e-0b7d-4c1e-9a55-3d7f2c0b6a11';

export const RECORDED_PARTICIPANTS: GroupChatParticipant[] = [
	{ sessionId: 's-alpha', name: 'Alpha', provider: 'claude-code' },
	{ sessionId: 's-beta', name: 'Beta', provider: 'codex' },
];

/** The moments of the recorded round, in seconds from its start. */
export const RECORDED_CHAT_POINTS = {
	sent: 0,
	routed: 3,
	alphaStarted: 4,
	betaStarted: 4,
	alphaReplied: 40,
	betaReplied: 55,
	synthesis: 70,
	idle: 71,
} as const;

/** The chat as the host reads it before the round: an idle room with one earlier exchange. */
export function recordedChatBefore(base: number): GroupChatRecord {
	return {
		id: RECORDED_CHAT_ID,
		name: 'Release review',
		moderatorProvider: 'claude-code',
		participants: RECORDED_PARTICIPANTS,
		state: 'idle',
		working: [],
		archived: false,
		lines: [
			makeGroupChatLine('user', 'Is the changelog ready?', base - 600_000),
			makeGroupChatLine('moderator', 'Yes, the changelog is ready.', base - 590_000),
		],
	};
}

/**
 * One round as the desktop pushes it: the message lands, the moderator thinks,
 * routes to both participants, each works and replies in turn, the moderator
 * posts a synthesis, and the room goes idle. Authored from the `groupChat:*`
 * emitters in `src/main/ipc/handlers/groupChat.ts`, not recorded from a desktop,
 * so it carries no user data.
 */
export function recordedRound(base: number): GroupChatEvent[] {
	const at = (seconds: number) => base + seconds * 1000;
	const p = RECORDED_CHAT_POINTS;
	return [
		{
			kind: 'message',
			at: at(p.sent),
			line: makeGroupChatLine('user', 'Can we ship 1.4 today?', at(p.sent)),
		},
		{ kind: 'state', at: at(p.sent), state: 'moderator-thinking' },
		{
			kind: 'message',
			at: at(p.routed),
			line: makeGroupChatLine('moderator', 'Asking @Alpha and @Beta.', at(p.routed)),
		},
		{ kind: 'state', at: at(p.routed), state: 'agent-working' },
		{ kind: 'participant', at: at(p.alphaStarted), name: 'Alpha', working: true },
		{ kind: 'participant', at: at(p.betaStarted), name: 'Beta', working: true },
		{ kind: 'participant', at: at(p.alphaReplied), name: 'Alpha', working: false },
		{
			kind: 'message',
			at: at(p.alphaReplied),
			line: makeGroupChatLine('Alpha', 'Tests are green on main.', at(p.alphaReplied)),
		},
		{ kind: 'participant', at: at(p.betaReplied), name: 'Beta', working: false },
		{
			kind: 'message',
			at: at(p.betaReplied),
			line: makeGroupChatLine('Beta', 'The migration still needs a review.', at(p.betaReplied)),
		},
		{ kind: 'state', at: at(p.synthesis), state: 'moderator-thinking' },
		{
			kind: 'message',
			at: at(p.synthesis),
			line: makeGroupChatLine(
				'moderator',
				'Not yet: review the migration first, then ship.',
				at(p.synthesis)
			),
		},
		{ kind: 'state', at: at(p.idle), state: 'idle' },
	];
}

/** The round cut off after the first `count` events. */
export const recordedRoundUntil = (base: number, count: number): GroupChatEvent[] =>
	recordedRound(base).slice(0, count);
