/** Real-process bootstrap race, sharing only a SQLite filename and a start barrier. */
import { openBoardDb } from '../../../../main/board/board-db';
import { BoardStorageFacade } from '../../../../main/board/board-storage';
import { requireBoardIsolation, type BoardIsolation } from '../../../../main/board/board-isolation';
import {
	applyBoardMigration,
	type BoardMigrationPlan,
} from '../../../../main/board/board-migration';

process.once(
	'message',
	(input: { file: string; plan?: BoardMigrationPlan; contract: BoardIsolation }) => {
		if (!input.contract) throw new Error('Board isolation requires the parent contract');
		requireBoardIsolation({ expected: input.contract });
		const db = openBoardDb(input.file);
		process.send!({ ready: true, pid: process.pid });
		process.once('message', () => {
			try {
				process.send!({
					...(input.plan
						? { migration: applyBoardMigration(db, input.plan) }
						: { board: new BoardStorageFacade(db).ensureGlobalBoard() }),
					pid: process.pid,
				});
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
