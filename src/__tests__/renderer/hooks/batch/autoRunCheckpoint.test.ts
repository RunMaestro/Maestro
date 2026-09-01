/**
 * Tests for the Auto Run task-boundary checkpoint gate.
 *
 * The behaviours worth pinning here are the ones a future change could quietly
 * break without failing anything else: that it is OFF unless asked for, and
 * that a failed snapshot never stops the run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const createCheckpoint = vi.fn();
const getState = vi.fn();

vi.mock('../../../../renderer/services/git', () => ({
	gitService: {
		createCheckpoint: (...args: unknown[]) => createCheckpoint(...args),
	},
}));

vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: { getState: () => getState() },
}));

import {
	autoRunCheckpointLabel,
	maybeCheckpointAfterTask,
} from '../../../../renderer/hooks/batch/internal/autoRunCheckpoint';

const CONTEXT = {
	cwd: '/repo',
	sshRemoteId: undefined,
	sessionName: 'Agent',
	documentName: 'plan.md',
	taskNumber: 3,
	taskSummary: 'Wired the parser',
};

beforeEach(() => {
	vi.clearAllMocks();
	(globalThis as { window?: unknown }).window = {
		maestro: { logger: { autorun: vi.fn() } },
	};
	getState.mockReturnValue({
		autoRunCheckpointsEnabled: true,
		autoRunCheckpointsIncludeIgnored: false,
	});
	createCheckpoint.mockResolvedValue({
		success: true,
		checkpoint: { id: 'cp1', label: 'l', includesIgnored: false },
	});
});

describe('autoRunCheckpointLabel', () => {
	it('leads with the document and task number, so the list reads as a run timeline', () => {
		expect(autoRunCheckpointLabel(CONTEXT)).toBe('plan.md - task 3: Wired the parser');
	});

	it('still identifies the task when the agent gave no summary', () => {
		expect(autoRunCheckpointLabel({ ...CONTEXT, taskSummary: undefined })).toBe('plan.md - task 3');
	});

	it('treats a whitespace-only summary as no summary', () => {
		expect(autoRunCheckpointLabel({ ...CONTEXT, taskSummary: '   ' })).toBe('plan.md - task 3');
	});

	it('clips a long summary - a label is a list row, not a paragraph', () => {
		const label = autoRunCheckpointLabel({ ...CONTEXT, taskSummary: 'x'.repeat(300) });
		expect(label.endsWith('...')).toBe(true);
		expect(label.length).toBeLessThan(120);
	});

	it('flattens a multi-line summary', () => {
		expect(autoRunCheckpointLabel({ ...CONTEXT, taskSummary: 'one\ntwo' })).toBe(
			'plan.md - task 3: one two'
		);
	});
});

describe('maybeCheckpointAfterTask', () => {
	it('does nothing when the setting is off', async () => {
		// The default. Every user would otherwise pay for a snapshot per task.
		getState.mockReturnValue({
			autoRunCheckpointsEnabled: false,
			autoRunCheckpointsIncludeIgnored: false,
		});

		const result = await maybeCheckpointAfterTask(CONTEXT);

		expect(createCheckpoint).not.toHaveBeenCalled();
		expect(result.taken).toBe(false);
	});

	it('stamps the checkpoint as auto-run so the list can tell it apart', async () => {
		await maybeCheckpointAfterTask(CONTEXT);

		expect(createCheckpoint).toHaveBeenCalledWith(
			'/repo',
			expect.objectContaining({ origin: 'auto-run', includeIgnored: false }),
			undefined
		);
	});

	it('forwards the ignored-files preference', async () => {
		getState.mockReturnValue({
			autoRunCheckpointsEnabled: true,
			autoRunCheckpointsIncludeIgnored: true,
		});

		await maybeCheckpointAfterTask(CONTEXT);

		expect(createCheckpoint).toHaveBeenCalledWith(
			'/repo',
			expect.objectContaining({ includeIgnored: true }),
			undefined
		);
	});

	it('passes the SSH remote through', async () => {
		await maybeCheckpointAfterTask({ ...CONTEXT, sshRemoteId: 'remote-1' });
		expect(createCheckpoint).toHaveBeenCalledWith('/repo', expect.anything(), 'remote-1');
	});

	it('reads the setting at call time, so toggling it mid-run takes effect', async () => {
		await maybeCheckpointAfterTask(CONTEXT);
		expect(createCheckpoint).toHaveBeenCalledTimes(1);

		getState.mockReturnValue({
			autoRunCheckpointsEnabled: false,
			autoRunCheckpointsIncludeIgnored: false,
		});
		await maybeCheckpointAfterTask(CONTEXT);

		expect(createCheckpoint).toHaveBeenCalledTimes(1);
	});

	it('reports a failed snapshot without throwing', async () => {
		// A checkpoint is a safety net, not a step of the work. Aborting a
		// six-hour run because a snapshot failed destroys more than it protects.
		createCheckpoint.mockResolvedValue({ success: false, error: 'disk full' });

		const result = await maybeCheckpointAfterTask(CONTEXT);

		expect(result).toEqual({ taken: false, error: 'disk full' });
	});

	it('swallows an unexpected throw rather than aborting the run', async () => {
		createCheckpoint.mockRejectedValue(new Error('bridge died'));

		await expect(maybeCheckpointAfterTask(CONTEXT)).resolves.toEqual({
			taken: false,
			error: 'bridge died',
		});
	});

	it('logs the reason when a snapshot fails, since a missing one is otherwise invisible', async () => {
		createCheckpoint.mockResolvedValue({ success: false, error: 'disk full' });

		await maybeCheckpointAfterTask(CONTEXT);

		const autorun = (
			globalThis as { window: { maestro: { logger: { autorun: ReturnType<typeof vi.fn> } } } }
		).window.maestro.logger.autorun;
		expect(autorun).toHaveBeenCalledWith(
			expect.stringContaining('disk full'),
			'Agent',
			expect.anything()
		);
	});
});
