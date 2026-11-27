/**
 * The shared lift runner (`runLift()`): the order of its refusals, the dry run, the import and
 * pointer, the roll back, and the plan text both `maestro-cli lift` and the desktop show.
 */
import { describe, expect, it, vi } from 'vitest';

import type { SshRemoteConfig } from '../../../types';
import type { AgentRecord } from '../../store/records';
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
		const record = withReturnedFromHost({ aiTabs: local }, { tabs: merge.tabs });
		const tabs = record.aiTabs as Array<{ id: string; name: string; logs: Entry[] }>;
		expect(tabs).toHaveLength(21);
		expect(tabs.some((t) => t.name.endsWith('(on the host)'))).toBe(false);
		// The longer side wins: the local transcript, with its note.
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
		const record = withReturnedFromHost({ aiTabs: local }, { tabs: merge.tabs });
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

	it('the side one turn further wins, though the other holds more notes (CodeRabbit on #2166)', () => {
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
		expect(merge).toMatchObject({ merged: 1, copies: 0 });
		const record = withReturnedFromHost({ aiTabs: local }, { tabs: merge.tabs });
		const [only] = record.aiTabs as Array<{ logs: Entry[] }>;
		expect(only.logs.map((entry) => entry.text)).toEqual(['one', 're: one', 'two', 're: two']);
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
		const record = withReturnedFromHost(
			{ aiTabs: [tab('t1', 's1', answered('l', 'Done here.'))] },
			{ tabs: merge.tabs }
		);
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
		const record = withReturnedFromHost({ aiTabs: local }, { tabs: merge.tabs });
		const tabs = record.aiTabs as Array<{ id: string; logs: Entry[] }>;
		expect(tabs.map((t) => t.id)).toEqual(['t1', 'h9-host']);
		expect(tabs[1].logs.map((entry) => entry.text)).toContain('two');
	});

	it('the plan the user confirms says how many tabs merge and how many stay as copies', () => {
		expect(formatHostTabMerge({ merged: 11, copies: 1, added: 1 })).toBe(
			'The host copy\'s tabs: 11 tabs merge into the tab of the same conversation; 1 tab stays as a copy named "(on the host)" (both sides went on after the Move Back); 1 tab comes in that only the host had.'
		);
		expect(formatHostTabMerge(undefined)).toBeUndefined();
	});
});
