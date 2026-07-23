/**
 * Maestro Plugin Host API contract version.
 *
 * This is the SINGLE source of truth for the version of the host surface that
 * plugins are written against. It becomes a permanent, semver-managed public
 * contract the moment the first plugin ships (Track B Phase 1), so treat any
 * change here with the same care as a breaking API change:
 *
 * - Bump the PATCH when fixing a bug in host behavior that does not change the
 *   shape of what plugins can rely on.
 * - Bump the MINOR when ADDING a contribution point, manifest field, or host
 *   capability in a backward-compatible way (older plugins keep working).
 * - Bump the MAJOR when REMOVING or changing the meaning of any existing
 *   contribution point, manifest field, or host capability.
 *
 * A plugin declares the minimum host API it needs via `maestro.minHostApi` in
 * its plugin.json. The host loads the plugin only when its own version
 * satisfies that minimum (same-major, host >= min). See isHostApiCompatible.
 */

import semver from 'semver';

/**
 * The host API version this Maestro build implements. Bumped to 1.15.0 for the
 * additive Board event topics `board.cardStatusChanged` / `board.cardCompleted`
 * / `board.cardBlocked` / `board.decomposed` (metadata-only: ids, statuses, and
 * the card title; never prompts, run output, summaries, or block reasons).
 * 1.14.0 added the backward-compatible additive `tool.executed` event topic
 * (metadata-only tool lifecycle: name + timing, never arguments or results)
 * plus the `ui.panelPost` host-to-panel push method (own-panels-only,
 * JSON-only, MAX_PANEL_POST_BYTES cap). 1.13.0 added the additive
 * host-mediated `PluginUiSurface` registry and trusted-chrome guard. 1.12.0
 * added the backward-compatible additive `net:connect` capability plus its
 * `net.connect` / `net.send` / `net.close` host methods (hold an outbound
 * persistent websocket to a host scope, e.g. a Discord/Slack gateway;
 * egress-classified). 1.11.0 added virtual `groupings` contributions and the
 * presentation-only `ui:grouping` publish/clear methods; 1.10.0 added the
 * backward-compatible, data-only `iconPacks` contribution; 1.9.0 added
 * host-rendered `hostViews`, their `ui:hostView` capability, and the
 * `ui.hostViewUpdate` / `ui.hostViewRemove` RPC methods; 1.8.0 added
 * `background.list`; 1.7.0 added history/session/tab/transcript
 * write/decision/shell/storage SQL/fs watch/power/background capabilities plus
 * `history.entryAdded` and metadata-only `agent.completed` events; 1.6.0 added
 * `cue.runStarted` / `cue.runFinished`; 1.5.0 added `agent.exited` /
 * `agent.error` / `usage.updated` / `run.completed` + functional
 * `sidebar`/`activity-bar`/`toolbar` uiItem surfaces; 1.4.0 added the
 * `ui:contribute` / `ui:panel` / `ui:render-unsafe` UI capabilities; 1.3.0
 * added `tools` + `keybindings`; 1.2.0 added `transcripts:read`.
 */
export const HOST_API_VERSION = '1.15.0';

/** Result of checking a plugin's declared host-API requirement. */
export interface HostApiCompatibility {
	compatible: boolean;
	/** Human-readable reason when not compatible (empty when compatible). */
	reason: string;
}

/**
 * Is a plugin requiring `minHostApi` loadable on a host running `hostVersion`?
 *
 * Rules (deliberately strict so a plugin built for a future/older major never
 * silently half-works):
 * - `minHostApi` absent / empty => compatible (plugin pins no minimum).
 * - `minHostApi` not valid semver => NOT compatible (manifest is malformed; we
 *   refuse rather than guess, unlike the marketplace's lenient gate, because a
 *   plugin can execute against this contract).
 * - Major versions must match exactly (a v2 host does not run v1-targeted
 *   plugins and vice versa).
 * - Within the same major, host must be >= the declared minimum.
 */
export function isHostApiCompatible(
	minHostApi: string | undefined,
	hostVersion: string = HOST_API_VERSION
): HostApiCompatibility {
	if (!minHostApi || minHostApi.trim() === '') {
		return { compatible: true, reason: '' };
	}
	const min = minHostApi.trim();
	if (!semver.valid(min)) {
		return {
			compatible: false,
			reason: `minHostApi "${minHostApi}" is not a valid semver version`,
		};
	}
	if (!semver.valid(hostVersion)) {
		// Defensive: a malformed host version is a build bug, not a plugin bug.
		return { compatible: false, reason: `host API version "${hostVersion}" is not valid semver` };
	}
	if (semver.major(min) !== semver.major(hostVersion)) {
		return {
			compatible: false,
			reason: `plugin needs host API major ${semver.major(min)}, host provides ${semver.major(
				hostVersion
			)}`,
		};
	}
	if (semver.gt(min, hostVersion)) {
		return {
			compatible: false,
			reason: `plugin needs host API >= ${min}, host provides ${hostVersion}`,
		};
	}
	return { compatible: true, reason: '' };
}
