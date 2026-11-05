import type { PluginEvent } from '../../shared/plugins/events';
import type { CardNotification, CardStatusChange } from './board-dispatcher';
import { buildBoardCardToastPayload, type BoardCardToastPayload } from './board-toast';
import type { BoardTransitionReceipt } from './board-transitions';
import { BOARD_SOURCE_PROJECT_PREFIX } from '../../shared/board/types';

export function createBoardNotificationHandlers(
	emit: (event: PluginEvent) => void,
	toast: (payload: BoardCardToastPayload) => void
) {
	const notifyBoardCard = (projectRoot: string, event: CardNotification) => {
		const blocked = event.kind === 'blocked';
		// Board Phase 5: the same terminal transition is republished on the
		// plugin event bus so OTHER plugins can build on the Board. Metadata
		// only - the toast below carries the run summary, the event never
		// does (summaries can quote agent output).
		const common = {
			boardId: event.boardId,
			cardId: event.cardId,
			cardTitle: event.cardTitle,
			projectPath: projectRoot,
			...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
			...(event.workerAgentId ? { workerAgentId: event.workerAgentId } : {}),
		};
		const at = new Date().toISOString();
		if (blocked) {
			emit({
				topic: 'board.cardBlocked',
				at,
				payload: { ...common, ...(event.outcome ? { outcome: event.outcome } : {}) },
			});
		} else if (event.kind === 'done') {
			// Deliberately no plugin event for `review`: a card awaiting human
			// approval is neither completed nor blocked, and there is no
			// `board.cardNeedsReview` topic yet, so emitting either existing topic
			// would lie to plugins. That transition stays toast-only for now.
			emit({
				topic: 'board.cardCompleted',
				at,
				payload: {
					...common,
					...(event.worktreeBranch ? { worktreeBranch: event.worktreeBranch } : {}),
				},
			});
		}
		// The done/review/blocked toast (including its pooled click-to-jump onto the
		// worker agent) is built by the pure `buildBoardCardToastPayload` helper
		// so the exact payload can be unit-tested without importing this module.
		toast(buildBoardCardToastPayload(event));
	};
	const onBoardCardStatusChanged = (projectRoot: string, event: CardStatusChange) =>
		emit({
			topic: 'board.cardStatusChanged',
			at: new Date().toISOString(),
			payload: {
				boardId: event.boardId,
				cardId: event.cardId,
				cardTitle: event.cardTitle,
				fromStatus: event.fromStatus,
				toStatus: event.toStatus,
				projectPath: projectRoot,
				...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
				...(event.workerAgentId ? { workerAgentId: event.workerAgentId } : {}),
			},
		});
	const onTransitions = (receipts: readonly BoardTransitionReceipt[]) => {
		for (const receipt of receipts) {
			const projectRoot = BOARD_SOURCE_PROJECT_PREFIX + receipt.key.sourceKey;
			onBoardCardStatusChanged(projectRoot, receipt.change);
			if (receipt.notification) notifyBoardCard(projectRoot, receipt.notification);
		}
	};
	return { notifyBoardCard, onBoardCardStatusChanged, onTransitions };
}
