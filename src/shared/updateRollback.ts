/**
 * Rolling back to an earlier Maestro release.
 *
 * Shared by the main process (which lists the releases and downloads one), the
 * Check for Updates modal (which shows them), and `maestro-cli rollback`. Pure
 * and electron-free so all three can import it.
 *
 * A rollback is an ordinary electron-updater download pointed at an OLDER
 * release's CDN asset directory with `allowDowngrade` switched on for that one
 * download. What makes a release a usable target is therefore not its
 * installer but its channel file (`latest-mac.yml` and friends): that is the
 * file electron-updater reads to find the installer, and a release without one
 * for this platform cannot be installed in place.
 */

import { compareVersions } from './pathUtils';

/** Which page of the Check for Updates modal shows: newer releases, or earlier ones. */
export type UpdateCheckView = 'updates' | 'rollback';

/** How many earlier releases the rollback list offers, newest first. */
export const ROLLBACK_LIST_LIMIT = 15;

/** One release the user can roll back to. */
export interface RollbackRelease {
	tag_name: string;
	name: string;
	body: string;
	html_url: string;
	published_at: string;
	prerelease: boolean;
}

/** What `listRollbackTargets()` returns, over IPC and the CLI bridge alike. */
export interface RollbackTargetsResult {
	currentVersion: string;
	/** Older releases installable on this platform, newest first. */
	releases: RollbackRelease[];
	releasesUrl: string;
	error?: string;
}

/**
 * A release tag safe to splice into a download URL: `v1.2.3` or `1.2.3`, with
 * an optional prerelease suffix (`v1.1.2-RC`). Anything else is refused before
 * it reaches the feed URL, so a crafted "tag" can never point the updater at a
 * different path.
 */
const RELEASE_TAG_PATTERN = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export function isReleaseTag(tag: string): boolean {
	return RELEASE_TAG_PATTERN.test(tag);
}

/** `1.0.3` and `v1.0.3` both name the tag `v1.0.3`. */
export function normalizeReleaseTag(version: string): string {
	const trimmed = version.trim();
	return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

/** True when `tag` is a valid release tag strictly older than `currentVersion`. */
export function isRollbackTarget(tag: string, currentVersion: string): boolean {
	return isReleaseTag(tag) && compareVersions(tag, currentVersion) < 0;
}

/**
 * The electron-updater channel file a release must carry for this platform.
 * electron-builder publishes `latest.yml` for Windows, `latest-mac.yml` for
 * macOS (both architectures in one file), and one Linux file per architecture.
 * Returns null on a platform electron-updater does not serve.
 */
export function updaterChannelFile(platform: string, arch: string): string | null {
	switch (platform) {
		case 'darwin':
			return 'latest-mac.yml';
		case 'win32':
			return 'latest.yml';
		case 'linux':
			return arch === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml';
		default:
			return null;
	}
}

/**
 * The subtitle a release carries beyond its tag. Release names are written as
 * `v1.0.4 | Red Pen`, `v1.0.4 - Red Pen`, or just `Red Pen`; this returns
 * `Red Pen` for all three, and null when the name only repeats the tag.
 */
export function releaseDisplayName(name: string | null | undefined, tag: string): string | null {
	if (!name || name === tag) return null;
	const lowerTag = tag.toLowerCase();

	const pipeIndex = name.indexOf('|');
	if (pipeIndex !== -1 && name.substring(0, pipeIndex).trim().toLowerCase() === lowerTag) {
		return name.substring(pipeIndex + 1).trim() || null;
	}
	const dashIndex = name.indexOf(' - ');
	if (dashIndex !== -1 && name.substring(0, dashIndex).trim().toLowerCase() === lowerTag) {
		return name.substring(dashIndex + 3).trim() || null;
	}
	if (name.toLowerCase().startsWith(lowerTag)) {
		const remainder = name.substring(tag.length).trim();
		if (remainder.startsWith('|') || remainder.startsWith('-')) {
			return remainder.substring(1).trim() || null;
		}
		return remainder || null;
	}
	return name;
}
