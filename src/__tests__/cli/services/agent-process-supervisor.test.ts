// @vitest-environment node
import { EventEmitter } from 'events';
import { spawn, type ChildProcess } from 'child_process';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import * as termination from '../../../shared/maestro-lib/control/termination';
import { createOutputParser } from '../../../shared/maestro-lib/parsers/parser-factory';
import { superviseAgentProcess } from '../../../cli/services/agent-process-supervisor';
import { HEADLESS_PROCESS_CLOSE_TIMEOUT_MS } from '../../../shared/plugins/headless-agent-timeouts';

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('headless process supervision', () => {
	it('keeps new normalized model work alive beyond the old one-hour deadline', async () => {
		vi.useFakeTimers();
		const onStop = vi.fn();
		const supervision = superviseAgentProcess({} as ChildProcess, {
			timeoutMs: 6 * 60 * 60_000,
			idle: { warnMs: 10 * 60_000, idleMs: 20 * 60_000, toolMs: 60 * 60_000 },
			onStop,
			onForcedStop: vi.fn(),
		});
		try {
			for (let step = 0; step < 14; step++) {
				supervision.observe({ type: 'text', text: `new work ${step}`, raw: {} });
				await vi.advanceTimersByTimeAsync(5 * 60_000);
			}
			expect(onStop).not.toHaveBeenCalled();
		} finally {
			supervision.dispose();
		}
	});

	it.each(['startup', 'lifetime', 'abort'] as const)(
		'terminates %s and releases the caller even when close never arrives',
		async (cause) => {
			vi.useFakeTimers();
			const child = Object.assign(new EventEmitter(), {
				kill: vi.fn(),
				exitCode: null,
				signalCode: null,
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
			await vi.advanceTimersByTimeAsync(5_000 + HEADLESS_PROCESS_CLOSE_TIMEOUT_MS);
			expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
			expect(onForcedStop).toHaveBeenCalledTimes(1);
			expect(child.stdout?.destroy).toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		}
	);

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
			{ from: 'terminate', graceMs: 5_000, label: 'headless agent' }
		);
		expect(onStop).toHaveBeenCalledWith('Agent run cancelled');
		expect(child.kill).toHaveBeenCalledWith('SIGTERM');
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
		expect(child.kill).toHaveBeenCalledWith('SIGTERM');
		// The caller disposes on close, including a repeated cleanup.
		supervision.dispose();
		supervision.dispose();
		expect(child.kill).toHaveBeenCalledTimes(1);
		expect(child.kill).toHaveBeenLastCalledWith('SIGTERM');
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
				await vi.advanceTimersByTimeAsync(5_000 + HEADLESS_PROCESS_CLOSE_TIMEOUT_MS);
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

describe('semantic inactivity policy', () => {
	let child: ChildProcess;
	let supervision: ReturnType<typeof superviseAgentProcess>;
	let onStop: ReturnType<typeof vi.fn>;
	let onStatus: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		vi.useFakeTimers();
		child = Object.assign(new EventEmitter(), {
			kill: vi.fn(),
			exitCode: null,
			signalCode: null,
			stdout: { destroy: vi.fn() },
			stderr: { destroy: vi.fn() },
		}) as unknown as ChildProcess;
		onStop = vi.fn();
		onStatus = vi.fn();
		supervision = superviseAgentProcess(child, {
			timeoutMs: 21_600_000,
			idle: { warnMs: 600_000, idleMs: 1_200_000, toolMs: 3_600_000 },
			onStop,
			onStatus,
			onForcedStop: vi.fn(),
		});
	});
	afterEach(() => supervision.dispose());

	it('treats the first cumulative usage snapshot as a baseline, not fresh work', async () => {
		await vi.advanceTimersByTimeAsync(19 * 60_000);
		supervision.observe({ type: 'usage', usage: { inputTokens: 100, outputTokens: 20 }, raw: {} });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(onStop).toHaveBeenCalledOnce();
	});

	it('preserves an ID-less tool deadline across delayed model events without poll renewal', async () => {
		supervision.observe({ type: 'tool_use', toolState: { status: 'running' }, raw: {} });
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		supervision.observe({ type: 'text', text: 'delayed model event', raw: {} });
		await vi.advanceTimersByTimeAsync(20 * 60_000);
		expect(onStop).not.toHaveBeenCalled();
		supervision.observe({ type: 'tool_use', toolState: { status: 'running' }, raw: {} });
		await vi.advanceTimersByTimeAsync(35 * 60_000);
		expect(onStop).toHaveBeenCalledOnce();
	});

	it('keeps the anonymous deadline when model work renews a simultaneous correlated tool', async () => {
		supervision.observe({ type: 'tool_use', toolState: { status: 'running' }, raw: {} });
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'build',
			toolState: { status: 'running' },
			raw: {},
		});
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		supervision.observe({ type: 'text', text: 'new model work', raw: {} });
		await vi.advanceTimersByTimeAsync(25 * 60_000);
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'build',
			toolState: { status: 'completed' },
			raw: {},
		});
		// The identified handoff ends at minute 50. Only the anonymous allowance
		// may keep this quiet run alive until its original minute-60 deadline.
		await vi.advanceTimersByTimeAsync(30 * 60_000 - 1);
		expect(onStop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(onStop).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('tool or wait budget'));
	});

	it.each(['anonymous', 'correlated'] as const)(
		'keeps separate tool start deadlines when %s starts first',
		async (first) => {
			const anonymous = { type: 'tool_use' as const, toolState: { status: 'running' }, raw: {} };
			const correlated = { ...anonymous, toolCallId: 'build' };
			supervision.observe(first === 'anonymous' ? anonymous : correlated);
			await vi.advanceTimersByTimeAsync(10 * 60_000);
			supervision.observe(first === 'anonymous' ? correlated : anonymous);
			await vi.advanceTimersByTimeAsync(20 * 60_000);
			supervision.observe({
				type: 'tool_use',
				toolCallId: 'build',
				toolState: { status: 'completed' },
				raw: {},
			});
			await vi.advanceTimersByTimeAsync((first === 'anonymous' ? 30 : 40) * 60_000 - 1);
			expect(onStop).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(onStop).toHaveBeenCalledOnce();
		}
	);

	it('lets a valid correlated allowance outlive an expired anonymous allowance', async () => {
		supervision.observe({ type: 'tool_use', toolState: { status: 'running' }, raw: {} });
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'build',
			toolState: { status: 'running' },
			raw: {},
		});
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		supervision.observe({ type: 'text', text: 'new model work', raw: {} });
		await vi.advanceTimersByTimeAsync(55 * 60_000);
		expect(onStop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
		expect(onStop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(onStop).toHaveBeenCalledOnce();
	});

	it('keeps fresh model work alive on its own idle budget after both tool allowances end', async () => {
		supervision.observe({ type: 'tool_use', toolState: { status: 'running' }, raw: {} });
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'build',
			toolState: { status: 'running' },
			raw: {},
		});
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		supervision.observe({ type: 'text', text: 'first model work', raw: {} });
		await vi.advanceTimersByTimeAsync(25 * 60_000);
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'build',
			toolState: { status: 'completed' },
			raw: {},
		});
		await vi.advanceTimersByTimeAsync(25 * 60_000);
		supervision.observe({ type: 'text', text: 'fresh model work', raw: {} });
		await vi.advanceTimersByTimeAsync(20 * 60_000 - 1);
		expect(onStop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(onStop).toHaveBeenCalledOnce();
	});

	it('signals before publishing a timeout status', async () => {
		await vi.advanceTimersByTimeAsync(1_200_000);
		const signalOrder = vi.mocked(child.kill).mock.invocationCallOrder[0];
		const stoppedOrder = onStatus.mock.invocationCallOrder.at(-1)!;
		expect(signalOrder).toBeLessThan(stoppedOrder);
	});

	it.each(['opencode', 'codex'] as const)(
		'gives real %s ID-less tools a finite allowance',
		async (provider) => {
			const parser = createOutputParser(provider)!;
			const raw =
				provider === 'opencode'
					? { type: 'tool_use', part: { tool: 'bash', state: { status: 'running' } } }
					: { type: 'item.completed', item: { type: 'tool_call', tool: 'shell', args: {} } };
			const event = parser.parseJsonLine(JSON.stringify(raw))!;
			expect(event.type).toBe('tool_use');
			expect(event.toolCallId).toBeUndefined();
			supervision.observe(event);
			await vi.advanceTimersByTimeAsync(1_200_000);
			expect(onStop).not.toHaveBeenCalled();
			supervision.observe(event);
			await vi.advanceTimersByTimeAsync(2_400_000);
			expect(onStop).toHaveBeenCalledOnce();
		}
	);

	it('counts distinct Copilot model steps with equal usage but ignores their replays', async () => {
		supervision.dispose();
		supervision = superviseAgentProcess(child, {
			timeoutMs: 21_600_000,
			usageReporting: 'per-step',
			idle: { warnMs: 600_000, idleMs: 1_200_000, toolMs: 3_600_000 },
			onStop,
			onStatus,
			onForcedStop: vi.fn(),
		});
		const parser = createOutputParser('copilot-cli')!;
		let lastEvent;
		for (let n = 0; n < 14; n++) {
			lastEvent = parser.parseJsonLine(
				JSON.stringify({
					type: 'assistant.message',
					id: `step-${n}`,
					data: { content: '', outputTokens: 10 },
				})
			)!;
			supervision.observe(lastEvent);
			await vi.advanceTimersByTimeAsync(300_000);
		}
		expect(onStop).not.toHaveBeenCalled();
		for (let n = 0; n < 4; n++) {
			supervision.observe(lastEvent!);
			await vi.advanceTimersByTimeAsync(300_000);
		}
		expect(onStop).toHaveBeenCalledOnce();
	});

	it('bounds provider exit with inherited stdio instead of waiting for the idle budget', async () => {
		supervision.observe({ type: 'text', text: 'initial work', raw: {} });
		child.emit('exit', 1, null);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(onStop).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining('exited without closing')
		);
		expect(child.stdout?.destroy).toHaveBeenCalled();
	});

	it('warns once at ten minutes and stops at twenty; warning does not renew', async () => {
		await vi.advanceTimersByTimeAsync(600_000);
		expect(onStatus).toHaveBeenCalledTimes(1);
		expect(onStatus).toHaveBeenLastCalledWith(expect.stringContaining('Warning:'));
		await vi.advanceTimersByTimeAsync(599_999);
		expect(onStop).not.toHaveBeenCalled();
		expect(onStatus).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(onStop).toHaveBeenCalledWith(expect.stringContaining('semantic inactivity'));
		// Timeout requests graceful termination, then the shared ladder escalates.
		expect(child.kill).toHaveBeenCalledWith('SIGTERM');
		expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
		await vi.advanceTimersByTimeAsync(5_000);
		expect(child.kill).toHaveBeenCalledWith('SIGKILL');
	});

	it('recovers on new private reasoning then warns again without exposing content', async () => {
		await vi.advanceTimersByTimeAsync(600_000);
		supervision.observe({ type: 'text', isReasoning: true, text: 'PRIVATE_REASONING', raw: {} });
		expect(onStatus).toHaveBeenLastCalledWith(expect.stringContaining('recovered'));
		await vi.advanceTimersByTimeAsync(600_000);
		expect(onStatus).toHaveBeenCalledTimes(3);
		expect(onStatus.mock.calls.flat().join()).not.toContain('PRIVATE_REASONING');
		expect(onStop).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(600_000);
		expect(onStop).toHaveBeenCalledOnce();
	});

	it('ignores duplicate/replayed text, unchanged or declining usage, retry and noise', async () => {
		const event = { type: 'text' as const, text: 'same', raw: {} };
		supervision.observe(event);
		supervision.observe({ type: 'usage', usage: { inputTokens: 20, outputTokens: 5 }, raw: {} });
		for (let n = 0; n < 4; n++) {
			await vi.advanceTimersByTimeAsync(300_000);
			supervision.observe(event);
			supervision.observe({ type: 'usage', usage: { inputTokens: 20, outputTokens: 4 }, raw: {} });
			supervision.observe({ type: 'text', text: `retry ${n}`, isRetryNotice: true, raw: {} });
			supervision.observe({ type: 'system', text: `typing ${n}`, raw: {} });
			supervision.observe({ type: 'text', text: `stdout ${n}`, raw: 'not parsed' });
		}
		expect(onStop).toHaveBeenCalledOnce();
	});

	it('accepts increasing token counts and caps active work at six hours', async () => {
		for (let n = 1; n <= 72; n++) {
			supervision.observe({ type: 'usage', usage: { inputTokens: 20, outputTokens: n }, raw: {} });
			await vi.advanceTimersByTimeAsync(300_000);
		}
		expect(onStop).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining('absolute runtime ceiling')
		);
	});

	it.each(['shell', 'functions.wait', 'functions.request_user_input'])(
		'protects a quiet %s within a finite allowance and ignores repeated polls',
		async (toolName) => {
			supervision.observe({
				type: 'tool_use',
				toolName,
				toolCallId: 'one',
				toolState: { status: 'running', input: 'PRIVATE_TOOL' },
				raw: {},
			});
			await vi.advanceTimersByTimeAsync(1_200_000);
			expect(onStop).not.toHaveBeenCalled();
			for (let n = 0; n < 8; n++) {
				supervision.observe({
					type: 'tool_use',
					toolCallId: `poll-${n}`,
					toolState: { status: 'running' },
					raw: {},
				});
				await vi.advanceTimersByTimeAsync(300_000);
			}
			expect(onStop).toHaveBeenCalledExactlyOnceWith(
				expect.stringContaining('tool or wait budget')
			);
			expect(onStatus.mock.calls.flat().join()).not.toContain('PRIVATE_TOOL');
		}
	);

	it('allows a correlated long tool completion to hand back to the model', async () => {
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'build',
			toolState: { status: 'running' },
			raw: {},
		});
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'build',
			toolState: { status: 'completed' },
			raw: {},
		});
		await vi.advanceTimersByTimeAsync(10_000);
		expect(onStop).not.toHaveBeenCalled();
		supervision.observe({ type: 'text', text: 'build verified', raw: {} });
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(onStop).not.toHaveBeenCalled();
	});

	it('ignores orphan completions and children without an open registered parent', async () => {
		await vi.advanceTimersByTimeAsync(19 * 60_000);
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'unknown',
			toolState: { status: 'completed' },
			raw: {},
		});
		supervision.observe({ type: 'text', text: 'orphan', parentToolUseId: 'unknown', raw: {} });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(onStop).toHaveBeenCalledOnce();
	});

	it('accepts new work from a correlated child but not after its parent closes', async () => {
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'parent',
			toolState: { status: 'running' },
			raw: {},
		});
		await vi.advanceTimersByTimeAsync(30 * 60_000);
		supervision.observe({ type: 'text', text: 'child work', parentToolUseId: 'parent', raw: {} });
		expect(onStatus).toHaveBeenLastCalledWith(expect.stringContaining('recovered'));
		supervision.observe({
			type: 'tool_use',
			toolCallId: 'parent',
			toolState: { status: 'completed' },
			raw: {},
		});
		await vi.advanceTimersByTimeAsync(19 * 60_000);
		supervision.observe({ type: 'text', text: 'late child', parentToolUseId: 'parent', raw: {} });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(onStop).toHaveBeenCalledOnce();
	});
});
