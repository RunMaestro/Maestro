/**
 * Marketplace Compatibility Helpers
 *
 * Pure functions used by both the main process (install IPC defense-in-depth)
 * and the renderer (tile/detail UI gating) to evaluate whether a marketplace
 * playbook is installable on the running Maestro version, and whether it
 * carries a beta signal.
 */

import semver from 'semver';
import type { MarketplacePlaybook } from './marketplace-types';

/**
 * Normalize a version string for case-insensitive comparison.
 *
 * Maestro's package.json uses uppercase prerelease tags (e.g. "0.16.17-RC")
 * while playbook manifests use lowercase ("0.16.17-rc"). Per semver 2.0,
 * prerelease identifiers are compared as ASCII, so "RC" < "rc" - which would
 * incorrectly gate a `-rc` playbook on an `-RC` build of the same version.
 * Lowercasing both sides before comparison sidesteps this without rolling our
 * own comparator.
 */
function normalize(version: string): string {
	return version.toLowerCase();
}

/**
 * Does the running Maestro version meet a minimum version?
 *
 * The one comparison behind every version gate in the Exchange: a playbook's own
 * `minMaestroVersion` ({@link isCompatible}) and the one inside its `launch` block
 * (`isLaunchAvailable` in `playbookLaunch.ts`). Both gates fail open, so a bad version string
 * can never lock a user out of the Exchange.
 *
 * Returns true when:
 * - No minimum is set, OR
 * - The minimum is not valid semver (treat as no minimum, don't crash exchange), OR
 * - The running version is not valid semver (defensive: don't brick exchange on bad app version), OR
 * - `runningVersion >= minVersion` per semver.gte().
 */
export function meetsMinVersion(minVersion: string | undefined, runningVersion: string): boolean {
	if (!minVersion) return true;

	const min = normalize(minVersion);
	const running = normalize(runningVersion);

	if (!semver.valid(min)) return true;
	if (!semver.valid(running)) return true;

	return semver.gte(running, min);
}

/**
 * Is this playbook installable on the given running Maestro version?
 *
 * Compatible when the running version meets the playbook's `minMaestroVersion`
 * (see {@link meetsMinVersion} for the fail-open rules).
 */
export function isCompatible(playbook: MarketplacePlaybook, runningVersion: string): boolean {
	return meetsMinVersion(playbook.minMaestroVersion, runningVersion);
}

/**
 * Strict beta check - only the literal boolean `true` counts. Anything else
 * (absent, false, "true", "yes", 1, 0) is treated as not-beta. This prevents
 * future contributors from assuming JS truthy-coercion applies.
 */
export function isBeta(playbook: MarketplacePlaybook): boolean {
	return playbook.beta === true;
}
