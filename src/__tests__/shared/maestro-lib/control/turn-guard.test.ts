/**
 * `guardTurn` and `recordRemoteAgent`: what a headless turn does around its process so it always
 * settles and Stop reaches an SSH agent on its host. The process is a stand-in; the remote signal
 * is observed, never sent.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remoteSignals = vi.hoisted(() => [] as string[]);
const remoteTargets = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../../shared/maestro-lib/control/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../shared/maestro-lib/control/ssh-remote-signal')
	>()),
	signalRemoteAgent: (target: unknown, mode: string) => {
		remoteTargets.push(target);
		remoteSignals.push(mode);
		return true;
	},
}));

import { SSH_STDIN_REMOTE_SHELL } from '../../../../shared/maestro-lib/control/ssh-remote-signal';
import { STDIO_CLOSE_GRACE_MS } from '../../../../shared/maestro-lib/control/stdio-close-watchdog';
import { guardTurn, recordRemoteAgent } from '../../../../shared/maestro-lib/control/turn-guard';
import type { TurnHandle } from '../../../../shared/maestro-lib/run/start-turn';

function stream() {
	return Object.assign(new EventEmitter(), {
		destroyed: false,
		destroy: vi.fn(function (this: { destroyed: boolean }) {
			this.destroyed = true;
		}),
	});
}

/** A turn handle over a child that exits and closes only when told to. */
function fakeTurn() {
	const child = Object.assign(new EventEmitter(), {
		pid: 4242,
		exitCode: null as number | null,
		signalCode: null as NodeJS.Signals | null,
		stdin: stream(),
		stdout: stream(),
		stderr: stream(),
	});
	type Exit = Awaited<TurnHandle['done']>;
	let settle: (exit?: Partial<Exit>) => void = () => undefined;
	const done = new Promise<Exit>((resolve) => {
		settle = (exit = {}) => resolve({ exitCode: 0, signal: null, ...exit } as Exit);
	});
	const handle = {
		child: child as unknown as TurnHandle['child'],
		done: done as unknown as TurnHandle['done'],
		interrupt: vi.fn(),
		terminate: vi.fn(),
		terminateNow: vi.fn(),
	};
	return { child, handle, settle };
}

const remote = {
	sshCommand: 'ssh',
	sshArgs: ['dev@host', ...SSH_STDIN_REMOTE_SHELL],
	pidFile: '/tmp/maestro-agent-1.pid',
	sessionId: 's1',
};

describe('guardTurn', () => {
	beforeEach(() => {
		remoteSignals.length = 0;
		remoteTargets.length = 0;
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('forces the close a grace period after an exit that left the pipes open', () => {
		const { child, handle } = fakeTurn();
		guardTurn(handle, { sessionId: 's1', graceMs: 100, remote });

		child.emit('exit', 0, null);
		vi.advanceTimersByTime(STDIO_CLOSE_GRACE_MS);

		expect(child.stdout.destroy).toHaveBeenCalled();
		expect(child.stderr.destroy).toHaveBeenCalled();
		// The open pipes are a remote agent still running behind a ControlMaster.
		expect(remoteSignals).toEqual(['terminate']);
	});

	it('interrupts the remote agent with the turn, and terminates it after the grace if the turn runs on', () => {
		const { handle } = fakeTurn();
		const stops = guardTurn(handle, { sessionId: 's1', graceMs: 100, remote });

		stops.interrupt();
		expect(handle.interrupt).toHaveBeenCalledOnce();
		expect(remoteSignals).toEqual(['interrupt']);

		vi.advanceTimersByTime(100);
		expect(remoteSignals).toEqual(['interrupt', 'terminate']);
	});

	it('sends no follow-up terminate to a turn that exited within the grace', () => {
		const { child, handle } = fakeTurn();
		const stops = guardTurn(handle, { sessionId: 's1', graceMs: 100, remote });

		stops.interrupt();
		child.exitCode = 130;
		child.emit('exit', 130, null);
		vi.advanceTimersByTime(100);

		expect(remoteSignals).toEqual(['interrupt']);
	});

	it('terminates the remote agent when the turn’s signal aborts', () => {
		const { handle } = fakeTurn();
		const controller = new AbortController();
		guardTurn(handle, { sessionId: 's1', graceMs: 100, remote, signal: controller.signal });

		controller.abort();

		expect(remoteSignals).toEqual(['terminate']);
	});

	it('retains the artifact owner escalation after the local SSH client closes', async () => {
		const { child, handle, settle } = fakeTurn();
		const owner = { ...remote, promptArtifactPath: '/tmp/private-prompt.json' };
		const stops = guardTurn(handle, { sessionId: 's1', graceMs: 100, remote: owner });
		stops.interrupt();
		child.exitCode = 0;
		child.emit('exit', 0, null);
		child.emit('close', 0, null);
		settle();
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		expect(remoteSignals).toEqual(['interrupt', 'terminate']);
		expect(remoteTargets).toEqual([owner, owner]);
	});

	it.each(['terminate', 'terminateNow', 'abort'] as const)(
		'keeps remote artifact ownership when stopped through %s',
		async (method) => {
			const { handle, settle } = fakeTurn();
			const owner = { ...remote, promptArtifactPath: '/tmp/private-prompt.json' };
			const controller = new AbortController();
			const stops = guardTurn(handle, {
				sessionId: 's1',
				graceMs: 100,
				remote: owner,
				signal: controller.signal,
			});
			if (method === 'abort') controller.abort();
			else stops[method]();
			expect(remoteSignals).toEqual(['terminate']);
			expect(remoteTargets).toEqual([owner]);
			if (method !== 'abort') expect(handle[method]).toHaveBeenCalledOnce();
			settle();
			await Promise.resolve();
		}
	);

	it.each([
		{ spawnError: new Error('post-spawn failure') },
		{ stdinError: new Error('partial transfer') },
		{ signal: 'SIGKILL' as const },
		{ interrupted: true },
		{ exitCode: 255 },
	])('requests owning-host cleanup after transport completion %j', async (exit) => {
		const { handle, settle } = fakeTurn();
		const owner = { ...remote, promptArtifactPath: '/tmp/private-prompt.json' };
		guardTurn(handle, { sessionId: 's1', graceMs: 100, remote: owner });
		settle(exit);
		await Promise.resolve();
		expect(remoteSignals).toEqual(['terminate']);
		expect(remoteTargets).toEqual([owner]);
	});

	it('does not signal an artifact whose local process never spawned', async () => {
		const { handle, settle } = fakeTurn();
		Object.defineProperty(handle.child, 'pid', { value: undefined });
		guardTurn(handle, {
			sessionId: 's1',
			graceMs: 100,
			remote: { ...remote, promptArtifactPath: '/tmp/private-prompt.json' },
		});
		settle({ spawnError: new Error('ENOENT') });
		await Promise.resolve();
		expect(remoteSignals).toEqual([]);
	});

	it('signals no remote for a local turn, and still stops the local process', async () => {
		const { handle, settle } = fakeTurn();
		const stops = guardTurn(handle, { sessionId: 's1', graceMs: 100 });

		stops.terminate();
		stops.terminateNow();
		settle();
		await Promise.resolve();

		expect(handle.terminate).toHaveBeenCalledOnce();
		expect(handle.terminateNow).toHaveBeenCalledOnce();
		expect(remoteSignals).toEqual([]);
	});
});

describe('recordRemoteAgent', () => {
	it('records the pid of a stdin-script SSH launch, and names where to signal it', () => {
		const recorded = recordRemoteAgent({
			command: 'ssh',
			args: remote.sshArgs,
			sshStdinScript: 'exec claude',
			sessionId: 's1',
		});

		expect(recorded.remote).toMatchObject({ sshCommand: 'ssh', sshArgs: remote.sshArgs });
		expect(recorded.sshStdinScript).toContain(recorded.remote!.pidFile);
		expect(recorded.sshStdinScript?.endsWith('\nexec claude')).toBe(true);
	});

	it('binds one fresh private owner record to the artifact path', () => {
		const launch = {
			command: 'ssh',
			args: remote.sshArgs,
			sshStdinScript: 'synthetic-script',
			sessionId: 's1',
			promptArtifactPath: '/tmp/private-prompt.json',
		};
		const first = recordRemoteAgent(launch);
		const second = recordRemoteAgent(launch);
		expect(first.remote).toMatchObject({ promptArtifactPath: launch.promptArtifactPath });
		expect(first.remote!.pidFile).toMatch(/^\/tmp\/maestro-prompt-owner-[0-9a-f-]{36}\.pid$/);
		expect(first.remote!.pidFile).not.toBe(second.remote!.pidFile);
		expect(first.sshStdinScript).toContain(
			`readonly _maestro_prompt_path='${launch.promptArtifactPath}'`
		);
		expect(first.sshStdinScript).not.toContain('find /tmp');
		for (const invalid of [{ args: ['host'] }, { sshStdinScript: undefined }]) {
			expect(() => recordRemoteAgent({ ...launch, ...invalid })).toThrow(
				'Remote prompt preparation unavailable.'
			);
		}
	});

	it('passes anything else through with no target', () => {
		expect(
			recordRemoteAgent({
				command: 'node',
				args: ['agent.js'],
				sshStdinScript: undefined,
				sessionId: 's1',
			})
		).toEqual({ sshStdinScript: undefined });
		expect(
			recordRemoteAgent({
				command: 'ssh',
				args: ['host'],
				sshStdinScript: 'exec x',
				sessionId: 's1',
			})
		).toEqual({ sshStdinScript: 'exec x' });
	});
});
