/** Owned production-mode source adapter: real discovery, SQLite, authenticated WS and client. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
	requireBoardIsolation,
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
	async (input: { contract: BoardIsolation; env: NodeJS.ProcessEnv; mode: string }) => {
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
			const registered = [
				{ id: 'a', dir: alias, projectRoot: alias, boardWorker: true },
				{ id: 'foreign', dir: foreign },
			];
			configureBoardSourceHost(() => registered);
			await refreshBoardSources();
			const collection = storage.query().collections.find((c) => c.board.id === 'b')!;
			if (!collection) throw new Error('Canonical alias discovery did not import collection');
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
			if (['retarget-queue', 'replace-queue', 'cwd-queue', 'missing-queue'].includes(input.mode)) {
				background = enqueueBoardWrite(root, async () => {
					enter();
					await barrier;
				});
				await entered;
			}
			const before = snapshotSqlite(db);
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
			const reply = requestBoardCommand(client, command).then((r) => {
				settled = true;
				return r;
			});
			if (input.mode.endsWith('-queue')) {
				await admitted;
				// The final association proof returns, then admission/enqueue microtasks finish.
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (settled) throw new Error('Expected command pending behind the held canonical queue');
				if (input.mode === 'cwd-queue') {
					registered[0].dir = foreign;
					registered[0].projectRoot = foreign;
				} else {
					fs.renameSync(alias, alias + '.old');
					if (input.mode !== 'missing-queue')
						fs.symlinkSync(input.mode === 'retarget-queue' ? foreign : root, alias, 'junction');
				}
				release();
			}
			const result = await reply;
			const unchanged = canonicalJson(snapshotSqlite(db)) === canonicalJson(before);
			process.send?.({
				result,
				unchanged,
				foreignProbes: probes,
				backgroundPending: input.mode === 'barrier' && !backgroundDone,
				productionSourceAdapter: true,
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
