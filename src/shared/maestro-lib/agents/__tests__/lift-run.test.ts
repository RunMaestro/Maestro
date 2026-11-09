/**
 * The shared lift runner (`runLift()`): the order of its refusals, the dry run, the import and
 * pointer, the roll back, and the plan text both `maestro-cli lift` and the desktop show.
 */
import { describe, expect, it, vi } from 'vitest';

import type { SshRemoteConfig } from '../../../types';
import type { AgentRecord } from '../../store/records';
import {
	LiftRunError,
	formatLiftPlan,
	liftErrorCode,
	providerEnvVarsOf,
	runLift,
	type LiftHostConnection,
	type LiftRunDeps,
} from '../lift-run';
import { planAgentLift } from '../lift-plan';

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
	removeResult: unknown = { ok: true, value: undefined }
) {
	const importAgent = vi.fn().mockResolvedValue(importResult);
	const remove = vi.fn().mockResolvedValue(removeResult);
	const release = vi.fn().mockResolvedValue(undefined);
	const connection = {
		peer: 'build-box',
		client: { agents: { import: importAgent, remove } },
		release,
	} as unknown as LiftHostConnection;
	return { connection, importAgent, remove, release };
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

	it('refuses a remote that is not opted in, with the fix', async () => {
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
		expect(error.message).toContain('maestro-cli remove-agent host-1');
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
