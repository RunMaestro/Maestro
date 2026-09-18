/**
 * Tests for the performance-profiling recording state machine.
 *
 * contentTracing is a process-global singleton, so the module under test holds a
 * single bit of module-level state. Each test re-imports the module (via
 * vi.resetModules) to start from a clean "not recording" baseline.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockStartRecording = vi.fn().mockResolvedValue(undefined);
const mockStopRecording = vi.fn().mockResolvedValue(undefined);
const mockGetTraceBufferUsage = vi.fn().mockResolvedValue({ value: 0, percentage: 0 });

vi.mock('electron', () => ({
	contentTracing: {
		startRecording: (...args: unknown[]) => mockStartRecording(...args),
		stopRecording: (...args: unknown[]) => mockStopRecording(...args),
		getTraceBufferUsage: () => mockGetTraceBufferUsage(),
	},
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Fresh module (and fresh recording state) per test.
async function loadModule() {
	vi.resetModules();
	return import('../../../main/profiling/content-tracing');
}

describe('profiling/content-tracing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockStartRecording.mockResolvedValue(undefined);
		mockStopRecording.mockResolvedValue(undefined);
		mockGetTraceBufferUsage.mockResolvedValue({ value: 0, percentage: 0 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/**
	 * Drive the watchdog's polling interval and let the awaited buffer probe
	 * settle. The poll body is async, so advancing timers alone is not enough -
	 * the promise it creates has to be flushed before the state it writes is
	 * observable.
	 */
	async function tickWatchdog(times = 1) {
		for (let i = 0; i < times; i++) {
			await vi.advanceTimersByTimeAsync(1_000);
		}
	}

	it('reports inactive status before any recording starts', async () => {
		const mod = await loadModule();
		expect(mod.isProfiling()).toBe(false);
		expect(mod.getProfilingStatus()).toMatchObject({
			active: false,
			startedAt: 0,
			elapsedMs: 0,
			categories: [],
			bufferPercent: 0,
			peakBufferPercent: 0,
			autoStopRequested: false,
		});
	});

	it('starts a recording and reports active status', async () => {
		const mod = await loadModule();
		const status = await mod.startProfiling(['toplevel', 'v8']);

		expect(mockStartRecording).toHaveBeenCalledTimes(1);
		expect(mod.isProfiling()).toBe(true);
		expect(status.active).toBe(true);
		expect(status.categories).toEqual(['toplevel', 'v8']);
		expect(status.startedAt).toBeGreaterThan(0);
	});

	it('uses the default categories when none are supplied', async () => {
		const { DEFAULT_TRACE_CATEGORIES } = await import('../../../main/profiling/categories');
		const mod = await loadModule();
		const status = await mod.startProfiling();

		expect(status.categories).toEqual(DEFAULT_TRACE_CATEGORIES);
		expect(status.categories.length).toBeGreaterThan(0);
	});

	it('no-ops a second start so the singleton never desyncs', async () => {
		const mod = await loadModule();
		await mod.startProfiling(['toplevel']);
		const second = await mod.startProfiling(['v8']);

		// Only the first start actually touched contentTracing.
		expect(mockStartRecording).toHaveBeenCalledTimes(1);
		// The returned status reflects the original (still-active) recording.
		expect(second.active).toBe(true);
		expect(second.categories).toEqual(['toplevel']);
	});

	it('throws when stopping with no active recording', async () => {
		const mod = await loadModule();
		await expect(mod.stopProfiling('/tmp/trace.json')).rejects.toThrow(
			'No active profiling recording to stop'
		);
		expect(mockStopRecording).not.toHaveBeenCalled();
	});

	it('stops a recording, flushes to the path, and clears state', async () => {
		const mod = await loadModule();
		await mod.startProfiling(['toplevel', 'cc']);

		const result = await mod.stopProfiling('/tmp/trace.json');

		expect(mockStopRecording).toHaveBeenCalledWith('/tmp/trace.json');
		expect(result.categories).toEqual(['toplevel', 'cc']);
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
		// A recording that never pressured the buffer reports itself complete.
		expect(result.bufferExhausted).toBe(false);
		expect(result.autoStopped).toBe(false);
		// Recording is no longer active after a successful stop.
		expect(mod.isProfiling()).toBe(false);
		expect(mod.getProfilingStatus().active).toBe(false);
	});

	it('clears recording state even when the flush fails', async () => {
		const mod = await loadModule();
		await mod.startProfiling(['toplevel']);
		mockStopRecording.mockRejectedValueOnce(new Error('disk full'));

		await expect(mod.stopProfiling('/tmp/trace.json')).rejects.toThrow('disk full');
		// State was cleared before awaiting the flush, so we aren't wedged "recording".
		expect(mod.isProfiling()).toBe(false);
	});
	// --- Buffer watchdog ---------------------------------------------------
	// Chromium drops trace events once its buffer fills, and says nothing about
	// it: the capture keeps "running" while recording less and less. Two field
	// captures were analyzed as if whole before anything watched for this.
	describe('buffer watchdog', () => {
		it('tracks live and peak buffer usage while recording', async () => {
			vi.useFakeTimers();
			const mod = await loadModule();
			await mod.startProfiling(['toplevel']);

			mockGetTraceBufferUsage.mockResolvedValue({ value: 1, percentage: 0.4 });
			await tickWatchdog();
			expect(mod.getProfilingStatus().bufferPercent).toBeCloseTo(0.4);

			// Usage can fall as well as rise; the peak is what decides completeness.
			mockGetTraceBufferUsage.mockResolvedValue({ value: 1, percentage: 0.2 });
			await tickWatchdog();
			const status = mod.getProfilingStatus();
			expect(status.bufferPercent).toBeCloseTo(0.2);
			expect(status.peakBufferPercent).toBeCloseTo(0.4);
		});

		it('calls the auto-stop handler once the buffer passes the threshold', async () => {
			vi.useFakeTimers();
			const mod = await loadModule();
			const onAutoStop = vi.fn();
			mod.setProfilingAutoStopHandler(onAutoStop);
			await mod.startProfiling(['toplevel']);

			mockGetTraceBufferUsage.mockResolvedValue({ value: 1, percentage: 0.5 });
			await tickWatchdog();
			expect(onAutoStop).not.toHaveBeenCalled();

			mockGetTraceBufferUsage.mockResolvedValue({ value: 1, percentage: 0.9 });
			await tickWatchdog();
			expect(onAutoStop).toHaveBeenCalledWith('buffer-full');
			expect(mod.getProfilingStatus().autoStopRequested).toBe(true);
		});

		it('asks to stop only once, however long the buffer stays full', async () => {
			vi.useFakeTimers();
			const mod = await loadModule();
			const onAutoStop = vi.fn();
			mod.setProfilingAutoStopHandler(onAutoStop);
			await mod.startProfiling(['toplevel']);

			mockGetTraceBufferUsage.mockResolvedValue({ value: 1, percentage: 0.99 });
			await tickWatchdog(4);

			// Stopping is a user-visible flow (save dialog, modal). Firing it once per
			// poll would stack four of them on the screen.
			expect(onAutoStop).toHaveBeenCalledTimes(1);
		});

		// A CLI capture owns its own output path and stops itself. Ending it through
		// the desktop flow would raise a save dialog in the middle of an unattended
		// loop and write the bundle somewhere the caller never looks.
		it('never auto-stops a CLI-owned capture through the desktop handler', async () => {
			vi.useFakeTimers();
			const mod = await loadModule();
			const onAutoStop = vi.fn();
			mod.setProfilingAutoStopHandler(onAutoStop);
			await mod.startProfiling(['toplevel'], 'cli');

			mockGetTraceBufferUsage.mockResolvedValue({ value: 1, percentage: 0.95 });
			await tickWatchdog(2);

			expect(onAutoStop).not.toHaveBeenCalled();
			// It is still flagged, so a polling CLI can see it and stop itself.
			expect(mod.getProfilingStatus().autoStopRequested).toBe(true);
		});

		it('reports a capture as incomplete when the buffer reached the threshold', async () => {
			vi.useFakeTimers();
			const mod = await loadModule();
			mod.setProfilingAutoStopHandler(vi.fn());
			await mod.startProfiling(['toplevel']);

			mockGetTraceBufferUsage.mockResolvedValue({ value: 1, percentage: 0.95 });
			await tickWatchdog();

			const outcome = await mod.stopProfiling('/tmp/trace.json');
			expect(outcome.bufferExhausted).toBe(true);
			expect(outcome.autoStopped).toBe(true);
			expect(outcome.peakBufferPercent).toBeCloseTo(0.95);
		});

		// The probe only observes. A tracing service that stops answering must not
		// take the recording down with it - that would turn a degraded capture into
		// no capture at all.
		it('keeps recording when the buffer probe throws', async () => {
			vi.useFakeTimers();
			const mod = await loadModule();
			await mod.startProfiling(['toplevel']);

			mockGetTraceBufferUsage.mockRejectedValue(new Error('tracing service gone'));
			await tickWatchdog(2);

			expect(mod.isProfiling()).toBe(true);
			expect(mod.getProfilingStatus().active).toBe(true);
		});

		it('stops polling once the recording ends', async () => {
			vi.useFakeTimers();
			const mod = await loadModule();
			await mod.startProfiling(['toplevel']);
			await tickWatchdog();
			const callsWhileRecording = mockGetTraceBufferUsage.mock.calls.length;
			expect(callsWhileRecording).toBeGreaterThan(0);

			await mod.stopProfiling('/tmp/trace.json');
			await tickWatchdog(3);

			expect(mockGetTraceBufferUsage.mock.calls.length).toBe(callsWhileRecording);
		});
	});
});
