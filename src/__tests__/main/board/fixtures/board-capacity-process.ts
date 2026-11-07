/** An owned writer or a genuinely fresh native admission host, controlled only by test IPC. */
import { once } from 'node:events';
import { requireBoardIsolation, type BoardIsolation } from '../../../../main/board/board-isolation';
import { BACKGROUND_STOP_GRACE_MS } from '../../../../shared/maestro-lib/control/termination';
import { boardDbPath, openBoardDb } from '../../../../main/board/board-db';
import { readBoardWorkerCapacity } from '../../../../main/board/board-capacity-reader';
import { createBoardAgentAdmission } from '../../../../main/board/board-claims';
import { configureBoardFeatures } from '../../../../main/board/board-feature';
import {
	BoardStorageFacade,
	configureBoardStorage,
	getExistingBoardStorage,
} from '../../../../main/board/board-storage';
import {
	configureAgentAdmission,
	canStartAgentTurn,
	issueAgentTurnAdmission,
	revokeAgentTurnAdmission,
	createAdmittedCliTurnStarter,
} from '../../../../main/utils/headless-agent-activity';
import { startTurn } from '../../../../shared/maestro-lib/run/start-turn';

let db: ReturnType<typeof openBoardDb> | undefined;
let flags = { board: false, maestroCue: false };
let activations = 0;
const diagnostics: string[] = [];
const proofs = new Map<string, ReturnType<typeof issueAgentTurnAdmission>>();
configureBoardFeatures({ get: () => flags });
configureAgentAdmission(
	createBoardAgentAdmission(
		{ get: () => flags },
		() => {
			activations++;
			if (!getExistingBoardStorage())
				configureBoardStorage(new BoardStorageFacade(openBoardDb(boardDbPath())));
			return getExistingBoardStorage()!.db;
		},
		(error) => diagnostics.push(String(error)),
		() => getExistingBoardStorage()?.db,
		readBoardWorkerCapacity
	)
);
function hold(agentId: string, kind: string) {
	if (kind === 'migration')
		db!
			.prepare('INSERT OR REPLACE INTO migration_worker_holds VALUES (?, ?)')
			.run(agentId, '[{"unknown":true}]');
	else {
		db!.prepare('INSERT OR IGNORE INTO workers VALUES (?, 1, 0, ?)').run(agentId, '{}');
		db!
			.prepare('INSERT OR IGNORE INTO collections VALUES (?, ?, ?, ?, 0)')
			.run(agentId, 'fixture', agentId, '{}');
		db!.prepare('INSERT OR IGNORE INTO cards VALUES (?, ?, ?, 0)').run(agentId, 'card', '{}');
		db!
			.prepare(
				'INSERT OR IGNORE INTO runs (run_id, collection_key, card_id, attempt, specification_json, outcome_json) VALUES (?, ?, ?, 1, ?, NULL)'
			)
			.run(agentId, agentId, 'card', '{}');
		db!
			.prepare('INSERT OR REPLACE INTO reservations VALUES (?, ?, ?, ?, 1, 1, ?)')
			.run(agentId, agentId, 'card', agentId, 'uncertain');
	}
}
process.on(
	'message',
	async (input: {
		id: number;
		action: string;
		contract: BoardIsolation;
		flags?: typeof flags;
		worker?: string;
		kind?: string;
		journal?: string;
		version?: number;
	}) => {
		try {
			requireBoardIsolation({ expected: input.contract });
			if (input.flags) flags = input.flags;
			if (input.action === 'setup') {
				db = openBoardDb(boardDbPath());
				if (input.journal === 'DELETE') db.pragma('journal_mode=DELETE');
				if (input.worker) hold(input.worker, input.kind!);
				if (input.version !== undefined) db.pragma(`user_version=${input.version}`);
			} else if (input.action === 'hold') hold(input.worker!, input.kind!);
			else if (input.action === 'prepare')
				proofs.set(input.worker!, issueAgentTurnAdmission(input.worker!));
			else if (input.action === 'start') {
				const worker = input.worker!;
				const proof = proofs.get(worker) ?? issueAgentTurnAdmission(worker);
				let started = false;
				let output = '';
				let allowed = false;
				try {
					const nativeStart = createAdmittedCliTurnStarter(
						startTurn,
						{ originWorkerId: worker, workerAdmission: proof },
						false
					);
					const turn = nativeStart(
						{
							command: process.execPath,
							args: ['-e', 'process.stdout.write("ordinary child completed\\n")'],
							cwd: process.cwd(),
							env: process.env,
						},
						{
							onStarted: () => {
								started = true;
							},
							onStdout: (data) => {
								output += data;
							},
						},
						{ stopGraceMs: BACKGROUND_STOP_GRACE_MS }
					);
					const [code] = await once(turn.child, 'close');
					allowed = code === 0;
				} catch (error) {
					diagnostics.push(String(error));
				} finally {
					revokeAgentTurnAdmission(proof);
					proofs.delete(worker);
				}
				process.send!({
					id: input.id,
					allowed,
					started,
					output,
					activations,
					diagnostics: [...diagnostics],
					retained: !!getExistingBoardStorage(),
					runIdAllowed: canStartAgentTurn(worker, worker),
				});
				return;
			} else if (input.action === 'close') {
				db?.close();
				db = undefined;
				process.send!({ id: input.id, closed: true });
				process.disconnect();
				return;
			}
			process.send!({ id: input.id, ready: true, pid: process.pid });
		} catch (error) {
			process.send!({ id: input.id, error: String(error) });
		}
	}
);
