/**
 * The desktop's side of a playbook run's disk evidence (tier B of the run report): snapshot the
 * agent's folder when the run starts, diff it when the run ends. The work happens in the main
 * process (`autorun:evidenceStart` / `autorun:evidenceEnd`, `src/main/services/run-evidence.ts`);
 * the CLI engine calls the same service through its environment port, so both report one shape.
 *
 * Evidence is never allowed to cost a run: both calls answer `null` instead of rejecting, and the
 * caller carries on without a "Files changed" section.
 */

import type { DiskEvidence } from '../../shared/playbookRunReport';
import type { RunEvidenceSnapshot } from '../../shared/runEvidence';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'RunEvidence';

/** Snapshot `cwd` (on the agent's SSH remote when it has one) at run start. */
export async function startRunEvidenceCapture(
	cwd: string,
	sshRemoteId?: string
): Promise<RunEvidenceSnapshot | null> {
	try {
		const reply = await window.maestro.autorun.evidenceStart(cwd, sshRemoteId);
		if (!reply.success) {
			logger.warn('Start snapshot failed', LOG_CONTEXT, { cwd, error: reply.error });
			return null;
		}
		return reply.snapshot ?? null;
	} catch (error) {
		logger.warn('Start snapshot failed', LOG_CONTEXT, { cwd, error });
		return null;
	}
}

/**
 * Diff `cwd` against the start snapshot at run end. `prUrl` is the pull request the run opened,
 * when it opened one.
 */
export async function finishRunEvidenceCapture(
	cwd: string,
	snapshot: RunEvidenceSnapshot,
	sshRemoteId?: string,
	prUrl?: string
): Promise<DiskEvidence | null> {
	try {
		const reply = await window.maestro.autorun.evidenceEnd(cwd, snapshot, sshRemoteId);
		if (!reply.success || !reply.evidence) {
			if (!reply.success) {
				logger.warn('End snapshot failed', LOG_CONTEXT, { cwd, error: reply.error });
			}
			return null;
		}
		return prUrl ? { ...reply.evidence, prUrl } : reply.evidence;
	} catch (error) {
		logger.warn('End snapshot failed', LOG_CONTEXT, { cwd, error });
		return null;
	}
}
