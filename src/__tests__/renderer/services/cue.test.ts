/**
 * Tests for src/renderer/services/cue.ts
 *
 * Covers:
 * - Read methods return their default value on IPC error
 * - Write methods rethrow on IPC error
 * - Successful calls pass values through unchanged
 * - onActivityUpdate is a direct passthrough
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cueService } from '../../../renderer/services/cue';

// ─── Mock helpers ─────────────────────────────────────────────────────────────

const mockCue = {
	getSettings: vi.fn(),
	getStatus: vi.fn(),
	getGraphData: vi.fn(),
	getActiveRuns: vi.fn(),
	getActivityLog: vi.fn(),
	getEventCount: vi.fn(),
	getQueueStatus: vi.fn(),
	getMetrics: vi.fn(),
	getFanInHealth: vi.fn(),
	readYaml: vi.fn(),
	loadPipelineLayout: vi.fn(),
	validateYaml: vi.fn(),
	enable: vi.fn(),
	disable: vi.fn(),
	stopRun: vi.fn(),
	stopAll: vi.fn(),
	triggerSubscription: vi.fn(),
	refreshSession: vi.fn(),
	removeSession: vi.fn(),
	writeYaml: vi.fn(),
	deleteYaml: vi.fn(),
	savePipelineLayout: vi.fn(),
	onActivityUpdate: vi.fn(),
};

const mockLogger = {
	log: vi.fn(),
};

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = { cue: mockCue, logger: mockLogger };
});

// ─── Read methods ─────────────────────────────────────────────────────────────

describe('cueService — read methods', () => {
	describe('getSettings', () => {
		it('passes resolved value through', async () => {
			const settings = { timeout_minutes: 10 } as any;
			mockCue.getSettings.mockResolvedValue(settings);
			expect(await cueService.getSettings()).toBe(settings);
		});

		it('returns empty object on error', async () => {
			mockCue.getSettings.mockRejectedValue(new Error('fail'));
			expect(await cueService.getSettings()).toEqual({});
			expect(mockLogger.log).toHaveBeenCalledWith(
				'error',
				'Cue getSettings error:',
				undefined,
				expect.any(Error)
			);
		});
	});

	describe('getStatus', () => {
		it('passes resolved value through', async () => {
			const statuses = [{ sessionId: 's1' }] as any;
			mockCue.getStatus.mockResolvedValue(statuses);
			expect(await cueService.getStatus()).toBe(statuses);
		});

		it('returns [] on error', async () => {
			mockCue.getStatus.mockRejectedValue(new Error('fail'));
			expect(await cueService.getStatus()).toEqual([]);
		});
	});

	describe('getGraphData', () => {
		it('passes resolved value through', async () => {
			const data = [{ id: 'g1' }] as any;
			mockCue.getGraphData.mockResolvedValue(data);
			expect(await cueService.getGraphData()).toBe(data);
		});

		it('returns [] on error', async () => {
			mockCue.getGraphData.mockRejectedValue(new Error('fail'));
			expect(await cueService.getGraphData()).toEqual([]);
		});
	});

	describe('getActiveRuns', () => {
		it('passes resolved value through', async () => {
			const runs = [{ runId: 'r1' }] as any;
			mockCue.getActiveRuns.mockResolvedValue(runs);
			expect(await cueService.getActiveRuns()).toBe(runs);
		});

		it('returns [] on error', async () => {
			mockCue.getActiveRuns.mockRejectedValue(new Error('fail'));
			expect(await cueService.getActiveRuns()).toEqual([]);
		});
	});

	describe('getActivityLog', () => {
		it('passes limit parameter through', async () => {
			mockCue.getActivityLog.mockResolvedValue([]);
			await cueService.getActivityLog(50);
			expect(mockCue.getActivityLog).toHaveBeenCalledWith(50);
		});

		it('returns [] on error', async () => {
			mockCue.getActivityLog.mockRejectedValue(new Error('fail'));
			expect(await cueService.getActivityLog()).toEqual([]);
		});
	});

	describe('getQueueStatus', () => {
		it('passes resolved value through', async () => {
			const status = { s1: 3 };
			mockCue.getQueueStatus.mockResolvedValue(status);
			expect(await cueService.getQueueStatus()).toBe(status);
		});

		it('returns {} on error', async () => {
			mockCue.getQueueStatus.mockRejectedValue(new Error('fail'));
			expect(await cueService.getQueueStatus()).toEqual({});
		});
	});

	describe('getMetrics', () => {
		it('passes resolved value through', async () => {
			const snap = { runsStarted: 3, runsCompleted: 2 } as any;
			mockCue.getMetrics.mockResolvedValue(snap);
			expect(await cueService.getMetrics()).toBe(snap);
		});

		it('returns null on error', async () => {
			mockCue.getMetrics.mockRejectedValue(new Error('fail'));
			expect(await cueService.getMetrics()).toBeNull();
		});
	});

	describe('getFanInHealth', () => {
		it('passes resolved value through', async () => {
			const entries = [{ key: 'x', completedCount: 1, expectedCount: 2 }] as any;
			mockCue.getFanInHealth.mockResolvedValue(entries);
			expect(await cueService.getFanInHealth()).toBe(entries);
		});

		it('returns [] on error', async () => {
			mockCue.getFanInHealth.mockRejectedValue(new Error('fail'));
			expect(await cueService.getFanInHealth()).toEqual([]);
		});
	});

	describe('readYaml', () => {
		it('passes resolved value through', async () => {
			mockCue.readYaml.mockResolvedValue('yaml content');
			expect(await cueService.readYaml('/root')).toBe('yaml content');
			expect(mockCue.readYaml).toHaveBeenCalledWith('/root');
		});

		it('passes through null when handler reports the file does not exist', async () => {
			mockCue.readYaml.mockResolvedValue(null);
			expect(await cueService.readYaml('/root')).toBeNull();
		});

		it('rethrows IPC errors instead of swallowing them as null', async () => {
			// The handler distinguishes "no file" (null) from a transport
			// failure (throws). Swallowing IPC errors as null hid bugs and
			// caused callers (e.g. CueYamlEditor) to silently fall back to a
			// template on transport failures.
			mockCue.readYaml.mockRejectedValue(new Error('fail'));
			await expect(cueService.readYaml('/root')).rejects.toThrow('fail');
		});
	});

	describe('loadPipelineLayout', () => {
		it('passes resolved value through', async () => {
			const layout = { pipelines: [] };
			mockCue.loadPipelineLayout.mockResolvedValue(layout);
			expect(await cueService.loadPipelineLayout()).toBe(layout);
		});

		it('returns null on error', async () => {
			mockCue.loadPipelineLayout.mockRejectedValue(new Error('fail'));
			expect(await cueService.loadPipelineLayout()).toBeNull();
		});
	});

	describe('validateYaml', () => {
		it('passes resolved value through', async () => {
			const validation = { valid: false, errors: ['bad yaml'] };
			mockCue.validateYaml.mockResolvedValue(validation);
			expect(await cueService.validateYaml('bad')).toBe(validation);
		});

		it('rethrows on IPC error so callers gate Save (no false-positive valid)', async () => {
			// The previous default was `{ valid: true, errors: [] }` — a
			// transport failure would have surfaced as "yaml is valid, save
			// freely". Callers must now catch and treat the failure as invalid.
			mockCue.validateYaml.mockRejectedValue(new Error('fail'));
			await expect(cueService.validateYaml('content')).rejects.toThrow('fail');
		});
	});
});

// ─── Write methods ────────────────────────────────────────────────────────────

describe('cueService — write methods', () => {
	it('enable — resolves on success', async () => {
		mockCue.enable.mockResolvedValue(undefined);
		await expect(cueService.enable()).resolves.toBeUndefined();
	});

	it('enable — rethrows on error', async () => {
		mockCue.enable.mockRejectedValue(new Error('IPC fail'));
		await expect(cueService.enable()).rejects.toThrow('IPC fail');
	});

	it('disable — rethrows on error', async () => {
		mockCue.disable.mockRejectedValue(new Error('IPC fail'));
		await expect(cueService.disable()).rejects.toThrow('IPC fail');
	});

	it('stopRun — passes runId and rethrows on error', async () => {
		mockCue.stopRun.mockRejectedValue(new Error('IPC fail'));
		await expect(cueService.stopRun('run-1')).rejects.toThrow('IPC fail');
		expect(mockCue.stopRun).toHaveBeenCalledWith('run-1');
	});

	it('stopRun — passes resolved boolean through', async () => {
		mockCue.stopRun.mockResolvedValue(true);
		expect(await cueService.stopRun('run-1')).toBe(true);
	});

	it('stopAll — rethrows on error', async () => {
		mockCue.stopAll.mockRejectedValue(new Error('IPC fail'));
		await expect(cueService.stopAll()).rejects.toThrow('IPC fail');
	});

	it('triggerSubscription — passes args and rethrows on error', async () => {
		mockCue.triggerSubscription.mockRejectedValue(new Error('IPC fail'));
		await expect(cueService.triggerSubscription('sub-1', 'prompt', 'agent-1')).rejects.toThrow(
			'IPC fail'
		);
		expect(mockCue.triggerSubscription).toHaveBeenCalledWith('sub-1', 'prompt', 'agent-1');
	});

	it('refreshSession — passes args and rethrows on error', async () => {
		mockCue.refreshSession.mockRejectedValue(new Error('IPC fail'));
		await expect(cueService.refreshSession('sess-1', '/root')).rejects.toThrow('IPC fail');
		expect(mockCue.refreshSession).toHaveBeenCalledWith('sess-1', '/root');
	});

	it('removeSession — rethrows on error', async () => {
		mockCue.removeSession.mockRejectedValue(new Error('IPC fail'));
		await expect(cueService.removeSession('sess-1')).rejects.toThrow('IPC fail');
	});

	it('writeYaml — passes args (including promptFiles) and rethrows on error', async () => {
		mockCue.writeYaml.mockRejectedValue(new Error('IPC fail'));
		const promptFiles = { 'p.md': 'content' };
		await expect(cueService.writeYaml('/root', 'yaml', promptFiles)).rejects.toThrow('IPC fail');
		expect(mockCue.writeYaml).toHaveBeenCalledWith('/root', 'yaml', promptFiles);
	});

	it('deleteYaml — passes resolved boolean through', async () => {
		mockCue.deleteYaml.mockResolvedValue(true);
		expect(await cueService.deleteYaml('/root')).toBe(true);
	});

	it('deleteYaml — rethrows on error', async () => {
		mockCue.deleteYaml.mockRejectedValue(new Error('IPC fail'));
		await expect(cueService.deleteYaml('/root')).rejects.toThrow('IPC fail');
	});

	it('savePipelineLayout — rethrows on error', async () => {
		mockCue.savePipelineLayout.mockRejectedValue(new Error('IPC fail'));
		await expect(cueService.savePipelineLayout({ x: 1 })).rejects.toThrow('IPC fail');
		expect(mockCue.savePipelineLayout).toHaveBeenCalledWith({ x: 1 });
	});
});

// ─── Event passthrough ────────────────────────────────────────────────────────

describe('cueService — onActivityUpdate', () => {
	it('is a direct passthrough to window.maestro.cue.onActivityUpdate', () => {
		const unsubscribe = vi.fn();
		mockCue.onActivityUpdate.mockReturnValue(unsubscribe);
		const callback = vi.fn();

		const result = cueService.onActivityUpdate(callback);

		expect(mockCue.onActivityUpdate).toHaveBeenCalledWith(callback);
		expect(result).toBe(unsubscribe);
	});
});
