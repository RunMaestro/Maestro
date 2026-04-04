// Get a single setting value
// Supports dot-notation for nested keys, --json, --verbose

import { readSettingValue } from '../services/storage';
import { formatSettingDetail, formatError, type SettingDisplay } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import {
	SETTINGS_METADATA,
	CATEGORY_LABELS,
	type SettingCategory,
	getSettingDefault,
} from '../../shared/settingsMetadata';

interface SettingsGetOptions {
	json?: boolean;
	verbose?: boolean;
}

export function settingsGet(key: string, options: SettingsGetOptions): void {
	try {
		const value = readSettingValue(key);

		// Resolve metadata — for dot-notation, use the top-level key
		const topKey = key.split('.')[0];
		const meta = SETTINGS_METADATA[topKey];
		const defaultValue = key.includes('.') ? undefined : getSettingDefault(key);

		if (value === undefined && !meta) {
			throw new Error(
				`Unknown setting: "${key}". Use "maestro-cli settings list --keys-only" to see all available keys.`
			);
		}

		if (options.json) {
			emitJsonl({
				type: 'setting',
				key,
				value,
				valueType: meta?.type ?? typeof value,
				category: meta
					? CATEGORY_LABELS[meta.category as SettingCategory] || meta.category
					: 'unknown',
				...(options.verbose && meta ? { description: meta.description } : {}),
				defaultValue,
				isDefault:
					defaultValue !== undefined
						? JSON.stringify(value) === JSON.stringify(defaultValue)
						: undefined,
			});
		} else {
			if (options.verbose && meta) {
				const display: SettingDisplay = {
					key,
					value,
					type: meta.type,
					category: CATEGORY_LABELS[meta.category as SettingCategory] || meta.category,
					description: meta.description,
					defaultValue,
					isDefault:
						defaultValue !== undefined
							? JSON.stringify(value) === JSON.stringify(defaultValue)
							: undefined,
				};
				console.log(formatSettingDetail(display));
			} else {
				// Simple output: just the value, suitable for scripting
				if (typeof value === 'object' && value !== null) {
					console.log(JSON.stringify(value, null, 2));
				} else {
					console.log(value === undefined ? '' : String(value));
				}
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}
}
