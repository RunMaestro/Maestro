/**
 * YAML loader for Maestro Cue configuration files.
 *
 * Handles discovery, parsing, validation, and watching of maestro-cue.yaml files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as chokidar from 'chokidar';
import {
	type CueConfig,
	type CueSubscription,
	type CueSettings,
	DEFAULT_CUE_SETTINGS,
	CUE_YAML_FILENAME,
} from './cue-types';

/**
 * Loads and parses a maestro-cue.yaml file from the given project root.
 * Returns null if the file doesn't exist. Throws on malformed YAML.
 */
export function loadCueConfig(projectRoot: string): CueConfig | null {
	const filePath = path.join(projectRoot, CUE_YAML_FILENAME);

	if (!fs.existsSync(filePath)) {
		return null;
	}

	const raw = fs.readFileSync(filePath, 'utf-8');
	const parsed = yaml.load(raw) as Record<string, unknown> | null;

	if (!parsed || typeof parsed !== 'object') {
		return null;
	}

	const subscriptions: CueSubscription[] = [];
	const rawSubs = parsed.subscriptions;
	if (Array.isArray(rawSubs)) {
		for (const sub of rawSubs) {
			if (sub && typeof sub === 'object') {
				subscriptions.push({
					name: String(sub.name ?? ''),
					event: String(sub.event ?? '') as CueSubscription['event'],
					enabled: sub.enabled !== false,
					prompt: String(sub.prompt ?? ''),
					interval_minutes:
						typeof sub.interval_minutes === 'number' ? sub.interval_minutes : undefined,
					watch: typeof sub.watch === 'string' ? sub.watch : undefined,
					source_session: sub.source_session,
					fan_out: Array.isArray(sub.fan_out) ? sub.fan_out : undefined,
				});
			}
		}
	}

	const rawSettings = parsed.settings as Record<string, unknown> | undefined;
	const settings: CueSettings = {
		timeout_minutes:
			typeof rawSettings?.timeout_minutes === 'number'
				? rawSettings.timeout_minutes
				: DEFAULT_CUE_SETTINGS.timeout_minutes,
		timeout_on_fail:
			rawSettings?.timeout_on_fail === 'break' || rawSettings?.timeout_on_fail === 'continue'
				? rawSettings.timeout_on_fail
				: DEFAULT_CUE_SETTINGS.timeout_on_fail,
	};

	return { subscriptions, settings };
}

/**
 * Watches a maestro-cue.yaml file for changes. Returns a cleanup function.
 * Calls onChange when the file is created, modified, or deleted.
 * Debounces by 1 second.
 */
export function watchCueYaml(projectRoot: string, onChange: () => void): () => void {
	const filePath = path.join(projectRoot, CUE_YAML_FILENAME);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const watcher = chokidar.watch(filePath, {
		persistent: true,
		ignoreInitial: true,
	});

	const debouncedOnChange = () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			onChange();
		}, 1000);
	};

	watcher.on('add', debouncedOnChange);
	watcher.on('change', debouncedOnChange);
	watcher.on('unlink', debouncedOnChange);

	return () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
		watcher.close();
	};
}

/**
 * Validates a CueConfig-shaped object. Returns validation result with error messages.
 */
export function validateCueConfig(config: unknown): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (!config || typeof config !== 'object') {
		return { valid: false, errors: ['Config must be a non-null object'] };
	}

	const cfg = config as Record<string, unknown>;

	if (!Array.isArray(cfg.subscriptions)) {
		errors.push('Config must have a "subscriptions" array');
	} else {
		for (let i = 0; i < cfg.subscriptions.length; i++) {
			const sub = cfg.subscriptions[i] as Record<string, unknown>;
			const prefix = `subscriptions[${i}]`;

			if (!sub || typeof sub !== 'object') {
				errors.push(`${prefix}: must be an object`);
				continue;
			}

			if (!sub.name || typeof sub.name !== 'string') {
				errors.push(`${prefix}: "name" is required and must be a string`);
			}

			if (!sub.event || typeof sub.event !== 'string') {
				errors.push(`${prefix}: "event" is required and must be a string`);
			}

			if (!sub.prompt || typeof sub.prompt !== 'string') {
				errors.push(`${prefix}: "prompt" is required and must be a non-empty string`);
			}

			const event = sub.event as string;
			if (event === 'time.interval') {
				if (typeof sub.interval_minutes !== 'number' || sub.interval_minutes <= 0) {
					errors.push(
						`${prefix}: "interval_minutes" is required and must be a positive number for time.interval events`
					);
				}
			} else if (event === 'file.changed') {
				if (!sub.watch || typeof sub.watch !== 'string') {
					errors.push(
						`${prefix}: "watch" is required and must be a non-empty string for file.changed events`
					);
				}
			} else if (event === 'agent.completed') {
				if (!sub.source_session) {
					errors.push(`${prefix}: "source_session" is required for agent.completed events`);
				} else if (typeof sub.source_session !== 'string' && !Array.isArray(sub.source_session)) {
					errors.push(
						`${prefix}: "source_session" must be a string or array of strings for agent.completed events`
					);
				}
			}
		}
	}

	if (cfg.settings !== undefined) {
		if (typeof cfg.settings !== 'object' || cfg.settings === null) {
			errors.push('"settings" must be an object');
		} else {
			const settings = cfg.settings as Record<string, unknown>;
			if (settings.timeout_on_fail !== undefined) {
				if (settings.timeout_on_fail !== 'break' && settings.timeout_on_fail !== 'continue') {
					errors.push('"settings.timeout_on_fail" must be "break" or "continue"');
				}
			}
		}
	}

	return { valid: errors.length === 0, errors };
}
