/**
 * MaestroRun - the status Maestro reports about the launcher on this Mac, and
 * the small state file that carries "ready" to processes that cannot ask the
 * service (the CLI builds its own system prompt from disk).
 */

import type { MaestroRunFullDiskAccess } from './contract';

/**
 * Where setup stands.
 *  - `unsupported`: this host is not macOS.
 *  - `not-installed`: no MaestroRun.app was found.
 *  - `invalid`: a bundle is there but it does not carry MaestroRun's signature.
 *  - `needs-access`: installed and verified, Full Disk Access not in effect.
 *  - `ready`: installed, verified, and `doctor` proves the grant is its own.
 */
export type MaestroRunPhase =
	| 'unsupported'
	| 'not-installed'
	| 'invalid'
	| 'needs-access'
	| 'ready';

export interface MaestroRunStatus {
	/** The host is macOS. False everywhere else, where nothing can be installed. */
	supported: boolean;
	/** The `maestroRun` Encore flag. */
	enabled: boolean;
	phase: MaestroRunPhase;
	/** The bundle Maestro manages (an existing copy, else where it would install). */
	appPath: string;
	/** The launcher inside it; the absolute path agents and job definitions use. */
	binaryPath: string;
	installedVersion: string | null;
	fullDiskAccess: MaestroRunFullDiskAccess;
	/** Newest installable release seen by the last release check, if any ran. */
	latestVersion: string | null;
	updateAvailable: boolean;
	/** An install or update is running. */
	installing: boolean;
	/** Maestro is polling `doctor` while the user switches the grant on. */
	watchingForAccess: boolean;
	/** Why the phase is `invalid`, or the last failure worth showing. */
	detail: string | null;
	/** When the bundle was last inspected (ms since epoch); 0 before the first look. */
	checkedAt: number;
}

/** Actions `maestro-cli maestro-run` sends over the WebSocket bridge. */
export type MaestroRunCommandAction = 'status' | 'install' | 'grant';

/** What `<userData>/maestro-run/state.json` holds. */
export interface MaestroRunStateFile {
	ready: boolean;
	binaryPath: string;
	version: string | null;
	checkedAt: number;
}

export function maestroRunStatePath(userDataDir: string): string {
	return `${userDataDir}/maestro-run/state.json`;
}

/** A parsed state file, or null when the content is not one. */
export function parseMaestroRunState(raw: string): MaestroRunStateFile | null {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return null;
	}
	if (!value || typeof value !== 'object') return null;
	const { ready, binaryPath, version, checkedAt } = value as Record<string, unknown>;
	if (typeof ready !== 'boolean' || typeof binaryPath !== 'string' || !binaryPath) return null;
	return {
		ready,
		binaryPath,
		version: typeof version === 'string' ? version : null,
		checkedAt: typeof checkedAt === 'number' ? checkedAt : 0,
	};
}

/** One line a person can read, shared by the tile and the CLI. */
export function describeMaestroRunPhase(status: MaestroRunStatus): string {
	switch (status.phase) {
		case 'unsupported':
			return 'MaestroRun is available on macOS only';
		case 'not-installed':
			return 'Not installed';
		case 'invalid':
			return 'A MaestroRun.app is present but it is not signed by MaestroRun';
		case 'needs-access':
			return 'Installed, waiting for Full Disk Access';
		case 'ready':
			return 'Ready';
	}
}
