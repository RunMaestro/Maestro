/**
 * A read-only report on where Maestro's data lives and who is using it.
 *
 * Backs `maestro-cli tui --doctor`. Everything it touches goes through
 * `DoctorDeps`, so the report builder is tested with an injected filesystem,
 * process probe, and clock. Nothing here creates a directory or a file.
 *
 * Two answers it gives that the path resolver cannot: whether the chosen data
 * directory EXISTS (the resolver only computes a path, and a wrong `Maestro` /
 * `maestro` guess is indistinguishable from the right one until something is
 * opened), and whether another Maestro process holds the directory - the
 * desktop app (`cli-server.json`) or a standalone Cue engine
 * (`cue-engine.lock`).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isPidAlive, parseCliServerInfo } from '../../cli-server-discovery';
import type { MaestroPaths, SyncDirSource } from './resolve';
import type { UserDataDirRule } from './userDataDir';

export type PathKind = 'file' | 'directory' | 'missing';

export interface DoctorDeps {
	/** Reads a file as UTF-8. Throws with an `ENOENT` code when it is missing. */
	readFile(filePath: string): string;
	/** What is at the path. A permission or I/O error is thrown, not reported as `missing`. */
	pathKind(filePath: string): PathKind;
	isPidAlive(pid: number): boolean;
	/** Epoch ms. */
	now(): number;
	/** Epoch ms the system booted. */
	bootTime(): number;
}

export const defaultDoctorDeps: DoctorDeps = {
	readFile: (filePath) => fs.readFileSync(filePath, 'utf-8'),
	pathKind: (filePath) => {
		try {
			const stat = fs.statSync(filePath);
			return stat.isDirectory() ? 'directory' : 'file';
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
			throw error;
		}
	},
	isPidAlive,
	now: () => Date.now(),
	bootTime: () => Date.now() - os.uptime() * 1000,
};

/**
 * Mirrors `CUE_ENGINE_LOCK_STALE_MS` and the boot tolerance in
 * `src/main/cue/cue-engine-lock.ts`. Duplicated because shared code cannot
 * import from `src/main`; `doctor-cue-lock-parity.test.ts` fails if the two
 * drift.
 */
export const DOCTOR_CUE_LOCK_STALE_MS = 180_000;
export const DOCTOR_CUE_BOOT_TOLERANCE_MS = 60_000;
export const CUE_ENGINE_LOCK_FILE_NAME = 'cue-engine.lock';

export interface DoctorPathCheck {
	label: string;
	path: string;
	kind: PathKind;
}

export type DesktopStatus =
	| { state: 'not-running' }
	| { state: 'running'; pid: number; port: number; version?: string; startedAt: number }
	| { state: 'stale'; pid: number };

export type CueLockStatus =
	| { state: 'none' }
	| { state: 'unreadable' }
	| { state: 'held'; pid: number; mode: string; startedAt: string }
	| {
			state: 'stale';
			pid: number;
			mode: string;
			reason: 'process gone' | 'earlier boot' | 'heartbeat quiet';
	  };

export interface DoctorReport {
	/** False when the resolved user data directory does not exist as a directory. */
	ok: boolean;
	userData: DoctorPathCheck & { rule: UserDataDirRule };
	/** Every directory a run could have meant, in the order tried. */
	tried: DoctorPathCheck[];
	sync: DoctorPathCheck & { source: SyncDirSource; rejection?: string };
	stores: DoctorPathCheck[];
	desktop: DesktopStatus;
	cueEngine: CueLockStatus;
}

export interface DoctorInput {
	paths: MaestroPaths;
	rule: UserDataDirRule;
	/** From `userDataDirCandidates()`. */
	candidates: string[];
}

function check(deps: DoctorDeps, label: string, filePath: string): DoctorPathCheck {
	return { label, path: filePath, kind: deps.pathKind(filePath) };
}

function readOptional(deps: DoctorDeps, filePath: string): string | undefined {
	try {
		return deps.readFile(filePath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
		throw error;
	}
}

function inspectDesktop(paths: MaestroPaths, deps: DoctorDeps): DesktopStatus {
	const raw = readOptional(deps, paths.cliServerFile);
	const info = raw === undefined ? null : parseCliServerInfo(raw);
	if (!info) return { state: 'not-running' };
	if (!deps.isPidAlive(info.pid)) return { state: 'stale', pid: info.pid };
	return {
		state: 'running',
		pid: info.pid,
		port: info.port,
		startedAt: info.startedAt,
		...(info.version ? { version: info.version } : {}),
	};
}

function inspectCueEngine(userDataDir: string, deps: DoctorDeps): CueLockStatus {
	const raw = readOptional(deps, path.join(userDataDir, CUE_ENGINE_LOCK_FILE_NAME));
	if (raw === undefined) return { state: 'none' };

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { state: 'unreadable' };
	}
	const lock = parsed as {
		pid?: unknown;
		mode?: unknown;
		startedAt?: unknown;
		heartbeatAt?: unknown;
		bootTime?: unknown;
	} | null;
	if (!lock || typeof lock.pid !== 'number' || typeof lock.mode !== 'string') {
		return { state: 'unreadable' };
	}

	const startedAt = typeof lock.startedAt === 'string' ? lock.startedAt : new Date(0).toISOString();
	const stale = (reason: 'process gone' | 'earlier boot' | 'heartbeat quiet'): CueLockStatus => ({
		state: 'stale',
		pid: lock.pid as number,
		mode: lock.mode as string,
		reason,
	});

	if (!deps.isPidAlive(lock.pid)) return stale('process gone');
	if (
		typeof lock.bootTime === 'number' &&
		Math.abs(lock.bootTime - deps.bootTime()) > DOCTOR_CUE_BOOT_TOLERANCE_MS
	) {
		return stale('earlier boot');
	}
	const beat = Date.parse(typeof lock.heartbeatAt === 'string' ? lock.heartbeatAt : startedAt);
	if (!Number.isFinite(beat) || deps.now() - beat > DOCTOR_CUE_LOCK_STALE_MS) {
		return stale('heartbeat quiet');
	}
	return { state: 'held', pid: lock.pid, mode: lock.mode, startedAt };
}

export function buildDoctorReport(
	input: DoctorInput,
	deps: DoctorDeps = defaultDoctorDeps
): DoctorReport {
	const { paths } = input;
	const userData = {
		...check(deps, 'user data', paths.userDataDir),
		rule: input.rule,
	};
	const syncCheck = check(deps, 'sync', paths.syncDir);

	const stores: DoctorPathCheck[] = [
		check(deps, 'bootstrap', paths.bootstrapFile),
		check(deps, 'sessions', paths.sessionsFile),
		check(deps, 'groups', paths.groupsFile),
		check(deps, 'settings', paths.settingsFile),
		check(deps, 'agent configs', paths.agentConfigsFile),
		check(deps, 'history', paths.historyDir),
		check(deps, 'group chats', paths.groupChatsDir),
		check(deps, 'session images', paths.sessionImagesDir),
	];

	return {
		ok: userData.kind === 'directory',
		userData,
		tried: input.candidates.map((candidate) => check(deps, 'candidate', candidate)),
		sync: {
			...syncCheck,
			source: paths.syncDirSource,
			...(paths.customSyncPathRejection ? { rejection: paths.customSyncPathRejection } : {}),
		},
		stores,
		desktop: inspectDesktop(paths, deps),
		cueEngine: inspectCueEngine(paths.userDataDir, deps),
	};
}

const KIND_MARK: Record<PathKind, string> = {
	directory: 'ok     ',
	file: 'ok     ',
	missing: 'missing',
};

/** A path that should be a directory reports a file there as the wrong kind, not as present. */
function line(check: DoctorPathCheck, width: number, expectDirectory = false): string {
	const mark = expectDirectory && check.kind === 'file' ? 'notdir ' : KIND_MARK[check.kind];
	return `  ${mark}  ${check.label.padEnd(width)}  ${check.path}`;
}

/** The report as plain text for a terminal. */
export function formatDoctorReport(report: DoctorReport): string {
	const out: string[] = [];
	const width = Math.max(
		...[report.userData, report.sync, ...report.stores, ...report.tried].map(
			(entry) => entry.label.length
		)
	);

	out.push('Maestro data directory');
	out.push(line(report.userData, width, true));
	out.push(`           chosen by: ${report.userData.rule}`);
	out.push(line(report.sync, width, true));
	out.push(
		`           chosen by: ${report.sync.source === 'customSyncPath' ? 'customSyncPath in the bootstrap file' : 'user data (no usable customSyncPath)'}`
	);
	if (report.sync.rejection) {
		out.push(`           customSyncPath ignored: ${report.sync.rejection}`);
	}

	out.push('');
	out.push('Stores');
	for (const store of report.stores) out.push(line(store, width));

	out.push('');
	out.push('Desktop app');
	const { desktop } = report;
	if (desktop.state === 'running') {
		const version = desktop.version ? `, version ${desktop.version}` : '';
		out.push(`  running (pid ${desktop.pid}, port ${desktop.port}${version})`);
	} else if (desktop.state === 'stale') {
		out.push(`  not running (cli-server.json names pid ${desktop.pid}, which is gone)`);
	} else {
		out.push('  not running (no cli-server.json)');
	}

	out.push('');
	out.push('Cue engine');
	const { cueEngine } = report;
	if (cueEngine.state === 'held') {
		out.push(
			`  held by a ${cueEngine.mode} engine (pid ${cueEngine.pid}, since ${cueEngine.startedAt})`
		);
	} else if (cueEngine.state === 'stale') {
		out.push(
			`  not held (stale ${cueEngine.mode} lock, pid ${cueEngine.pid}: ${cueEngine.reason})`
		);
	} else if (cueEngine.state === 'unreadable') {
		out.push('  not held (cue-engine.lock is unreadable)');
	} else {
		out.push('  not held (no cue-engine.lock)');
	}

	if (!report.ok) {
		out.push('');
		out.push('No Maestro data directory found. Paths tried, in order:');
		for (const candidate of report.tried) out.push(line(candidate, width, true));
		out.push('Set MAESTRO_USER_DATA, or pass --data-dir, to the directory the desktop app uses.');
	}

	return out.join('\n');
}
