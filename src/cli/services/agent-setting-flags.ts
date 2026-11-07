/**
 * The per-agent setting flags `update-agent` and `update-group-settings` share,
 * read into the patch the app applies:
 *
 *   --nudge, --new-session-message, --custom-path, --custom-args, --env,
 *   --clear-env, --gateway-url, --proxy-mode, --tier, --background-requests,
 *   --system-one, --model, --effort, --context-window, --token-source,
 *   --maestro-p-path, --codex-transport, --bookmark,
 *   --retry-on-availability, --retry-on-token-exhaustion, --codex-auto-reset,
 *   --additional-dir, --clear-additional-dirs, --env-park, --env-unpark
 *   --ssh-remote, --ssh-cwd, --sync-history-to-remote,
 *   --share-history-to-project-dir  (the SSH patch)
 *
 * `update-agent` registers all of them. `update-group-settings` registers the
 * ones a group's defaults hold, so a flag it does not offer is never read.
 *
 * Only the spelling is read here. Whether a value is acceptable for a provider
 * is judged by the app, with the validators the Edit Agent dialog and Group
 * Settings save with, so a flag and a click cannot store different things.
 *
 * A group's defaults are keyed by the same names an agent's record is, which is
 * why one reader serves both verbs.
 */

import { toClaudeTokenModeSource, type ClaudeTokenMode } from '../../shared/claudeTokenMode';
import { CODEX_TRANSPORTS, isCodexTransport } from '../../shared/codexTransport';
import { parseBackgroundRequestsSpec } from '../../shared/local-models/background-requests';
import { asTokenProxyMode, TOKEN_PROXY_MODES } from '../../shared/local-models/token-proxy';
import { parseTierAssignment, type TierTarget } from '../../shared/modelTiers';
import { parseAdditionalDirFlag, type EnvParkEdits } from '../../shared/agentConfigExtras';
import { isInheritValue, parseCliBool } from '../utils/parse';

/** The commander options the setting flags populate. */
export interface AgentSettingFlagOptions {
	nudge?: string;
	peerDescription?: string;
	newSessionMessage?: string;
	customPath?: string;
	customArgs?: string;
	env?: string[];
	clearEnv?: boolean;
	gatewayUrl?: string;
	proxyMode?: string;
	tier?: string[];
	backgroundRequests?: string;
	systemOne?: string;
	model?: string;
	effort?: string;
	contextWindow?: string;
	tokenSource?: string;
	maestroPPath?: string;
	codexTransport?: string;
	bookmark?: string;
	retryOnAvailability?: string;
	retryOnTokenExhaustion?: string;
	codexAutoReset?: string;
	additionalDir?: string[];
	clearAdditionalDirs?: boolean;
	envPark?: string[];
	envUnpark?: string[];
}

/** The commander options the SSH flags populate. */
export interface SshFlagOptions {
	sshRemote?: string;
	sshCwd?: string;
	syncHistoryToRemote?: string;
	shareHistoryToProjectDir?: string;
}

/** Whether any SSH flag was passed. */
export function hasSshFlags(options: SshFlagOptions): boolean {
	return (
		options.sshRemote !== undefined ||
		options.sshCwd !== undefined ||
		options.syncHistoryToRemote !== undefined ||
		options.shareHistoryToProjectDir !== undefined
	);
}

/**
 * Build the SSH patch from the SSH flags. Only keys the caller touched are
 * included, so the app merges rather than clobbers. Throws on a malformed value.
 */
export function buildSshPatch(options: SshFlagOptions): Record<string, unknown> {
	const sshPatch: Record<string, unknown> = {};
	if (options.sshRemote !== undefined) {
		const raw = options.sshRemote.trim();
		if (raw === '' || raw.toLowerCase() === 'none' || raw.toLowerCase() === 'null') {
			// Revert to local execution; preserve other fields via the merge.
			sshPatch.enabled = false;
			sshPatch.remoteId = null;
		} else {
			sshPatch.enabled = true;
			sshPatch.remoteId = raw;
		}
	}
	if (options.sshCwd !== undefined) {
		sshPatch.workingDirOverride = options.sshCwd;
	}
	if (options.syncHistoryToRemote !== undefined) {
		sshPatch.syncHistory = parseCliBool(options.syncHistoryToRemote, '--sync-history-to-remote');
	}
	// Independent of whether a remote is enabled: it mirrors History into the
	// local project's `.maestro/history/`, for an agent another Maestro controls.
	// It rides in the SSH block because that is where the agent record keeps it.
	if (options.shareHistoryToProjectDir !== undefined) {
		sshPatch.shareHistoryToProjectDir = parseCliBool(
			options.shareHistoryToProjectDir,
			'--share-history-to-project-dir'
		);
	}
	return sshPatch;
}

// Parse repeatable `--env KEY=VALUE` flags into a map. The provided set REPLACES
// the agent's customEnvVars (matching create-agent semantics); use --clear-env to
// empty it. Throws on a malformed entry.
export function parseEnvVars(entries: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const entry of entries) {
		const eq = entry.indexOf('=');
		if (eq <= 0) {
			throw new Error(`Invalid --env "${entry}". Use KEY=VALUE (e.g. FOO=bar).`);
		}
		out[entry.slice(0, eq).trim()] = entry.slice(eq + 1);
	}
	return out;
}

// Build the per-session config patch from the editable flags. Only keys the
// caller touched are included. A `null` value clears the field on the renderer
// side; for string fields an empty value (e.g. `--nudge ""`) maps to null.
// `--bookmark` rides along here because it goes through the same allowlisted
// `update_session_config` message, even though it is UI state rather than a
// spawn-time setting.
export function buildConfigPatch(
	options: AgentSettingFlagOptions
): Record<string, unknown> | undefined {
	const patch: Record<string, unknown> = {};
	const strField = (value: string | undefined, key: string) => {
		if (value === undefined) return;
		patch[key] = value.trim() === '' ? null : value;
	};

	strField(options.nudge, 'nudgeMessage');
	strField(options.peerDescription, 'peerDescription');
	strField(options.newSessionMessage, 'newSessionMessage');
	strField(options.customPath, 'customPath');
	strField(options.customArgs, 'customArgs');
	strField(options.model, 'customModel');
	strField(options.effort, 'customEffort');
	strField(options.maestroPPath, 'maestroPPath');

	if (options.bookmark !== undefined) {
		patch.bookmarked = parseCliBool(options.bookmark, '--bookmark');
	}

	if (options.clearEnv) {
		patch.customEnvVars = {};
	} else if (options.env && options.env.length > 0) {
		patch.customEnvVars = parseEnvVars(options.env);
	}

	// `--gateway-url <url|none>`. Only the clear is decided here; a URL is
	// validated against the agent's provider once the agent has been read (see
	// updateAgent), because which providers can use a gateway is per provider.
	if (options.gatewayUrl !== undefined) {
		const raw = options.gatewayUrl.trim();
		patch.gatewayUrl = raw === '' || raw.toLowerCase() === 'none' ? null : raw;
	}

	// `--proxy-mode <off|passthrough|compress|compress-early>`: how the Maestro token proxy
	// carries this agent's requests. The app points the agent's gateway at the
	// proxy (or clears it for `off`), so the two flags cannot be combined.
	if (options.proxyMode !== undefined) {
		const mode = asTokenProxyMode(options.proxyMode.trim().toLowerCase());
		if (!mode) {
			throw new Error(
				`--proxy-mode expects ${TOKEN_PROXY_MODES.join(', ')}, got "${options.proxyMode}"`
			);
		}
		if (options.gatewayUrl !== undefined) {
			throw new Error(
				'Use --proxy-mode or --gateway-url, not both: the proxy mode chooses the gateway URL.'
			);
		}
		patch.tokenProxyMode = mode;
	}

	// `--tier <tier>=<target>` (repeatable): a patch with one entry per tier
	// named, `null` for `default`. Only the spelling is read here; each target
	// is checked against the agent's provider and the saved sources once the
	// agent has been read (see updateAgent), and the app merges the patch onto
	// the tiers the agent already holds.
	if (options.tier && options.tier.length > 0) {
		const tiers: Record<string, TierTarget | null> = {};
		for (const entry of options.tier) {
			const assignment = parseTierAssignment(entry);
			if (!assignment.ok) throw new Error(`--tier: ${assignment.error}`);
			if (assignment.tier in tiers) {
				throw new Error(`--tier: the "${assignment.tier}" tier is set more than once.`);
			}
			tiers[assignment.tier] = assignment.target ?? null;
		}
		patch.tierTargets = tiers;
	}

	// `--background-requests <source id>:<model>|none`: where the token proxy
	// sends this agent's side requests. `none` turns it off (`null` on the
	// wire). Checked against the agent once it has been read.
	if (options.backgroundRequests !== undefined) {
		const parsed = parseBackgroundRequestsSpec(options.backgroundRequests);
		if (!parsed.ok) throw new Error(`--background-requests: ${parsed.error}`);
		patch.backgroundRequests = parsed.backgroundRequests ?? null;
	}

	// `--system-one <on|off>`: the Models tab's System One switch. On is the
	// absence of the opt-out (`null` on the wire), so the agent follows "Let
	// agents use System One"; off stores the opt-out for this agent only.
	if (options.systemOne !== undefined) {
		const word = options.systemOne.trim().toLowerCase();
		if (word !== 'on' && word !== 'off') {
			throw new Error(`--system-one expects on or off, got "${options.systemOne}"`);
		}
		patch.systemOneOptOut = word === 'off' ? true : null;
	}

	if (options.contextWindow !== undefined) {
		const raw = options.contextWindow.trim().toLowerCase();
		if (raw === '' || raw === 'none' || raw === '0') {
			patch.customContextWindow = null;
			// Clearing the value clears its provenance with it.
			patch.contextWindowSource = null;
		} else {
			const n = Number(raw);
			if (!Number.isFinite(n) || n < 0) {
				throw new Error(
					`--context-window expects a positive number, got "${options.contextWindow}"`
				);
			}
			patch.customContextWindow = Math.floor(n);
			// Typing `--context-window` is unambiguously a deliberate choice, so it
			// outranks a provider-reported window (finding AD1). No seed to compare
			// against here, unlike the edit modal.
			patch.contextWindowSource = 'user-edited';
		}
	}

	if (options.tokenSource !== undefined) {
		const mode = options.tokenSource.trim().toLowerCase();
		if (mode !== 'api' && mode !== 'tui' && mode !== 'dynamic') {
			throw new Error(`--token-source expects api, tui, or dynamic, got "${options.tokenSource}"`);
		}
		// Map the friendly tri-state to the stored (enableMaestroP, maestroPMode)
		// pair so every spawn surface reads it consistently. tui -> interactive.
		const canonical: ClaudeTokenMode = mode === 'tui' ? 'interactive' : mode;
		const encoded = toClaudeTokenModeSource(canonical);
		patch.enableMaestroP = encoded.enableMaestroP;
		patch.maestroPMode = encoded.maestroPMode;
	}

	if (options.codexTransport !== undefined) {
		const transport = options.codexTransport.trim().toLowerCase();
		if (!isCodexTransport(transport)) {
			throw new Error(
				`--codex-transport expects ${CODEX_TRANSPORTS.join(' or ')}, got "${options.codexTransport}"`
			);
		}
		// Only the opt-in is stored; `exec` clears the field, matching the Edit
		// Agent modal, where Standard leaves `codexTransport` unset.
		patch.codexTransport = transport === 'app-server' ? transport : null;
	}

	// The Agent Resilience switches and the Codex auto reset: on, off, or
	// `default` to drop the choice (`null` on the wire). The two retries are on
	// by default, so `default` and `false` are different things.
	for (const [value, flag, key] of [
		[options.retryOnAvailability, '--retry-on-availability', 'retryOnAvailabilityErrors'],
		[options.retryOnTokenExhaustion, '--retry-on-token-exhaustion', 'retryOnTokenExhaustion'],
		[options.codexAutoReset, '--codex-auto-reset', 'codexAutoResetOnExhaustion'],
	] as const) {
		if (value === undefined) continue;
		patch[key] = isInheritValue(value.trim().toLowerCase()) ? null : parseCliBool(value, flag);
	}

	// `--additional-dir <path>[:<r|w|rw>]` (repeatable). Like `--env`, the set
	// given REPLACES the agent's list; `--clear-additional-dirs` empties it.
	if (options.clearAdditionalDirs) {
		if (options.additionalDir?.length) {
			throw new Error('Use --additional-dir or --clear-additional-dirs, not both.');
		}
		patch.additionalDirectories = null;
	} else if (options.additionalDir && options.additionalDir.length > 0) {
		patch.additionalDirectories = options.additionalDir.map(parseAdditionalDirFlag);
	}

	// `--env-park KEY` / `--env-unpark KEY` (repeatable): the eye button on an
	// environment variable row. The app moves the names between the live and the
	// parked record, so it is refused beside a flag that replaces the live one.
	const park = options.envPark ?? [];
	const unpark = options.envUnpark ?? [];
	if (park.length > 0 || unpark.length > 0) {
		if (options.clearEnv || (options.env && options.env.length > 0)) {
			throw new Error(
				'--env-park and --env-unpark cannot be combined with --env or --clear-env: those replace the variables being parked.'
			);
		}
		const edits: EnvParkEdits = {};
		if (park.length > 0) edits.park = park;
		if (unpark.length > 0) edits.unpark = unpark;
		patch.envParkEdits = edits;
	}

	return Object.keys(patch).length > 0 ? patch : undefined;
}
