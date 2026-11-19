import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	finishRunEvidenceCapture,
	startRunEvidenceCapture,
} from '../../../renderer/services/runEvidence';
import type { RunEvidenceSnapshot } from '../../../shared/runEvidence';

const snapshot: RunEvidenceSnapshot = { source: 'git', takenAt: 1, base: 'abc', changes: {} };
const evidence = {
	source: 'git' as const,
	changedFiles: ['a.ts'],
	createdFiles: [],
	deletedFiles: [],
	branch: 'feat/x',
};

function autorunApi() {
	return window.maestro.autorun as unknown as {
		evidenceStart: ReturnType<typeof vi.fn>;
		evidenceEnd: ReturnType<typeof vi.fn>;
	};
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe('startRunEvidenceCapture', () => {
	it('returns the snapshot and passes the SSH remote through', async () => {
		autorunApi().evidenceStart.mockResolvedValueOnce({ success: true, snapshot });

		await expect(startRunEvidenceCapture('/repo', 'remote-1')).resolves.toBe(snapshot);
		expect(autorunApi().evidenceStart).toHaveBeenCalledWith('/repo', 'remote-1');
	});

	it('answers null on a failed reply or a rejected call, never throwing', async () => {
		autorunApi().evidenceStart.mockResolvedValueOnce({ success: false, error: 'boom' });
		await expect(startRunEvidenceCapture('/repo')).resolves.toBeNull();

		autorunApi().evidenceStart.mockRejectedValueOnce(new Error('bridge down'));
		await expect(startRunEvidenceCapture('/repo')).resolves.toBeNull();
	});
});

describe('finishRunEvidenceCapture', () => {
	it('returns the evidence, with the pull request the run opened', async () => {
		autorunApi().evidenceEnd.mockResolvedValue({ success: true, evidence });

		await expect(finishRunEvidenceCapture('/repo', snapshot, 'remote-1')).resolves.toEqual(
			evidence
		);
		expect(autorunApi().evidenceEnd).toHaveBeenCalledWith('/repo', snapshot, 'remote-1');
		await expect(
			finishRunEvidenceCapture('/repo', snapshot, undefined, 'https://github.com/o/r/pull/7')
		).resolves.toEqual({ ...evidence, prUrl: 'https://github.com/o/r/pull/7' });
	});

	it('answers null when there is no evidence, the reply failed, or the call rejected', async () => {
		autorunApi().evidenceEnd.mockResolvedValueOnce({ success: true, evidence: null });
		await expect(finishRunEvidenceCapture('/repo', snapshot)).resolves.toBeNull();

		autorunApi().evidenceEnd.mockResolvedValueOnce({ success: false, error: 'boom' });
		await expect(finishRunEvidenceCapture('/repo', snapshot)).resolves.toBeNull();

		autorunApi().evidenceEnd.mockRejectedValueOnce(new Error('bridge down'));
		await expect(finishRunEvidenceCapture('/repo', snapshot)).resolves.toBeNull();
	});
});
