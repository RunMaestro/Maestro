/** Shared read-only fence for review queueing, claim, completion and human acceptance. */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { canonicalJson } from '../../shared/canonicalJson';
import type { BoardReviewHandoff } from '../../shared/board/types';

export function boardReviewSourceDigest(
	db: Database.Database,
	handoff: Pick<
		BoardReviewHandoff,
		'runId' | 'collectionKey' | 'cardId' | 'attempt' | 'sourceKey' | 'repositoryId'
	>,
	reviewerAgentId: string
): string | null {
	const row = db
		.prepare(
			'SELECT specification_json, lifecycle_json, outcome_json FROM runs WHERE run_id=? AND collection_key=? AND card_id=? AND attempt=?'
		)
		.get(handoff.runId, handoff.collectionKey, handoff.cardId, handoff.attempt) as
		| { specification_json: string; lifecycle_json: string | null; outcome_json: string | null }
		| undefined;
	if (!row?.outcome_json || !row.lifecycle_json) return null;
	const specification = JSON.parse(row.specification_json);
	const lifecycle = JSON.parse(row.lifecycle_json);
	const outcome = JSON.parse(row.outcome_json);
	const run = outcome.cardOutcome?.run;
	if (
		specification.key?.sourceKey !== handoff.sourceKey ||
		specification.key?.collectionKey !== handoff.collectionKey ||
		specification.key?.cardId !== handoff.cardId ||
		specification.card?.repositoryId !== handoff.repositoryId ||
		specification.runToken?.runId !== handoff.runId ||
		specification.attempt !== handoff.attempt ||
		run?.runId !== handoff.runId ||
		run?.attempt !== handoff.attempt ||
		run?.workerAgentId !== specification.workerAgentId ||
		!run?.endedAt ||
		!['done', 'review'].includes(run.outcome ?? '') ||
		!reviewerAgentId ||
		!specification.workerAgentId ||
		specification.workerAgentId === reviewerAgentId ||
		lifecycle.phase !== 'finished' ||
		!lifecycle.launchAuthorized ||
		lifecycle.process?.cueRunId !== handoff.runId ||
		outcome.result?.executionStarted !== true ||
		outcome.result?.terminationConfirmed !== true ||
		typeof specification.card?.body !== 'string' ||
		typeof outcome.result?.output !== 'string' ||
		outcome.result?.exitCode !== 0 ||
		outcome.result?.error
	)
		return null;
	return createHash('sha256').update(canonicalJson({ specification, outcome })).digest('hex');
}
