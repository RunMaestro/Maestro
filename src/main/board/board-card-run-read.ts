/** Read display-only attempt data from one fenced central snapshot, without discovery or runtime acquisition. */
import type { BoardCardRunRead, BoardCardRunView } from '../../shared/board/commands';
import { getExistingBoardStorage, BoardStorageError } from './board-storage';

export function readBoardCardRun(command: BoardCardRunRead): BoardCardRunView {
	const storage = getExistingBoardStorage();
	if (!storage) throw new BoardStorageError('not-found', 'Board data is not open');
	return storage.db.transaction(() => {
		const collection = storage.workspace.readCollection(command.target);
		const card = collection?.cards.find((entry) => entry.cardId === command.cardId);
		if (
			!collection ||
			collection.archived ||
			!card ||
			card.archived ||
			storage.db
				.prepare('SELECT 1 FROM board_source_suppressions WHERE source_key=?')
				.get(command.target.sourceKey)
		)
			throw new BoardStorageError('not-found', 'Board card is unavailable');
		if (
			collection.revision !== command.target.expectedRevision ||
			card.revision !== command.cardRevision
		)
			throw new BoardStorageError('stale-revision', 'Board card changed; reopen its details');
		const row = storage.db
			.prepare(
				'SELECT attempt, specification_json, lifecycle_json, outcome_json FROM runs WHERE run_id=? AND collection_key=? AND card_id=?'
			)
			.get(command.runId, command.target.collectionKey, command.cardId) as
			| {
					attempt: number;
					specification_json: string;
					lifecycle_json: string | null;
					outcome_json: string | null;
			  }
			| undefined;
		if (!row) throw new BoardStorageError('not-found', 'Board attempt is unavailable');
		const spec = JSON.parse(row.specification_json);
		// Do not expose run tokens, launch overrides, host proofs or arbitrary metadata.
		if (
			spec.key?.sourceKey !== command.target.sourceKey ||
			spec.key?.collectionKey !== command.target.collectionKey ||
			spec.key?.cardId !== command.cardId ||
			spec.attempt !== row.attempt
		)
			throw new BoardStorageError('identity-mismatch', 'Board attempt identity changed');
		const outcome = row.outcome_json ? JSON.parse(row.outcome_json) : null;
		const lifecycle = row.lifecycle_json ? JSON.parse(row.lifecycle_json) : null;
		const phase = lifecycle?.phase;
		const result = outcome?.result ?? lifecycle?.pendingResult;
		return {
			runId: command.runId,
			attempt: row.attempt,
			instructions: typeof spec.card?.body === 'string' ? spec.card.body : null,
			output: typeof result?.output === 'string' ? result.output : null,
			phase: ['prepared', 'starting', 'running', 'stopping', 'uncertain', 'finished'].includes(
				phase
			)
				? phase
				: null,
			exitCode: typeof result?.exitCode === 'number' ? result.exitCode : null,
		};
	})();
}
