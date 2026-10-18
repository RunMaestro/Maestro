/**
 * Tests for main/cot-export/resolve-agent.ts.
 *
 * The id shapes below are the ones minted by the real spawn sites (see the
 * table in the module header). They are written out literally rather than
 * built by calling the minting code, so a change to a minting site that is not
 * mirrored in the resolver fails here.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
	warn: vi.fn(),
	error: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({ logger: loggerMock }));

import {
	__resetCotResolverLogForTests,
	classifyCotSessionId,
	peekCotAgentId,
	resolveCotTarget,
} from '../../../main/cot-export/resolve-agent';
import type {
	CotResolverDeps,
	CotResolverParticipant,
	CotResolverSession,
} from '../../../main/cot-export/resolve-agent';

const AGENT = '11111111-2222-4333-8444-555555555555';
const OTHER_AGENT = '66666666-7777-4888-8999-000000000000';
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHAT = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
const UUID_TAIL = '12345678-1234-4234-8234-123456789abc';

const SESSIONS: CotResolverSession[] = [
	{ id: AGENT, name: 'Backend', toolType: 'claude-code' },
	{ id: OTHER_AGENT, name: 'Review Bot [Linux]', toolType: 'codex' },
];

function makeDeps(overrides: Partial<CotResolverDeps> = {}): CotResolverDeps {
	return {
		getSessions: () => SESSIONS,
		getGroupChatParticipant: () => undefined,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	__resetCotResolverLogForTests();
});

describe('classifyCotSessionId', () => {
	it.each([
		['an AI tab', `${AGENT}-ai-${TAB}`, { origin: 'interactive', agentId: AGENT, tabId: TAB }],
		[
			'a forced-parallel AI tab, with the suffix stripped',
			`${AGENT}-ai-${TAB}-fp-1767225600000`,
			{ origin: 'interactive', agentId: AGENT, tabId: TAB },
		],
		[
			'the default tab',
			`${AGENT}-ai-default`,
			{ origin: 'interactive', agentId: AGENT, tabId: 'default' },
		],
		['the older bare AI id', `${AGENT}-ai`, { origin: 'interactive', agentId: AGENT }],
		['an Auto Run task', `${AGENT}-batch-1767225600000`, { origin: 'auto-run', agentId: AGENT }],
	])('reads %s as an agent turn', (_label, id, expected) => {
		expect(classifyCotSessionId(id)).toEqual({ kind: 'agent-turn', ...expected });
	});

	it('reads a participant id into the chat id and the participant name', () => {
		expect(classifyCotSessionId(`group-chat-${CHAT}-participant-Backend-${UUID_TAIL}`)).toEqual({
			kind: 'group-chat-participant',
			groupChatId: CHAT,
			participantName: 'Backend',
		});
	});

	it('strips the recovery marker from a participant name', () => {
		expect(
			classifyCotSessionId(`group-chat-${CHAT}-participant-Backend-recovery-1767225600000`)
		).toEqual({ kind: 'group-chat-participant', groupChatId: CHAT, participantName: 'Backend' });
	});

	it('keeps a hyphenated participant name whole', () => {
		expect(classifyCotSessionId(`group-chat-${CHAT}-participant-Review-Bot-1767225600000`)).toEqual(
			{
				kind: 'group-chat-participant',
				groupChatId: CHAT,
				participantName: 'Review-Bot',
			}
		);
	});

	it.each([
		['a moderator', `group-chat-${CHAT}-moderator-1767225600000`],
		['a moderator synthesis turn', `group-chat-${CHAT}-moderator-1767225600001`],
		['an exit synopsis', `${AGENT}-synopsis-1767225600000`],
		['the Cue assist chat', `${AGENT}-cue-assist-1767225600000`],
		['a context groomer (AI command mode, Director Notes, merge)', `groomer-${UUID_TAIL}`],
		['tab naming', `tab-naming-${UUID_TAIL}`],
		['a feedback conversation', 'feedback-1767225600000-k3j2h1g0f'],
		['the wizard conversation', 'wizard-1767225600000-k3j2h1g0f'],
		['the wizard document generation', 'wizard-gen-1767225600000-k3j2h1g0f'],
		['the inline wizard conversation', 'inline-wizard-1767225600000-k3j2h1g0f'],
		['the inline wizard document generation', 'inline-wizard-gen-1767225600000-k3j2h1g0f'],
		['a Cue run listing', 'cue-run-8f14e45f-ceea-467a-9575-1d5b0c7a5a2e'],
		['the terminal', `${AGENT}-terminal`],
		['a terminal tab', `${AGENT}-terminal-${TAB}`],
	])('reads %s as internal', (_label, id) => {
		expect(classifyCotSessionId(id)).toEqual({ kind: 'internal' });
	});

	it.each([
		['a made-up shape', 'something-else-entirely'],
		['an empty id', ''],
		['a group chat id of no known kind', `group-chat-${CHAT}-observer-1767225600000`],
		['an id whose chat id is not a uuid', 'group-chat-not-a-uuid-moderator-1'],
	])('reads %s as unknown', (_label, id) => {
		expect(classifyCotSessionId(id)).toEqual({ kind: 'unknown' });
	});

	it('does not read a terminal tab as an AI turn even when the tab id says ai', () => {
		expect(classifyCotSessionId(`${AGENT}-terminal-ai-1`)).toEqual({ kind: 'internal' });
	});
});

describe('resolveCotTarget', () => {
	describe('interactive and Auto Run turns', () => {
		it('resolves an AI tab to the agent, the tab, and the interactive origin', async () => {
			await expect(resolveCotTarget(`${AGENT}-ai-${TAB}`, makeDeps())).resolves.toEqual({
				agentId: AGENT,
				origin: 'interactive',
				tabId: TAB,
			});
		});

		it('strips a forced-parallel suffix from the tab id', async () => {
			await expect(
				resolveCotTarget(`${AGENT}-ai-${TAB}-fp-1767225600000`, makeDeps())
			).resolves.toEqual({ agentId: AGENT, origin: 'interactive', tabId: TAB });
		});

		it('resolves an Auto Run task with no tab', async () => {
			const target = await resolveCotTarget(`${AGENT}-batch-1767225600000`, makeDeps());
			expect(target).toEqual({ agentId: AGENT, origin: 'auto-run' });
			expect(target).not.toHaveProperty('tabId');
		});

		it('returns null when the agent is not in the sessions store', async () => {
			await expect(
				resolveCotTarget('99999999-9999-4999-8999-999999999999-ai-t1', makeDeps())
			).resolves.toBeNull();
			await expect(
				resolveCotTarget('99999999-9999-4999-8999-999999999999-batch-1767225600000', makeDeps())
			).resolves.toBeNull();
		});

		it('reads the sessions at the moment of the call, not once', async () => {
			let sessions: CotResolverSession[] = [];
			const deps = makeDeps({ getSessions: () => sessions });
			await expect(resolveCotTarget(`${AGENT}-ai-${TAB}`, deps)).resolves.toBeNull();
			sessions = SESSIONS;
			await expect(resolveCotTarget(`${AGENT}-ai-${TAB}`, deps)).resolves.not.toBeNull();
		});
	});

	describe('Maestro-internal spawns', () => {
		it.each([
			`${AGENT}-synopsis-1767225600000`,
			`${AGENT}-cue-assist-1767225600000`,
			`groomer-${UUID_TAIL}`,
			`tab-naming-${UUID_TAIL}`,
			'feedback-1767225600000-k3j2h1g0f',
			'wizard-1767225600000-k3j2h1g0f',
			'wizard-gen-1767225600000-k3j2h1g0f',
			'inline-wizard-1767225600000-k3j2h1g0f',
			'inline-wizard-gen-1767225600000-k3j2h1g0f',
			`cue-run-${UUID_TAIL}`,
			`${AGENT}-terminal`,
			`${AGENT}-terminal-${TAB}`,
		])('resolves %s to null without logging', async (id) => {
			await expect(resolveCotTarget(id, makeDeps())).resolves.toBeNull();
			expect(loggerMock.debug).not.toHaveBeenCalled();
		});

		it('never asks for the sessions of an internal spawn', async () => {
			const getSessions = vi.fn(() => SESSIONS);
			await resolveCotTarget(`${AGENT}-synopsis-1767225600000`, makeDeps({ getSessions }));
			expect(getSessions).not.toHaveBeenCalled();
		});
	});

	describe('group chat', () => {
		const participantId = (name: string, tail = '1767225600000') =>
			`group-chat-${CHAT}-participant-${name}-${tail}`;

		it('resolves a participant to the agent it runs as, by name', async () => {
			const getGroupChatParticipant = vi.fn(
				(): CotResolverParticipant => ({ agentId: 'claude-code' })
			);
			const target = await resolveCotTarget(
				participantId('Backend'),
				makeDeps({ getGroupChatParticipant })
			);
			expect(target).toEqual({ agentId: AGENT, origin: 'group-chat' });
			expect(getGroupChatParticipant).toHaveBeenCalledWith(CHAT, 'Backend');
		});

		it('accepts an asynchronous participant lookup', async () => {
			const target = await resolveCotTarget(
				participantId('Backend', UUID_TAIL),
				makeDeps({ getGroupChatParticipant: async () => ({ agentId: 'claude-code' }) })
			);
			expect(target).toEqual({ agentId: AGENT, origin: 'group-chat' });
		});

		it('resolves a recovery turn to the same agent', async () => {
			const target = await resolveCotTarget(
				`group-chat-${CHAT}-participant-Backend-recovery-1767225600000`,
				makeDeps({ getGroupChatParticipant: () => ({ agentId: 'claude-code' }) })
			);
			expect(target).toEqual({ agentId: AGENT, origin: 'group-chat' });
		});

		it('resolves the safe-normalized form of a participant name', async () => {
			const target = await resolveCotTarget(
				participantId('Review-Bot-Linux'),
				makeDeps({ getGroupChatParticipant: () => ({ agentId: 'codex' }) })
			);
			expect(target).toEqual({ agentId: OTHER_AGENT, origin: 'group-chat' });
		});

		it('returns null for a moderator and never looks anything up', async () => {
			const getGroupChatParticipant = vi.fn();
			const getSessions = vi.fn(() => SESSIONS);
			await expect(
				resolveCotTarget(
					`group-chat-${CHAT}-moderator-1767225600000`,
					makeDeps({ getGroupChatParticipant, getSessions })
				)
			).resolves.toBeNull();
			expect(getGroupChatParticipant).not.toHaveBeenCalled();
			expect(getSessions).not.toHaveBeenCalled();
		});

		it('returns null when no agent carries the participant name', async () => {
			const getGroupChatParticipant = vi.fn(() => ({ agentId: 'claude-code' }));
			await expect(
				resolveCotTarget(participantId('Nobody'), makeDeps({ getGroupChatParticipant }))
			).resolves.toBeNull();
			expect(getGroupChatParticipant).not.toHaveBeenCalled();
		});

		it('returns null when two agents carry the name, rather than picking one', async () => {
			const sessions: CotResolverSession[] = [
				{ id: AGENT, name: 'Backend', toolType: 'claude-code' },
				{ id: OTHER_AGENT, name: 'Backend', toolType: 'claude-code' },
			];
			await expect(
				resolveCotTarget(
					participantId('Backend'),
					makeDeps({
						getSessions: () => sessions,
						getGroupChatParticipant: () => ({ agentId: 'claude-code' }),
					})
				)
			).resolves.toBeNull();
		});

		it('does not take a weak (safe-folded) match, the one the router refuses', async () => {
			// "Review Bot (Linux)" folds to the same key as "Review Bot [Linux]" only
			// at priority 1, which the router never accepts for a persisted name.
			const target = await resolveCotTarget(
				participantId('Review Bot (Linux)'),
				makeDeps({ getGroupChatParticipant: () => ({ agentId: 'codex' }) })
			);
			expect(target).toBeNull();
		});

		it('returns null when the chat or the participant is gone', async () => {
			await expect(
				resolveCotTarget(
					participantId('Backend'),
					makeDeps({ getGroupChatParticipant: () => null })
				)
			).resolves.toBeNull();
			await expect(
				resolveCotTarget(
					participantId('Backend'),
					makeDeps({ getGroupChatParticipant: async () => undefined })
				)
			).resolves.toBeNull();
		});

		it('returns null when the name now belongs to an agent on another provider', async () => {
			// The participant was created from a Codex agent; an agent on Claude Code
			// now holds that name. Filing the turn under it would be the wrong chain.
			await expect(
				resolveCotTarget(
					participantId('Backend'),
					makeDeps({ getGroupChatParticipant: () => ({ agentId: 'codex' }) })
				)
			).resolves.toBeNull();
		});

		it('lets a failing participant lookup reject, so the caller decides', async () => {
			await expect(
				resolveCotTarget(
					participantId('Backend'),
					makeDeps({
						getGroupChatParticipant: async () => {
							throw new Error('metadata unreadable');
						},
					})
				)
			).rejects.toThrow('metadata unreadable');
		});
	});

	describe('unrecognized shapes', () => {
		it('returns null and writes one debug line for the shape', async () => {
			await expect(resolveCotTarget('mystery-1767225600000', makeDeps())).resolves.toBeNull();
			expect(loggerMock.debug).toHaveBeenCalledTimes(1);
			expect(loggerMock.debug.mock.calls[0][0]).toContain('mystery-<n>');
		});

		it('logs a shape once, however many ids carry it', async () => {
			await resolveCotTarget('mystery-1767225600000', makeDeps());
			await resolveCotTarget('mystery-1767225600001', makeDeps());
			await resolveCotTarget('mystery-1767225600002', makeDeps());
			expect(loggerMock.debug).toHaveBeenCalledTimes(1);
		});

		it('logs a different shape separately', async () => {
			await resolveCotTarget('mystery-1767225600000', makeDeps());
			await resolveCotTarget('another-shape', makeDeps());
			expect(loggerMock.debug).toHaveBeenCalledTimes(2);
		});

		it('does not log at any level above debug', async () => {
			await resolveCotTarget('mystery-1767225600000', makeDeps());
			expect(loggerMock.info).not.toHaveBeenCalled();
			expect(loggerMock.warn).not.toHaveBeenCalled();
			expect(loggerMock.error).not.toHaveBeenCalled();
		});
	});
});

describe('peekCotAgentId', () => {
	const participantId = (name: string) => `group-chat-${CHAT}-participant-${name}-1767225600000`;

	// The answer every shape gets from memory alone, beside the answer the full
	// lookup gives. A peek may name an agent the full lookup then refuses. It
	// must never name a DIFFERENT agent, and never miss one the lookup accepts.
	const cases: Array<{ name: string; id: string; agentId: string | null }> = [
		{ name: 'an interactive turn', id: `${AGENT}-ai-${TAB}`, agentId: AGENT },
		{ name: 'a failover turn', id: `${AGENT}-ai-${TAB}-fp-1767225600000`, agentId: AGENT },
		{ name: 'an older bare AI id', id: `${AGENT}-ai`, agentId: AGENT },
		{ name: 'an Auto Run task', id: `${AGENT}-batch-1767225600000`, agentId: AGENT },
		{ name: 'a group chat participant', id: participantId('Backend'), agentId: AGENT },
		{
			name: 'a participant by its safe-normalized name',
			id: participantId('Review-Bot-Linux'),
			agentId: OTHER_AGENT,
		},
		{ name: 'a participant no agent is named after', id: participantId('Ghost'), agentId: null },
		{
			name: 'a turn of an agent Maestro no longer has',
			id: `deadbeef-0000-4000-8000-000000000000-ai-${TAB}`,
			agentId: null,
		},
		{
			name: 'a group chat moderator',
			id: `group-chat-${CHAT}-moderator-1767225600000`,
			agentId: null,
		},
		{ name: 'an exit synopsis', id: `${AGENT}-synopsis-1767225600000`, agentId: null },
		{ name: 'a terminal tab', id: `${AGENT}-terminal-${TAB}`, agentId: null },
		{ name: 'a tab naming run', id: `tab-naming-${UUID_TAIL}`, agentId: null },
		// No consult router is given here, so nothing vouches for the consult.
		{ name: 'a consult nobody lists', id: `cross-agent-${UUID_TAIL}`, agentId: null },
		{ name: 'a shape nobody listed', id: 'mystery-1767225600000', agentId: null },
	];

	it.each(cases)('answers $name', ({ id, agentId }) => {
		expect(peekCotAgentId(id, makeDeps())).toBe(agentId);
	});

	it.each(cases)('never disagrees with the full lookup about $name', async ({ id, agentId }) => {
		const target = await resolveCotTarget(
			id,
			makeDeps({
				// The provider each named agent runs, so the full lookup accepts.
				getGroupChatParticipant: (_chat, name) => ({
					agentId: name === 'Backend' ? 'claude-code' : 'codex',
				}),
			})
		);
		expect(target?.agentId ?? null).toBe(agentId);
	});

	it('answers without the participant lookup, which needs a read', () => {
		const getGroupChatParticipant = vi.fn();
		const deps = makeDeps({ getGroupChatParticipant });
		expect(peekCotAgentId(participantId('Backend'), deps)).toBe(AGENT);
		expect(getGroupChatParticipant).not.toHaveBeenCalled();
	});

	it('can name an agent the full lookup then refuses', async () => {
		// The participant was created on another provider than the agent that
		// now carries its name, so the turn is not that agent's to record.
		const deps = makeDeps({ getGroupChatParticipant: () => ({ agentId: 'codex' }) });
		expect(peekCotAgentId(participantId('Backend'), deps)).toBe(AGENT);
		await expect(resolveCotTarget(participantId('Backend'), deps)).resolves.toBeNull();
	});

	it('does not read the agents for a process that is not an agent turn', () => {
		const getSessions = vi.fn(() => SESSIONS);
		peekCotAgentId(`${AGENT}-synopsis-1767225600000`, { getSessions });
		peekCotAgentId(`${AGENT}-terminal`, { getSessions });
		peekCotAgentId(`group-chat-${CHAT}-moderator-1767225600000`, { getSessions });
		peekCotAgentId('mystery-1767225600000', { getSessions });
		expect(getSessions).not.toHaveBeenCalled();
	});

	it('writes the one debug line for a shape nobody listed, shared with the full lookup', async () => {
		expect(peekCotAgentId('mystery-1767225600000', makeDeps())).toBeNull();
		await resolveCotTarget('mystery-1767225600001', makeDeps());
		expect(loggerMock.debug).toHaveBeenCalledTimes(1);
		expect(loggerMock.debug.mock.calls[0][0]).toContain('mystery-<n>');
	});
});

describe('a consult', () => {
	const REQUEST = UUID_TAIL;
	const ID = `cross-agent-${REQUEST}`;
	const ASKING = 'aaaaaaaa-1111-4222-8333-444444444444';

	/** A consult router that lists one consult: `ASKING` asks `answering`. */
	const withConsult = (answering: string = AGENT) =>
		makeDeps({
			getConsultParties: (requestId) =>
				requestId === REQUEST ? { sourceSessionId: ASKING, targetSessionId: answering } : null,
		});

	it('is read by its request id', () => {
		expect(classifyCotSessionId(ID)).toEqual({ kind: 'consult', requestId: REQUEST });
		expect(classifyCotSessionId('cross-agent-')).toEqual({ kind: 'unknown' });
	});

	it('is a turn of the agent that answers, and names the agent that asked', async () => {
		expect(peekCotAgentId(ID, withConsult())).toBe(AGENT);
		await expect(resolveCotTarget(ID, withConsult())).resolves.toEqual({
			agentId: AGENT,
			origin: 'consult',
			consultedBy: ASKING,
		});
		expect(loggerMock.debug).not.toHaveBeenCalled();
	});

	it('is answered from memory, with no read of a group chat', async () => {
		const getGroupChatParticipant = vi.fn();
		const deps = { ...withConsult(), getGroupChatParticipant };

		await resolveCotTarget(ID, deps);

		expect(getGroupChatParticipant).not.toHaveBeenCalled();
	});

	it.each([
		['a consult the router no longer lists', makeDeps({ getConsultParties: () => null })],
		['a caller that has no consult router', makeDeps()],
		['an answering agent Maestro no longer has', withConsult('gone-agent')],
	])('is nothing for %s', async (_name, deps) => {
		expect(peekCotAgentId(ID, deps)).toBeNull();
		await expect(resolveCotTarget(ID, deps)).resolves.toBeNull();
	});

	it('is nothing when the consult settled between the two lookups', async () => {
		let listed = true;
		const deps = makeDeps({
			getConsultParties: () =>
				listed ? { sourceSessionId: ASKING, targetSessionId: AGENT } : null,
			// The agent list is read after the first lookup of the consult.
			getSessions: () => {
				listed = false;
				return SESSIONS;
			},
		});

		await expect(resolveCotTarget(ID, deps)).resolves.toBeNull();
	});
});
