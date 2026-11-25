// Set a single setting value
// Supports dot-notation, auto type coercion, --raw for explicit JSON

import { readSettingValue, resolveAgentId, writeSettingValue } from '../services/storage';
import { PRIMARY_AGENT_SETTING_KEY } from '../../shared/primaryAgent';
import { formatSuccess, formatWarning } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import {
	SETTINGS_METADATA,
	isNestedTextSetting,
	nestedSettingProblem,
} from '../../shared/settingsMetadata';
import { resolveMediaModelDirectory } from '../../main/plugins/plugin-media-tools';
import { failCommand } from '../services/session-command';

interface SettingsSetOptions {
	json?: boolean;
	raw?: string;
}

/**
 * Parse a CLI value string into the appropriate JS type.
 * - "true"/"false" → boolean
 * - numeric strings → number
 * - "null" → null
 * - JSON arrays/objects → parsed
 * - everything else → string
 */
function parseValue(input: string): unknown {
	if (input === 'true') return true;
	if (input === 'false') return false;
	if (input === 'null') return null;

	// Try number (but not empty string or strings with leading zeros like "007")
	if (input !== '' && !/^0\d/.test(input)) {
		const num = Number(input);
		if (!isNaN(num) && isFinite(num)) return num;
	}

	// Try JSON for arrays/objects
	if (input.startsWith('[') || input.startsWith('{')) {
		try {
			return JSON.parse(input);
		} catch {
			// Fall through to string
		}
	}

	return input;
}

export async function settingsSet(
	key: string,
	value: string,
	options: SettingsSetOptions
): Promise<void> {
	try {
		const oldValue = readSettingValue(key);
		const topKey = key.split('.')[0];
		const meta = SETTINGS_METADATA[topKey];

		// Warn on unknown keys but allow (schema uses [key: string]: any)
		if (!meta && !options.json) {
			console.error(formatWarning(`"${key}" is not a known setting. Writing anyway.`));
		}

		// Parse the value
		let parsedValue: unknown;
		if (options.raw !== undefined) {
			try {
				parsedValue = JSON.parse(options.raw);
			} catch (e) {
				throw new Error(`Invalid JSON in --raw: ${e instanceof Error ? e.message : String(e)}`);
			}
		} else {
			parsedValue = parseValue(value);
		}

		// A setting that is one object with a field table (the A Cappella blob)
		// is checked against it: its readers sanitise, so a bad value would be
		// stored, reported as set, and silently read back as the default.
		if (options.raw === undefined && isNestedTextSetting(key)) parsedValue = value;
		const problem = nestedSettingProblem(key, parsedValue);
		if (problem) throw new Error(problem);

		// Preserve an existing legacy plaintext TURN credential if the user is
		// updating acappella.ice / acappella.ice.turn without a keyring available.
		if (
			(key === 'acappella.ice.turn' || key === 'acappella.ice' || key === 'acappella') &&
			typeof parsedValue === 'object' &&
			parsedValue !== null &&
			!Array.isArray(parsedValue)
		) {
			const legacyCred = readSettingValue('acappella.ice.turn.credential');
			if (typeof legacyCred === 'string' && legacyCred.trim()) {
				const obj = parsedValue as Record<string, unknown>;
				if (key === 'acappella.ice.turn') {
					parsedValue = { ...obj, credential: legacyCred };
				} else if (
					key === 'acappella.ice' &&
					typeof obj.turn === 'object' &&
					obj.turn !== null &&
					!Array.isArray(obj.turn)
				) {
					parsedValue = {
						...obj,
						turn: { ...(obj.turn as Record<string, unknown>), credential: legacyCred },
					};
				} else if (
					key === 'acappella' &&
					typeof obj.ice === 'object' &&
					obj.ice !== null &&
					!Array.isArray(obj.ice)
				) {
					const ice = obj.ice as Record<string, unknown>;
					if (typeof ice.turn === 'object' && ice.turn !== null && !Array.isArray(ice.turn)) {
						parsedValue = {
							...obj,
							ice: {
								...ice,
								turn: { ...(ice.turn as Record<string, unknown>), credential: legacyCred },
							},
						};
					}
				}
			}
		}

		if (topKey === 'mediaModelDirectory') {
			if (key !== topKey) throw new Error('mediaModelDirectory does not accept nested keys');
			parsedValue = await resolveMediaModelDirectory(parsedValue);
		}
		if (topKey === PRIMARY_AGENT_SETTING_KEY) {
			if (key !== topKey) throw new Error(`${topKey} does not accept nested keys`);
			// An agent name or a partial id is accepted, as everywhere else an agent
			// is named on the CLI; `null` or '' clears the Primary Agent.
			if (parsedValue !== null && parsedValue !== '') {
				parsedValue = resolveAgentId(String(parsedValue));
			} else {
				parsedValue = null;
			}
		}
		if (!writeSettingValue(key, parsedValue)) throw new Error('Could not persist setting');

		if (options.json) {
			emitJsonl({
				type: 'setting_set',
				key,
				oldValue,
				newValue: parsedValue,
			});
		} else {
			console.log(formatSuccess(`${key} = ${JSON.stringify(parsedValue)}`));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		failCommand(`Failed to set "${key}": ${message}`, options.json);
	}
}
