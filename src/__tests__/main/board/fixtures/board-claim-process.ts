/** Source-owned subprocess fixture: each process opens the SAME real SQLite DB.
 * Parent IPC is only a start barrier, never a substitute for SQLite locking. */
import { openBoardDb } from '../../../../main/board/board-db';
import { BoardWorkspaceStorage } from '../../../../main/board/board-workspace-storage';
import {
	claimBoardCard,
	type BoardClaimCommand,
	type BoardClaimHostContext,
} from '../../../../main/board/board-claims';
import type { BoardCaptureCatalog } from '../../../../shared/board/types';

process.once(
	'message',
	(input: {
		file: string;
		command: BoardClaimCommand;
		host: BoardClaimHostContext & { catalog: BoardCaptureCatalog };
	}) => {
		const db = openBoardDb(input.file);
		process.send!({ ready: true, pid: process.pid });
		process.once('message', () => {
			try {
				let result = claimBoardCard(db, input.command, () => input.host);
				// Model a bounded read/prepare retry after another writer's commit.
				if (!result.ok && result.reason === 'stale-revision') {
					const workspace = new BoardWorkspaceStorage(db);
					const collection = workspace.readCollection(input.command)!;
					input.command.readRevision = {
						workspace: workspace.readWorkspace().revision,
						collection: collection.revision,
						card: collection.cards.find((card) => card.cardId === input.command.cardId)!.revision,
						registry: input.host.registryRevision,
					};
					result = claimBoardCard(db, input.command, () => input.host);
				}
				process.send!({ result, pid: process.pid });
			} catch (error) {
				process.send!({ error: String(error), pid: process.pid });
				process.exitCode = 1;
			} finally {
				db.close();
				process.disconnect();
			}
		});
	}
);
