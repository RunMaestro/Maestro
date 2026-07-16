// Set a single setting value
// Supports dot-notation, auto type coercion, --raw for explicit JSON

import { readSettingValue, writeSettingValue } from '../services/storage';
import { formatSuccess, formatWarning } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import { reportSettingsCliError } from '../utils/settings-error';
import { parseSettingsCliValue } from '../utils/settings-value';
import { SETTINGS_METADATA } from '../../shared/settingsMetadata';

interface SettingsSetOptions {
	json?: boolean;
	raw?: string;
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
			parsedValue = parseSettingsCliValue(value);
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
		reportSettingsCliError(error, options, `Failed to set "${key}"`);
	}
}
