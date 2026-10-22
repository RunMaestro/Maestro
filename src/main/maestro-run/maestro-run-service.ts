/**
 * MaestroRun - installs the launcher, walks the Full Disk Access grant, and
 * says when it is ready.
 *
 * One instance per app (see ./index.ts). The Extensions tile reaches it over
 * `maestroRun:*` IPC and `maestro-cli maestro-run` over the WebSocket bridge,
 * so both drive the same code. macOS only: on any other host every verb
 * reports `unsupported` and touches nothing.
 *
 * "Ready" is what gates the MaestroRun section of the agent system prompt, so
 * it is deliberately hard to reach: the bundle must carry MaestroRun's own
 * signature AND a fresh `doctor` must prove the launcher holds Full Disk
 * Access itself (see `doctorProvesAccess`).
 *
 * Everything that touches the machine (exec, fetch, shell) is injected, so the
 * whole flow runs in a test without a network or a signed bundle.
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
	MAESTRO_RUN_APP_NAME,
	MAESTRO_RUN_CODE_REQUIREMENT,
	MAESTRO_RUN_REPO,
	compareMaestroRunVersions,
	doctorProvesAccess,
	maestroRunAppCandidates,
	maestroRunBinaryPath,
	parseMaestroRunChecksum,
	parseMaestroRunDoctor,
	parseMaestroRunVersion,
	pickMaestroRunRelease,
	type MaestroRunArch,
	type MaestroRunFullDiskAccess,
	type MaestroRunReleaseLike,
	type MaestroRunReleasePick,
} from '../../shared/maestro-run/contract';
import {
	maestroRunStatePath,
	type MaestroRunPhase,
	type MaestroRunStateFile,
	type MaestroRunStatus,
} from '../../shared/maestro-run/status';
import type { ExecOptions, ExecResult } from '../utils/execFile';

/** How often `doctor` runs while the user is switching the grant on. */
export const ACCESS_WATCH_INTERVAL_MS = 3_000;
/** The watch gives up after this long; the user can start it again. */
export const ACCESS_WATCH_BUDGET_MS = 10 * 60_000;
/** A status older than this is re-inspected before it gates a system prompt. */
export const READY_MAX_AGE_MS = 5 * 60_000;
/** A release archive is a few hundred kilobytes; this is a guard, not a quota. */
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_BUDGET_MS = 120_000;
const TOOL_TIMEOUT_MS = 30_000;

/** The Full Disk Access pane of System Settings. */
export const FULL_DISK_ACCESS_SETTINGS_URL =
	'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

export interface MaestroRunServiceDeps {
	platform: NodeJS.Platform;
	homeDir: string;
	userDataDir: string;
	/** The `maestroRun` Encore flag, read live. */
	isEnabled: () => boolean;
	exec: (
		command: string,
		args: string[],
		cwd?: string,
		options?: ExecOptions
	) => Promise<ExecResult>;
	fetch: (url: string, options?: RequestInit, timeoutMs?: number) => Promise<Response>;
	openExternal: (url: string) => Promise<void>;
	showItemInFolder: (fullPath: string) => void;
	onStatusChange?: (status: MaestroRunStatus) => void;
	log?: (level: 'info' | 'warn' | 'error', message: string) => void;
	now?: () => number;
	/** Where a copy may live, first match wins. Defaults to `maestroRunAppCandidates(homeDir)`. */
	appCandidates?: readonly string[];
	/** Defaults to `ACCESS_WATCH_INTERVAL_MS`. */
	watchIntervalMs?: number;
}

interface Inspection {
	phase: MaestroRunPhase;
	appPath: string;
	installedVersion: string | null;
	fullDiskAccess: MaestroRunFullDiskAccess;
	detail: string | null;
}

function errorText(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export class MaestroRunService {
	private readonly deps: MaestroRunServiceDeps;
	private current: MaestroRunStatus;
	private latestVersion: string | null = null;
	private installing: Promise<MaestroRunStatus> | null = null;
	private refreshing: Promise<MaestroRunStatus> | null = null;
	private watchTimer: ReturnType<typeof setInterval> | null = null;
	private watchDeadline = 0;
	private watchTickRunning = false;

	constructor(deps: MaestroRunServiceDeps) {
		this.deps = deps;
		const appPath = this.defaultAppPath();
		this.current = {
			supported: this.supported,
			enabled: false,
			phase: this.supported ? 'not-installed' : 'unsupported',
			appPath,
			binaryPath: maestroRunBinaryPath(appPath),
			installedVersion: null,
			fullDiskAccess: 'unknown',
			latestVersion: null,
			updateAvailable: false,
			installing: false,
			watchingForAccess: false,
			detail: null,
			checkedAt: 0,
		};
	}

	private get supported(): boolean {
		return this.deps.platform === 'darwin';
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	private log(level: 'info' | 'warn' | 'error', message: string): void {
		this.deps.log?.(level, message);
	}

	private appCandidates(): readonly string[] {
		return this.deps.appCandidates ?? maestroRunAppCandidates(this.deps.homeDir);
	}

	private defaultAppPath(): string {
		return this.appCandidates()[0];
	}

	/** An existing copy wins, so Maestro upgrades it in place instead of adding a second. */
	private resolveAppPath(): string {
		for (const candidate of this.appCandidates()) {
			if (fs.existsSync(candidate)) return candidate;
		}
		return this.defaultAppPath();
	}

	/**
	 * Run one of the launcher's or the system's tools. `MAESTRO_RUN_CONFIG_DIR`
	 * redirects the launcher's allowlist and log, so it must never leak in from
	 * Maestro's own environment.
	 */
	private run(command: string, args: string[]): Promise<ExecResult> {
		const env = { ...process.env };
		delete env.MAESTRO_RUN_CONFIG_DIR;
		return this.deps.exec(command, args, undefined, { env, timeout: TOOL_TIMEOUT_MS });
	}

	/** The last known status. Never touches the machine. */
	status(): MaestroRunStatus {
		return { ...this.current, enabled: this.deps.isEnabled() };
	}

	private publish(patch: Partial<MaestroRunStatus>): MaestroRunStatus {
		const next: MaestroRunStatus = {
			...this.current,
			...patch,
			enabled: this.deps.isEnabled(),
			installing: this.installing !== null,
			watchingForAccess: this.watchTimer !== null,
			latestVersion: this.latestVersion,
		};
		next.binaryPath = maestroRunBinaryPath(next.appPath);
		next.updateAvailable = this.isNewer(this.latestVersion, next.installedVersion);
		this.current = next;
		this.deps.onStatusChange?.(next);
		return next;
	}

	private isNewer(candidate: string | null, installed: string | null): boolean {
		const a = candidate ? parseMaestroRunVersion(candidate) : null;
		const b = installed ? parseMaestroRunVersion(installed) : null;
		return !!a && !!b && compareMaestroRunVersions(a, b) > 0;
	}

	/** Does `bundle` carry MaestroRun's identifier and signing team? */
	private async verifyIdentity(bundle: string): Promise<string | null> {
		const result = await this.run('/usr/bin/codesign', [
			'--verify',
			'--strict',
			`-R=${MAESTRO_RUN_CODE_REQUIREMENT}`,
			bundle,
		]);
		if (result.exitCode === 0) return null;
		return result.stderr.trim() || `codesign exited ${result.exitCode}`;
	}

	/** The bundle version. Only trusted after `verifyIdentity` passed: Info.plist is covered by the signature. */
	private async readVersion(bundle: string): Promise<string | null> {
		const result = await this.run('/usr/bin/plutil', [
			'-extract',
			'CFBundleShortVersionString',
			'raw',
			'-o',
			'-',
			path.join(bundle, 'Contents', 'Info.plist'),
		]);
		const version = result.exitCode === 0 ? result.stdout.trim() : '';
		return parseMaestroRunVersion(version) ? version : null;
	}

	/**
	 * Ask the launcher itself. `doctor` exits 0 with the grant, 3 without, and
	 * anything else is a failure of its own (126: the allowlist location cannot
	 * be examined). An ungranted run also registers the launcher with macOS, which
	 * is what puts it in the Full Disk Access list for the user to switch on.
	 */
	private async runDoctor(
		appPath: string
	): Promise<{ granted: boolean; access: MaestroRunFullDiskAccess; detail: string | null }> {
		const result = await this.run(maestroRunBinaryPath(appPath), ['doctor']);
		const report = parseMaestroRunDoctor(result.stdout);
		if (doctorProvesAccess(result.exitCode, report)) {
			return { granted: true, access: 'granted', detail: null };
		}
		if (result.exitCode === 0) {
			// Granted, but not to the launcher: it inherited the grant of the process that started it.
			return {
				granted: false,
				access: 'unknown',
				detail: `MaestroRun could not take responsibility for itself (responsible process: ${report.responsibleProcess}), so its own access cannot be confirmed.`,
			};
		}
		if (result.exitCode === 3) {
			return { granted: false, access: report.fullDiskAccess, detail: null };
		}
		return {
			granted: false,
			access: 'unknown',
			detail: `maestro-run doctor failed (exit ${result.exitCode})${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''}`,
		};
	}

	private async inspect(): Promise<Inspection> {
		const appPath = this.resolveAppPath();
		const blank = { appPath, installedVersion: null, fullDiskAccess: 'unknown' as const };
		if (!this.supported) return { ...blank, phase: 'unsupported', detail: null };
		if (!fs.existsSync(appPath)) return { ...blank, phase: 'not-installed', detail: null };

		// Identity first. Nothing from the bundle runs until this passes: a bundle
		// that is merely named MaestroRun.app must never be executed by Maestro.
		const identityError = await this.verifyIdentity(appPath);
		if (identityError) return { ...blank, phase: 'invalid', detail: identityError };

		const installedVersion = await this.readVersion(appPath);
		const doctor = await this.runDoctor(appPath);
		return {
			appPath,
			installedVersion,
			fullDiskAccess: doctor.access,
			phase: doctor.granted ? 'ready' : 'needs-access',
			detail: doctor.detail,
		};
	}

	/** Re-inspect the machine. `checkLatest` also asks GitHub for the newest release. */
	refresh(opts: { checkLatest?: boolean } = {}): Promise<MaestroRunStatus> {
		// A release check is its own request; an in-flight plain refresh must not swallow it.
		if (this.refreshing && !opts.checkLatest) return this.refreshing;
		const work = (async () => {
			const inspection = await this.inspect();
			if (opts.checkLatest && this.supported) {
				try {
					const pick = await this.findRelease();
					this.latestVersion = pick?.version ?? null;
				} catch (err) {
					// Offline or rate limited: the installed copy is still what it is.
					this.log('warn', `MaestroRun release check failed: ${errorText(err)}`);
				}
			}
			if (inspection.phase === 'ready') this.stopWatching();
			const status = this.publish({ ...inspection, checkedAt: this.now() });
			await this.persist(status);
			return status;
		})();
		this.refreshing = work;
		const clear = () => {
			if (this.refreshing === work) this.refreshing = null;
		};
		work.then(clear, clear);
		return work;
	}

	/** Follow the Encore flag: inspect when it is on, stop polling when it is off. */
	async reconcile(): Promise<void> {
		if (!this.supported || !this.deps.isEnabled()) {
			this.stopWatching();
			this.publish({});
			return;
		}
		await this.refresh();
	}

	/**
	 * The launcher's absolute path when it is ready RIGHT NOW, else undefined.
	 * This is the gate for the system-prompt section, so a stale answer is
	 * re-checked first: a grant the user revoked must not keep being advertised.
	 */
	async readyBinaryPath(): Promise<string | undefined> {
		if (!this.supported || !this.deps.isEnabled()) return undefined;
		const stale = this.now() - this.current.checkedAt > READY_MAX_AGE_MS;
		const status = stale ? await this.refresh() : this.current;
		return status.phase === 'ready' ? status.binaryPath : undefined;
	}

	/**
	 * The same answer from the last inspection, without re-checking. For the one
	 * builder that cannot wait (the Group Chat moderator's synchronous spawn).
	 */
	readyBinaryPathCached(): string | undefined {
		if (!this.supported || !this.deps.isEnabled()) return undefined;
		return this.current.phase === 'ready' ? this.current.binaryPath : undefined;
	}

	private async persist(status: MaestroRunStatus): Promise<void> {
		const state: MaestroRunStateFile = {
			ready: status.phase === 'ready',
			binaryPath: status.binaryPath,
			version: status.installedVersion,
			checkedAt: status.checkedAt,
		};
		const file = maestroRunStatePath(this.deps.userDataDir);
		try {
			await fs.promises.mkdir(path.dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
			await fs.promises.rename(tmp, file);
		} catch (err) {
			// The CLI then reads an older answer; the app's own gate is unaffected.
			this.log('warn', `Could not write MaestroRun state: ${errorText(err)}`);
		}
	}

	// ---- install ----------------------------------------------------------

	/** The archive for the hardware, not for this process (Rosetta reports x86_64). */
	private async hardwareArch(): Promise<MaestroRunArch> {
		const result = await this.run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64']);
		return result.exitCode === 0 && result.stdout.trim() === '1' ? 'arm64' : 'x86_64';
	}

	private async findRelease(): Promise<MaestroRunReleasePick | null> {
		const arch = await this.hardwareArch();
		const response = await this.deps.fetch(
			`https://api.github.com/repos/${MAESTRO_RUN_REPO}/releases?per_page=30`,
			{ headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Maestro' } }
		);
		if (!response.ok) {
			throw new Error(`GitHub answered ${response.status} for the MaestroRun release list`);
		}
		const releases = (await response.json()) as unknown;
		if (!Array.isArray(releases)) throw new Error('Unexpected MaestroRun release list');
		return pickMaestroRunRelease(releases as MaestroRunReleaseLike[], arch);
	}

	private async download(url: string): Promise<Buffer> {
		const response = await this.deps.fetch(
			url,
			{ headers: { 'User-Agent': 'Maestro' }, signal: AbortSignal.timeout(DOWNLOAD_BUDGET_MS) },
			DOWNLOAD_BUDGET_MS
		);
		if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
		const declared = Number(response.headers.get('content-length') ?? '0');
		if (declared > MAX_ARCHIVE_BYTES) throw new Error(`Download is larger than expected: ${url}`);
		const body = Buffer.from(await response.arrayBuffer());
		if (body.byteLength > MAX_ARCHIVE_BYTES)
			throw new Error(`Download is larger than expected: ${url}`);
		return body;
	}

	/**
	 * Install the newest supported release, or update the copy that is there.
	 * Resolves with the status afterwards; rejects with the reason when a step
	 * fails, leaving whatever was installed before untouched.
	 */
	install(): Promise<MaestroRunStatus> {
		if (this.installing) return this.installing;
		if (!this.supported) return Promise.reject(new Error('MaestroRun is available on macOS only'));
		// The status handed back is published AFTER the flag clears, so a caller
		// never receives a finished install that still reads `installing`.
		const work = this.runInstall().then(
			() => {
				this.installing = null;
				return this.publish({});
			},
			(err) => {
				this.installing = null;
				this.publish({ detail: errorText(err) });
				throw err;
			}
		);
		this.installing = work;
		this.publish({ detail: null });
		return work;
	}

	private async runInstall(): Promise<MaestroRunStatus> {
		const pick = await this.findRelease();
		if (!pick) {
			throw new Error('MaestroRun has not published a release for this Mac yet.');
		}
		this.latestVersion = pick.version;

		const appPath = this.resolveAppPath();
		const installedVersion = await this.installedVerifiedVersion(appPath);
		this.assertNotDowngrade(pick.version, installedVersion);
		if (installedVersion === pick.version) {
			// Already current and verified: nothing to download.
			return this.refresh();
		}

		const parent = path.dirname(appPath);
		await fs.promises.mkdir(parent, { recursive: true });
		// Beside the destination, so the final move is a rename on one volume.
		const stage = await fs.promises.mkdtemp(path.join(parent, '.maestro-run-install-'));
		try {
			const archive = path.join(stage, pick.archiveName);
			const [archiveBytes, checksumBytes] = await Promise.all([
				this.download(pick.archiveUrl),
				this.download(pick.checksumUrl),
			]);
			const expected = parseMaestroRunChecksum(checksumBytes.toString('utf-8'), pick.archiveName);
			if (!expected) throw new Error(`The checksum file does not name ${pick.archiveName}`);
			const actual = createHash('sha256').update(archiveBytes).digest('hex');
			if (actual !== expected) {
				throw new Error(`Checksum mismatch for ${pick.archiveName}; the download is damaged.`);
			}
			await fs.promises.writeFile(archive, archiveBytes);

			// ditto is how the archive is made; a zip library would drop the
			// executable bit and the stapled notarization ticket.
			const unpacked = path.join(stage, 'unpacked');
			const unzip = await this.run('/usr/bin/ditto', ['-x', '-k', archive, unpacked]);
			if (unzip.exitCode !== 0) {
				throw new Error(`Could not unpack ${pick.archiveName}: ${unzip.stderr.trim()}`);
			}
			const staged = path.join(unpacked, MAESTRO_RUN_APP_NAME);
			if (!fs.existsSync(staged)) {
				throw new Error(`${pick.archiveName} does not contain ${MAESTRO_RUN_APP_NAME}`);
			}

			// The checksum only detects a damaged download. These two tie the bundle
			// to its publisher, and both must pass before it is moved into place.
			const identityError = await this.verifyIdentity(staged);
			if (identityError) {
				throw new Error(`The download is not signed by MaestroRun: ${identityError}`);
			}
			const gatekeeper = await this.run('/usr/sbin/spctl', [
				'--assess',
				'--type',
				'execute',
				'--verbose=2',
				staged,
			]);
			if (gatekeeper.exitCode !== 0) {
				throw new Error(
					`macOS did not accept the download as notarized: ${(gatekeeper.stderr || gatekeeper.stdout).trim()}`
				);
			}
			const stagedVersion = await this.readVersion(staged);
			if (stagedVersion !== pick.version) {
				throw new Error(
					`Release ${pick.version} contains version ${stagedVersion ?? 'unknown'}; refusing to install it.`
				);
			}

			await this.swapIntoPlace(staged, appPath, stage);
		} finally {
			// No backup and no leftover: every signed copy on disk holds the grant.
			await fs.promises.rm(stage, { recursive: true, force: true });
		}

		this.log('info', `Installed MaestroRun ${pick.version} at ${appPath}`);
		return this.refresh();
	}

	/** The installed version, or null when nothing verified is installed. */
	private async installedVerifiedVersion(appPath: string): Promise<string | null> {
		if (!fs.existsSync(appPath)) return null;
		if (await this.verifyIdentity(appPath)) return null;
		return this.readVersion(appPath);
	}

	private assertNotDowngrade(candidate: string, installed: string | null): void {
		const next = parseMaestroRunVersion(candidate);
		const have = installed ? parseMaestroRunVersion(installed) : null;
		if (next && have && compareMaestroRunVersions(next, have) < 0) {
			throw new Error(
				`MaestroRun ${installed} is installed and the newest supported release is ${candidate}; refusing to downgrade.`
			);
		}
	}

	/** Replace the installed bundle with the staged one, restoring the old one if the move fails. */
	private async swapIntoPlace(staged: string, appPath: string, stage: string): Promise<void> {
		const displaced = path.join(stage, 'previous.app');
		const hadPrevious = fs.existsSync(appPath);
		if (hadPrevious) await fs.promises.rename(appPath, displaced);
		try {
			await fs.promises.rename(staged, appPath);
		} catch (err) {
			if (hadPrevious) await fs.promises.rename(displaced, appPath);
			throw err;
		}
	}

	// ---- Full Disk Access -------------------------------------------------

	/**
	 * Take the user to the Full Disk Access list and watch for the switch.
	 *
	 * macOS has no prompt for Full Disk Access: the user switches it on by hand.
	 * The refresh runs `doctor`, which registers MaestroRun so it is in the list,
	 * then System Settings opens on that pane. `reveal` also shows the bundle in
	 * Finder, for dragging into the list when macOS did not add the row.
	 */
	async requestAccess(opts: { reveal?: boolean } = {}): Promise<MaestroRunStatus> {
		if (!this.supported) throw new Error('MaestroRun is available on macOS only');
		const status = await this.refresh();
		if (status.phase === 'not-installed') throw new Error('Install MaestroRun first.');
		if (status.phase === 'invalid') {
			throw new Error(`MaestroRun.app at ${status.appPath} failed verification: ${status.detail}`);
		}
		if (status.phase === 'ready') return status;

		await this.deps.openExternal(FULL_DISK_ACCESS_SETTINGS_URL);
		if (opts.reveal) this.deps.showItemInFolder(status.appPath);
		this.startWatching();
		return this.publish({});
	}

	private startWatching(): void {
		this.watchDeadline = this.now() + ACCESS_WATCH_BUDGET_MS;
		if (this.watchTimer) return;
		this.watchTimer = setInterval(
			() => void this.watchTick(),
			this.deps.watchIntervalMs ?? ACCESS_WATCH_INTERVAL_MS
		);
		this.watchTimer.unref?.();
	}

	private async watchTick(): Promise<void> {
		if (this.watchTickRunning) return;
		if (this.now() > this.watchDeadline || !this.deps.isEnabled()) {
			this.stopWatching();
			this.publish({});
			return;
		}
		this.watchTickRunning = true;
		try {
			// A fresh process each time: it is the only way to ask, and each run
			// is judged on the grant as it stands at that moment.
			await this.refresh();
		} catch (err) {
			this.log('warn', `MaestroRun access check failed: ${errorText(err)}`);
		} finally {
			this.watchTickRunning = false;
		}
	}

	stopWatching(): void {
		if (!this.watchTimer) return;
		clearInterval(this.watchTimer);
		this.watchTimer = null;
	}

	/** App shutdown. */
	dispose(): void {
		this.stopWatching();
	}
}
