/**
 * MaestroRun - reading the state file the desktop app writes.
 *
 * The app's MaestroRunService is the only thing that inspects the launcher. It
 * records the answer at `<userData>/maestro-run/state.json` so a process with
 * no service to ask (the CLI building a system prompt) can still tell whether
 * MaestroRun is ready. Node-only (reads the disk); the pure shapes live in
 * ./status.ts.
 */

import fs from 'fs';
import { maestroRunStatePath, parseMaestroRunState } from './status';

/**
 * The launcher's absolute path when the app last found it ready, else
 * undefined. A missing or unreadable file reads as "not ready": the section is
 * left out rather than advertising a tool nobody has confirmed.
 */
export function readMaestroRunReadyPath(userDataDir: string): string | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(maestroRunStatePath(userDataDir), 'utf-8');
	} catch {
		return undefined;
	}
	const state = parseMaestroRunState(raw);
	return state?.ready ? state.binaryPath : undefined;
}
