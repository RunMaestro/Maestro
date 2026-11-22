import { getMediaToolStatus, resolveMediaRuntime } from '../../main/plugins/plugin-media-tools';
// Get a single setting value
// Supports dot-notation for nested keys, --json, --verbose

import { readSettingValue } from '../services/storage';
import { formatSettingDetail, type SettingDisplay } from '../output/formatter';
import { emitJsonl } from '../output/jsonl';
import {
	SETTINGS_METADATA,
	CATEGORY_LABELS,
	type SettingCategory,
	getSettingDefaultAtPath,
	nestedSettingPathProblem,
	redactNestedSettingSecrets,
} from '../../shared/settingsMetadata';
import { failCommand } from '../services/session-command';

interface SettingsGetOptions {
	json?: boolean;
	verbose?: boolean;
}

export function settingsGet(key: string, options: SettingsGetOptions): void {
	try {
		// Resolve metadata - for dot-notation, use the top-level key
		const topKey = key.split('.')[0];
		const meta = SETTINGS_METADATA[topKey];
		const pathProblem = nestedSettingPathProblem(key);
		if (pathProblem) throw new Error(pathProblem);
		// A nested path has a default only under a setting with a field table.
		const defaultValue = getSettingDefaultAtPath(key);
		// An unset field of such a setting reads as its default, which is what
		// the app runs on. A secret inside an object read is masked.
		const stored = readSettingValue(key);
		const value = redactNestedSettingSecrets(
			key,
			stored === undefined && key.includes('.') ? defaultValue : stored
		);

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
		failCommand(message, options.json);
	}
}

/** Uses the Host Media resolver in this CLI process's PATH and environment. */
export async function settingsMediaStatus(): Promise<void> {
	try {
		console.log(
			JSON.stringify(
				getMediaToolStatus(await resolveMediaRuntime(readSettingValue('mediaModelDirectory')))
			)
		);
	} catch (error) {
		failCommand(error instanceof Error ? error.message : 'Media status unavailable', true);
	}
}
