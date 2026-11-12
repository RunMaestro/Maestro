/**
 * Launch offer - whether the Exchange offers Launch for a playbook, before any agent is chosen.
 *
 * The Exchange asks this for every playbook it draws (the tile's badge, the detail view's footer),
 * so the module imports shared code only: nothing here may pull in sessions, stores or services.
 * The agent-dependent half of the gate is in `launchAgents.ts`, which shares `specForPlatform()`.
 */

import { isCompatible } from '../../../../shared/marketplace-compatibility';
import type { MarketplacePlaybook, PlaybookLaunchSpec } from '../../../../shared/marketplace-types';
import { isLaunchAvailable } from '../../../../shared/playbookLaunch';

/** The same spec with the platform list emptied, which restricts nothing. */
function withoutPlatformList(spec: PlaybookLaunchSpec): PlaybookLaunchSpec {
	if (!spec.preconditions?.platforms) return spec;
	return { ...spec, preconditions: { ...spec.preconditions, platforms: [] } };
}

/**
 * The spec as this client should judge it: an unknown host platform (`''`, a web-desktop browser)
 * restricts nothing, because main checks the platform again at launch.
 */
export function specForPlatform(spec: PlaybookLaunchSpec, platform: string): PlaybookLaunchSpec {
	return platform === '' ? withoutPlatformList(spec) : spec;
}

/**
 * What the Exchange offers beside Download for one playbook.
 *
 * - `none`: the playbook has no `launch` block, so the Exchange is exactly what it was.
 * - `available`: Launch is offered.
 * - `unavailable`: the playbook has a `launch` block but cannot launch on this machine. Download
 *   stays; `reason` is a sentence for a tooltip.
 */
export type LaunchOffer =
	| { status: 'none' }
	| { status: 'available' }
	| { status: 'unavailable'; reason: string };

/**
 * Whether the Exchange offers Launch for a playbook: its tile badge and its detail view's primary
 * button. The same gate as the dialog's, minus the parts that need an agent (`maestro-cli` on a
 * remote or not installed), which the dialog explains once an agent is chosen. On top of the
 * block's own checks it applies the playbook's top-level `minMaestroVersion`
 * (`isCompatible()`): `isLaunchAvailable()` does not read it, because Download is gated on it, and
 * a playbook this Maestro cannot import cannot launch either.
 *
 * `platform` is `hostPlatform()`, or `''` when the client cannot tell.
 */
export function getLaunchOffer(
	playbook: MarketplacePlaybook,
	runningVersion: string,
	platform: string
): LaunchOffer {
	const spec = playbook.launch;
	if (!spec) return { status: 'none' };
	if (!isCompatible(playbook, runningVersion)) {
		return {
			status: 'unavailable',
			reason: `Update Maestro to ${playbook.minMaestroVersion} or newer to launch this playbook.`,
		};
	}
	// The block's own Maestro version and the OS. `maestro-cli` needs an agent, so it is not asked.
	const machine = isLaunchAvailable(
		{ launch: specForPlatform(spec, platform) },
		runningVersion,
		platform
	);
	return machine.available
		? { status: 'available' }
		: { status: 'unavailable', reason: machine.reason ?? 'This playbook cannot launch here.' };
}
