/**
 * The shared lift runner (`runLift()`): the order of its refusals, the dry run, the import and
 * pointer, the roll back, and the plan text both `maestro-cli lift` and the desktop show.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SshRemoteConfig } from '../../../types';
import { MAX_PERSISTED_TOOL_OUTPUT_CHARS, compactLogToolOutputs } from '../../../toolOutput';
import { setMaestroLibImageRefResolver } from '../../host';
import { withInlineEntryImages } from '../../launch/image-refs';
import type { AITabRecord, AgentRecord } from '../../store/records';
import { createSessionImageStore, sessionImageContentSha256 } from '../../store/session-images';
import { planAgentImport } from '../import-plan';
import { DEFAULT_TAB_DEFAULTS } from '../rules';
import { LIFT_HOST_TOO_OLD } from '../../../federationCommands';
import {
	LiftRunError,
	formatLiftPlan,
	keepDivergentHostTabs,
	liftErrorCode,
	providerEnvVarsOf,
	runLift,
	type LiftHostConnection,
	type LiftRunDeps,
} from '../lift-run';
import { formatHostTabMerge, planAgentLift } from '../lift-plan';
import { withReturnedFromHost } from '../lift-return-record';

const NOW = 1_700_000_000_000;

const remote = {
	id: 'remote-1',
	name: 'build-box',
	enabled: true,
	federation: true,
} as SshRemoteConfig;

function sshAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: 'agent-1',
		name: 'Docs',
		toolType: 'claude-code',
		cwd: '/Users/me/placeholder',
		state: 'idle',
		sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1', workingDirOverride: '/home/me' },
		customEnvVars: { FOO: 'bar', ANTHROPIC_API_KEY: 'sk-secret' },
		aiTabs: [
			{
				id: 'tab-1',
				name: 'Main',
				agentSessionId: 'sess-1',
				logs: [{ id: 'l1', timestamp: 1, source: 'user', text: 'hi' }],
			},
		],
		executionQueue: [{ id: 'q1', tabId: 'tab-1', type: 'message', text: 'next' }],
		...overrides,
	};
}

function connectionWith(
	importResult: unknown = { ok: true, value: { agentId: 'host-1', queued: 1 } },
	removeResult: unknown = { ok: true, value: undefined },
	updateResult: unknown = { ok: true, value: { applied: [] } }
) {
	const importAgent = vi.fn().mockResolvedValue(importResult);
	const remove = vi.fn().mockResolvedValue(removeResult);
	const update = vi.fn().mockResolvedValue(updateResult);
	const release = vi.fn().mockResolvedValue(undefined);
	const connection = {
		peer: 'build-box',
		client: { agents: { import: importAgent, remove, update } },
		release,
	} as unknown as LiftHostConnection;
	return { connection, importAgent, remove, update, release };
}

function depsWith(
	agent: AgentRecord,
	overrides: Partial<LiftRunDeps> = {},
	conn = connectionWith()
) {
	const deps: LiftRunDeps = {
		readAgents: () => [agent],
		readRemotes: () => [remote],
		providerEnvVars: () => undefined,
		busyReason: () => undefined,
		connect: vi.fn().mockResolvedValue(conn.connection),
		setPointer: vi.fn().mockResolvedValue(undefined),
		now: () => NOW,
		...overrides,
	};
	return { deps, ...conn };
}

async function refusalOf(promise: Promise<unknown>): Promise<LiftRunError> {
	const error = await promise.then(
		() => undefined,
		(caught: unknown) => caught
	);
	expect(error).toBeInstanceOf(LiftRunError);
	return error as LiftRunError;
}

describe('runLift refusals', () => {
	it('refuses an unknown agent without reaching the host', async () => {
		const { deps } = depsWith(sshAgent());
		const error = await refusalOf(runLift('nope', {}, deps));
		expect(error.code).toBe('AGENT_NOT_FOUND');
		expect(deps.connect).not.toHaveBeenCalled();
	});

	it('maps a resolver failure to AGENT_NOT_FOUND', async () => {
		const { deps } = depsWith(sshAgent(), {
			resolveAgentId: () => {
				throw new Error('Agent not found: x');
			},
		});
		const error = await refusalOf(runLift('x', {}, deps));
		expect(error).toMatchObject({ code: 'AGENT_NOT_FOUND', message: 'Agent not found: x' });
	});

	it('reports a record refusal as LIFT_<CODE>', async () => {
		const { deps } = depsWith(sshAgent({ sessionSshRemoteConfig: undefined }));
		const error = await refusalOf(runLift('agent-1', {}, deps));
		expect(error.code).toBe('LIFT_NOT_SSH');
		expect(deps.connect).not.toHaveBeenCalled();
	});

	it('refuses a disabled remote, which the mirror would never show the pointer for', async () => {
		const { deps } = depsWith(sshAgent(), {
			readRemotes: () => [{ ...remote, enabled: false }],
		});
		const error = await refusalOf(runLift('agent-1', {}, deps));
		expect(error.code).toBe('LIFT_REMOTE_DISABLED');
		expect(deps.connect).not.toHaveBeenCalled();
	});

	it('refuses a remote that opted out, with the fix', async () => {
		const { deps } = depsWith(sshAgent(), {
			readRemotes: () => [{ ...remote, federation: false }],
		});
		const error = await refusalOf(runLift('agent-1', {}, deps));
		expect(error.code).toBe('PEER_FEDERATION_OFF');
		expect(error.message).toContain('maestro-cli update-ssh-remote remote-1 --federation on');
	});

	it('refuses a busy agent with the reason the caller gave', async () => {
		const { deps } = depsWith(sshAgent(), { busyReason: () => 'a turn is running' });
		const error = await refusalOf(runLift('agent-1', {}, deps));
		expect(error.code).toBe('LIFT_BUSY');
		expect(error.message).toContain('"Docs" is busy: a turn is running.');
	});

	it('throws the caller refusal last, before the host is reached', async () => {
		const { deps } = depsWith(sshAgent(), {
			localRefusal: () => new LiftRunError('LIFT_LOCAL_HOST', 'a host owns the store'),
		});
		const error = await refusalOf(runLift('agent-1', {}, deps));
		expect(error.code).toBe('LIFT_LOCAL_HOST');
		expect(deps.connect).not.toHaveBeenCalled();
	});
});

describe('runLift', () => {
	it('hands the plan over and stops on a dry run', async () => {
		const { deps, importAgent, release } = depsWith(sshAgent());
		const onPlan = vi.fn();
		const result = await runLift('agent-1', { dryRun: true }, deps, onPlan);
		expect(onPlan).toHaveBeenCalledTimes(1);
		expect(result).toMatchObject({ dryRun: true, plan: { peer: 'build-box', cwd: '/home/me' } });
		expect(importAgent).not.toHaveBeenCalled();
		expect(deps.setPointer).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalled();
		expect(deps.connect).toHaveBeenCalledWith(remote, 'build-box');
	});

	it('imports onto the host, then sets the pointer with the moved queue items', async () => {
		const { deps, importAgent, release } = depsWith(sshAgent());
		const result = await runLift('agent-1', {}, deps);
		expect(importAgent).toHaveBeenCalledTimes(1);
		const pointer = { peer: 'build-box', agentId: 'host-1', at: NOW };
		expect(deps.setPointer).toHaveBeenCalledWith('agent-1', pointer, ['q1']);
		expect(result).toMatchObject({
			dryRun: false,
			liftedTo: pointer,
			target: 'build-box:host-1',
			queued: 1,
		});
		expect(result.notices).toBeUndefined();
		expect(release).toHaveBeenCalled();
	});

	// Parity R57: a held message moves held only to a host that says it keeps one held
	// (`import-held`); to an older host, or one that cannot say, it stays here, held.
	it.each([
		['keeps it held', ['turn-agent-text', 'import-held'], true],
		['is too old to say so', [], false],
		['cannot be asked', undefined, false],
	] as const)(
		'moves a held message only to a host that %s (R57)',
		async (_how, capabilities, moves) => {
			const conn = connectionWith();
			const capabilitiesCall = vi.fn().mockResolvedValue({ ok: true, value: capabilities });
			if (capabilities) {
				(conn.connection.client as { connection?: unknown }).connection = {
					capabilities: capabilitiesCall,
				};
			}
			const agent = sshAgent({
				executionQueue: [
					{ id: 'q1', tabId: 'tab-1', type: 'message', text: 'ready' },
					{ id: 'q2', tabId: 'tab-1', type: 'message', text: 'held', paused: true },
				],
			});
			const { deps, importAgent } = depsWith(agent, {}, conn);
			await runLift('agent-1', {}, deps);
			expect(importAgent.mock.calls[0][0].queue).toEqual(
				moves
					? [
							{ tabId: 'tab-1', text: 'ready' },
							{ tabId: 'tab-1', text: 'held', held: true },
						]
					: [{ tabId: 'tab-1', text: 'ready' }]
			);
			const pointer = { peer: 'build-box', agentId: 'host-1', at: NOW };
			expect(deps.setPointer).toHaveBeenCalledWith(
				'agent-1',
				pointer,
				moves ? ['q1', 'q2'] : ['q1']
			);
		}
	);

	// CodeRabbit on #2171: a message held (or removed) while the move was planned would move in its
	// old state, a held one running on the host. The queue is read again before the import.
	it.each([
		['held', [{ id: 'q1', tabId: 'tab-1', type: 'message', text: 'next', paused: true }]],
		['removed', []],
	])(
		'refuses with nothing changed when a moved message was %s after the plan',
		async (_how, queue) => {
			const agent = sshAgent();
			const { deps, importAgent } = depsWith(agent, {
				readAgents: vi
					.fn()
					.mockReturnValueOnce([agent])
					.mockReturnValue([{ ...agent, executionQueue: queue }]),
			});
			const error = await refusalOf(runLift('agent-1', {}, deps));
			expect(error.code).toBe('LIFT_QUEUE_CHANGED');
			expect(importAgent).not.toHaveBeenCalled();
			expect(deps.setPointer).not.toHaveBeenCalled();
		}
	);

	it('asks nothing about held messages when the queue holds none (R57)', async () => {
		const conn = connectionWith();
		const capabilitiesCall = vi.fn();
		(conn.connection.client as { connection?: unknown }).connection = {
			capabilities: capabilitiesCall,
		};
		const { deps } = depsWith(sshAgent(), {}, conn);
		await runLift('agent-1', {}, deps);
		expect(capabilitiesCall).not.toHaveBeenCalled();
	});

	it('withholds secret env vars unless withEnv is set', async () => {
		const { deps, importAgent } = depsWith(sshAgent());
		await runLift('agent-1', {}, deps);
		expect(importAgent.mock.calls[0][0].agent.env).not.toHaveProperty('ANTHROPIC_API_KEY');
		importAgent.mockClear();
		await runLift('agent-1', { withEnv: true }, deps);
		expect(importAgent.mock.calls[0][0].agent.env).toHaveProperty('ANTHROPIC_API_KEY');
	});

	it('passes the host notices through', async () => {
		const conn = connectionWith({
			ok: true,
			value: { agentId: 'host-1', queued: 0, notices: ['image refs stayed'] },
		});
		const { deps } = depsWith(sshAgent(), {}, conn);
		const result = await runLift('agent-1', {}, deps);
		expect(result.notices).toEqual(['image refs stayed']);
	});

	it('names the peer on a host refusal by default', async () => {
		const conn = connectionWith({ ok: false, error: { code: 'failed', message: 'no such dir' } });
		const { deps } = depsWith(sshAgent(), {}, conn);
		const error = await refusalOf(runLift('agent-1', {}, deps));
		expect(error).toMatchObject({
			code: 'LIFT_HOST_FAILED',
			message: 'Peer "build-box": no such dir',
		});
		expect(deps.setPointer).not.toHaveBeenCalled();
		expect(conn.release).toHaveBeenCalled();
	});

	it('names the update to make when the host predates import_agent', async () => {
		const conn = connectionWith({
			ok: false,
			error: { code: 'unsupported', message: 'too old', method: 'agents.import' },
		});
		const hostCallError = vi.fn(() => new Error('mapped'));
		const { deps } = depsWith(sshAgent(), { hostCallError }, conn);
		await expect(runLift('agent-1', {}, deps)).rejects.toThrow('mapped');
		const [peer, error] = hostCallError.mock.calls[0] as unknown as [
			string,
			{ code: string; message: string },
		];
		expect(peer).toBe('build-box');
		expect(error.code).toBe('unsupported');
		expect(error.message).toContain('Update Maestro.app on build-box');
		expect(error.message).toContain('maestro-cli remote-host install build-box --restart --force');
		expect(deps.setPointer).not.toHaveBeenCalled();
	});

	it('reports a host that predates import_agent with its own code by default', async () => {
		const conn = connectionWith({
			ok: false,
			error: { code: 'unsupported', message: 'too old', method: 'agents.import' },
		});
		const { deps } = depsWith(sshAgent(), {}, conn);
		const error = await refusalOf(runLift('agent-1', {}, deps));
		expect(error.code).toBe(LIFT_HOST_TOO_OLD);
		expect(error.message).toContain('Update Maestro.app on build-box');
	});

	it("uses the caller's host error when given", async () => {
		const conn = connectionWith({ ok: false, error: { code: 'host-lost', message: 'gone' } });
		const custom = new Error('custom');
		const { deps } = depsWith(sshAgent(), { hostCallError: () => custom }, conn);
		await expect(runLift('agent-1', {}, deps)).rejects.toBe(custom);
	});

	it("removes the host's copy when the pointer cannot be set", async () => {
		const { deps, remove } = depsWith(sshAgent(), {
			setPointer: vi.fn().mockRejectedValue(new Error('window refused')),
		});
		const error = await refusalOf(runLift('agent-1', {}, deps));
		expect(error.code).toBe('LIFT_POINTER_FAILED');
		expect(error.message).toContain('window refused');
		expect(error.message).toContain("The host's copy was removed again");
		expect(remove).toHaveBeenCalledWith('host-1');
	});

	it('names the manual fix when the roll back fails too', async () => {
		const conn = connectionWith(undefined, {
			ok: false,
			error: { code: 'failed', message: 'nope.' },
		});
		const { deps } = depsWith(
			sshAgent(),
			{ setPointer: vi.fn().mockRejectedValue(new Error('disk full')) },
			conn
		);
		const error = await refusalOf(runLift('agent-1', {}, deps));
		expect(error.message).toContain('maestro-cli remove-agent build-box:host-1');
	});
});

describe('formatLiftPlan', () => {
	const plan = planAgentLift({
		agent: sshAgent(),
		remote,
		peer: 'build-box',
		providerEnvVars: undefined,
		withEnv: false,
	});

	it('says what moves and what stays, with env keys only', () => {
		const text = formatLiftPlan(plan.summary, true);
		expect(text).toContain('Would lift "Docs" (claude-code) onto peer "build-box"');
		expect(text).toContain('Working directory: /home/me');
		expect(text).toContain('"Main": 1 transcript entries, resumes sess-1');
		expect(text).toContain('Queued messages: 1');
		expect(text).toContain('Env var ANTHROPIC_API_KEY');
		expect(text).not.toContain('sk-secret');
	});

	it('reads "Lifting" outside a dry run', () => {
		expect(formatLiftPlan(plan.summary, false)).toMatch(/^Lifting "Docs"/);
	});
});

describe('helpers', () => {
	it('liftErrorCode upper-cases and underscores', () => {
		expect(liftErrorCode('already-lifted')).toBe('LIFT_ALREADY_LIFTED');
	});

	it('providerEnvVarsOf keeps only string entries', () => {
		expect(providerEnvVarsOf({ A: 'x', B: 2, C: null })).toEqual({ A: 'x' });
		expect(providerEnvVarsOf(undefined)).toBeUndefined();
		expect(providerEnvVarsOf(['x'])).toBeUndefined();
	});
});

describe('runLift follow-up settings', () => {
	it('sends the settings an import cannot carry right after the import', async () => {
		const agent = sshAgent({
			bookmarked: true,
			codexTransport: 'app-server',
			maestroPMode: 'dynamic',
		});
		const { deps, update, importAgent } = depsWith(agent);
		const result = await runLift('agent-1', {}, deps);
		expect(importAgent).toHaveBeenCalled();
		expect(update).toHaveBeenCalledWith('host-1', {
			bookmarked: true,
			maestroPMode: 'dynamic',
			codexTransport: 'app-server',
		});
		expect(result).not.toHaveProperty('notices');
	});

	it('sends nothing more for an agent that sets none of them', async () => {
		const { deps, update } = depsWith(sshAgent());
		await runLift('agent-1', {}, deps);
		expect(update).not.toHaveBeenCalled();
	});

	it('keeps the lift when the follow-up is refused, and says what did not move', async () => {
		const conn = connectionWith(undefined, undefined, {
			ok: false,
			error: { code: 'invalid', message: 'bad transport', method: 'agents.update' },
		});
		const { deps } = depsWith(sshAgent({ bookmarked: true }), {}, conn);
		const result = await runLift('agent-1', {}, deps);
		expect(deps.setPointer).toHaveBeenCalled();
		expect(result).toMatchObject({
			dryRun: false,
			notices: ['Some settings did not reach the host: bad transport'],
		});
	});
});

describe('keepDivergentHostTabs (T5 review)', () => {
	const tab = (id: string, logIds: string[], name = 'Main') => ({
		id,
		name,
		logs: logIds.map((logId) => ({ id: logId, timestamp: 1, source: 'user', text: logId })),
	});

	it('merges a tab whose transcript one side only extended', () => {
		const local = [tab('t1', ['a', 'b', 'c'])];
		expect(keepDivergentHostTabs(local, [tab('t1', ['a', 'b'])]).tabs).toEqual([
			tab('t1', ['a', 'b']),
		]);
		expect(keepDivergentHostTabs(local, [tab('t1', ['a', 'b', 'c', 'd'])]).tabs[0].id).toBe('t1');
	});

	it('brings a tab both sides went on in as a tab of its own', () => {
		const local = [tab('t1', ['a', 'local-1', 'local-2'])];
		const [host] = keepDivergentHostTabs(local, [tab('t1', ['a', 'host-1'])]).tabs;
		expect(host).toMatchObject({ id: 't1-host', name: 'Main (on the host)' });
		expect((host.logs as Array<{ id: string }>).map((entry) => entry.id)).toEqual(['a', 'host-1']);
	});

	it('picks an id no other tab holds', () => {
		const local = [tab('t1', ['a', 'x']), tab('t1-host', [])];
		expect(keepDivergentHostTabs(local, [tab('t1', ['a', 'y'])]).tabs[0].id).toBe('t1-host-2');
	});
});

describe('Move to Host again after an offline Move Back: one tab per conversation (U4)', () => {
	type Entry = { id: string; timestamp: number; source: string; text: string };
	/** A conversation of `turns` user messages, each answered, with entry ids from `prefix`. */
	const conversation = (prefix: string, turns: string[]): Entry[] =>
		turns.flatMap((text, index) => [
			{ id: `${prefix}-u${index}`, timestamp: index * 10, source: 'user', text },
			{ id: `${prefix}-a${index}`, timestamp: index * 10 + 1, source: 'ai', text: `re: ${text}` },
		]);
	const tab = (
		id: string,
		session: string | null,
		logs: Entry[],
		name: string | null = 'Chat'
	) => ({
		id,
		name,
		agentSessionId: session,
		logs,
	});
	/** The record once the host's tabs merge in, as `runLift()` builds it (told each tab's side). */
	const mergedRecord = (local: unknown[], merge: ReturnType<typeof keepDivergentHostTabs>) =>
		withReturnedFromHost(
			{ aiTabs: local },
			{ tabs: merge.tabs, transcriptSides: merge.transcriptSides }
		);
	/** The note a Move Back writes on this machine's copy of a tab, which the host never had. */
	const movedBackNote = (id: string): Entry => ({
		id: `${id}-note`,
		timestamp: 999,
		source: 'system',
		text: 'Moved back from the host.',
	});

	it('the live pass: 21 tabs, 11 of them on the host one entry shorter, stay 21 tabs (not 33)', () => {
		const local = Array.from({ length: 21 }, (_, n) =>
			tab(`t${n}`, `s${n}`, [...conversation(`local${n}`, [`ask ${n}`]), movedBackNote(`t${n}`)])
		);
		// The host's transcripts were stored with their own entry ids, and lack the local note.
		const host = local
			.slice(0, 11)
			.map((t, n) => tab(t.id, `s${n}`, conversation(`host${n}`, [`ask ${n}`])));
		const merge = keepDivergentHostTabs(local, host);
		expect(merge).toMatchObject({ merged: 11, copies: 0, added: 0 });
		const record = mergedRecord(local, merge);
		const tabs = record.aiTabs as Array<{ id: string; name: string; logs: Entry[] }>;
		expect(tabs).toHaveLength(21);
		expect(tabs.some((t) => t.name.endsWith('(on the host)'))).toBe(false);
		// The side that holds the other wins: the local transcript, with its note.
		expect(tabs[0].logs.map((entry) => entry.id)).toEqual(['local0-u0', 'local0-a0', 't0-note']);
	});

	it('a host tab under another id that resumes the same provider session merges into that tab', () => {
		const local = [tab('t1', 's1', conversation('l', ['one']))];
		const host = [tab('h9', 's1', conversation('h', ['one', 'two']))];
		const merge = keepDivergentHostTabs(local, host);
		expect(merge).toMatchObject({ merged: 1, copies: 0, added: 0 });
		expect(merge.tabs.map((t) => t.id)).toEqual(['t1']);
	});

	it('a conversation both sides went on in after the Move Back stays two tabs, the host one named "(on the host)"', () => {
		const local = [tab('t1', 's1', conversation('l', ['one', 'here after']))];
		const host = [tab('t1', 's1', conversation('h', ['one', 'there after']))];
		const merge = keepDivergentHostTabs(local, host);
		expect(merge).toMatchObject({ merged: 0, copies: 1, added: 0 });
		expect(merge.tabs).toEqual([
			expect.objectContaining({ id: 't1-host', name: 'Chat (on the host)' }),
		]);
		const record = mergedRecord(local, merge);
		expect((record.aiTabs as unknown[]).length).toBe(2);
	});

	it("the host copy's own new tab is named from its first message, never by its session id", () => {
		const merge = keepDivergentHostTabs(
			[tab('t1', 's1', conversation('l', ['one']))],
			[tab('h2', 's9', conversation('h', ['**Check** the cache\nthen the tests']), null)]
		);
		expect(merge).toMatchObject({ merged: 0, copies: 0, added: 1 });
		expect(merge.tabs[0].name).toBe('Check the cache');
		// A tab with a name keeps it.
		const named = keepDivergentHostTabs([], [tab('h3', 's8', conversation('h', ['x']), 'Mine')]);
		expect(named.tabs[0].name).toBe('Mine');
	});

	it('a side one turn further and a side with notes the other lacks stay two tabs, neither losing an entry (U10)', () => {
		const local = [
			tab('t1', 's1', [
				...conversation('l', ['one']),
				movedBackNote('n1'),
				movedBackNote('n2'),
				movedBackNote('n3'),
			]),
		];
		const host = [tab('t1', 's1', conversation('h', ['one', 'two']))];
		const merge = keepDivergentHostTabs(local, host);
		expect(merge).toMatchObject({ merged: 0, copies: 1 });
		const tabs = mergedRecord(local, merge).aiTabs as Array<{ logs: Entry[] }>;
		expect(tabs.map((t) => t.logs.map((entry) => entry.id))).toEqual([
			['l-u0', 'l-a0', 'n1-note', 'n2-note', 'n3-note'],
			['h-u0', 'h-a0', 'h-u1', 'h-a1'],
		]);
	});

	it('a side with more entries never wins over turns the other went on with: count is not containment (U10)', () => {
		// Locally "one" was answered, then "two" and "three" were sent after the Move Back (7 entries).
		const local = [
			tab('t1', 's1', [...conversation('l', ['one', 'two', 'three']), movedBackNote('t1')]),
		];
		// The host stored "one" with its tool steps as entries of their own (10 entries).
		const toolSteps: Entry[] = Array.from({ length: 8 }, (_, n) => ({
			id: `h-tool${n}`,
			timestamp: 0.5,
			source: 'tool',
			text: `step ${n}`,
		}));
		const [userOne, answerOne] = conversation('h', ['one']);
		const host = [tab('t1', 's1', [userOne, ...toolSteps, answerOne])];
		expect(local[0].logs).toHaveLength(7);
		expect(host[0].logs).toHaveLength(10);
		const merge = keepDivergentHostTabs(local, host);
		expect(merge).toMatchObject({ merged: 0, copies: 1, added: 0 });
		const tabs = mergedRecord(local, merge).aiTabs as Array<{ logs: Entry[] }>;
		expect(tabs).toHaveLength(2);
		expect(tabs[0].logs.map((entry) => entry.text)).toEqual(
			expect.arrayContaining(['two', 'three'])
		);
		expect(tabs[1].logs.filter((entry) => entry.source === 'tool')).toHaveLength(8);
	});

	it('the merge keeps the side it is told holds the other, never recounting (U10)', () => {
		// The same conversation under other entry ids: each side holds the other. The local side is
		// kept, so what points at its entries (a pin) still finds them.
		const local = [tab('t1', 's1', conversation('l', ['one', 'two']))];
		const host = [tab('t1', 's1', conversation('h', ['one', 'two']))];
		const merge = keepDivergentHostTabs(local, host);
		expect(merge).toMatchObject({ merged: 1, copies: 0, transcriptSides: { t1: 'local' } });
		const [only] = mergedRecord(local, merge).aiTabs as Array<{ logs: Entry[] }>;
		expect(only.logs.map((entry) => entry.id)).toEqual(['l-u0', 'l-a0', 'l-u1', 'l-a1']);
		// The host side, when it holds the local one and went further.
		const further = keepDivergentHostTabs(local, [
			tab('t1', 's1', conversation('h', ['one', 'two', 'three'])),
		]);
		expect(further.transcriptSides).toEqual({ t1: 'host' });
		const [longer] = mergedRecord(local, further).aiTabs as Array<{ logs: Entry[] }>;
		expect(longer.logs).toHaveLength(6);
	});

	it('two different "continue" turns with the same reply are two conversations (U11)', () => {
		const went = (prefix: string, at: number): Entry[] => [
			...conversation(prefix, ['one']),
			{ id: `${prefix}-c`, timestamp: at, source: 'user', text: 'continue' },
			{ id: `${prefix}-r`, timestamp: at + 1, source: 'ai', text: 'Done.' },
		];
		const local = [tab('t1', 's1', went('l', 50))];
		const merge = keepDivergentHostTabs(local, [tab('t1', 's1', went('h', 70))]);
		expect(merge).toMatchObject({ merged: 0, copies: 1 });
		expect((mergedRecord(local, merge).aiTabs as unknown[]).length).toBe(2);
	});

	it('two image-only messages with other images are two conversations (U11)', () => {
		const sent = (prefix: string, image: string) => [
			...conversation(prefix, ['one']),
			{ id: `${prefix}-i`, timestamp: 50, source: 'user', text: '', images: [image] },
			{ id: `${prefix}-r`, timestamp: 51, source: 'ai', text: 'Looks fine.' },
		];
		const local = [tab('t1', 's1', sent('l', 'data:image/png;base64,AAAA') as Entry[])];
		const merge = keepDivergentHostTabs(local, [
			tab('t1', 's1', sent('h', 'data:image/png;base64,BBBB') as Entry[]),
		]);
		expect(merge).toMatchObject({ merged: 0, copies: 1 });
	});

	it('the same message answered differently on each side is two conversations (CodeRabbit on #2166)', () => {
		const answered = (prefix: string, answer: string): Entry[] => [
			...conversation(prefix, ['one']),
			{ id: `${prefix}-c`, timestamp: 50, source: 'user', text: 'continue' },
			{ id: `${prefix}-r`, timestamp: 51, source: 'ai', text: answer },
		];
		const merge = keepDivergentHostTabs(
			[tab('t1', 's1', answered('l', 'Done here.'))],
			[tab('t1', 's1', answered('h', 'Done there.'))]
		);
		expect(merge).toMatchObject({ merged: 0, copies: 1 });
		const record = mergedRecord([tab('t1', 's1', answered('l', 'Done here.'))], merge);
		expect((record.aiTabs as unknown[]).length).toBe(2);
	});

	it('a second host tab of one conversation keeps an id of its own, so neither overwrites the other (CodeRabbit on #2166)', () => {
		const local = [tab('t1', 's1', conversation('l', ['one']))];
		const host = [
			tab('h9', 's1', conversation('h9', ['one', 'two'])),
			tab('t1', 's1', conversation('h1', ['one'])),
		];
		const merge = keepDivergentHostTabs(local, host);
		expect(merge.tabs.map((t) => t.id)).toEqual(['h9-host', 't1']);
		expect(merge).toMatchObject({ merged: 1, copies: 1, added: 0 });
		const record = mergedRecord(local, merge);
		const tabs = record.aiTabs as Array<{ id: string; logs: Entry[] }>;
		expect(tabs.map((t) => t.id)).toEqual(['t1', 'h9-host']);
		expect(tabs[1].logs.map((entry) => entry.text)).toContain('two');
	});

	/** The tabs after the merge: one per id, and as many as the plan's counts say. */
	const expectCountsAddUp = (local: unknown[], merge: ReturnType<typeof keepDivergentHostTabs>) => {
		const tabs = mergedRecord(local, merge).aiTabs as Array<{ id: string; logs: Entry[] }>;
		expect(new Set(tabs.map((t) => t.id)).size).toBe(tabs.length);
		expect(tabs).toHaveLength(local.length + merge.copies + merge.added);
		expect(merge.merged + merge.copies + merge.added).toBe(merge.tabs.length);
		return tabs;
	};

	it('a host tab whose local match is taken gets an id of its own and counts as a copy, in either order (U12)', () => {
		const local = [tab('t1', 's1', conversation('l', ['one']))];
		const sameSession = tab('h9', 's1', conversation('h9', ['one', 'two']));
		const ownTab = tab('t1', 's1', conversation('h1', ['one']));
		for (const host of [
			[sameSession, ownTab],
			[ownTab, sameSession],
		]) {
			const merge = keepDivergentHostTabs(local, host);
			expect(merge).toMatchObject({ merged: 1, copies: 1, added: 0 });
			const tabs = expectCountsAddUp(local, merge);
			expect(tabs.map((t) => t.id)).toEqual(['t1', 'h9-host']);
			expect(tabs[1].logs.map((entry) => entry.text)).toContain('two');
		}
	});

	it('two host tabs under one id never end as two tabs with that id, and neither transcript is lost (U12)', () => {
		const local = [tab('t1', 's1', conversation('l', ['one']))];
		const merge = keepDivergentHostTabs(local, [
			tab('t1', 's1', conversation('a', ['one'])),
			tab('t1', 's1', conversation('b', ['one', 'two'])),
		]);
		expect(merge).toMatchObject({ merged: 1, copies: 1, added: 0 });
		const tabs = expectCountsAddUp(local, merge);
		expect(tabs.map((t) => t.id)).toEqual(['t1', 't1-host']);
		expect(tabs[1].logs.map((entry) => entry.text)).toContain('two');

		// The same for tabs only the host had.
		const only = keepDivergentHostTabs(local, [
			tab('h5', 's5', conversation('a', ['x'])),
			tab('h5', 's6', conversation('b', ['y'])),
		]);
		expect(only).toMatchObject({ merged: 0, copies: 0, added: 2 });
		expect(expectCountsAddUp(local, only).map((t) => t.id)).toEqual(['t1', 'h5', 'h5-host']);
	});

	it("a merged tab stays the local tab: its name, star, draft, pins and queue, with the containing side's transcript and usage (U13)", () => {
		const pin = { id: 'p1', logId: 'l-a0', pinnedAt: 5 };
		const localTab = {
			...tab('t1', 's1', conversation('l', ['one'])),
			name: 'Renamed here',
			starred: true,
			inputValue: 'half a draft',
			stagedImages: ['data:image/png;base64,AAAA'],
			pinnedMessages: [pin],
			usageStats: { inputTokens: 1 },
		};
		const queue = [{ id: 'q1', tabId: 't1', text: 'next' }];
		const record = (merge: ReturnType<typeof keepDivergentHostTabs>) =>
			withReturnedFromHost(
				{ aiTabs: [localTab], executionQueue: queue, activeTabId: 't1' },
				{ tabs: merge.tabs, transcriptSides: merge.transcriptSides }
			);

		// The host went further: its transcript and usage, the local tab's own details.
		const hostFurther = {
			...tab('t1', 's1', conversation('l', ['one', 'two']), 'Old name'),
			starred: false,
			usageStats: { inputTokens: 9 },
		};
		const further = record(keepDivergentHostTabs([localTab], [hostFurther]));
		const [kept] = further.aiTabs as Array<Record<string, unknown>>;
		expect(kept).toMatchObject({
			id: 't1',
			name: 'Renamed here',
			starred: true,
			inputValue: 'half a draft',
			stagedImages: ['data:image/png;base64,AAAA'],
			pinnedMessages: [pin],
			usageStats: { inputTokens: 9 },
			agentSessionId: 's1',
		});
		expect((kept.logs as Entry[]).map((entry) => entry.text)).toEqual([
			'one',
			're: one',
			'two',
			're: two',
		]);
		expect(further.executionQueue).toEqual(queue);

		// The local side holds the host's: its own transcript and usage; a star from the host stays.
		const hostBehind = {
			...tab('t1', 's1', [], 'Old name'),
			starred: true,
			usageStats: { inputTokens: 0 },
		};
		const [behind] = record(keepDivergentHostTabs([localTab], [hostBehind])).aiTabs as Array<
			Record<string, unknown>
		>;
		expect(behind).toMatchObject({
			name: 'Renamed here',
			starred: true,
			usageStats: { inputTokens: 1 },
		});
		expect(behind.logs).toEqual(localTab.logs);
		const unstarred = { ...localTab, starred: false };
		const [starredThere] = withReturnedFromHost(
			{ aiTabs: [unstarred] },
			keepDivergentHostTabs([unstarred], [hostBehind])
		).aiTabs as Array<Record<string, unknown>>;
		expect(starredThere.starred).toBe(true);
	});

	it('a reply copied mid-stream under the same entry id is held by its finished copy, which wins (CodeRabbit on #2166)', () => {
		const [userOne, answerOne] = conversation('x', ['one']);
		const partial = { ...answerOne, text: 're: o' };
		const local = [tab('t1', 's1', [userOne, partial])];
		const host = [tab('t1', 's1', [userOne, answerOne])];
		const merge = keepDivergentHostTabs(local, host);
		expect(merge).toMatchObject({ merged: 1, copies: 0, transcriptSides: { t1: 'host' } });
		const [only] = mergedRecord(local, merge).aiTabs as Array<{ logs: Entry[] }>;
		expect(only.logs.map((entry) => entry.text)).toEqual(['one', 're: one']);
		// An entry whose text was changed otherwise is no copy of the other: two tabs.
		const changed = keepDivergentHostTabs(
			[tab('t1', 's1', [userOne, { ...answerOne, text: 'something else' }])],
			host
		);
		expect(changed).toMatchObject({ merged: 0, copies: 1 });
	});

	it("a pin on a local entry the host stored under another id names the host's id once the host transcript wins (CodeRabbit on #2166)", () => {
		const pin = { id: 'p1', logId: 'l-a0', pinnedAt: 5 };
		const other = { id: 'p2', logId: 'not-in-the-transcript', pinnedAt: 6 };
		const local = [
			{ ...tab('t1', 's1', conversation('l', ['one'])), pinnedMessages: [pin, other] },
		];
		const host = [tab('t1', 's1', conversation('h', ['one', 'two']))];
		const merge = keepDivergentHostTabs(local, host);
		expect(merge.transcriptSides).toEqual({ t1: 'host' });
		const [only] = mergedRecord(local, merge).aiTabs as Array<{
			logs: Entry[];
			pinnedMessages: Array<{ id: string; logId: string }>;
		}>;
		expect(only.logs.map((entry) => entry.id)).toEqual(['h-u0', 'h-a0', 'h-u1', 'h-a1']);
		expect(only.pinnedMessages).toEqual([{ ...pin, logId: 'h-a0' }, other]);
	});

	it('the plan the user confirms says how many tabs merge and how many stay as copies', () => {
		expect(formatHostTabMerge({ merged: 11, copies: 1, added: 1 })).toBe(
			'The host copy\'s tabs: 11 tabs merge into the tab of the same conversation; 1 tab stays as a copy named "(on the host)" (both sides went on after the Move Back); 1 tab comes in that only the host had.'
		);
		expect(formatHostTabMerge(undefined)).toBeUndefined();
	});

	it('the plan leaves out a part with no tab (U14)', () => {
		expect(formatHostTabMerge({ merged: 0, copies: 2, added: 1 })).toBe(
			'The host copy\'s tabs: 2 tabs stay as a copy named "(on the host)" (both sides went on after the Move Back); 1 tab comes in that only the host had.'
		);
		expect(formatHostTabMerge({ merged: 1, copies: 0, added: 0 })).toBe(
			"The host copy's tabs: 1 tab merges into the tab of the same conversation."
		);
		expect(formatHostTabMerge({ merged: 0, copies: 0, added: 0 })).toBeUndefined();
	});
});

describe('Move to Host again: a pasted image, a capped tool card, an entry with no time (U16)', () => {
	type Log = Record<string, unknown>;
	const PASTE = `data:image/png;base64,${Buffer.from('the bytes of one pasted image').toString('base64')}`;
	const dirs: string[] = [];
	afterEach(() => {
		setMaestroLibImageRefResolver(() => null);
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});
	/** One machine's content-addressed image store, in a folder of its own. */
	const imageStore = () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u16-images-'));
		dirs.push(dir);
		return createSessionImageStore(() => dir);
	};

	/** This machine's agent: one tab whose first message carries the pasted image (stored here as a ref). */
	async function agentWithPastedImage() {
		const here = imageStore();
		const ref = await here.storeInlineImage(PASTE);
		expect(ref.startsWith('maestro-image://store/')).toBe(true);
		const agent = sshAgent({
			aiTabs: [
				{
					id: 'tab-1',
					name: 'Main',
					agentSessionId: 'sess-1',
					logs: [
						{ id: 'l1', timestamp: 1, source: 'user', text: 'what is this?', images: [ref] },
						{ id: 'l2', timestamp: 2, source: 'ai', text: 'A screenshot.' },
					],
				},
			],
			executionQueue: [],
		});
		return { here, agent, ref };
	}

	/**
	 * The host copy's tabs as the real lift and import leave them, read back the way each host
	 * kind answers `tabs.transcript`: a headless host stores the image in its own store and sends
	 * it inline (M10); a desktop host writes the record as imported, and its window stores the image
	 * as a ref into the desktop's own store on its next save.
	 */
	async function hostCopyTabs(
		agent: AgentRecord,
		here: ReturnType<typeof imageStore>,
		host: 'headless' | 'desktop as imported' | 'desktop after its save'
	): Promise<AITabRecord[]> {
		setMaestroLibImageRefResolver(here.resolveToBytesSync);
		const plan = planAgentLift({ agent, remote, peer: 'build-box', withEnv: false });
		const imported = planAgentImport(plan.input, {
			agents: [],
			groupIds: [],
			defaults: DEFAULT_TAB_DEFAULTS,
			checkCwd: () => null,
		});
		if (!imported.ok) throw new Error(imported.message);
		if (host === 'desktop as imported') return imported.agent.aiTabs ?? [];
		const there = imageStore();
		const {
			sessions: [stored],
		} = await there.relocateSessionImages([imported.agent]);
		if (host === 'desktop after its save') return stored.aiTabs ?? [];
		setMaestroLibImageRefResolver(there.resolveToBytesSync);
		return (stored.aiTabs ?? []).map((tab) => ({
			...tab,
			logs: (tab.logs ?? []).map((entry) => withInlineEntryImages(entry as Log)),
		}));
	}

	it.each(['headless', 'desktop as imported', 'desktop after its save'] as const)(
		'%s host: a tab with a pasted image merges back into its tab, not an "(on the host)" copy',
		async (host) => {
			const { here, agent, ref } = await agentWithPastedImage();
			const hostTabs = await hostCopyTabs(agent, here, host);
			const hostImage = (hostTabs[0].logs?.[0] as Log).images as string[];
			expect(hostImage).toHaveLength(1);
			// The offline Move Back left this machine's tab as it was, with a note of its own.
			const local = (agent.aiTabs ?? []).map((tab) => ({
				...tab,
				logs: [
					...(tab.logs ?? []),
					{ id: 'note', timestamp: 3, source: 'system', text: 'Moved back from the host.' },
				],
			}));
			const merge = keepDivergentHostTabs(local, hostTabs);
			expect(merge).toMatchObject({ merged: 1, copies: 0, added: 0 });
			expect(merge.transcriptSides).toEqual({ 'tab-1': 'local' });
			const [only] = withReturnedFromHost({ aiTabs: local }, merge).aiTabs as AITabRecord[];
			expect((only.logs?.[0] as Log).images).toEqual([ref]);
		}
	);

	it('another image under the same words is not the same entry: the tab stays two tabs', async () => {
		const { here, agent } = await agentWithPastedImage();
		const hostTabs = await hostCopyTabs(agent, here, 'headless');
		const other = `data:image/png;base64,${Buffer.from('another image').toString('base64')}`;
		const changed = hostTabs.map((tab) => ({
			...tab,
			logs: (tab.logs ?? []).map((entry, index) =>
				index === 0 ? { ...(entry as Log), images: [other] } : entry
			),
		}));
		expect(keepDivergentHostTabs(agent.aiTabs ?? [], changed)).toMatchObject({
			merged: 0,
			copies: 1,
		});
	});

	it("a pin on the image entry follows the host's entry id when the host's transcript wins", () => {
		const bytes = Buffer.from('pin image');
		const sha = crypto.createHash('sha256').update(bytes).digest('hex');
		const ref = `maestro-image://store/${sha}.png`;
		const inline = `data:image/png;base64,${bytes.toString('base64')}`;
		const pin = { id: 'p1', logId: 'l-u0' };
		const local = [
			{
				id: 't1',
				agentSessionId: 's1',
				logs: [
					{ id: 'l-u0', timestamp: 0, source: 'user', text: 'look', images: [ref] },
					{ id: 'l-a0', timestamp: 1, source: 'ai', text: 'seen' },
				],
				pinnedMessages: [pin],
			},
		] as AITabRecord[];
		const host = [
			{
				id: 't1',
				agentSessionId: 's1',
				logs: [
					{ id: 'h-u0', timestamp: 0, source: 'user', text: 'look', images: [inline] },
					{ id: 'h-a0', timestamp: 1, source: 'ai', text: 'seen' },
					{ id: 'h-u1', timestamp: 2, source: 'user', text: 'and now?' },
					{ id: 'h-a1', timestamp: 3, source: 'ai', text: 'still seen' },
				],
			},
		] as AITabRecord[];
		const merge = keepDivergentHostTabs(local, host);
		expect(merge.transcriptSides).toEqual({ t1: 'host' });
		const [only] = withReturnedFromHost(
			{ aiTabs: local },
			{ tabs: merge.tabs, transcriptSides: merge.transcriptSides },
			{ imageKey: sessionImageContentSha256 }
		).aiTabs as unknown as Array<{ pinnedMessages: unknown[] }>;
		expect(only.pinnedMessages).toEqual([{ ...pin, logId: 'h-u0' }]);
	});

	it.each(['host', 'local'] as const)(
		'a tool card whose output was capped on the %s side only still merges',
		(capped) => {
			const output = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS * 3);
			const logs: Log[] = [
				{ id: 'u', timestamp: 0, source: 'user', text: 'run the tests' },
				{
					id: 'tool',
					timestamp: 1,
					source: 'tool',
					text: 'Bash',
					metadata: { toolState: { status: 'completed', input: { command: 'npm test' }, output } },
				},
				{ id: 'a', timestamp: 2, source: 'ai', text: 'All green.' },
			];
			const cut = compactLogToolOutputs(logs);
			expect(cut).not.toEqual(logs);
			const local = [{ id: 't1', agentSessionId: 's1', logs: capped === 'local' ? cut : logs }];
			const host = [{ id: 't1', agentSessionId: 's1', logs: capped === 'host' ? cut : logs }];
			expect(keepDivergentHostTabs(local as AITabRecord[], host as AITabRecord[])).toMatchObject({
				merged: 1,
				copies: 0,
				added: 0,
			});
		}
	);

	it('two "yes" entries with no id and no time are not one entry: the tabs stay two', () => {
		const yes = (text: string) => [
			{ source: 'user', text: 'yes' },
			{ source: 'ai', text },
		];
		// This machine went on after the host's "yes"; with no id and no time nothing says the two
		// "yes" turns are one, so the host's tab is kept as a copy rather than merged away.
		const local = [{ id: 't1', agentSessionId: 's1', logs: [...yes('done'), ...yes('more')] }];
		const host = [{ id: 't1', agentSessionId: 's1', logs: yes('done') }];
		expect(keepDivergentHostTabs(local as AITabRecord[], host as AITabRecord[])).toMatchObject({
			merged: 0,
			copies: 1,
		});
		// With a time each, the same entries are one conversation.
		const timed = (logs: Log[]) => logs.map((entry, index) => ({ ...entry, timestamp: index }));
		expect(
			keepDivergentHostTabs(
				[{ ...local[0], logs: timed(local[0].logs) }] as AITabRecord[],
				[{ ...host[0], logs: timed(host[0].logs) }] as AITabRecord[]
			)
		).toMatchObject({ merged: 1, copies: 0 });
	});
});
