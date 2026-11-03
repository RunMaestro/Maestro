// Encore Features commands - list and toggle Maestro's optional features in the
// running desktop app. Toggling routes through the set_setting
// WS message (key: encoreFeatures), so changes apply live and persist. Mirrors
// the Settings > Plugins toggles.

import { ENCORE_FEATURE_DEFAULTS, resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import {
	FIRST_PARTY_PLUGINS,
	isFirstPartyPluginAvailableOn,
	type FirstPartyEncoreFlag,
} from '../../shared/plugins/first-party';
import { readSettingValue } from '../services/storage';
import { encoreFeatureName, type EncoreFlag } from '../utils/encore-gate';
import {
	sendSimpleCommand,
	reportResult,
	failCommand,
	exitIfMaestroNotRunning,
} from '../services/session-command';

// Feature ID -> display name. Keys come from ENCORE_FEATURE_DEFAULTS, so every
// flag the app knows is listed and accepted; names are the Plugins tab's. A
// hand-kept list here once knew 9 of the 15 flags.
const FEATURES: Record<string, string> = Object.fromEntries(
	(Object.keys(ENCORE_FEATURE_DEFAULTS) as EncoreFlag[]).map((key) => [key, encoreFeatureName(key)])
);

// Aliases let an agent say "symphony" or "cue". Any key also matches with its
// hyphens dropped (`groups-plus`, `web-login`). Group Chat is a core feature
// with no Encore flag, so it has no alias here: mapping it to Symphony once
// made `encore disable group-chat` turn off the wrong feature.
const ALIASES: Record<string, string> = {
	'director-notes': 'directorNotes',
	directornotes: 'directorNotes',
	notes: 'directorNotes',
	'usage-stats': 'usageStats',
	usagestats: 'usageStats',
	usage: 'usageStats',
	stats: 'usageStats',
	dashboard: 'usageStats',
	'maestro-symphony': 'symphony',
	cue: 'maestroCue',
	maestrocue: 'maestroCue',
	'auto-pilot': 'pianola',
	autopilot: 'pianola',
	pilot: 'pianola',
	manager: 'pianola',
	'manager-agent': 'pianola',
	'computer-history': 'computerHistory',
	computerhistory: 'computerHistory',
	'screen-history': 'computerHistory',
	'quick-chat': 'quickChat',
	quickchat: 'quickChat',
	'maestro-run': 'maestroRun',
	maestrorun: 'maestroRun',
	'throughput-gauge': 'throughputGauge',
	throughputgauge: 'throughputGauge',
	throughput: 'throughputGauge',
	gauge: 'throughputGauge',
	tps: 'throughputGauge',
};

interface EncoreOptions {
	json?: boolean;
}

/** Whether `key` exists on this operating system (a feature with no platform list exists everywhere). */
function isAvailableHere(key: string): boolean {
	const definition = FIRST_PARTY_PLUGINS[key as FirstPartyEncoreFlag];
	return !definition || isFirstPartyPluginAvailableOn(definition, process.platform);
}

/** The features this machine can run: the ones listed and accepted by `enable`. */
function availableFeatureKeys(): string[] {
	return Object.keys(FEATURES).filter(isAvailableHere);
}

function readFlags(): Record<string, boolean> {
	// Resolve against the shared defaults, not against `false`: on an install
	// where the user has never opened the Encore tab nothing is persisted yet,
	// and reporting every feature as off would contradict the running app.
	const resolved = resolveEncoreFeatures(readSettingValue('encoreFeatures'));
	const flags: Record<string, boolean> = {};
	for (const key of availableFeatureKeys()) {
		flags[key] = resolved[key as keyof typeof resolved];
	}
	return flags;
}

function resolveFeature(input: string): string | null {
	const q = input.trim();
	if (FEATURES[q]) return q;
	const lower = q.toLowerCase();
	if (ALIASES[lower]) return ALIASES[lower];
	// Case-insensitive match on canonical keys, hyphens ignored (`groups-plus`).
	const bare = lower.replace(/-/g, '');
	const direct = Object.keys(FEATURES).find((k) => k.toLowerCase() === bare);
	return direct ?? null;
}

export function encoreList(options: EncoreOptions): void {
	const flags = readFlags();
	const autoFixEnabled = readSettingValue('pianolaAutoFixEnabled') === true;
	const pianola = {
		mode: !flags.pianola ? 'disabled' : autoFixEnabled ? 'automatic_repairs' : 'supervision',
		autoFixEnabled,
		automaticMergeAvailable: false,
	};
	if (options.json) {
		console.log(JSON.stringify({ features: flags, pianola }));
		return;
	}
	console.log('Encore Features:');
	for (const key of availableFeatureKeys()) {
		const label = FEATURES[key];
		console.log(
			`  ${flags[key] ? 'on ' : 'off'}  ${key}${' '.repeat(Math.max(1, 16 - key.length))}${label}`
		);
	}
	console.log(`  Pianola mode: ${pianola.mode}. Automatic merge is unavailable.`);
}

/** Toggle one supported Encore feature while preserving the desktop's other saved flags. */
export async function encoreSet(
	feature: string,
	enabled: boolean,
	options: EncoreOptions
): Promise<void> {
	const key = resolveFeature(feature);
	if (!key) {
		failCommand(
			`Unknown Encore feature "${feature}". Valid features: ${availableFeatureKeys().join(', ')}.`,
			options.json
		);
	}

	// A feature that does not exist on this OS cannot be switched on. The CLI
	// runs on the same machine as the app, so its own platform is the host's.
	if (enabled && !isAvailableHere(key)) {
		failCommand(`${FEATURES[key]} is not available on this operating system.`, options.json);
	}

	// The desktop replaces the whole object, so retain flags outside this
	// command's target list (including flags introduced by a newer desktop).
	const storedFlags = readSettingValue('encoreFeatures');
	const flags: Record<string, unknown> = {
		...(storedFlags && typeof storedFlags === 'object' && !Array.isArray(storedFlags)
			? storedFlags
			: {}),
		...resolveEncoreFeatures(storedFlags),
	};
	flags[key] = enabled;

	const note =
		key === 'pianola' && ['autopilot', 'auto-pilot', 'pilot'].includes(feature.trim().toLowerCase())
			? 'Autopilot is an alias for Pianola. Automatic repairs require the separate pianolaAutoFixEnabled setting; automatic merge is unavailable.'
			: undefined;
	try {
		const result = await sendSimpleCommand(
			{ type: 'set_setting', key: 'encoreFeatures', value: flags },
			'set_setting_result'
		);
		reportResult(result, {
			json: options.json,
			successMessage: `${enabled ? 'Enabled' : 'Disabled'} Encore feature: ${FEATURES[key]}${note ? `. ${note}` : ''}`,
			jsonExtra: { feature: key, enabled, ...(note ? { note } : {}) },
		});
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}
