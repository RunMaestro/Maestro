// @vitest-environment node
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as termination from '../../../shared/maestro-lib/control/termination';
import { superviseAgentProcess } from '../../../cli/services/agent-process-supervisor';
import { HEADLESS_PROCESS_CLOSE_TIMEOUT_MS } from '../../../shared/plugins/headless-agent-timeouts';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('headless process supervision', () => {
	it('does not confuse a failed kill with process exit, and observes a late exit after forced stop', async () => {
		vi.useFakeTimers();
		const child = Object.assign(new EventEmitter(), {
			pid: undefined as number | undefined,
			kill: vi.fn(),
			exitCode: null,
			signalCode: null,
			stdout: { destroy: vi.fn() },
			stderr: { destroy: vi.fn() },
		});
		const controller = new AbortController();
		const onForcedStop = vi.fn();
		const supervision = superviseAgentProcess(child as unknown as ChildProcess, {
			signal: controller.signal,
			onStop: vi.fn(),
			onForcedStop,
		});
		let exited = false;
		void supervision.processExited.then(() => {
			exited = true;
		});
		controller.abort();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(onForcedStop).toHaveBeenCalledOnce();
		expect(child.stdout.destroy).toHaveBeenCalledOnce();
		expect(child.stderr.destroy).toHaveBeenCalledOnce();
		expect(vi.getTimerCount()).toBe(0);
		expect(exited).toBe(false);
		child.pid = 123;
		child.emit('error', new Error('synthetic kill failure'));
		await Promise.resolve();
		expect(exited).toBe(false);
		child.emit('exit', null, 'SIGKILL');
		await supervision.processExited;
		expect(exited).toBe(true);
		supervision.dispose();
		expect(child.listenerCount('error')).toBe(0);
	});

	it('confirms a failed spawn without waiting for an exit from a process that never existed', async () => {
		const child = Object.assign(new EventEmitter(), {
			pid: undefined,
			exitCode: null,
			signalCode: null,
		});
		const supervision = superviseAgentProcess(child as unknown as ChildProcess, {
			onStop: vi.fn(),
			onForcedStop: vi.fn(),
		});
		child.emit('error', new Error('synthetic ENOENT'));
		await supervision.processExited;
		supervision.dispose();
	});

	it('uses the shared ownership-aware stop ladder before waiting for close', () => {
		vi.useFakeTimers();
		const stop = vi.spyOn(termination, 'stopProcess');
		const child = Object.assign(new EventEmitter(), {
			kill: vi.fn(),
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		const controller = new AbortController();
		const onStop = vi.fn();
		const supervision = superviseAgentProcess(child, {
			signal: controller.signal,
			onStop,
			onForcedStop: vi.fn(),
		});
		controller.abort();
		expect(stop).toHaveBeenCalledWith(
			{ child },
			{ from: 'terminate', graceMs: 0, immediate: true, label: 'headless agent' }
		);
		expect(onStop).toHaveBeenCalledWith('Agent run timed out or was cancelled');
		expect(child.kill).toHaveBeenCalledWith('SIGKILL');
		supervision.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('disposes teardown idempotently when the launcher closes', async () => {
		vi.useFakeTimers();
		const child = Object.assign(new EventEmitter(), {
			kill: vi.fn(),
			exitCode: null,
			signalCode: null,
		}) as unknown as ChildProcess;
		const supervision = superviseAgentProcess(child, {
			startupMs: 100,
			onStop: vi.fn(),
			onForcedStop: vi.fn(),
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(child.kill).toHaveBeenCalledWith('SIGKILL');
		// The caller disposes on close, including a repeated cleanup.
		supervision.dispose();
		supervision.dispose();
		expect(child.kill).toHaveBeenCalledTimes(2);
		expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
		expect(vi.getTimerCount()).toBe(0);
	});

	it('disarms startup alone on model activity, and all timers on normal completion', async () => {
		vi.useFakeTimers();
		const onStop = vi.fn();
		const supervision = superviseAgentProcess({} as ChildProcess, {
			startupMs: 120_000,
			timeoutMs: 3_600_000,
			onStop,
			onForcedStop: vi.fn(),
		});
		supervision.modelActivity();
		await vi.advanceTimersByTimeAsync(120_000);
		expect(onStop).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(1);
		supervision.dispose();
		expect(vi.getTimerCount()).toBe(0);
	});

	it.skipIf(process.platform === 'win32').each(['startup', 'lifetime', 'abort'] as const)(
		'ends a real SIGTERM-ignoring fixture on %s without credentials or a user profile',
		async (cause) => {
			const child = spawn(
				process.execPath,
				[
					'-e',
					'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);',
				],
				{ detached: true, stdio: ['ignore', 'pipe', 'pipe'] }
			);
			let supervision: ReturnType<typeof superviseAgentProcess> | undefined;
			try {
				await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
				const closed = new Promise((resolve) =>
					child.once('close', (code, signal) => resolve({ code, signal }))
				);
				vi.useFakeTimers();
				const controller = new AbortController();
				supervision = superviseAgentProcess(child, {
					startupMs: cause === 'startup' ? 100 : undefined,
					timeoutMs: cause === 'lifetime' ? 100 : undefined,
					signal: controller.signal,
					onStop: vi.fn(),
					onForcedStop: () => supervision?.dispose(),
				});
				if (cause === 'abort') controller.abort();
				else await vi.advanceTimersByTimeAsync(100);
				expect(child.exitCode).toBeNull();
				await vi.advanceTimersByTimeAsync(HEADLESS_PROCESS_CLOSE_TIMEOUT_MS);
				vi.useRealTimers();
				expect(await closed).toEqual({ code: null, signal: 'SIGKILL' });
			} finally {
				supervision?.dispose();
				vi.useRealTimers();
				if (child.exitCode === null && child.signalCode === null)
					process.kill(-child.pid!, 'SIGKILL');
			}
		}
	);
});
