/**
 * Desktop chat's process pipeline against a REAL process.
 *
 * `turn-recordings.test.ts` feeds the recordings straight to the handlers.
 * This file starts the fake agent through `ProcessManager.spawn()`, the way a
 * turn is really started, and listens where the renderer listens. What it
 * pins is the contract the renderer depends on: which events arrive, in which
 * order, and that a turn settles exactly once.
 */
import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('node-pty', () => ({
	spawn: vi.fn(),
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../main/coworking/coworking-socket-path', () => ({
	getBridgeSocketPath: () => '/tmp/maestro-test-coworking.sock',
}));

// Real local children exercise SSH lifecycle classification; never dispatch an SSH signal.
vi.mock('../../../main/utils/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/ssh-remote-signal')>()),
	signalRemoteAgent: vi.fn(() => true),
}));

import { ProcessManager } from '../../../main/process-manager';
import {
	createSshTerminationAuthority,
	type SshActivityHost,
	type SshActivityIdentity,
	type SshActivityLaunch,
	type SshActivityObserver,
} from '../../../main/process-manager/ssh-activity';
import { SSH_STDIN_REMOTE_SHELL } from '../../../main/utils/ssh-remote-signal';
import type { ProcessConfig, SpawnResult } from '../../../main/process-manager/types';
import {
	getHeadlessAgentActivity,
	trackHeadlessAgentActivity,
} from '../../../main/utils/headless-agent-activity';
import { isAgentBusy } from '../../../main/utils/agent-busy';
import { CAPTURED_RECORDINGS, CAPTURED_OPENCODE_SESSION_ID } from './recordings/captured';
import {
	FAKE_AGENT_PATH,
	createScratchDir,
	fakeTurnFromRecording,
	writeFakeTurn,
	type FakeTurn,
} from '../../shared/maestro-lib/run/fakeAgent';

const SESSION_ID = 'agent-1-ai-tab-1';
const posixIt = it.skipIf(process.platform === 'win32');

let scratch: { dir: string; cleanup: () => void };
const managers: ProcessManager[] = [];

beforeAll(() => {
	scratch = createScratchDir('maestro-desktop-spawn');
});

afterAll(() => {
	scratch.cleanup();
});

afterEach(() => {
	for (const manager of managers.splice(0)) manager.killAll({ shutdown: true });
});

interface Heard {
	type: string;
	args: unknown[];
}

/** Everything the renderer would be told about the session, in order. */
function listen(manager: ProcessManager, sessionId = SESSION_ID): Heard[] {
	const heard: Heard[] = [];
	for (const type of [
		'raw-stdout',
		'data',
		'session-id',
		'usage',
		'thinking-chunk',
		'tool-execution',
		'agent-error',
		'query-complete',
		'exit',
	]) {
		manager.on(type, (...args: unknown[]) => {
			if (args[0] === sessionId) heard.push({ type, args: args.slice(1) });
		});
	}
	return heard;
}

function spawnFakeAgent(
	manager: ProcessManager,
	turn: FakeTurn,
	options: { hold?: boolean; command?: string; prompt?: string } & Partial<
		Pick<
			ProcessConfig,
			| 'sessionId'
			| 'originWorkerId'
			| 'sshStdinScript'
			| 'sshRemoteCommand'
			| 'sshRemoteId'
			| 'querySource'
			| 'args'
		>
	> = {}
) {
	const env: Record<string, string> = { FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, turn) };
	if (options.hold) env.FAKE_AGENT_HOLD = '1';
	const config: ProcessConfig = {
		sessionId: options.sessionId ?? SESSION_ID,
		originWorkerId: options.originWorkerId,
		toolType: 'opencode',
		cwd: scratch.dir,
		command: options.command ?? process.execPath,
		args: options.args ?? (options.command ? [] : [FAKE_AGENT_PATH]),
		prompt: options.prompt ?? 'What is the capital of France?',
		customEnvVars: env,
		sshStdinScript: options.sshStdinScript,
		sshRemoteCommand: options.sshRemoteCommand,
		sshRemoteId: options.sshRemoteId,
		querySource: options.querySource,
	};
	return manager.spawn(config);
}

function untilExit(heard: Heard[], timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const poll = (): void => {
			if (heard.some((entry) => entry.type === 'exit')) return resolve();
			if (Date.now() > deadline) return reject(new Error('no exit event'));
			setTimeout(poll, 20);
		};
		poll();
	});
}

const types = (heard: Heard[]): string[] => heard.map((entry) => entry.type);

describe('ProcessManager.spawn against a real process', () => {
	it('releases only the refused duplicate activity when the real owner exits', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);
		const other = trackHeadlessAgentActivity('agent-1');
		try {
			spawnFakeAgent(
				manager,
				fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']),
				{ hold: true }
			);
			const child = manager.get(SESSION_ID)!.childProcess!;
			expect(getHeadlessAgentActivity().counts['agent-1']).toBe(2);
			expect(() =>
				spawnFakeAgent(
					manager,
					fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
				)
			).toThrow();
			expect(getHeadlessAgentActivity().counts['agent-1']).toBe(2);
			child.kill();
			await untilExit(heard);
			expect(getHeadlessAgentActivity().counts['agent-1']).toBe(1);
			child.emit('close', 0, null);
			expect(getHeadlessAgentActivity().counts['agent-1']).toBe(1);
		} finally {
			other();
		}
		expect(getHeadlessAgentActivity().counts['agent-1']).toBeUndefined();
	});

	it('releases the new activity and preserves the original synchronous error', () => {
		const manager = new ProcessManager();
		const failure = new Error('synchronous failure');
		const other = trackHeadlessAgentActivity('throw-worker');
		const spy = vi
			.spyOn(
				manager as unknown as { spawnManaged(config: ProcessConfig): SpawnResult },
				'spawnManaged'
			)
			.mockImplementation(() => {
				throw failure;
			});
		try {
			expect(() =>
				manager.spawn({
					sessionId: 'throw-tab',
					originWorkerId: 'throw-worker',
					toolType: 'opencode',
					cwd: scratch.dir,
					command: process.execPath,
					args: [FAKE_AGENT_PATH],
				})
			).toThrow(failure);
			expect(getHeadlessAgentActivity().counts['throw-worker']).toBe(1);
		} finally {
			spy.mockRestore();
			other();
		}
		expect(getHeadlessAgentActivity().counts['throw-worker']).toBeUndefined();
	});

	posixIt.each(['board', 'desktop'] as const)(
		'keeps %s SSH activity after uncertain child termination',
		async (scope) => {
			const manager = new ProcessManager();
			managers.push(manager);
			const sessionId = `ssh-${scope}-signal-ai-tab-1`;
			const workerId = scope === 'board' ? 'ssh-worker' : 'ssh-desktop-signal';
			const heard = listen(manager, sessionId);
			spawnFakeAgent(
				manager,
				fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']),
				{
					sessionId,
					originWorkerId: scope === 'board' ? workerId : undefined,
					sshStdinScript: 'script',
					hold: true,
				}
			);
			const child = manager.get(sessionId)!.childProcess!;
			child.kill();
			await untilExit(heard);
			expect(manager.get(sessionId)).toBeUndefined();
			expect(getHeadlessAgentActivity().counts[workerId]).toBe(1);
			expect(isAgentBusy({ id: workerId }, manager, new Set())).toBe(true);
		}
	);

	it.each([
		{ sshStdinScript: 'script' },
		{ sshRemoteCommand: 'remote command' },
		{ sshRemoteId: 'remote-id' },
	])('releases only the clean desktop SSH turn: %j', async (sshConfig) => {
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);
		const recording = fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']);
		const other = trackHeadlessAgentActivity('agent-1');
		try {
			expect(spawnFakeAgent(manager, recording, sshConfig).success).toBe(true);
			expect(getHeadlessAgentActivity().counts['agent-1']).toBe(2);
			await untilExit(heard);
			expect(heard.find((entry) => entry.type === 'exit')?.args[0]).toBe(0);
			expect(getHeadlessAgentActivity().counts['agent-1']).toBe(1);
			expect(isAgentBusy({ id: 'agent-1' }, manager, new Set())).toBe(true);
		} finally {
			other();
		}
		expect(isAgentBusy({ id: 'agent-1' }, manager, new Set())).toBe(false);
	});

	describe.each(['board', 'desktop'] as const)('%s SSH activity', (scope) => {
		it.each([1, 255])('retains an unverified exit %i, even with a final answer', async (code) => {
			const manager = new ProcessManager();
			managers.push(manager);
			const agentId = `ssh-${scope}-exit-${code}`;
			const sessionId = `${agentId}-ai-tab-1`;
			const workerId = scope === 'board' ? `${agentId}-worker` : agentId;
			const heard = listen(manager, sessionId);
			const recording = fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']);
			expect(
				spawnFakeAgent(
					manager,
					{ ...recording, close: { code, signal: null } },
					{
						sessionId,
						originWorkerId: scope === 'board' ? workerId : undefined,
						sshStdinScript: 'script',
						querySource: 'user',
					}
				).success
			).toBe(true);
			await untilExit(heard);
			expect(heard.find((entry) => entry.type === 'exit')?.args[0]).toBe(code);
			expect(types(heard)).toContain('query-complete');
			expect(
				heard
					.filter((entry) => entry.type === 'data')
					.map((entry) => String(entry.args[0]))
					.join('')
			).toContain('The capital of France is Paris.');
			expect(manager.get(sessionId)).toBeUndefined();
			expect(getHeadlessAgentActivity().counts[workerId]).toBe(1);
			expect(isAgentBusy({ id: workerId }, manager, new Set())).toBe(true);

			// A later successful transport is a different attempt, not proof that
			// the previous remote attempt ended. Its cleanup must leave that entry.
			const nextHeard = listen(manager, sessionId);
			expect(
				spawnFakeAgent(manager, recording, {
					sessionId,
					originWorkerId: scope === 'board' ? workerId : undefined,
					sshStdinScript: 'script',
				}).success
			).toBe(true);
			await untilExit(nextHeard);
			expect(nextHeard.find((entry) => entry.type === 'exit')?.args[0]).toBe(0);
			expect(getHeadlessAgentActivity().counts[workerId]).toBe(1);
			expect(isAgentBusy({ id: workerId }, manager, new Set())).toBe(true);
		});
	});

	it('late clean SSH events cannot clear a successor on the same desktop tab', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);
		const recording = fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']);
		spawnFakeAgent(manager, recording, { sshStdinScript: 'script' });
		const child = manager.get(SESSION_ID)!.childProcess!;
		await untilExit(heard);
		expect(getHeadlessAgentActivity().counts['agent-1']).toBeUndefined();

		const nextHeard = listen(manager);
		spawnFakeAgent(manager, recording, { hold: true });
		const nextChild = manager.get(SESSION_ID)!.childProcess!;
		expect(getHeadlessAgentActivity().counts['agent-1']).toBe(1);
		const revision = getHeadlessAgentActivity().revision;
		child.emit('exit', 0, null);
		child.emit('close', 0, null);
		expect(getHeadlessAgentActivity().revision).toBe(revision);
		expect(getHeadlessAgentActivity().counts['agent-1']).toBe(1);
		expect(manager.get(SESSION_ID)?.childProcess).toBe(nextChild);
		nextChild.kill();
		await untilExit(nextHeard);
		expect(getHeadlessAgentActivity().counts['agent-1']).toBeUndefined();
		expect(isAgentBusy({ id: 'agent-1' }, manager, new Set())).toBe(false);
	});
	describe('private desktop SSH reconciliation core', () => {
		function createHost() {
			const authority = createSshTerminationAuthority();
			const attempts: {
				launch: SshActivityLaunch;
				observer: SshActivityObserver;
				uncertain: ReturnType<typeof vi.fn>;
				dispose: ReturnType<typeof vi.fn>;
			}[] = [];
			const host: SshActivityHost = {
				readTerminationProof: authority.readTerminationProof,
				observeLaunch: (launch, observer) => {
					const attempt = { launch, observer, uncertain: vi.fn(), dispose: vi.fn() };
					attempts.push(attempt);
					return attempt;
				},
			};
			return { host, attempts, authority };
		}

		function identity(launch: SshActivityLaunch): SshActivityIdentity {
			return {
				launch,
				hostKey: 'authenticated-host-key',
				pid: 12345,
				startedAt: 'original-start-identity',
				boundary: { kind: 'supervised', id: 'owned-boundary', generation: 'boundary-1' },
			};
		}

		function start(
			manager: ProcessManager,
			sessionId: string,
			code = 255,
			hold = false,
			originWorkerId?: string
		) {
			const heard = listen(manager, sessionId);
			const recording = fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']);
			expect(
				spawnFakeAgent(
					manager,
					{ ...recording, close: { code, signal: null } },
					{
						sessionId,
						originWorkerId,
						hold,
						sshStdinScript: 'owned fixture, not a remote execution',
						prompt: '',
						sshRemoteId: 'original-remote',
						args: [FAKE_AGENT_PATH, ...SSH_STDIN_REMOTE_SHELL],
					}
				).success
			).toBe(true);
			return { heard, child: manager.get(sessionId)!.childProcess! };
		}

		it('releases only the original token after row removal, preserving a successor and other registration', async () => {
			const fixture = createHost();
			const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
			managers.push(manager);
			const sessionId = 'recovered-ai-tab-1';
			const other = trackHeadlessAgentActivity('recovered');
			try {
				const { heard, child } = start(manager, sessionId);
				const attempt = fixture.attempts[0];
				const original = identity(attempt.launch);
				attempt.observer.started(original);
				expect(Object.isFrozen(attempt.launch)).toBe(true);
				expect(Object.isFrozen(attempt.launch.args)).toBe(true);
				expect(attempt.launch.pidRecordNonce).toBe(attempt.launch.pidFile);
				expect(attempt.launch.pidFile).toMatch(/^\/tmp\/maestro-agent-.+\.pid$/);
				// Mutating a UI/process-table row cannot retarget the retained attempt.
				manager.get(sessionId)!.sshRemoteId = 'edited-remote';
				manager.get(sessionId)!.args!.push('edited-args');
				expect(attempt.launch.remoteId).toBe('original-remote');
				expect(attempt.launch.args).not.toContain('edited-args');
				await untilExit(heard);
				expect(manager.get(sessionId)).toBeUndefined();
				expect(attempt.uncertain).toHaveBeenCalledTimes(1);
				const next = start(manager, sessionId, 0, true);
				const successor = fixture.attempts[1];
				const successorIdentity = identity(successor.launch);
				successor.observer.started(successorIdentity);
				expect(getHeadlessAgentActivity().counts.recovered).toBe(3);
				const proof = fixture.authority.issueVerifiedTermination(original);
				attempt.observer.terminated(proof);
				expect(getHeadlessAgentActivity().counts.recovered).toBe(2);
				successor.observer.terminated(proof);
				expect(getHeadlessAgentActivity().counts.recovered).toBe(2);
				expect(manager.get(sessionId)?.childProcess).toBe(next.child);
				expect(attempt.dispose).toHaveBeenCalledTimes(1);
				const revision = getHeadlessAgentActivity().revision;
				attempt.observer.terminated(proof);
				child.emit('exit', 0, null);
				child.emit('close', 0, null);
				expect(getHeadlessAgentActivity().revision).toBe(revision);
				next.child.kill();
				await untilExit(next.heard);
				// The successor SSH turn is uncertain too, so prove its own boundary separately.
				successor.observer.terminated(
					fixture.authority.issueVerifiedTermination(successorIdentity)
				);
				expect(getHeadlessAgentActivity().counts.recovered).toBe(1);
			} finally {
				other();
			}
			expect(getHeadlessAgentActivity().counts.recovered).toBeUndefined();
		});

		it('rejects forged, malformed, foreign-host and mismatched proof identities without changing occupancy', async () => {
			const fixture = createHost();
			const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
			managers.push(manager);
			const { heard, child } = start(manager, 'proof-refusal-ai-tab-1');
			const attempt = fixture.attempts[0];
			const original = identity(attempt.launch);
			attempt.observer.started(original);
			await untilExit(heard);
			const revision = getHeadlessAgentActivity().revision;
			for (const proof of [
				undefined,
				null,
				true,
				'terminated',
				{},
				{ ...original },
				{ status: 'terminated', identity: original },
				createSshTerminationAuthority().issueVerifiedTermination(original),
			]) {
				attempt.observer.terminated(proof);
			}
			const wrong: SshActivityIdentity[] = [
				{ ...original, hostKey: 'other-host-key' },
				{ ...original, pid: original.pid + 1 },
				{ ...original, startedAt: 'reused-pid-start' },
				{ ...original, boundary: { ...original.boundary, id: 'other-boundary' } },
				{ ...original, boundary: { ...original.boundary, generation: 'boundary-2' } },
				...[
					{ sessionId: 'other-tab' },
					{ generation: original.launch.generation + 1 },
					{ remoteId: 'other-remote' },
					{ command: 'other-ssh' },
					{ args: ['other-host'] },
					{ pidFile: '/tmp/other.pid' },
					{ pidRecordNonce: 'other-nonce' },
				].map((patch) => ({ ...original, launch: { ...original.launch, ...patch } })),
			];
			for (const value of wrong)
				attempt.observer.terminated(fixture.authority.issueVerifiedTermination(value));
			for (const malformed of [
				{ ...original, pid: 0 },
				{ ...original, startedAt: '' },
				{ ...original, boundary: { kind: 'process-group', id: '12345', generation: '1' } },
				{ ...original, boundary: undefined },
				null,
			]) {
				expect(
					fixture.authority.issueVerifiedTermination(malformed as SshActivityIdentity)
				).toBeUndefined();
				attempt.observer.started(malformed as SshActivityIdentity);
			}
			// A later local close with a contradictory clean status is not remote proof.
			child.emit('close', 0, null);
			expect(getHeadlessAgentActivity().revision).toBe(revision);
			expect(getHeadlessAgentActivity().counts['proof-refusal']).toBe(1);
			attempt.observer.terminated(fixture.authority.issueVerifiedTermination(original));
			expect(getHeadlessAgentActivity().counts['proof-refusal']).toBeUndefined();
		});

		it('retains unknown occupancy when the original launch identity is missing or arrives late', async () => {
			const fixture = createHost();
			const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
			managers.push(manager);
			const { heard } = start(manager, 'identity-required-ai-tab-1');
			const attempt = fixture.attempts[0];
			const original = identity(attempt.launch);
			attempt.observer.terminated(fixture.authority.issueVerifiedTermination(original));
			await untilExit(heard);
			expect(getHeadlessAgentActivity().counts['identity-required']).toBe(1);
			attempt.observer.started({ ...original, launch: { ...attempt.launch, generation: -1 } });
			expect(getHeadlessAgentActivity().counts['identity-required']).toBe(1);
			attempt.observer.started(original);
			expect(getHeadlessAgentActivity().counts['identity-required']).toBe(1);
			expect(attempt.dispose).not.toHaveBeenCalled();
		});

		it('captures identity once and waits for uncertain settlement even when proof arrives early', async () => {
			const fixture = createHost();
			const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
			managers.push(manager);
			const { heard, child } = start(manager, 'early-proof-ai-tab-1', 255, true);
			const attempt = fixture.attempts[0];
			const original = identity(attempt.launch);
			const mutable = { ...original, boundary: { ...original.boundary } };
			attempt.observer.started(mutable);
			mutable.pid++;
			mutable.boundary.id = 'changed';
			attempt.observer.started(mutable);
			attempt.observer.terminated(fixture.authority.issueVerifiedTermination(original));
			expect(getHeadlessAgentActivity().counts['early-proof']).toBe(1);
			child.kill();
			await untilExit(heard);
			expect(getHeadlessAgentActivity().counts['early-proof']).toBeUndefined();
			expect(attempt.dispose).toHaveBeenCalledTimes(1);
			expect(attempt.uncertain).not.toHaveBeenCalled();
		});

		it('never offers Board-origin uncertain occupancy to the desktop proof host', async () => {
			const fixture = createHost();
			const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
			managers.push(manager);
			const { heard, child } = start(
				manager,
				'board-proof-ai-tab-1',
				255,
				false,
				'board-proof-worker'
			);
			await untilExit(heard);
			expect(fixture.attempts).toHaveLength(0);
			expect(getHeadlessAgentActivity().counts['board-proof-worker']).toBe(1);
			child.emit('close', 0, null);
			expect(getHeadlessAgentActivity().counts['board-proof-worker']).toBe(1);
		});

		it('disposes clean turns and stale proof callbacks cannot clear a later desktop turn', async () => {
			const fixture = createHost();
			const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
			managers.push(manager);
			const sessionId = 'clean-proof-ai-tab-1';
			const { heard } = start(manager, sessionId, 0);
			const attempt = fixture.attempts[0];
			const original = identity(attempt.launch);
			attempt.observer.started(original);
			await untilExit(heard);
			expect(attempt.dispose).toHaveBeenCalledTimes(1);
			expect(attempt.uncertain).not.toHaveBeenCalled();
			const nextHeard = listen(manager, sessionId);
			spawnFakeAgent(
				manager,
				fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']),
				{ sessionId, hold: true }
			);
			const nextChild = manager.get(sessionId)!.childProcess!;
			attempt.observer.terminated(fixture.authority.issueVerifiedTermination(original));
			expect(getHeadlessAgentActivity().counts['clean-proof']).toBe(1);
			nextChild.kill();
			await untilExit(nextHeard);
			expect(getHeadlessAgentActivity().counts['clean-proof']).toBeUndefined();
		});

		it('retains unknown occupancy if the host cannot observe the launch', async () => {
			const fixture = createHost();
			fixture.host.observeLaunch = () => {
				throw new Error('unsupported host boundary');
			};
			const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
			managers.push(manager);
			const { heard } = start(manager, 'unsupported-proof-ai-tab-1');
			await untilExit(heard);
			expect(getHeadlessAgentActivity().counts['unsupported-proof']).toBe(1);
		});

		it.each([0, 255])(
			'keeps native settlement safe if host lifecycle notification throws (exit %i)',
			async (code) => {
				const fixture = createHost();
				const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
				managers.push(manager);
				const workerId = `host-callback-${code}`;
				const { heard } = start(manager, `${workerId}-ai-tab-1`, code);
				const attempt = fixture.attempts[0];
				attempt.uncertain.mockImplementation(() => {
					throw new Error('probe unavailable');
				});
				attempt.dispose.mockImplementation(() => {
					throw new Error('adapter teardown failed');
				});
				await untilExit(heard);
				expect(getHeadlessAgentActivity().counts[workerId]).toBe(code === 0 ? undefined : 1);
			}
		);

		it('leaves unsupported SSH launches without a PID record unknown', async () => {
			const fixture = createHost();
			const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
			managers.push(manager);
			const sessionId = 'missing-record-ai-tab-1';
			const heard = listen(manager, sessionId);
			const recording = fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']);
			spawnFakeAgent(
				manager,
				{ ...recording, close: { code: 255, signal: null } },
				{
					sessionId,
					sshRemoteId: 'legacy-remote',
				}
			);
			await untilExit(heard);
			expect(fixture.attempts).toHaveLength(0);
			expect(getHeadlessAgentActivity().counts['missing-record']).toBe(1);
		});

		it('does not register a recovery observer for an SSH child that never started', async () => {
			const fixture = createHost();
			const manager = new ProcessManager(undefined, { sshActivityHost: fixture.host });
			managers.push(manager);
			const sessionId = 'nonstart-proof-ai-tab-1';
			const heard = listen(manager, sessionId);
			expect(
				spawnFakeAgent(
					manager,
					{ chunks: [], close: { code: 0, signal: null } },
					{
						sessionId,
						command: path.join(scratch.dir, 'absent-ssh'),
						args: ['fixture-host', ...SSH_STDIN_REMOTE_SHELL],
						sshStdinScript: 'script',
					}
				).success
			).toBe(false);
			await untilExit(heard);
			expect(fixture.attempts).toHaveLength(0);
			expect(getHeadlessAgentActivity().counts['nonstart-proof']).toBeUndefined();
		});
	});
	it('streams a real OpenCode turn to the renderer and settles it as completed', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);

		const result = spawnFakeAgent(
			manager,
			fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
		);
		expect(result.success).toBe(true);
		expect(result.pid).toBeGreaterThan(0);
		expect(manager.get(SESSION_ID)?.childProcess?.pid).toBe(result.pid);

		await untilExit(heard);

		const order = types(heard);
		// The renderer hears the raw stream before anything is made of it.
		expect(order[0]).toBe('raw-stdout');
		expect(order.indexOf('session-id')).toBeLessThan(order.indexOf('exit'));
		expect(order.indexOf('data')).toBeLessThan(order.indexOf('exit'));
		expect(order.filter((type) => type === 'exit')).toHaveLength(1);

		expect(heard.find((entry) => entry.type === 'session-id')?.args[0]).toBe(
			CAPTURED_OPENCODE_SESSION_ID
		);
		const dataText = heard
			.filter((entry) => entry.type === 'data')
			.map((entry) => String(entry.args[0]))
			.join('');
		expect(dataText).toContain('The capital of France is Paris.');

		const exit = heard.find((entry) => entry.type === 'exit')!;
		expect(exit.args[0]).toBe(0);
		expect(exit.args[2]).toMatchObject({ outcome: 'completed' });
		expect(manager.get(SESSION_ID)).toBeUndefined();
	});

	it('reports a provider that could not be started exactly once', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);

		const result = spawnFakeAgent(
			manager,
			{ chunks: [], close: { code: 0, signal: null } },
			{ command: path.join(scratch.dir, 'no-such-provider') }
		);
		expect(result.success).toBe(false);

		await untilExit(heard);
		// Node follows ENOENT's `error` with a `close`; the turn still settles once.
		await new Promise((resolve) => setTimeout(resolve, 200));

		expect(types(heard).filter((type) => type === 'exit')).toHaveLength(1);
		expect(types(heard).filter((type) => type === 'agent-error')).toHaveLength(1);
		const error = heard.find((entry) => entry.type === 'agent-error')!;
		expect(error.args[0]).toMatchObject({ type: 'agent_crashed' });
		expect(manager.get(SESSION_ID)).toBeUndefined();
	});

	it('leaves stdin open for an interactive process and closes it for a batch turn', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const stdinOut = path.join(scratch.dir, 'desktop-stdin.txt');
		const recording = fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']);

		// Batch: a prompt, so stdin is closed at once and the agent can finish.
		const heard = listen(manager);
		manager.spawn({
			sessionId: SESSION_ID,
			toolType: 'opencode',
			cwd: scratch.dir,
			command: process.execPath,
			args: [FAKE_AGENT_PATH],
			prompt: 'batch',
			customEnvVars: {
				FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, recording),
				FAKE_AGENT_STDIN_OUT: stdinOut,
			},
		});
		await untilExit(heard);
		expect(fs.readFileSync(stdinOut, 'utf8')).toBe('');

		// Interactive: no prompt, so stdin stays open for ProcessManager.write().
		const interactive = new ProcessManager();
		managers.push(interactive);
		interactive.spawn({
			sessionId: SESSION_ID,
			toolType: 'opencode',
			cwd: scratch.dir,
			command: process.execPath,
			args: [FAKE_AGENT_PATH],
			customEnvVars: { FAKE_AGENT_RECORDING: writeFakeTurn(scratch.dir, recording) },
		});
		const child = interactive.get(SESSION_ID)!.childProcess!;
		expect(child.stdin?.writableEnded).toBe(false);
		expect(interactive.write(SESSION_ID, 'hello\n')).toBe(true);
	});

	it('writes an SSH script to stdin and closes it, though the turn has no local prompt', async () => {
		// A remote turn carries its prompt inside the script, so `prompt` is
		// empty here. The remote shell and the agent both wait for the end of
		// input: the fake agent reads stdin to its end before it replays, so it
		// only finishes if stdin was closed behind the script.
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);
		const stdinOut = path.join(scratch.dir, 'desktop-ssh-stdin.txt');
		const script = '#!/bin/bash\ncd /project || exit 1\nexec opencode run --format json\n';

		manager.spawn({
			sessionId: SESSION_ID,
			toolType: 'opencode',
			cwd: scratch.dir,
			command: process.execPath,
			args: [FAKE_AGENT_PATH],
			sshStdinScript: script,
			customEnvVars: {
				FAKE_AGENT_RECORDING: writeFakeTurn(
					scratch.dir,
					fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal'])
				),
				FAKE_AGENT_STDIN_OUT: stdinOut,
			},
		});
		await untilExit(heard);

		expect(fs.readFileSync(stdinOut, 'utf8')).toBe(script);
		expect(heard.find((entry) => entry.type === 'exit')?.args[0]).toBe(0);
	});

	posixIt('Stop interrupts a running turn and settles it as interrupted', async () => {
		const manager = new ProcessManager();
		managers.push(manager);
		const heard = listen(manager);

		spawnFakeAgent(
			manager,
			fakeTurnFromRecording(CAPTURED_RECORDINGS['captured-opencode-normal']),
			{ hold: true }
		);
		await new Promise<void>((resolve) => {
			const poll = (): void => {
				if (heard.some((entry) => entry.type === 'data')) resolve();
				else setTimeout(poll, 20);
			};
			poll();
		});

		expect(manager.interrupt(SESSION_ID)).toBe(true);
		await untilExit(heard);

		const exit = heard.find((entry) => entry.type === 'exit')!;
		expect(exit.args[2]).toMatchObject({ outcome: 'interrupted' });
		expect(types(heard)).not.toContain('agent-error');
	});
});
