/** Source-attempt handoff. Git IO stays outside the write transaction; the exact
 * observed source outcome is checked again inside the atomic capture callback. */
import * as fs from 'node:fs';
import type {
	BoardCaptureCommand,
	BoardRunArtifact,
	BoardReviewHandoff,
	CardRun,
} from '../../shared/board/types';
import { canonicalJson } from '../../shared/canonicalJson';
import { execGitReadOnly } from '../utils/remote-git';
import {
	BoardStorageError,
	captureBoardCard,
	getBoardStorage,
	type BoardStorageFacade,
} from './board-storage';

/** No inferred commit, dirty checkout, detached branch or caller-reported SHA. */
export async function readBoardRunArtifact(cwd: string): Promise<BoardRunArtifact | null> {
	const git = await execGitReadOnly(['status', '--porcelain', '--untracked-files=normal'], cwd);
	if (git.exitCode !== 0 || git.stdout.trim()) return null;
	const head = await execGitReadOnly(['rev-parse', '--verify', 'HEAD^{commit}'], cwd);
	const branch = await execGitReadOnly(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
	if (head.exitCode !== 0 || branch.exitCode !== 0 || !/^[a-f0-9]{40}$/i.test(head.stdout.trim()))
		return null;
	return {
		worktreePath: fs.realpathSync(cwd),
		branch: branch.stdout.trim(),
		commit: head.stdout.trim(),
	};
}

export async function captureBoardCardFromHost(command: BoardCaptureCommand, human = false) {
	if (!command.reviewSource) return captureBoardCard(command, human);
	const request = command.reviewSource;
	if (
		!request ||
		typeof request.cardId !== 'string' ||
		!Number.isSafeInteger(request.attempt) ||
		request.attempt < 1
	)
		throw new BoardStorageError('invalid-input', 'Invalid review source attempt');
	const storage = getBoardStorage();
	const board = storage.read(command.projectRoot, command.boardId);
	const key = board.storage!;
	if (
		board.cards.some((card) => card.id === command.card.id) ||
		command.card.kind !== 'review' ||
		!command.card.parents.includes(request.cardId)
	)
		throw new BoardStorageError(
			'protected-field',
			'A review handoff requires a new dependent review card'
		);
	const source = storage.db
		.prepare(
			'SELECT run_id, outcome_json FROM runs WHERE collection_key=? AND card_id=? AND attempt=?'
		)
		.get(key.collectionKey, request.cardId, request.attempt) as
		| { run_id: string; outcome_json: string | null }
		| undefined;
	const outcome = source?.outcome_json ? JSON.parse(source.outcome_json) : null;
	const run = outcome?.cardOutcome?.run as CardRun | undefined;
	const specification = storage.db
		.prepare('SELECT specification_json FROM runs WHERE run_id=?')
		.get(source?.run_id ?? '') as { specification_json: string } | undefined;
	const spec = specification ? JSON.parse(specification.specification_json) : null;
	if (
		!source ||
		!run?.endedAt ||
		!['done', 'review'].includes(run.outcome ?? '') ||
		!run.artifact ||
		!run.summary?.trim() ||
		spec?.card.repositoryId !== command.card.repositoryId
	)
		throw new BoardStorageError(
			'invalid-input',
			'Review requires a completed source attempt with a clean artifact and reported checks'
		);
	if (spec?.repository?.location?.kind === 'ssh')
		throw new BoardStorageError(
			'legacy-mapping-missing',
			'Remote review artifact requires an explicit remote artifact adapter'
		);
	const artifact = await readBoardRunArtifact(run.artifact.worktreePath);
	if (!artifact || canonicalJson(artifact) !== canonicalJson(run.artifact))
		throw new BoardStorageError(
			'invalid-input',
			'Source artifact changed or has uncommitted changes'
		);
	const handoff: BoardReviewHandoff = {
		repositoryId: command.card.repositoryId!,
		sourceKey: key.sourceKey,
		collectionKey: key.collectionKey,
		cardId: request.cardId,
		runId: source.run_id,
		attempt: request.attempt,
		artifact,
		checks: run.summary,
	};
	return captureBoardCard(command, human, () => {
		const current = storage.db
			.prepare('SELECT outcome_json FROM runs WHERE run_id=?')
			.get(source.run_id) as { outcome_json: string } | undefined;
		if (current?.outcome_json !== source.outcome_json)
			throw new BoardStorageError(
				'stale-revision',
				'Source run changed while preparing the review'
			);
		const row = storage.db
			.prepare('SELECT payload_json FROM cards WHERE collection_key=? AND id=?')
			.get(key.collectionKey, command.card.id) as { payload_json: string };
		storage.db
			.prepare('UPDATE cards SET payload_json=? WHERE collection_key=? AND id=?')
			.run(
				canonicalJson({ ...JSON.parse(row.payload_json), reviewHandoff: handoff }),
				key.collectionKey,
				command.card.id
			);
	});
}

/** Recheck the bound attempt and checkout before each native claim/preparation. */
export async function prepareBoardReviewHandoff(
	storage: BoardStorageFacade,
	handoff: BoardReviewHandoff
): Promise<string | null> {
	if (!handoff?.artifact || typeof handoff.artifact.worktreePath !== 'string') return null;
	const row = storage.db
		.prepare(
			'SELECT specification_json, outcome_json FROM runs WHERE run_id=? AND collection_key=? AND card_id=? AND attempt=?'
		)
		.get(handoff.runId, handoff.collectionKey, handoff.cardId, handoff.attempt) as
		| { specification_json: string; outcome_json: string | null }
		| undefined;
	if (!row?.outcome_json) return null;
	const spec = JSON.parse(row.specification_json);
	if (spec.repository?.location?.kind === 'ssh') return null;
	const run = JSON.parse(row.outcome_json).cardOutcome?.run;
	if (
		spec.key?.sourceKey !== handoff.sourceKey ||
		spec.card?.repositoryId !== handoff.repositoryId ||
		!run?.artifact ||
		run.summary !== handoff.checks ||
		canonicalJson(run.artifact) !== canonicalJson(handoff.artifact)
	)
		return null;
	const artifact = await readBoardRunArtifact(handoff.artifact.worktreePath);
	return artifact && canonicalJson(artifact) === canonicalJson(handoff.artifact)
		? canonicalJson(handoff)
		: null;
}
