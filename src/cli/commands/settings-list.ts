// List all settings with optional verbose descriptions
// Supports --json, --verbose, --keys-only, --defaults, --category filters

import { readSettings } from '../services/storage';
import { formatSettingsList, formatError, type SettingDisplay } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import {
	SETTINGS_METADATA,
	CATEGORY_ORDER,
	CATEGORY_LABELS,
	type SettingCategory,
} from '../../shared/settingsMetadata';

interface SettingsListOptions {
	json?: boolean;
	verbose?: boolean;
	keysOnly?: boolean;
	defaults?: boolean;
	category?: string;
	showSecrets?: boolean;
}

export function settingsList(options: SettingsListOptions): void {
	try {
		const settings = readSettings();

		// Build display entries from metadata + current values
		let entries: SettingDisplay[] = [];

		for (const category of CATEGORY_ORDER) {
			const keys = Object.entries(SETTINGS_METADATA)
				.filter(([, meta]) => meta.category === category)
				.map(([key]) => key)
				.sort();

			for (const key of keys) {
				const meta = SETTINGS_METADATA[key];
				const currentValue = key in settings ? settings[key] : meta.default;
				const isDefault = JSON.stringify(currentValue) === JSON.stringify(meta.default);

				entries.push({
					key,
					value: currentValue,
					type: meta.type,
					category: CATEGORY_LABELS[meta.category as SettingCategory] || meta.category,
					description: meta.description,
					defaultValue: meta.default,
					isDefault,
					sensitive: meta.sensitive && !options.showSecrets,
				});
			}
		}

		// Filter by category if specified
		if (options.category) {
			const filter = options.category.toLowerCase();
			entries = entries.filter((e) => e.category.toLowerCase().includes(filter));
			if (entries.length === 0) {
				const validCategories = CATEGORY_ORDER.map((c) => CATEGORY_LABELS[c]).join(', ');
				throw new Error(
					`No settings found for category "${options.category}". Valid categories: ${validCategories}`
				);
			}
		}

		if (options.json) {
			if (options.keysOnly) {
				console.log(JSON.stringify(entries.map((e) => e.key)));
			} else {
				for (const entry of entries) {
					emitJsonl({
						type: 'setting',
						key: entry.key,
						value: entry.sensitive ? '***' : entry.value,
						valueType: entry.type,
						category: entry.category,
						...(options.verbose ? { description: entry.description } : {}),
						...(options.defaults
							? { defaultValue: entry.defaultValue, isDefault: entry.isDefault }
							: {}),
					});
				}
			}
		} else {
			console.log(
				formatSettingsList(entries, {
					verbose: options.verbose,
					keysOnly: options.keysOnly,
					showDefaults: options.defaults,
				})
			);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(`Failed to list settings: ${message}`));
		}
		process.exit(1);
	}
}
