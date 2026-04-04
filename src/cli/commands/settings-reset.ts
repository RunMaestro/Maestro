// Reset a setting to its default value
// Removes the key from the store so the default takes effect

import { readSettingValue, deleteSettingValue } from '../services/storage';
import { formatSuccess, formatError } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import { SETTINGS_METADATA, getSettingDefault } from '../../shared/settingsMetadata';

interface SettingsResetOptions {
	json?: boolean;
}

export function settingsReset(key: string, options: SettingsResetOptions): void {
	try {
		const topKey = key.split('.')[0];
		const meta = SETTINGS_METADATA[topKey];

		if (!meta) {
			throw new Error(
				`Unknown setting: "${key}". Use "maestro-cli settings list --keys-only" to see all available keys.`
			);
		}

		const oldValue = readSettingValue(key);
		const defaultValue = getSettingDefault(topKey);

		deleteSettingValue(key);

		if (options.json) {
			emitJsonl({
				type: 'setting_reset',
				key,
				oldValue,
				defaultValue,
			});
		} else {
			console.log(formatSuccess(`${key} reset to default (${JSON.stringify(defaultValue)})`));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to reset "${key}": ${message}`));
		}
		process.exit(1);
	}
}
