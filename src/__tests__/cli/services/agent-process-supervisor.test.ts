// @vitest-environment node
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { superviseAgentProcess } from '../../../cli/services/agent-process-supervisor';
import { HEADLESS_PROCESS_KILL_GRACE_MS } from '../../../shared/plugins/headless-agent-timeouts';

afterEach(() => vi.useRealTimers());

describe('headless process supervision', () => {
	it.each(['startup', 'lifetime', 'abort'] as const)(
		'escalates %s and releases the caller even when close never arrives',
		async (cause) => {
			vi.useFakeTimers();
			const child = Object.assign(new EventEmitter(), {
				kill: vi.fn(),
				stdout: { destroy: vi.fn() },
				stderr: { destroy: vi.fn() },
			}) as unknown as ChildProcess;
			const controller = new AbortController();
			const onStop = vi.fn();
			const onForcedStop = vi.fn(() => supervision.dispose());
			const supervision = superviseAgentProcess(child, {
				startupMs: cause === 'startup' ? 120_000 : undefined,
				timeoutMs: 3_600_000,
				signal: controller.signal,
				onStop,
				onForcedStop,
			});
			if (cause === 'abort') controller.abort();
			else await vi.advanceTimersByTimeAsync(cause === 'startup' ? 120_000 : 3_600_000);
			expect(onStop).toHaveBeenCalledTimes(1);
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');
			expect(onForcedStop).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(HEADLESS_PROCESS_KILL_GRACE_MS);
			expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
			expect(onForcedStop).toHaveBeenCalledTimes(1);
			expect(child.stdout?.destroy).toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		}
	);

	it('kills remaining group members if the launcher closes during teardown', async () => {
		vi.useFakeTimers();
		const child = { kill: vi.fn() } as unknown as ChildProcess;
		const supervision = superviseAgentProcess(child, {
			startupMs: 100,
			onStop: vi.fn(),
			onForcedStop: vi.fn(),
		});
		await vi.advanceTimersByTimeAsync(100);
		expect(child.kill).toHaveBeenCalledWith('SIGTERM');
		// The caller disposes on close even if another group member survives.
		supervision.dispose();
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

	it.skipIf(process.platform === 'win32')(
		'kills a real process group that ignores SIGTERM',
		async () => {
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
				supervision = superviseAgentProcess(child, {
					startupMs: 100,
					onStop: vi.fn(),
					onForcedStop: () => supervision?.dispose(),
				});
				await vi.advanceTimersByTimeAsync(100);
				expect(child.exitCode).toBeNull();
				await vi.advanceTimersByTimeAsync(HEADLESS_PROCESS_KILL_GRACE_MS);
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
