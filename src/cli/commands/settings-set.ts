// Set a single setting value
// Supports dot-notation, auto type coercion, --raw for explicit JSON

import { readSettingValue, writeSettingValue } from '../services/storage';
import { formatSuccess, formatError, formatWarning } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';

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

export function settingsSet(key: string, value: string, options: SettingsSetOptions): void {
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

		writeSettingValue(key, parsedValue);

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
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to set "${key}": ${message}`));
		}
		process.exit(1);
	}
}
