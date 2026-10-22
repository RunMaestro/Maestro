/**
 * `guardTurn` and `recordRemoteAgent`: what a headless turn does around its process so it always
 * settles and Stop reaches an SSH agent on its host. The process is a stand-in; the remote signal
 * is observed, never sent.
 */
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const remoteSignals = vi.hoisted(() => [] as string[]);
vi.mock('../../../../shared/maestro-lib/control/ssh-remote-signal', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../shared/maestro-lib/control/ssh-remote-signal')
	>()),
	signalRemoteAgent: (_target: unknown, mode: string) => {
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
	let settle: () => void = () => undefined;
	const done = new Promise<never>((resolve) => {
		settle = () => resolve(undefined as never);
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
