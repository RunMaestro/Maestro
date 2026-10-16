// Encore Features commands - list and toggle Maestro's Encore Features in the
// running desktop app. Toggling routes through the set_setting
// WS message (key: encoreFeatures), so changes apply live and persist. Mirrors
// the Settings -> Encore Features toggles.

import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import {
	FIRST_PARTY_PLUGINS,
	isFirstPartyPluginAvailableOn,
	type FirstPartyEncoreFlag,
} from '../../shared/plugins/first-party';
import { readSettingValue } from '../services/storage';
import {
	sendSimpleCommand,
	reportResult,
	failCommand,
	exitIfMaestroNotRunning,
} from '../services/session-command';

// Feature ID -> display name. Keys mirror EncoreFeatureFlags in
// src/shared/encoreFeatures.ts. Aliases let an agent say "symphony" or "cue".
// Group Chat is a core feature with no Encore flag, so it has no alias here:
// mapping it to Symphony once made `encore disable group-chat` turn off the
// wrong feature.
const FEATURES: Record<string, string> = {
	directorNotes: "Director's Notes",
	usageStats: 'Usage Dashboard',
	symphony: 'Maestro Symphony',
	maestroCue: 'Maestro Cue',
	pianola: 'Pianola (Manager Agent)',
	computerHistory: 'Computer History',
	quickChat: 'Quick Chat',
	maestroRun: 'MaestroRun (macOS)',
	throughputGauge: 'Throughput Gauge',
};

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
	// Case-insensitive direct match on canonical keys
	const direct = Object.keys(FEATURES).find((k) => k.toLowerCase() === lower);
	return direct ?? null;
}

export function encoreList(options: EncoreOptions): void {
	const flags = readFlags();
	if (options.json) {
		console.log(JSON.stringify({ features: flags }));
		return;
	}
	console.log('Encore Features:');
	for (const key of availableFeatureKeys()) {
		const label = FEATURES[key];
		console.log(
			`  ${flags[key] ? 'on ' : 'off'}  ${key}${' '.repeat(Math.max(1, 16 - key.length))}${label}`
		);
	}
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

	try {
		const result = await sendSimpleCommand(
			{ type: 'set_setting', key: 'encoreFeatures', value: flags },
			'set_setting_result'
		);
		reportResult(result, {
			json: options.json,
			successMessage: `${enabled ? 'Enabled' : 'Disabled'} Encore feature: ${FEATURES[key]}`,
			jsonExtra: { feature: key, enabled },
		});
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}
