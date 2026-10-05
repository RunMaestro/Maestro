/**
 * Which client the TUI runs on (decision D4.2, `Plans/maestro-tui-runtime.md`
 * section 3). Three branches, decided before the first frame:
 *
 * - No desktop and no other runtime holds the data directory: the TUI hosts it
 *   in process and the runtime is its client (`host: this TUI`).
 * - A desktop or detached host serves it: attach with the WebSocket client.
 * - Anything else refuses (another TUI holds the lock, a corrupt store, ...):
 *   open read-only on the store files and say why.
 *
 * Both collaborators are injected so the branches are tested with fakes and no
 * data directory.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
	loadBetterSqlite3,
	type MaestroClient,
	type MaestroPaths,
	type MaestroRuntimeOptions,
	type RuntimeRefusal,
	type RuntimeStart,
	type RuntimeTurnOptions,
	type StatsConnectionConstructor,
} from '../shared/maestro-lib';

export type TuiStartPaths = Pick<MaestroPaths, 'userDataDir' | 'productionDataDir'>;

export interface TuiStartupDeps {
	startRuntime(options: MaestroRuntimeOptions): Promise<RuntimeStart>;
	/** The client for a running desktop. Called only when one serves the directory. */
	attachToHost(): MaestroClient;
}

export type TuiStartup =
	/** The TUI owns the directory: its runtime is the client and writes are live. */
	| { branch: 'in-process'; client: MaestroClient }
	/** A desktop or detached host owns it: the client attaches and follows it. */
	| { branch: 'attach'; client: MaestroClient }
	/** Nobody can be written through: the store files are read, and `label` says why. */
	| { branch: 'read-only'; label: string; notice: string };

/** What the status bar prints after `host: ` for a refusal the TUI opens read-only on. */
export function readOnlyLabelFor(refusal: RuntimeRefusal): string {
	switch (refusal.reason) {
		case 'held': {
			const who = refusal.holder.mode === 'tui' ? 'TUI' : refusal.holder.mode;
			return `read-only (${who} pid ${refusal.holder.pid} holds this data dir)`;
		}
		case 'data-dir-missing':
			return 'read-only (no data directory)';
		case 'synced-data-dir':
			return 'read-only (synced data directory)';
		case 'store-corrupt':
			return 'read-only (a store file is corrupt)';
		case 'store-too-new':
			return 'read-only (update maestro-cli)';
		case 'lock-failed':
			return 'read-only (data directory not lockable)';
		case 'host-running':
			return 'read-only';
	}
}

export async function startTuiHost(
	paths: TuiStartPaths,
	deps: TuiStartupDeps
): Promise<TuiStartup> {
	const started = await deps.startRuntime({
		dataDir: paths.userDataDir,
		productionDataDir: paths.productionDataDir,
		mode: 'tui',
	});
	if (started.ok) return { branch: 'in-process', client: started.runtime };

	const { refusal } = started;
	// A desktop that has not published `cli-server.json` yet cannot be attached to,
	// so that one reads the files like any other refusal.
	if (refusal.reason === 'host-running' && refusal.attachable) {
		return { branch: 'attach', client: deps.attachToHost() };
	}
	return { branch: 'read-only', label: readOnlyLabelFor(refusal), notice: refusal.message };
}

/**
 * What the in-process runtime needs to run turns, found beside the running bundle: the
 * `maestro-cli.js` agents are told to call (PA6) and the `maestro-p` script a Claude agent on the
 * TUI token source runs through. `dist/cli` holds all three in a checkout and `Resources/` once
 * installed, so a sibling that is not there is simply absent (the turn degrades: no CLI path in the
 * template, Claude over `--print`). SQLite is the CLI's loader, which proves the module loads in
 * this runtime or says how to fix it; the runtime logs that once and skips only the usage row.
 */
export function resolveTuiTurnOptions(
	moduleDirectory: string,
	exists: (file: string) => boolean = fs.existsSync
): RuntimeTurnOptions {
	const beside = (name: string): string | undefined => {
		const candidate = path.join(moduleDirectory, name);
		return exists(candidate) ? candidate : undefined;
	};
	return {
		// The loader types its result as the one method it proves (`close`); the real constructor is
		// `better-sqlite3`'s, which is what `StatsConnectionConstructor` names.
		loadSqlite: () => loadBetterSqlite3() as unknown as StatsConnectionConstructor,
		moduleDirectory,
		maestroCliPath: beside('maestro-cli.js'),
		maestroPBinPath: beside('maestro-p.js') ?? null,
	};
}
