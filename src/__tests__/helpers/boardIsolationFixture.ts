/**
 * Explicit, test-only Board storage. No environment changes until install().
 *
 * Use one installed fixture per Vitest file/fork, before the first Board store
 * access. Product admission retains that process's contract; cleanup deliberately
 * does not reset it. Independent fixtures/negative cases use their explicit env,
 * and children receive both env and the separately supplied parent contract.
 *
 * await fixture.cleanup(async () => { db.close(); await stopOwnedChildren(); });
 * Close all resources before cleanup returns storage to the filesystem.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	boardIsolationChildEnv,
	readBoardIsolationRegistries,
	requireBoardIsolation,
} from '../../main/board/board-isolation';
import { canonicalJson } from '../../shared/canonicalJson';
import { BOOTSTRAP_STORE_FILE } from '../../shared/syncPath';

export function createBoardIsolationFixture(options: { syncInUserData?: boolean } = {}) {
	const worktree = fs.realpathSync.native(path.resolve(__dirname, '../../..'));
	const isolated = path.join(worktree, 'isolated');
	fs.mkdirSync(isolated, { recursive: true, mode: 0o700 });
	if (fs.lstatSync(isolated).isSymbolicLink() || fs.realpathSync.native(isolated) !== isolated)
		throw new Error('Board test fixtures require a canonical isolated directory');
	const root = fs.mkdtempSync(path.join(isolated, 'board-test-'));
	const owned = fs.lstatSync(root);
	try {
		const userData = path.join(root, 'userData');
		// Shared E2E suites seed stores through one testDataDir; keep that layout
		// inside the same admitted child contract when explicitly requested.
		const sync = options.syncInUserData ? userData : path.join(root, 'sync');
		const sourceRoot = path.join(root, 'sources');
		const sources = Object.freeze({
			one: path.join(sourceRoot, 'one'),
			two: path.join(sourceRoot, 'two'),
		});
		for (const dir of [userData, sync, ...Object.values(sources)])
			fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const agentRegistry = path.join(root, 'agents.json');
		const sourceRegistry = path.join(root, 'sources.json');
		fs.writeFileSync(agentRegistry, canonicalJson({ sessions: [] }), { mode: 0o600 });
		fs.writeFileSync(
			sourceRegistry,
			canonicalJson({
				sources: Object.entries(sources).map(([id, root]) => ({ id, root })),
			}),
			{ mode: 0o600 }
		);
		fs.writeFileSync(
			path.join(userData, BOOTSTRAP_STORE_FILE),
			canonicalJson({ customSyncPath: sync }),
			{ mode: 0o600 }
		);

		// Never reuse inherited fixture/transport/evidence paths or redirect HOME.
		const explicit: NodeJS.ProcessEnv = { ...process.env };
		for (const key of Object.keys(explicit)) if (key.startsWith('BOARD_')) delete explicit[key];
		delete explicit.MAESTRO_DEMO_DIR;
		delete explicit.MAESTRO_DATA_DIR;
		Object.assign(explicit, {
			BOARD_ISOLATION_ID: path.basename(root),
			BOARD_ISOLATED_ROOT: root,
			BOARD_DB_PATH: path.join(root, 'board.sqlite'),
			MAESTRO_USER_DATA: userData,
			BOARD_SYNC_PATH: sync,
			BOARD_AGENT_REGISTRY: agentRegistry,
			BOARD_SOURCE_REGISTRY: sourceRegistry,
			BOARD_SOURCE_ROOT: sourceRoot,
		});
		const contract = requireBoardIsolation({ env: explicit, worktree });
		const env = Object.freeze(boardIsolationChildEnv(contract, explicit));
		readBoardIsolationRegistries(contract, env);

		let disposed = false;
		let saved: Map<string, string | undefined> | undefined;
		const restoreEnvironment = () => {
			for (const [key, value] of saved ?? []) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			saved = undefined;
		};
		return Object.freeze({
			contract,
			env,
			sources,
			install() {
				if (disposed) throw new Error('Board test fixture already disposed');
				if (saved) return;
				requireBoardIsolation({ env, expected: contract });
				const keys = new Set([
					...Object.keys(process.env).filter((key) => key.startsWith('BOARD_')),
					...Object.keys(env).filter((key) => key.startsWith('BOARD_')),
					'MAESTRO_USER_DATA',
					'MAESTRO_DEMO_DIR',
					'MAESTRO_DATA_DIR',
				]);
				saved = new Map([...keys].map((key) => [key, process.env[key]]));
				try {
					for (const key of keys) {
						if (env[key] === undefined) delete process.env[key];
						else process.env[key] = env[key];
					}
					// Respect any retained product contract; never reset it for a test.
					requireBoardIsolation({ expected: contract });
				} catch (error) {
					restoreEnvironment();
					throw error;
				}
			},
			/** Omit the callback only when every owned DB/process is already closed. */
			async cleanup(closeResources?: () => void | Promise<void>) {
				if (disposed) return;
				await closeResources?.();
				const current = fs.lstatSync(root);
				if (
					!current.isDirectory() ||
					current.dev !== owned.dev ||
					current.ino !== owned.ino ||
					fs.realpathSync.native(root) !== root
				)
					throw new Error('Board test fixture root ownership changed; refusing cleanup');
				fs.rmSync(root, { recursive: true });
				restoreEnvironment();
				disposed = true;
			},
		});
	} catch (error) {
		// No handles have been opened; this root was just allocated by this call.
		fs.rmSync(root, { recursive: true });
		throw error;
	}
}
