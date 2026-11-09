/** Owned production-mode source adapter: real discovery, SQLite, authenticated WS and client. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { applyBoardMigration, planBoardMigration } from '../../../../main/board/board-migration';
import {
	requireBoardIsolation,
	assertBoardIsolationPath,
	isBoardIsolationRequested,
	type BoardIsolation,
} from '../../../../main/board/board-isolation';
import { configureBoardFeatures } from '../../../../main/board/board-feature';
import { openBoardDb } from '../../../../main/board/board-db';
import {
	BoardStorageFacade,
	configureBoardStorage,
	configureBoardCaptureHost,
	enqueueBoardWrite,
} from '../../../../main/board/board-storage';
import {
	configureBoardSourceHost,
	refreshBoardSources,
} from '../../../../main/board/board-source-host';
import type { BoardSourceSession } from '../../../../main/board/board-source-core';
import { listBoardWorkers } from '../../../../main/board/board-workspace-storage';
import { executeBoardCommand } from '../../../../main/board/board-command-host';
import { createMaestroRuntime } from '../../../../shared/maestro-lib/runtime';
import { startRuntimeServer } from '../../../../shared/maestro-lib/runtime/server';
import { BridgeConnection } from '../../../../shared/maestro-lib/client/bridge-connection';
import { requestBoardCommand } from '../../../../shared/maestro-lib/client/board';
import { BOARD_SOURCE_PROJECT_PREFIX } from '../../../../shared/board/types';
import { canonicalJson } from '../../../../shared/canonicalJson';
import { snapshotSqlite } from '../../../helpers/sqliteSnapshot';

process.once(
	'message',
	async (input: {
		contract: BoardIsolation;
		env: NodeJS.ProcessEnv;
		mode: string;
		cliBundle?: string;
	}) => {
		let db: ReturnType<typeof openBoardDb> | undefined;
		let server: Awaited<ReturnType<typeof startRuntimeServer>> | undefined;
		let client: BridgeConnection | undefined;
		let release = () => {};
		let background: Promise<unknown> | undefined;
		let backgroundDone = false;
		const realpath = fs.promises.realpath.bind(fs.promises);
		try {
			// Verify independent parent's owned paths without installing a test adapter in this process.
			const contract = requireBoardIsolation({ env: input.env, expected: input.contract });
			if (isBoardIsolationRequested())
				throw new Error('Alias case must exercise production source admission');
			const root = path.join(contract.sourceRoot, 'physical'),
				alias = path.join(contract.sourceRoot, 'alias'),
				foreign = path.join(contract.sourceRoot, 'foreign');
			fs.mkdirSync(path.join(root, '.maestro'), { recursive: true });
			fs.mkdirSync(foreign, { recursive: true });
			execFileSync('git', ['init', '--quiet', root]);
			execFileSync('git', ['init', '--quiet', foreign]);
			fs.symlinkSync(root, alias, 'junction');
			fs.writeFileSync(
				path.join(root, '.maestro', 'board.yaml'),
				JSON.stringify({
					boards: [
						{
							id: 'b',
							name: 'Board',
							cards: [
								{
									id: 'c',
									title: 'Card',
									body: '',
									status: 'todo',
									parents: [],
									createdAt: '2026-01-01T00:00:00.000Z',
									updatedAt: '2026-01-01T00:00:00.000Z',
								},
							],
						},
					],
				})
			);
			configureBoardFeatures({ get: () => ({ board: true, maestroCue: true }) });
			db = openBoardDb(contract.db);
			const storage = new BoardStorageFacade(db);
			configureBoardStorage(storage);
			configureBoardCaptureHost(() => ({ agents: [{ id: 'a' }], groups: [] }));
			const registered: BoardSourceSession[] = [
				{ id: 'a', dir: alias, projectRoot: alias, boardWorker: true },
				{ id: 'foreign', dir: foreign },
			];
			configureBoardSourceHost(() =>
				input.mode.startsWith('retained-ssh-cli-') ? [] : registered
			);
			await refreshBoardSources();
			if (input.mode.startsWith('retained-ssh-cli-')) {
				applyBoardMigration(
					db,
					planBoardMigration({
						source: {
							location: { kind: 'ssh', remoteId: 'fixture-remote' },
							path: '/retained/Repo',
						},
						repository: {
							id: 'retained-repo',
							workingDirectory: '/retained/Repo',
							validated: true,
							location: { kind: 'ssh', remoteId: 'fixture-remote' },
						},
						boardBytes: Buffer.from(
							JSON.stringify({ boards: [{ id: 'b', name: 'Remote board', cards: [] }] })
						),
						profileBytes: null,
						workers: [],
					})
				);
			}
			const collection = storage.query().collections.find((c) => c.board.id === 'b')!;
			if (!collection) throw new Error('Canonical alias discovery did not import collection');
			if (input.mode.startsWith('orphan-')) {
				// Central data survives a closed project; no completed import is required.
				db.prepare('INSERT OR IGNORE INTO board_sources(source_key) VALUES (?)').run(
					collection.sourceKey
				);
				db.prepare('DELETE FROM migration_blockers WHERE source_key=?').run(collection.sourceKey);
				db.prepare('DELETE FROM migrations WHERE source_key=?').run(collection.sourceKey);
				registered.splice(0, 1);
				fs.unlinkSync(alias);
				fs.rmSync(root, { recursive: true });
			}

			const currentChange = input.mode.match(
				/current-(ssh|invalid|no-root)-(present|await|queue)$/
			);
			const relatedWorkerBound = listBoardWorkers(db).some(
				(worker) =>
					worker.agentId === 'a' &&
					Array.isArray(worker.payload.allowedRepositoryIds) &&
					worker.payload.allowedRepositoryIds.includes(`source:${collection.sourceKey}`)
			);
			if (currentChange && !relatedWorkerBound)
				throw new Error('Current registration case requires the canonical source-bound worker');
			const changeCurrentRegistration = () => {
				let item = registered.find((item) => item.id === 'a');
				if (!item) {
					item = { id: 'a', dir: root, projectRoot: root, boardWorker: true };
					registered.push(item);
				}
				if (currentChange![1] === 'no-root') {
					delete item.dir;
					delete item.projectRoot;
				} else {
					item.sshRemoteId = 'changed-remote';
					if (currentChange![1] === 'invalid')
						item.sessionSshRemoteConfig = { enabled: true, remoteId: 'conflicting-remote' };
				}
			};
			if (currentChange?.[2] === 'present') changeCurrentRegistration();

			const started = await createMaestroRuntime({
				dataDir: contract.userData,
				mode: 'host',
				deps: { watchDirectory: () => ({ close() {} }) },
			});
			if (!started.ok) throw new Error(started.refusal.message);
			server = await startRuntimeServer({
				runtime: started.runtime,
				token: 'alias-fixture',
				cliSecret: 'owned-alias-secret',
				boardHost: executeBoardCommand,
				onStopRequested() {},
			});
			if (input.mode.startsWith('retained-ssh-cli-') || input.mode === 'orphan-cli') {
				if (!input.cliBundle) throw new Error('CLI bundle must be parent-owned');
				assertBoardIsolationPath(contract, input.cliBundle);
				fs.writeFileSync(
					path.join(contract.userData, 'cli-server.json'),
					JSON.stringify({
						pid: process.pid,
						port: server.port,
						token: 'alias-fixture',
						cliSecret: 'owned-alias-secret',
						startedAt: Date.now(),
						version: 'fixture',
						hostKind: 'headless',
					})
				);
				const sessionsFile = path.join(contract.sync, 'maestro-sessions.json');
				fs.writeFileSync(
					sessionsFile,
					JSON.stringify({
						sessions: [
							{
								id: 'remote-agent',
								name: 'Remote fixture',
								toolType: 'codex',
								projectRoot: '/retained/Repo',
								cwd: '/retained/Repo',
								sessionSshRemoteConfig: { enabled: true, remoteId: 'fixture-remote' },
							},
						],
					})
				);
				const run = async (...args: string[]) =>
					JSON.parse(
						(
							await promisify(execFile)(
								process.execPath,
								[input.cliBundle!, 'board', ...args, '--json'],
								{ env: process.env }
							)
						).stdout
					);
				const operation = input.mode.slice('retained-ssh-cli-'.length);
				const cliBefore = snapshotSqlite(db);
				let response;
				if (input.mode === 'orphan-cli') {
					fs.writeFileSync(sessionsFile, JSON.stringify({ sessions: [] }));
					response = await run(
						'remove-cards',
						'--source',
						collection.sourceKey,
						'--collection',
						collection.collectionKey,
						'--revision',
						String(collection.revision),
						'--cards',
						JSON.stringify([
							{ cardId: 'c', cardRevision: collection.board.cards[0].storageRevision! },
						])
					);
				} else if (operation === 'closed') {
					fs.writeFileSync(sessionsFile, JSON.stringify({ sessions: [] }));
					response = await run(
						'rename',
						'b',
						'Closed source edit',
						'--source',
						collection.sourceKey
					);
				} else if (operation === 'rename')
					response = await run('rename', 'b', 'Renamed remote', '--agent', 'remote-agent');
				else response = await run(operation, '--agent', 'remote-agent');
				const cliAfter = snapshotSqlite(db);
				process.send?.({
					changedTables: Object.keys(cliAfter).filter(
						(name) => cliAfter[name].sha256 !== cliBefore[name].sha256
					),
					actualCli: true,
					operation,
					deleted: input.mode === 'orphan-cli' ? response.cards : undefined,
					archives:
						input.mode === 'orphan-cli'
							? db.prepare('SELECT count(*) AS n FROM card_archives').get()
							: undefined,
					listed: operation === 'list' ? response.map((b: { id: string }) => b.id) : undefined,
					replyType: response.type,
					name: storage.read(BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey, 'b').name,
				});
				return;
			}
			client = new BridgeConnection({
				endpoint: { port: server.port, token: 'alias-fixture', cliSecret: 'owned-alias-secret' },
				strictReplies: true,
			});
			await client.connect();
			const command = {
				action: 'delete-cards' as const,
				target: {
					projectRoot: BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey,
					sourceKey: collection.sourceKey,
					collectionKey: collection.collectionKey,
					expectedRevision: collection.revision,
				},
				cards: [{ cardId: 'c', cardRevision: collection.board.cards[0].storageRevision! }],
			};

			if (input.mode === 'orphan-no-namespace')
				db.prepare('DELETE FROM board_sources WHERE source_key=?').run(collection.sourceKey);
			if (input.mode === 'orphan-stale') command.target.expectedRevision++;
			if (input.mode === 'orphan-stale-card') command.cards[0].cardRevision++;
			if (input.mode === 'orphan-unknown') {
				command.target.sourceKey = 'f'.repeat(64);
				command.target.projectRoot = BOARD_SOURCE_PROJECT_PREFIX + command.target.sourceKey;
			}
			if (input.mode === 'orphan-crosscollection')
				command.target.collectionKey = 'foreign-collection';
			if (input.mode === 'orphan-physical') command.target.projectRoot = root;
			if (input.mode === 'orphan-suppressed')
				db.prepare('INSERT INTO board_source_suppressions(source_key) VALUES (?)').run(
					collection.sourceKey
				);
			if (input.mode === 'orphan-malformed-source')
				db.prepare(
					"UPDATE board_source_locations SET payload_json=json_set(payload_json,'$.path',?) WHERE source_key=?"
				).run(foreign, collection.sourceKey);
			if (input.mode === 'orphan-running')
				db.prepare(
					"UPDATE cards SET payload_json=json_set(payload_json,'$.status','running') WHERE collection_key=?"
				).run(collection.collectionKey);
			if (input.mode === 'orphan-reservation') {
				db.prepare("INSERT INTO workers VALUES ('held',1,0,'{}')").run();
				db.prepare(
					"INSERT INTO runs(run_id,collection_key,card_id,attempt,specification_json,outcome_json) VALUES ('attempt',?,'c',1,'{}',NULL)"
				).run(collection.collectionKey);
				db.prepare("INSERT INTO reservations VALUES ('held',?,'c','attempt',1,1,'unknown')").run(
					collection.collectionKey
				);
			}

			if (input.mode === 'orphan-linked-review' || input.mode === 'orphan-dag') {
				const put = (id: string, extra: object) =>
					db!
						.prepare('INSERT INTO cards(collection_key,id,payload_json,revision) VALUES (?,?,?,0)')
						.run(
							collection.collectionKey,
							id,
							JSON.stringify({ ...collection.board.cards[0], id, ...extra })
						);
				if (input.mode === 'orphan-linked-review')
					put('parent', {
						status: 'review',
						workflow: { version: 1, corrections: 0, reviewCardId: 'c' },
					});
				else {
					put('g', { parents: [] });
					put('d', { parents: ['c'] });
					put('unrelated', { parents: [] });
					db.prepare(
						"UPDATE cards SET payload_json=json_set(payload_json,'$.parents',json('[\"g\"]')) WHERE collection_key=? AND id='c'"
					).run(collection.collectionKey);
				}
			}
			if (input.mode.startsWith('orphan-off-'))
				configureBoardFeatures({
					get: () => ({
						board: input.mode === 'orphan-off-cue',
						maestroCue: input.mode === 'orphan-off-board',
					}),
				});
			let changed = false;
			let enter!: () => void;
			const entered = new Promise<void>((r) => {
				enter = r;
			});
			const barrier = new Promise<void>((r) => {
				release = r;
			});
			let probes = 0;
			// Pass-through filesystem dependency instrumentation; no production guard replacement.
			fs.promises.realpath = new Proxy(realpath, {
				async apply(original, receiver, args) {
					const result = await Reflect.apply(original, receiver, args);
					if (args[0] === foreign) {
						probes++;
						enter();
						await barrier;
					}
					if (args[0] === alias && currentChange?.[2] === 'await' && !changed) {
						changed = true;
						changeCurrentRegistration();
					}
					if (args[0] === alias && input.mode === 'retarget-await' && !changed) {
						changed = true;
						fs.unlinkSync(alias);
						fs.symlinkSync(foreign, alias, 'junction');
					}
					return result;
				},
			});
			if (input.mode === 'barrier') {
				background = refreshBoardSources().finally(() => {
					backgroundDone = true;
				});
				await entered;
			}
			if (
				['retarget-queue', 'replace-queue', 'cwd-queue', 'missing-queue'].includes(input.mode) ||
				input.mode.startsWith('orphan-queue-') ||
				currentChange?.[2] === 'queue'
			) {
				background = enqueueBoardWrite(
					input.mode.startsWith('orphan-')
						? BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey
						: root,
					async () => {
						enter();
						await barrier;
					}
				);
				await entered;
			}
			let before = snapshotSqlite(db);
			let admissionReady!: () => void;
			const admitted = new Promise<void>((r) => {
				admissionReady = r;
			});
			let collectionProofs = 0;
			const readCollection = storage.workspace.readCollection.bind(storage.workspace);
			storage.workspace.readCollection = (...args) => {
				const result = readCollection(...args);
				// The second revision check is the final synchronous step of target admission.
				if (++collectionProofs === 2) admissionReady();
				return result;
			};
			let settled = false;
			const request =
				input.mode === 'orphan-forged-human'
					? { ...command, human: true }
					: input.mode === 'orphan-foreign-actor'
						? { ...command, actor: { agentId: 'foreign' } }
						: input.mode === 'orphan-rename'
							? { action: 'rename' as const, target: command.target, name: 'Must remain unchanged' }
							: command;
			const reply = requestBoardCommand(client, request).then((r) => {
				settled = true;
				return r;
			});
			if (input.mode.endsWith('-queue') || input.mode.startsWith('orphan-queue-')) {
				await admitted;
				// The final association proof returns, then admission/enqueue microtasks finish.
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (settled) throw new Error('Expected command pending behind the held canonical queue');
				if (currentChange?.[2] === 'queue') {
					changeCurrentRegistration();
				} else if (input.mode === 'orphan-queue-source') {
					db.prepare(
						"UPDATE board_source_locations SET payload_json=payload_json || ' ' WHERE source_key=?"
					).run(collection.sourceKey);
				} else if (input.mode === 'orphan-queue-registration') {
					registered.push({ id: 'a', dir: root, projectRoot: root, boardWorker: true });
				} else if (input.mode === 'orphan-queue-suppression') {
					db.prepare('INSERT INTO board_source_suppressions(source_key) VALUES (?)').run(
						collection.sourceKey
					);
				} else if (input.mode === 'orphan-queue-new-card') {
					db.prepare(
						'INSERT INTO cards(collection_key,id,payload_json,revision) VALUES (?,?,?,0)'
					).run(
						collection.collectionKey,
						'new-card',
						JSON.stringify({ ...collection.board.cards[0], id: 'new-card' })
					);
					db.prepare('UPDATE collections SET revision=revision+1 WHERE collection_key=?').run(
						collection.collectionKey
					);
				} else if (input.mode === 'orphan-queue-revision') {
					db.prepare('UPDATE collections SET revision=revision+1 WHERE collection_key=?').run(
						collection.collectionKey
					);
				} else if (input.mode === 'cwd-queue') {
					registered[0].dir = foreign;
					registered[0].projectRoot = foreign;
				} else {
					fs.renameSync(alias, alias + '.old');
					if (input.mode !== 'missing-queue')
						fs.symlinkSync(input.mode === 'retarget-queue' ? foreign : root, alias, 'junction');
				}
				if (input.mode.startsWith('orphan-queue-')) before = snapshotSqlite(db);
				release();
			}
			const result = await reply;
			const after = snapshotSqlite(db);
			const unchanged = canonicalJson(after) === canonicalJson(before);
			process.send?.({
				result,
				unchanged,
				changedTables: Object.keys(after).filter(
					(name) => after[name].sha256 !== before[name].sha256
				),
				foreignProbes: probes,
				backgroundPending: input.mode === 'barrier' && !backgroundDone,
				productionSourceAdapter: true,
				relatedWorkerBound,
				dag:
					input.mode === 'orphan-dag'
						? storage
								.read(BOARD_SOURCE_PROJECT_PREFIX + collection.sourceKey, 'b')
								.cards.map((c) => ({ id: c.id, parents: c.parents }))
						: undefined,
				orphanProof: input.mode.startsWith('orphan-')
					? {
							folderAbsent: !fs.existsSync(root),
							ledgerAbsent: !db
								.prepare('SELECT 1 FROM migrations WHERE source_key=?')
								.get(collection.sourceKey),
							archives: db.prepare('SELECT count(*) AS n FROM card_archives').get(),
							cards: storage.workspace
								.readCollection(collection)!
								.cards.filter((card) => !card.archived).length,
						}
					: undefined,
			});
		} catch (e) {
			process.send?.({ error: e instanceof Error ? e.stack : String(e) });
			process.exitCode = 1;
		} finally {
			release();
			await background?.catch(() => {});
			fs.promises.realpath = realpath;
			client?.disconnect();
			await server?.close();
			db?.close();
			process.disconnect?.();
		}
	}
);
