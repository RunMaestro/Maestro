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
 * Is this playbook installable on the given running Maestro version?
 *
 * Returns true (compatible) when:
 * - No `minMaestroVersion` is set, OR
 * - The minimum is not valid semver (treat as no minimum, don't crash exchange), OR
 * - The running version is not valid semver (defensive: don't brick exchange on bad app version), OR
 * - `runningVersion >= minMaestroVersion` per semver.gte().
 */
export function isCompatible(playbook: MarketplacePlaybook, runningVersion: string): boolean {
	if (!playbook.minMaestroVersion) return true;

	const min = normalize(playbook.minMaestroVersion);
	const running = normalize(runningVersion);

	if (!semver.valid(min)) return true;
	if (!semver.valid(running)) return true;

	return semver.gte(running, min);
}

/**
 * Strict beta check - only the literal boolean `true` counts. Anything else
 * (absent, false, "true", "yes", 1, 0) is treated as not-beta. This prevents
 * future contributors from assuming JS truthy-coercion applies.
 */
export function isBeta(playbook: MarketplacePlaybook): boolean {
	return playbook.beta === true;
}
