/**
 * Tests for the performance-profiling recording state machine.
 *
 * contentTracing is a process-global singleton, so the module under test holds a
 * single bit of module-level state. Each test re-imports the module (via
 * vi.resetModules) to start from a clean "not recording" baseline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockStartRecording = vi.fn().mockResolvedValue(undefined);
const mockStopRecording = vi.fn().mockResolvedValue(undefined);

vi.mock('electron', () => ({
	contentTracing: {
		startRecording: (...args: unknown[]) => mockStartRecording(...args),
		stopRecording: (...args: unknown[]) => mockStopRecording(...args),
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
	});

	it('reports inactive status before any recording starts', async () => {
		const mod = await loadModule();
		expect(mod.isProfiling()).toBe(false);
		expect(mod.getProfilingStatus()).toEqual({
			active: false,
			startedAt: 0,
			elapsedMs: 0,
			categories: [],
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
});
