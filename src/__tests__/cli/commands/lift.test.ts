/**
 * Tests for `maestro-cli lift <agent>`: every refusal before anything moves, the plan in both
 * output forms, `--dry-run`, the host import, the local pointer through the desktop or the store
 * file, and the roll back that keeps the agent with one owner.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	getSyncDir: vi.fn(() => '/tmp/maestro'),
	readAgentConfig: vi.fn(() => ({})),
	readSessions: vi.fn(() => []),
	readSshRemotes: vi.fn(() => []),
	resolveAgentId: vi.fn((id: string) => id),
	resolveSshRemoteId: vi.fn((id: string) => id),
}));

import { lift, withLiftPointer, type LiftDeps } from '../../../cli/commands/lift';
import { ExitCode } from '../../../cli/exit-codes';
import { PeerResolveError, type PeerConnection } from '../../../cli/services/peer-resolver';
import { MaestroNotRunningError } from '../../../cli/services/maestro-not-running';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import type { SshRemoteConfig } from '../../../shared/types';

const NOW = 1_700_000_000_000;

const remote: SshRemoteConfig = {
	id: 'remote-1',
	name: 'build-box',
	host: 'build.example.com',
	port: 22,
	username: 'me',
	privateKeyPath: '',
	enabled: true,
	federation: true,
};

function sshAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
	return {
		id: 'agent-1',
		name: 'Docs',
		toolType: 'claude-code',
		cwd: '/Users/me/placeholder',
		state: 'idle',
		sessionSshRemoteConfig: {
			enabled: true,
			remoteId: 'remote-1',
			workingDirOverride: '/home/me/docs',
		},
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

function fakeConnection(
	importResult: unknown = { ok: true, value: { agentId: 'host-1', queued: 1 } }
) {
	const importAgent = vi.fn().mockResolvedValue(importResult);
	const remove = vi.fn().mockResolvedValue({ ok: true, value: undefined });
	const release = vi.fn().mockResolvedValue(undefined);
	const connection = {
		peer: 'build-box',
		remote,
		client: { agents: { import: importAgent, remove } },
		release,
	} as unknown as PeerConnection;
	return { connection, importAgent, remove, release };
}

function depsWith(
	agent: AgentRecord,
	overrides: Partial<LiftDeps> = {},
	connection = fakeConnection()
) {
	const deps: LiftDeps = {
		readAgents: () => [agent],
		readRemotes: () => [remote],
		resolveAgentId: (ref) => {
			if (ref !== agent.id && ref !== agent.name) throw new Error(`Agent not found: ${ref}`);
			return agent.id;
		},
		providerEnvVars: () => undefined,
		cliBusy: () => ({ busy: false }),
		localStoreOwner: () => 'desktop',
		connect: vi.fn().mockResolvedValue(connection.connection),
		setPointerInDesktop: vi.fn().mockResolvedValue({ success: true }),
		setPointerOnDisk: vi.fn().mockResolvedValue(undefined),
		now: () => NOW,
		...overrides,
	};
	return { deps, ...connection };
}

let logs: string[];
let errors: string[];

beforeEach(() => {
	logs = [];
	errors = [];
	vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
		logs.push(String(line));
	});
	vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
		errors.push(String(line));
	});
	process.exitCode = undefined;
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
});

function lastJson(): Record<string, unknown> {
	return JSON.parse(logs[logs.length - 1]) as Record<string, unknown>;
}

describe('lift refusals', () => {
	it.each([
		[
			'an agent that was already lifted',
			{ liftedTo: { peer: 'build-box', agentId: 'h', at: 1 } },
			'LIFT_ALREADY_LIFTED',
		],
		['a local agent', { sessionSshRemoteConfig: undefined }, 'LIFT_NOT_SSH'],
		['a busy tab', { aiTabs: [{ id: 'tab-1', state: 'busy' as const }] }, 'LIFT_BUSY'],
		['a busy agent', { state: 'busy' as const }, 'LIFT_BUSY'],
		[
			'an agent whose SSH remote is no longer configured',
			{
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'gone',
					workingDirOverride: '/home/me/docs',
				},
			},
			'LIFT_REMOTE_MISSING',
		],
		['an agent with no AI tab to move', { aiTabs: [] }, 'LIFT_NO_TABS'],
	])('refuses %s before reaching the host', async (_label, overrides, code) => {
		const { deps } = depsWith(sshAgent(overrides as Partial<AgentRecord>));
		await lift('agent-1', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code });
		expect(process.exitCode).toBe(ExitCode.GeneralError);
		expect(deps.connect).not.toHaveBeenCalled();
	});

	it('refuses an agent whose remote is not opted in to Federation', async () => {
		const { deps } = depsWith(sshAgent(), {
			readRemotes: () => [{ ...remote, federation: false }],
		});
		await lift('agent-1', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code: 'PEER_FEDERATION_OFF' });
		expect(String(lastJson().error)).toContain('--federation on');
		expect(deps.connect).not.toHaveBeenCalled();
	});

	it('refuses a run another CLI instance holds', async () => {
		const { deps } = depsWith(sshAgent(), {
			cliBusy: () => ({ busy: true, reason: 'Running "Nightly" from CLI (PID: 9)' }),
		});
		await lift('agent-1', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code: 'LIFT_BUSY' });
		expect(deps.connect).not.toHaveBeenCalled();
	});

	it('refuses while a local headless host owns the agent store', async () => {
		const { deps } = depsWith(sshAgent(), { localStoreOwner: () => 'headless-host' });
		await lift('agent-1', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code: 'LIFT_LOCAL_HOST' });
		expect(deps.connect).not.toHaveBeenCalled();
	});

	it('refuses an unknown agent', async () => {
		const { deps } = depsWith(sshAgent());
		await lift('nope', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code: 'AGENT_NOT_FOUND' });
	});

	it('refuses when no host is running on the remote, with the fix and exit 3', async () => {
		const { deps } = depsWith(sshAgent(), {
			connect: vi
				.fn()
				.mockRejectedValue(
					new PeerResolveError(
						'host-down',
						'No Maestro host is running on peer "build-box". Start it with: maestro-cli remote-host start build-box',
						ExitCode.NotRunning,
						'build-box'
					)
				),
		});
		await lift('agent-1', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code: 'PEER_HOST_DOWN' });
		expect(String(lastJson().error)).toContain('remote-host start build-box');
		expect(process.exitCode).toBe(ExitCode.NotRunning);
	});
});

describe('lift plan and --dry-run', () => {
	it('prints what moves and what stays, then stops', async () => {
		const { deps, importAgent, release } = depsWith(sshAgent());
		await lift('Docs', { dryRun: true }, deps);
		const out = logs.join('\n');
		expect(out).toContain('Would lift "Docs" (claude-code) onto peer "build-box"');
		expect(out).toContain('Working directory: /home/me/docs');
		expect(out).toContain('"Main": 1 transcript entries, resumes sess-1');
		expect(out).toContain('Env vars (1): FOO');
		expect(out).toContain('Env var ANTHROPIC_API_KEY: Secret. Pass --with-env to send it.');
		expect(out).toContain('Queued messages: 1');
		expect(out).toContain('Dry run: nothing moved.');
		expect(out).not.toContain('sk-secret');
		expect(importAgent).not.toHaveBeenCalled();
		expect(release).toHaveBeenCalled();
	});

	it('gives the same plan as JSON, without env values or transcript text', async () => {
		const { deps, importAgent } = depsWith(sshAgent());
		await lift('agent-1', { dryRun: true, json: true }, deps);
		const json = lastJson();
		expect(json).toMatchObject({ success: true, dryRun: true });
		expect(json.plan).toMatchObject({
			peer: 'build-box',
			cwd: '/home/me/docs',
			env: { sent: ['FOO'], withheld: ['ANTHROPIC_API_KEY'] },
			tabs: [{ id: 'tab-1', agentSessionId: 'sess-1', entries: 1 }],
			queued: ['q1'],
		});
		expect(logs.join('\n')).not.toContain('sk-secret');
		expect(importAgent).not.toHaveBeenCalled();
	});
});

describe('lift', () => {
	it('imports onto the host, then sets the pointer through the desktop', async () => {
		const { deps, importAgent, release } = depsWith(sshAgent());
		await lift('agent-1', { json: true }, deps);
		expect(importAgent).toHaveBeenCalledWith(
			expect.objectContaining({
				agent: expect.objectContaining({ cwd: '/home/me/docs', env: { FOO: 'bar' } }),
				tabs: [expect.objectContaining({ id: 'tab-1', agentSessionId: 'sess-1' })],
				queue: [{ tabId: 'tab-1', text: 'next' }],
			})
		);
		const pointer = { peer: 'build-box', agentId: 'host-1', at: NOW };
		expect(deps.setPointerInDesktop).toHaveBeenCalledWith('agent-1', pointer, ['q1']);
		expect(deps.setPointerOnDisk).not.toHaveBeenCalled();
		expect(lastJson()).toMatchObject({
			success: true,
			dryRun: false,
			liftedTo: pointer,
			target: 'build-box:host-1',
			queued: 1,
		});
		expect(release).toHaveBeenCalled();
	});

	it('sends secrets with --with-env', async () => {
		const { deps, importAgent } = depsWith(sshAgent());
		await lift('agent-1', { json: true, withEnv: true }, deps);
		expect(importAgent.mock.calls[0][0].agent.env).toEqual({
			FOO: 'bar',
			ANTHROPIC_API_KEY: 'sk-secret',
		});
	});

	it('writes the store file when no desktop runs', async () => {
		const { deps } = depsWith(sshAgent(), { localStoreOwner: () => 'none' });
		await lift('agent-1', { json: true }, deps);
		expect(deps.setPointerInDesktop).not.toHaveBeenCalled();
		expect(deps.setPointerOnDisk).toHaveBeenCalledWith(
			'agent-1',
			{ peer: 'build-box', agentId: 'host-1', at: NOW },
			['q1']
		);
	});

	it('falls back to the store file when the desktop quit since the check', async () => {
		const { deps } = depsWith(sshAgent(), {
			setPointerInDesktop: vi
				.fn()
				.mockRejectedValue(new MaestroNotRunningError('no-discovery-file')),
		});
		await lift('agent-1', { json: true }, deps);
		expect(deps.setPointerOnDisk).toHaveBeenCalled();
		expect(lastJson()).toMatchObject({ success: true });
	});

	it('removes the host copy again when the desktop refuses the pointer', async () => {
		const { deps, remove } = depsWith(sshAgent(), {
			setPointerInDesktop: vi.fn().mockResolvedValue({ success: false, error: 'busy now' }),
		});
		await lift('agent-1', { json: true }, deps);
		expect(remove).toHaveBeenCalledWith('host-1');
		expect(lastJson()).toMatchObject({ success: false, code: 'LIFT_POINTER_FAILED' });
		expect(String(lastJson().error)).toContain('busy now');
		expect(String(lastJson().error)).toContain("host's copy was removed again");
	});

	it('names the manual fix when the roll back fails too', async () => {
		const connection = fakeConnection();
		connection.remove.mockResolvedValue({
			ok: false,
			error: { code: 'host-lost', message: 'gone.' },
		});
		const { deps } = depsWith(
			sshAgent(),
			{
				setPointerOnDisk: vi.fn().mockRejectedValue(new Error('disk full')),
				localStoreOwner: () => 'none',
			},
			connection
		);
		await lift('agent-1', { json: true }, deps);
		expect(String(lastJson().error)).toContain('maestro-cli remove-agent host-1');
	});

	it('reports a host refusal and sets no pointer', async () => {
		const connection = fakeConnection({
			ok: false,
			error: { code: 'invalid', message: 'The working directory does not exist.' },
		});
		const { deps } = depsWith(sshAgent(), {}, connection);
		await lift('agent-1', { json: true }, deps);
		expect(lastJson()).toMatchObject({ success: false, code: 'PEER_HOST_FAILED' });
		expect(String(lastJson().error)).toContain('does not exist');
		expect(deps.setPointerInDesktop).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalled();
	});

	it('prints the new target in human output', async () => {
		const { deps } = depsWith(sshAgent());
		await lift('agent-1', {}, deps);
		expect(logs.join('\n')).toContain('send to build-box:host-1');
	});
});

describe('withLiftPointer', () => {
	it('sets the pointer and takes only the moved items off the queue', () => {
		const pointer = { peer: 'build-box', agentId: 'host-1', at: NOW };
		const record = {
			id: 'agent-1',
			aiTabs: [{ id: 'tab-1' }],
			executionQueue: [{ id: 'q1' }, { id: 'q2' }],
		};
		expect(withLiftPointer(record, pointer, ['q1'])).toEqual({
			id: 'agent-1',
			aiTabs: [{ id: 'tab-1' }],
			executionQueue: [{ id: 'q2' }],
			liftedTo: pointer,
		});
	});
});
