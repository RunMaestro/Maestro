// Reset a setting to its default value
// Removes the key from the store so the default takes effect

import { readSettingValue, deleteSettingValue } from '../services/storage';
import { formatSuccess } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import { reportSettingsCliError } from '../utils/settings-error';
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
		reportSettingsCliError(error, options, `Failed to reset "${key}"`);
	}
}
