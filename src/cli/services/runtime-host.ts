/**
 * The detached host: the library runtime, served over the desktop bridge's WebSocket, with Cue
 * beside it when the rules allow.
 *
 * `maestro-cli host start` runs this in a process that outlives its parent, so an Auto Run or a chat
 * turn survives the TUI quitting or an SSH drop. The runtime owns the data directory (its lock says
 * `host`); the server (`runtime/server.ts`) is the only way in. The discovery file is published
 * LAST, once the socket is listening, and removed FIRST on the way out, so a client that finds it
 * always finds a host that answers.
 */

import * as crypto from 'crypto';

import {
	createMaestroRuntime,
	deleteCliServerInfoFrom,
	resolveRuntimeTurnOptions,
	startRuntimeServer,
	writeCliServerInfoTo,
	type MaestroPaths,
	type MaestroRuntime,
	type RuntimeRefusal,
	type RuntimeServer,
} from '../../shared/maestro-lib';
import { startHostCue, type HostCue } from './host-cue';

/** The runtime refused the directory: another host, a desktop, a held lock, a corrupt store. */
export class HostStartError extends Error {
	constructor(readonly refusal: RuntimeRefusal) {
		super(refusal.message);
		this.name = 'HostStartError';
	}
}

export interface RuntimeHostOptions {
	paths: Pick<MaestroPaths, 'userDataDir' | 'productionDataDir' | 'settingsFile' | 'cliServerFile'>;
	/** The folder the running bundle sits in: where `maestro-cli.js` and `maestro-p.js` are looked for. */
	moduleDirectory: string;
	/** The build version, published in the discovery file and in `status`. */
	version?: string;
	/** Port to listen on. Default 0: any free one. */
	port?: number;
	log(line: string): void;
}

export interface RuntimeHostDeps {
	createRuntime: typeof createMaestroRuntime;
	startServer: typeof startRuntimeServer;
	startCue: typeof startHostCue;
	randomToken(): string;
	now(): number;
	pid: number;
}

export interface RunningHost {
	readonly runtime: MaestroRuntime;
	readonly server: RuntimeServer;
	readonly cue: HostCue;
	readonly token: string;
	/** Settles once the host has fully stopped. */
	readonly stopped: Promise<void>;
	/** Stop everything in order and release the data directory. Idempotent. */
	stop(): Promise<void>;
}

const defaultDeps: RuntimeHostDeps = {
	createRuntime: createMaestroRuntime,
	startServer: startRuntimeServer,
	startCue: startHostCue,
	randomToken: () => crypto.randomBytes(24).toString('hex'),
	now: () => Date.now(),
	pid: process.pid,
};

/** Start the host, or throw `HostStartError` naming why the directory is not ours to serve. */
export async function startRuntimeHost(
	options: RuntimeHostOptions,
	overrides: Partial<RuntimeHostDeps> = {}
): Promise<RunningHost> {
	const deps = { ...defaultDeps, ...overrides };
	const { paths, log } = options;

	const started = await deps.createRuntime({
		dataDir: paths.userDataDir,
		productionDataDir: paths.productionDataDir,
		mode: 'host',
		turns: resolveRuntimeTurnOptions(options.moduleDirectory),
	});
	if (!started.ok) throw new HostStartError(started.refusal);
	const { runtime } = started;

	let cue: HostCue = { state: () => ({ state: 'disabled' }), stop: () => undefined };
	let stopping: Promise<void> | undefined;
	let finish!: () => void;
	const stopped = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const stop = (): Promise<void> => {
		stopping ??= (async () => {
			// Unpublish first: nothing new should find a host that is going away.
			deleteCliServerInfoFrom(paths.userDataDir, deps.pid);
			cue.stop();
			unsubscribeLost();
			await server?.close();
			// The runtime stops its runs and turns, records how they ended, and releases the lock.
			await runtime.connection.close();
			log('Host stopped.');
			finish();
		})();
		return stopping;
	};

	// Losing the directory (another Maestro took it over) fences the runtime; a host with no
	// writable directory has nothing left to serve.
	const unsubscribeLost = runtime.events.subscribe(
		(event) => {
			if (event.type !== 'host.lost') return;
			log(`Lost the data directory: ${event.reason}`);
			void stop();
		},
		{ types: ['host.lost'] }
	);

	let server: RuntimeServer | undefined;
	try {
		const token = deps.randomToken();
		const cliSecret = deps.randomToken();
		cue = await deps.startCue(paths);
		server = await deps.startServer({
			runtime,
			token,
			cliSecret,
			port: options.port,
			onStopRequested: () => void stop(),
			describe: () => ({
				cue: cue.state(),
				...(options.version ? { version: options.version } : {}),
			}),
		});
		writeCliServerInfoTo(paths.userDataDir, {
			port: server.port,
			token,
			pid: deps.pid,
			startedAt: deps.now(),
			cliSecret,
			hostKind: 'headless',
			...(options.version ? { version: options.version } : {}),
		});
		log(`Host serving ${paths.userDataDir} on 127.0.0.1:${server.port} (pid ${deps.pid}).`);
		return { runtime, server, cue, token, stopped, stop };
	} catch (error) {
		await stop();
		throw error;
	}
}
