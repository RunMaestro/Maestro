/**
 * MaestroRun - the parts of its published contract Maestro codes against.
 *
 * MaestroRun (https://github.com/RunMaestro/MaestroRun) is a separate, Developer
 * ID signed macOS launcher that holds the user's Full Disk Access grant and runs
 * approved scripts with it. Everything here mirrors `docs/CONTRACT.md` in that
 * repository: identity, release asset names, the checksum file, version format,
 * and `doctor` output. Pure and bundle-safe (no fs, no Electron), so the main
 * process, the CLI, and the tests share one reading of the contract.
 */

export const MAESTRO_RUN_BUNDLE_ID = 'com.maestro.run';
export const MAESTRO_RUN_TEAM_ID = '4N4DQ24LED';
export const MAESTRO_RUN_REPO = 'RunMaestro/MaestroRun';
export const MAESTRO_RUN_APP_NAME = 'MaestroRun.app';

/**
 * The code requirement that ties a bundle to its publisher. macOS stores the
 * privacy grant under this identifier and team, so a bundle that fails it is
 * not MaestroRun, whatever it is named.
 */
export const MAESTRO_RUN_CODE_REQUIREMENT = `identifier "${MAESTRO_RUN_BUNDLE_ID}" and anchor apple generic and certificate leaf[subject.OU] = "${MAESTRO_RUN_TEAM_ID}"`;

/**
 * The newest MaestroRun major version this Maestro build knows how to drive.
 * The contract changes only with a major version, so a release past this
 * ceiling is skipped until Maestro itself is updated.
 */
export const MAESTRO_RUN_MAX_SUPPORTED_MAJOR = 1;

/** One archive per hardware architecture; there is no universal build. */
export type MaestroRunArch = 'arm64' | 'x86_64';

export type MaestroRunVersion = readonly [number, number, number];

/** `MAJOR.MINOR.PATCH`, three decimal numbers, no prefix and no suffix. */
export function parseMaestroRunVersion(text: string): MaestroRunVersion | null {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
	if (!match) return null;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric, field by field. Negative when `a` is older than `b`. */
export function compareMaestroRunVersions(a: MaestroRunVersion, b: MaestroRunVersion): number {
	for (let i = 0; i < 3; i++) {
		if (a[i] !== b[i]) return a[i] - b[i];
	}
	return 0;
}

export function maestroRunArchiveName(version: string, arch: MaestroRunArch): string {
	return `MaestroRun-${version}-macos-${arch}.zip`;
}

/** `<app>/Contents/MacOS/maestro-run`, the path that goes in a job definition. */
export function maestroRunBinaryPath(appPath: string): string {
	return `${appPath}/Contents/MacOS/maestro-run`;
}

/**
 * Where a copy may live, in the order Maestro looks. The first is where Maestro
 * installs (no admin rights needed); the second is adopted when the user put a
 * copy there by hand, so Maestro never adds a second one beside it.
 */
export function maestroRunAppCandidates(homeDir: string): string[] {
	return [
		`${homeDir}/Applications/${MAESTRO_RUN_APP_NAME}`,
		`/Applications/${MAESTRO_RUN_APP_NAME}`,
	];
}

/** The slice of a GitHub release object the picker reads. */
export interface MaestroRunReleaseLike {
	tag_name?: unknown;
	draft?: unknown;
	prerelease?: unknown;
	assets?: unknown;
}

export interface MaestroRunReleasePick {
	version: string;
	archiveName: string;
	archiveUrl: string;
	checksumUrl: string;
}

function assetUrl(assets: unknown, name: string): string | null {
	if (!Array.isArray(assets)) return null;
	for (const asset of assets) {
		if (!asset || typeof asset !== 'object') continue;
		const { name: assetName, browser_download_url: url } = asset as Record<string, unknown>;
		if (assetName === name && typeof url === 'string' && url) return url;
	}
	return null;
}

/**
 * The release to install: the highest published version within the supported
 * major that carries BOTH the archive and its checksum for this architecture.
 * Drafts, prereleases, tags that are not `v<version>`, and releases with a
 * missing asset are skipped rather than half-trusted.
 */
export function pickMaestroRunRelease(
	releases: readonly MaestroRunReleaseLike[],
	arch: MaestroRunArch,
	maxMajor: number = MAESTRO_RUN_MAX_SUPPORTED_MAJOR
): MaestroRunReleasePick | null {
	let best: { parsed: MaestroRunVersion; pick: MaestroRunReleasePick } | null = null;
	for (const release of releases) {
		if (!release || release.draft === true || release.prerelease === true) continue;
		if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) continue;
		const version = release.tag_name.slice(1);
		const parsed = parseMaestroRunVersion(version);
		if (!parsed || parsed[0] > maxMajor) continue;
		const archiveName = maestroRunArchiveName(version, arch);
		const archiveUrl = assetUrl(release.assets, archiveName);
		const checksumUrl = assetUrl(release.assets, `${archiveName}.sha256`);
		if (!archiveUrl || !checksumUrl) continue;
		if (best && compareMaestroRunVersions(parsed, best.parsed) <= 0) continue;
		best = { parsed, pick: { version, archiveName, archiveUrl, checksumUrl } };
	}
	return best?.pick ?? null;
}

/**
 * The digest from a `shasum -a 256` line: 64 lowercase hex characters, two
 * spaces, the archive file name. A line naming another file is not accepted.
 */
export function parseMaestroRunChecksum(text: string, archiveName: string): string | null {
	for (const line of text.split('\n')) {
		const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line.trimEnd());
		if (match && match[2] === archiveName) return match[1];
	}
	return null;
}

export type MaestroRunFullDiskAccess = 'granted' | 'not-granted' | 'unknown';

export interface MaestroRunDoctorReport {
	fullDiskAccess: MaestroRunFullDiskAccess;
	/** `self`, a process name with a pid, or `unknown`. */
	responsibleProcess: string;
}

/**
 * `doctor` prints `key: value` lines. Only the values of `full-disk-access` and
 * `responsible-process` are promised, so those are the only two read.
 */
export function parseMaestroRunDoctor(stdout: string): MaestroRunDoctorReport {
	const values = new Map<string, string>();
	for (const line of stdout.split('\n')) {
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
	}
	const access = values.get('full-disk-access');
	return {
		fullDiskAccess: access === 'granted' || access === 'not-granted' ? access : 'unknown',
		responsibleProcess: values.get('responsible-process') || 'unknown',
	};
}

/**
 * Whether a `doctor` run proves the launcher holds Full Disk Access ITSELF.
 *
 * All three must hold. `responsible-process: self` is the one that is easy to
 * drop: when the launcher cannot disclaim responsibility it inherits the grant
 * of whatever started it, and Maestro may hold one, so `granted` alone would
 * be a false positive for a launchd or cron job.
 */
export function doctorProvesAccess(
	exitCode: number | string,
	report: MaestroRunDoctorReport
): boolean {
	return (
		exitCode === 0 && report.fullDiskAccess === 'granted' && report.responsibleProcess === 'self'
	);
}
