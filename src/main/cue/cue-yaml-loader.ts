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
	type CueScheduleDay,
	DEFAULT_CUE_SETTINGS,
	CUE_SCHEDULE_DAYS,
} from './cue-types';
import { CUE_CONFIG_PATH, LEGACY_CUE_CONFIG_PATH } from '../../shared/maestro-paths';

/**
 * Resolve the cue config file path, preferring .maestro/cue.yaml
 * with fallback to legacy maestro-cue.yaml.
 * Returns null if neither exists.
 */
export function resolveCueConfigPath(projectRoot: string): string | null {
	const canonical = path.join(projectRoot, CUE_CONFIG_PATH);
	if (fs.existsSync(canonical)) return canonical;
	const legacy = path.join(projectRoot, LEGACY_CUE_CONFIG_PATH);
	if (fs.existsSync(legacy)) return legacy;
	return null;
}

/**
 * Loads and parses a cue config file from the given project root.
 * Checks .maestro/cue.yaml first, then falls back to maestro-cue.yaml.
 * Returns null if neither file exists. Throws on malformed YAML.
 */
export function loadCueConfig(projectRoot: string): CueConfig | null {
	const filePath = resolveCueConfigPath(projectRoot);

	if (!filePath) {
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
				// Parse filter field: accept plain object with string/number/boolean values
				let filter: Record<string, string | number | boolean> | undefined;
				if (sub.filter && typeof sub.filter === 'object' && !Array.isArray(sub.filter)) {
					const filterObj: Record<string, string | number | boolean> = {};
					let valid = true;
					for (const [k, v] of Object.entries(sub.filter as Record<string, unknown>)) {
						if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
							filterObj[k] = v;
						} else {
							valid = false;
							break;
						}
					}
					if (valid) {
						filter = filterObj;
					}
				}

				// Resolve prompt_file: read external file content into prompt field
				let prompt = String(sub.prompt ?? '');
				const promptFile = typeof sub.prompt_file === 'string' ? sub.prompt_file : undefined;
				if (promptFile && !prompt) {
					const resolvedPromptPath = path.isAbsolute(promptFile)
						? promptFile
						: path.join(projectRoot, promptFile);
					try {
						prompt = fs.readFileSync(resolvedPromptPath, 'utf-8');
					} catch {
						// File missing — keep empty prompt, engine will handle error
					}
				}

				let outputPrompt = typeof sub.output_prompt === 'string' ? sub.output_prompt : undefined;
				const outputPromptFile =
					typeof sub.output_prompt_file === 'string' ? sub.output_prompt_file : undefined;
				if (outputPromptFile && !outputPrompt) {
					const resolvedOutputPath = path.isAbsolute(outputPromptFile)
						? outputPromptFile
						: path.join(projectRoot, outputPromptFile);
					try {
						outputPrompt = fs.readFileSync(resolvedOutputPath, 'utf-8');
					} catch {
						// File missing — keep undefined
					}
				}

				subscriptions.push({
					name: String(sub.name ?? ''),
					event: String(sub.event ?? '') as CueSubscription['event'],
					enabled: sub.enabled !== false,
					prompt,
					prompt_file: promptFile,
					output_prompt: outputPrompt,
					output_prompt_file: outputPromptFile,
					interval_minutes:
						typeof sub.interval_minutes === 'number' ? sub.interval_minutes : undefined,
					schedule_times:
						Array.isArray(sub.schedule_times) &&
						sub.schedule_times.every((s: unknown) => typeof s === 'string')
							? (sub.schedule_times as string[])
							: undefined,
					schedule_days:
						Array.isArray(sub.schedule_days) &&
						sub.schedule_days.every(
							(s: unknown) =>
								typeof s === 'string' && CUE_SCHEDULE_DAYS.includes(s as CueScheduleDay)
						)
							? (sub.schedule_days as CueScheduleDay[])
							: undefined,
					watch: typeof sub.watch === 'string' ? sub.watch : undefined,
					source_session: sub.source_session,
					fan_out: Array.isArray(sub.fan_out) ? sub.fan_out : undefined,
					filter,
					repo: typeof sub.repo === 'string' ? sub.repo : undefined,
					poll_minutes: typeof sub.poll_minutes === 'number' ? sub.poll_minutes : undefined,
					agent_id: typeof sub.agent_id === 'string' ? sub.agent_id : undefined,
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
		max_concurrent:
			typeof rawSettings?.max_concurrent === 'number'
				? rawSettings.max_concurrent
				: DEFAULT_CUE_SETTINGS.max_concurrent,
		queue_size:
			typeof rawSettings?.queue_size === 'number'
				? rawSettings.queue_size
				: DEFAULT_CUE_SETTINGS.queue_size,
	};

	return { subscriptions, settings };
}

/**
 * Watches a maestro-cue.yaml file for changes. Returns a cleanup function.
 * Calls onChange when the file is created, modified, or deleted.
 * Debounces by 1 second.
 */
export function watchCueYaml(projectRoot: string, onChange: () => void): () => void {
	// Watch both canonical and legacy paths
	const canonicalPath = path.join(projectRoot, CUE_CONFIG_PATH);
	const legacyPath = path.join(projectRoot, LEGACY_CUE_CONFIG_PATH);
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	const watcher = chokidar.watch([canonicalPath, legacyPath], {
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

			const hasPrompt = sub.prompt && typeof sub.prompt === 'string';
			const hasPromptFile = sub.prompt_file && typeof sub.prompt_file === 'string';
			if (!hasPrompt && !hasPromptFile) {
				errors.push(`${prefix}: "prompt" or "prompt_file" is required`);
			}

			const event = sub.event as string;
			if (event === 'time.heartbeat') {
				if (typeof sub.interval_minutes !== 'number' || sub.interval_minutes <= 0) {
					errors.push(
						`${prefix}: "interval_minutes" is required and must be a positive number for time.heartbeat events`
					);
				}
			} else if (event === 'time.scheduled') {
				if (!Array.isArray(sub.schedule_times) || sub.schedule_times.length === 0) {
					errors.push(
						`${prefix}: "schedule_times" is required and must be a non-empty array of time strings (e.g. ["09:00", "17:00"]) for time.scheduled events`
					);
				} else {
					const timeRegex = /^\d{2}:\d{2}$/;
					for (const t of sub.schedule_times as string[]) {
						if (typeof t !== 'string' || !timeRegex.test(t)) {
							errors.push(`${prefix}: schedule_times value "${t}" must be in HH:MM format`);
						}
					}
				}
				if (sub.schedule_days !== undefined) {
					if (!Array.isArray(sub.schedule_days)) {
						errors.push(
							`${prefix}: "schedule_days" must be an array of day names (mon, tue, wed, thu, fri, sat, sun)`
						);
					} else {
						for (const d of sub.schedule_days as string[]) {
							if (!CUE_SCHEDULE_DAYS.includes(d as CueScheduleDay)) {
								errors.push(
									`${prefix}: schedule_days value "${d}" must be one of: ${CUE_SCHEDULE_DAYS.join(', ')}`
								);
							}
						}
					}
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
			} else if (event === 'task.pending') {
				if (!sub.watch || typeof sub.watch !== 'string') {
					errors.push(
						`${prefix}: "watch" is required and must be a non-empty glob string for task.pending events`
					);
				}
				if (sub.poll_minutes !== undefined) {
					if (typeof sub.poll_minutes !== 'number' || sub.poll_minutes < 1) {
						errors.push(`${prefix}: "poll_minutes" must be a number >= 1 for task.pending events`);
					}
				}
			} else if (event === 'github.pull_request' || event === 'github.issue') {
				// repo is optional (auto-detected from git remote)
				if (sub.repo !== undefined && typeof sub.repo !== 'string') {
					errors.push(
						`${prefix}: "repo" must be a string (e.g., "owner/repo") for ${event} events`
					);
				}
				if (sub.poll_minutes !== undefined) {
					if (typeof sub.poll_minutes !== 'number' || sub.poll_minutes < 1) {
						errors.push(`${prefix}: "poll_minutes" must be a number >= 1 for ${event} events`);
					}
				}
			}

			// Validate filter field
			if (sub.filter !== undefined) {
				if (typeof sub.filter !== 'object' || sub.filter === null || Array.isArray(sub.filter)) {
					errors.push(`${prefix}: "filter" must be a plain object`);
				} else {
					for (const [filterKey, filterVal] of Object.entries(
						sub.filter as Record<string, unknown>
					)) {
						if (
							typeof filterVal !== 'string' &&
							typeof filterVal !== 'number' &&
							typeof filterVal !== 'boolean'
						) {
							errors.push(
								`${prefix}: filter key "${filterKey}" must be a string, number, or boolean (got ${typeof filterVal})`
							);
						}
					}
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
			if (settings.max_concurrent !== undefined) {
				if (
					typeof settings.max_concurrent !== 'number' ||
					!Number.isInteger(settings.max_concurrent) ||
					settings.max_concurrent < 1 ||
					settings.max_concurrent > 10
				) {
					errors.push('"settings.max_concurrent" must be a positive integer between 1 and 10');
				}
			}
			if (settings.queue_size !== undefined) {
				if (
					typeof settings.queue_size !== 'number' ||
					!Number.isInteger(settings.queue_size) ||
					settings.queue_size < 0 ||
					settings.queue_size > 50
				) {
					errors.push('"settings.queue_size" must be a non-negative integer between 0 and 50');
				}
			}
		}
	}

	return { valid: errors.length === 0, errors };
}
