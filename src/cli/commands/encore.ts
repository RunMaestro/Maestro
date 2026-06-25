// Encore Features commands - list and toggle Maestro's experimental "Encore"
// features in the running desktop app. Toggling routes through the set_setting
// WS message (key: encoreFeatures), so changes apply live and persist. Mirrors
// the Settings -> Encore Features toggles.

import { readSettingValue } from '../services/storage';
import { sendSimpleCommand, reportResult, failCommand } from '../services/session-command';

// Feature ID -> display name. Keys mirror EncoreFeatureFlags in
// src/renderer/types/index.ts. Aliases let an agent say "group chat" or "cue".
const FEATURES: Record<string, string> = {
	directorNotes: "Director's Notes",
	usageStats: 'Usage Dashboard',
	symphony: 'Symphony (Group Chat)',
	maestroCue: 'Maestro Cue',
	pianola: 'Pianola (Manager Agent)',
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
	'group-chat': 'symphony',
	groupchat: 'symphony',
	cue: 'maestroCue',
	maestrocue: 'maestroCue',
	'auto-pilot': 'pianola',
	autopilot: 'pianola',
	pilot: 'pianola',
	manager: 'pianola',
	'manager-agent': 'pianola',
};

interface EncoreOptions {
	json?: boolean;
}

function readFlags(): Record<string, boolean> {
	const raw = readSettingValue('encoreFeatures');
	const flags: Record<string, boolean> = {};
	for (const key of Object.keys(FEATURES)) {
		flags[key] = Boolean((raw as Record<string, unknown> | undefined)?.[key]);
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
	for (const [key, label] of Object.entries(FEATURES)) {
		console.log(
			`  ${flags[key] ? 'on ' : 'off'}  ${key}${' '.repeat(Math.max(1, 16 - key.length))}${label}`
		);
	}
}

export async function encoreSet(
	feature: string,
	enabled: boolean,
	options: EncoreOptions
): Promise<void> {
	const key = resolveFeature(feature);
	if (!key) {
		failCommand(
			`Unknown Encore feature "${feature}". Valid features: ${Object.keys(FEATURES).join(', ')}.`,
			options.json
		);
	}

	const flags = readFlags();
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
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}
