/**
 * "Start background host" (palette action `startBackgroundHost`): move the data directory from the
 * TUI's own runtime to a detached `maestro-cli host`, so an Auto Run or a chat turn goes on after the
 * TUI quits or an SSH session drops.
 *
 * The TUI hosting in process holds the runtime lock, and a host refuses a directory that is held, so
 * the order is: refuse while anything is running (closing the runtime would end it), close the
 * runtime, start the host, then decide the client again. That last step is the same `startTuiHost`
 * the TUI ran at launch, so the new client is found by the same discovery and is the same WebSocket
 * client as for a desktop (`host: headless pid N`). If the host does not come up the directory is
 * taken back, so the TUI is never left with no client.
 *
 * Every collaborator is injected, so the branches are tested with no process and no directory.
 */

import { execFile } from 'child_process';
import type { MaestroPaths } from '../shared/maestro-lib';
import type { TuiStartup } from './startup';

export type HostStartResult = { ok: true } | { ok: false; message: string };

export interface BackgroundHostDeps {
	/** Runs `maestro-cli host start` on the data directory and says whether the host is up. */
	runHostStart(): Promise<HostStartResult>;
	/** Decides the client again, as at launch. */
	restart(): Promise<TuiStartup>;
}

export interface BackgroundHostOutcome {
	/** The line for the status bar. */
	notice: string;
	/** The startup to run on from now on. Absent when nothing changed. */
	startup?: TuiStartup;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export async function startBackgroundHost(
	current: TuiStartup,
	deps: BackgroundHostDeps
): Promise<BackgroundHostOutcome> {
	if (current.branch === 'attach') {
		return { notice: 'Already attached to a running host. Nothing to start.' };
	}
	if (current.branch === 'read-only') {
		return { notice: `Cannot start a host from here: ${current.label}.` };
	}

	const runtime = current.client;
	const turns = runtime.turnsInFlight();
	const runs = runtime.runs.activeRuns().length;
	if (turns + runs > 0) {
		const what = [
			...(turns > 0 ? [plural(turns, 'turn')] : []),
			...(runs > 0 ? [plural(runs, 'Auto Run')] : []),
		].join(' and ');
		return {
			notice: `${what} running here would end with this TUI's runtime. Wait for the work to finish or stop it, then start the host.`,
		};
	}

	await runtime.connection.close();
	const started = await deps.runHostStart();
	const next = await deps.restart();

	if (started.ok && next.branch === 'attach') {
		return {
			startup: next,
			notice: 'Background host started. Work now continues after the TUI quits.',
		};
	}
	const why = started.ok
		? 'The host started but this TUI could not attach to it.'
		: `Could not start the background host: ${started.message}`;
	return { startup: next, notice: why };
}

/** `maestro-cli host start --json` replies with `{ started: true, ... }` or `{ error }`. */
export function parseHostStartOutput(stdout: string): HostStartResult {
	try {
		const parsed = JSON.parse(stdout) as {
			started?: boolean;
			alreadyRunning?: boolean;
			error?: string;
		};
		if (parsed.started === true || parsed.alreadyRunning === true) return { ok: true };
		return { ok: false, message: parsed.error ?? 'the host did not start' };
	} catch {
		return { ok: false, message: stdout.trim().split('\n').pop() || 'the host did not start' };
	}
}

/** How long the CLI gets: its own wait for the child to publish is 20 s. */
const HOST_START_TIMEOUT_MS = 30_000;

export interface MaestroCliHostStart {
	/** `maestro-cli.js` beside the running bundle, or undefined when it was not found. */
	cliScript: string | undefined;
	userDataDir: MaestroPaths['userDataDir'];
	/** Test seam: the process runner. */
	run?: (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ stdout: string }>;
}

function execNode(
	file: string,
	args: string[],
	env: NodeJS.ProcessEnv
): Promise<{ stdout: string }> {
	return new Promise((resolve, reject) => {
		execFile(file, args, { env, timeout: HOST_START_TIMEOUT_MS }, (error, stdout, stderr) => {
			// A failed start still prints its reason as JSON on stdout, so a non-zero exit is read, not thrown.
			if (error && !stdout.trim()) reject(new Error(stderr.trim() || error.message));
			else resolve({ stdout });
		});
	});
}

/** Runs `maestro-cli host start` for the directory the TUI resolved. */
export async function runMaestroCliHostStart(
	options: MaestroCliHostStart
): Promise<HostStartResult> {
	if (!options.cliScript) {
		return { ok: false, message: 'maestro-cli was not found beside the TUI.' };
	}
	const run = options.run ?? execNode;
	try {
		const { stdout } = await run(
			process.execPath,
			[options.cliScript, 'host', 'start', '--data-dir', options.userDataDir, '--json'],
			{ ...process.env, MAESTRO_USER_DATA: options.userDataDir }
		);
		return parseHostStartOutput(stdout);
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}
