import { describe, it, expect } from 'vitest';
import {
	planGroupChatStart,
	toRemoteGroupChatState,
	withParticipantMentions,
} from '../../shared/groupChatRemote';
import type { GroupChat } from '../../shared/group-chat-types';

const baseChat: GroupChat = {
	id: 'chat-1',
	name: 'Maestro Release',
	createdAt: 0,
	moderatorAgentId: 'claude-code',
	moderatorSessionId: 'group-chat-chat-1-moderator',
	participants: [
		{ name: 'rc', agentId: 'claude-code', sessionId: 'proc-rc', addedAt: 0 },
		{ name: 'RunMaestro.ai', agentId: 'codex', sessionId: 'proc-web', addedAt: 0 },
	],
	logPath: '/tmp/log',
	imagesDir: '/tmp/images',
};

describe('toRemoteGroupChatState', () => {
	it('maps the chat name to topic and each participant agent type to toolType', () => {
		const state = toRemoteGroupChatState(baseChat, 'idle');
		expect(state.topic).toBe('Maestro Release');
		expect(state.participants).toEqual([
			{ sessionId: 'proc-rc', name: 'rc', toolType: 'claude-code' },
			{ sessionId: 'proc-web', name: 'RunMaestro.ai', toolType: 'codex' },
		]);
		expect(state.messages).toEqual([]);
		expect(state.moderatorAgentId).toBe('claude-code');
	});

	it('reports any non-idle state as active', () => {
		expect(toRemoteGroupChatState(baseChat, 'idle').isActive).toBe(false);
		expect(toRemoteGroupChatState(baseChat, 'moderator-thinking').isActive).toBe(true);
		expect(toRemoteGroupChatState(baseChat, 'agent-working')).toMatchObject({
			isActive: true,
			state: 'agent-working',
		});
	});

	it('marks user lines as user and everything else as assistant, with epoch timestamps', () => {
		const state = toRemoteGroupChatState(baseChat, 'idle', [
			{ timestamp: '2026-09-26T10:00:00.000Z', from: 'user', content: 'go' },
			{ timestamp: '2026-09-26T10:00:05.000Z', from: 'moderator', content: 'on it' },
		]);
		expect(state.messages.map((m) => [m.role, m.participantName, m.content])).toEqual([
			['user', 'user', 'go'],
			['assistant', 'moderator', 'on it'],
		]);
		expect(state.messages[1].timestamp).toBe(Date.parse('2026-09-26T10:00:05.000Z'));
		expect(new Set(state.messages.map((m) => m.id)).size).toBe(2);
	});

	it('carries who took a steered user message, and nothing on a plain one', () => {
		const state = toRemoteGroupChatState(baseChat, 'moderator-thinking', [
			{ timestamp: '2026-09-26T10:00:00.000Z', from: 'user', content: 'go' },
			{
				timestamp: '2026-09-26T10:00:01.000Z',
				from: 'user',
				content: 'also docs',
				steeredTo: ['Moderator'],
			},
			{ timestamp: '2026-09-26T10:00:02.000Z', from: 'user', content: 'x', steeredTo: [] },
		]);
		expect(state.messages[0]).not.toHaveProperty('steeredTo');
		expect(state.messages[1].steeredTo).toEqual(['Moderator']);
		expect(state.messages[2]).not.toHaveProperty('steeredTo');
	});

	it('leaves the queue out when none is passed', () => {
		const state = toRemoteGroupChatState(baseChat, 'idle');
		expect(state).not.toHaveProperty('queue');
		expect(state).not.toHaveProperty('queuePaused');
	});

	it('reports the queue with only the flags that are set, and never the image data', () => {
		const state = toRemoteGroupChatState(baseChat, 'agent-working', [], {
			items: [
				{ id: 'q1', text: 'plain', timestamp: 1 },
				{
					id: 'q2',
					text: 'with everything',
					timestamp: 2,
					images: ['data:image/png;base64,AAAA'],
					failed: true,
					failureReason: 'boom',
					sending: true,
					readOnlyMode: true,
				},
				{ id: 'q3', text: 'empty images', timestamp: 3, images: [] },
			],
			paused: true,
		});
		expect(state.queue).toEqual([
			{ id: 'q1', text: 'plain', timestamp: 1 },
			{
				id: 'q2',
				text: 'with everything',
				timestamp: 2,
				hasImages: true,
				failed: true,
				failureReason: 'boom',
				sending: true,
			},
			{ id: 'q3', text: 'empty images', timestamp: 3 },
		]);
		expect(state.queuePaused).toBe(true);
	});
});

describe('withParticipantMentions', () => {
	it('prefixes every participant the body does not mention', () => {
		expect(withParticipantMentions('Cut the release.', ['rc', 'RunMaestro.ai'])).toBe(
			'@rc @RunMaestro.ai\n\nCut the release.'
		);
	});

	it('leaves the body alone when every participant is already mentioned', () => {
		const body = '@rc owns the RC. **@RunMaestro.ai** announces.';
		expect(withParticipantMentions(body, ['rc', 'RunMaestro.ai'])).toBe(body);
	});

	it('only adds the missing ones, hyphenating names with spaces', () => {
		expect(withParticipantMentions('@rc go', ['rc', 'Web Site'])).toBe('@Web-Site\n\n@rc go');
	});

	it('treats a hyphenated mention as matching a spaced name', () => {
		expect(withParticipantMentions('@Web-Site go', ['Web Site'])).toBe('@Web-Site go');
	});
});

describe('planGroupChatStart', () => {
	const agents = [
		{ id: 'a1', name: 'Alpha', toolType: 'claude-code' },
		{ id: 'a2', name: 'Beta', toolType: 'codex' },
		{ id: 'a3', name: 'Shell', toolType: 'terminal' },
		{ id: 'a4', name: 'Review Bot', toolType: 'claude-code' },
		{ id: 'a5', name: 'review-bot', toolType: 'opencode' },
	];

	it('plans the participants in the order asked, moderated by the first one’s provider', () => {
		expect(planGroupChatStart(['a2', 'a1'], agents)).toEqual({
			ok: true,
			participants: [agents[1], agents[0]],
			moderatorProvider: 'codex',
		});
	});

	it('lets the caller name the moderator’s provider', () => {
		expect(planGroupChatStart(['a1'], agents, 'opencode')).toMatchObject({
			ok: true,
			moderatorProvider: 'opencode',
		});
	});

	it('refuses an unknown agent, a terminal, and nobody', () => {
		expect(planGroupChatStart(['zzz'], agents)).toEqual({ ok: false, error: 'Unknown agent: zzz' });
		expect(planGroupChatStart(['a3'], agents)).toEqual({
			ok: false,
			error: '"Shell" is a terminal agent and cannot join a group chat',
		});
		expect(planGroupChatStart([], agents)).toEqual({
			ok: false,
			error: 'At least 1 participant is required',
		});
	});

	it('refuses a name two agents answer to, so a mention picks out exactly one', () => {
		expect(planGroupChatStart(['a4'], agents)).toEqual({
			ok: false,
			error: '2 agents answer to @Review Bot; rename one so the mention is unambiguous',
		});
	});

	it('does not count a terminal as a namesake', () => {
		const withTerminalTwin = [
			{ id: 'a1', name: 'Alpha', toolType: 'claude-code' },
			{ id: 'a9', name: 'alpha', toolType: 'terminal' },
		];
		expect(planGroupChatStart(['a1'], withTerminalTwin).ok).toBe(true);
	});
});
