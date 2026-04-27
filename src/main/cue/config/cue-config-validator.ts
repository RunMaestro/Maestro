import picomatch from 'picomatch';
import {
	CUE_EVENT_TYPES,
	CUE_GITHUB_STATES,
	CUE_SCHEDULE_DAYS,
	type CueGitHubState,
	type CueScheduleDay,
} from '../../../shared/cue';

function validateGlobPattern(pattern: string, prefix: string, errors: string[]): void {
	// Path-traversal guard: the watcher resolves `watchGlob` against `projectRoot`
	// via chokidar, so any pattern that escapes the project root (via `..`
	// segments, an absolute POSIX path, or a Windows drive letter) would allow
	// watching arbitrary files on disk. Reject those shapes up-front — the
	// runtime guard in `cue-file-watcher.ts` is the defense-in-depth backstop.
	const segments = pattern.split(/[\\/]/);
	if (segments.includes('..')) {
		errors.push(
			`${prefix}: "watch" pattern "${pattern}" is not allowed (contains ".." path traversal)`
		);
		return;
	}
	if (pattern.startsWith('/') || pattern.startsWith('\\')) {
		errors.push(
			`${prefix}: "watch" pattern "${pattern}" is not allowed (absolute paths are not permitted)`
		);
		return;
	}
	// Match any leading `X:` drive letter — both drive-absolute (`C:\foo`,
	// `C:/foo`) and drive-relative (`C:secret\foo`) forms. Drive-relative
	// paths resolve against Windows' per-drive current-directory table and
	// can escape the project root just as effectively as the absolute forms.
	if (/^[A-Za-z]:/.test(pattern)) {
		errors.push(
			`${prefix}: "watch" pattern "${pattern}" is not allowed (Windows drive paths are not permitted)`
		);
		return;
	}
	try {
		picomatch(pattern);
	} catch (error) {
		errors.push(
			`${prefix}: "watch" value "${pattern}" is not a valid glob pattern: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

/**
 * Validate a `command` field, required when `action === 'command'`. Accepts:
 *   { mode: 'shell', shell: <non-empty string> }
 *   { mode: 'cli', cli: { command: 'send', target: <non-empty string>, message?: string } }
 */
function validateCommandField(value: unknown, prefix: string, errors: string[]): void {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		errors.push(`${prefix}: "command" is required and must be an object when action is "command"`);
		return;
	}
	const cmd = value as Record<string, unknown>;
	const mode = cmd.mode;
	if (mode === 'shell') {
		if (typeof cmd.shell !== 'string' || cmd.shell.trim().length === 0) {
			errors.push(
				`${prefix}: "command.shell" is required and must be a non-empty string when command.mode is "shell"`
			);
		}
	} else if (mode === 'cli') {
		const cli = cmd.cli;
		if (!cli || typeof cli !== 'object' || Array.isArray(cli)) {
			errors.push(
				`${prefix}: "command.cli" is required and must be an object when command.mode is "cli"`
			);
			return;
		}
		const cliRecord = cli as Record<string, unknown>;
		if (cliRecord.command !== 'send') {
			errors.push(
				`${prefix}: "command.cli.command" must be "send" (only supported maestro-cli sub-command for now)`
			);
		}
		if (typeof cliRecord.target !== 'string' || cliRecord.target.trim().length === 0) {
			errors.push(`${prefix}: "command.cli.target" is required and must be a non-empty string`);
		}
		if (cliRecord.message !== undefined && typeof cliRecord.message !== 'string') {
			errors.push(`${prefix}: "command.cli.message" must be a string when provided`);
		}
	} else {
		errors.push(`${prefix}: "command.mode" must be "shell" or "cli"`);
	}
}

/**
 * Validate a single subscription. Returns errors specific to this subscription
 * (with the supplied `prefix` prepended). Used both by the strict whole-config
 * validator and the lenient per-subscription partitioner used by the loader.
 *
 * Note: name-uniqueness is a cross-subscription concern and lives in the caller.
 */
export function validateSubscription(sub: unknown, prefix: string): string[] {
	const errors: string[] = [];

	if (!sub || typeof sub !== 'object') {
		errors.push(`${prefix}: must be an object`);
		return errors;
	}

	const subRecord = sub as Record<string, unknown>;

	const normalized =
		subRecord.name && typeof subRecord.name === 'string' ? String(subRecord.name).trim() : '';
	if (!normalized) {
		errors.push(`${prefix}: "name" is required and must be a non-empty string`);
	}

	if (!subRecord.event || typeof subRecord.event !== 'string') {
		errors.push(`${prefix}: "event" is required and must be a string`);
	}

	if (subRecord.prompt !== undefined && typeof subRecord.prompt !== 'string') {
		errors.push(`${prefix}: "prompt" must be a string when provided`);
	}
	if (subRecord.prompt_file !== undefined && typeof subRecord.prompt_file !== 'string') {
		errors.push(`${prefix}: "prompt_file" must be a string when provided`);
	}

	const action = subRecord.action;
	if (action !== undefined && action !== 'prompt' && action !== 'command') {
		errors.push(`${prefix}: "action" must be "prompt" or "command" when provided`);
	}

	const isCommand = action === 'command';

	if (isCommand) {
		validateCommandField(subRecord.command, prefix, errors);
		// Fan-out targets sessions, not subscriptions — combining it with
		// `action: command` would execute the command once per target session,
		// which is never the user's intent (the pipeline editor already blocks
		// this; this guard catches hand-edited YAML).
		if (Array.isArray(subRecord.fan_out) && subRecord.fan_out.length > 0) {
			errors.push(`${prefix}: "fan_out" is not supported when action is "command"`);
		}
	} else {
		// `fan_out_ids` is the rename-stable id mirror of `fan_out`. When
		// present it must be a string array of the same length so the
		// dispatcher can look up `fan_out_ids[i]` for each `fan_out[i]`.
		if (subRecord.fan_out_ids !== undefined) {
			if (
				!Array.isArray(subRecord.fan_out_ids) ||
				!subRecord.fan_out_ids.every((v: unknown) => typeof v === 'string')
			) {
				errors.push(`${prefix}: "fan_out_ids" must be an array of strings when provided`);
			} else if (
				Array.isArray(subRecord.fan_out) &&
				subRecord.fan_out_ids.length !== subRecord.fan_out.length
			) {
				errors.push(
					`${prefix}: "fan_out_ids" length (${subRecord.fan_out_ids.length}) must match "fan_out" length (${subRecord.fan_out.length})`
				);
			}
		}
		const hasPrompt = typeof subRecord.prompt === 'string';
		const hasPromptFile = typeof subRecord.prompt_file === 'string';
		// A fan-out subscription can carry its prompts per-target via
		// `fan_out_prompt_files` (file references, preferred) or
		// `fan_out_prompts` (legacy inline array). Either satisfies the "prompt
		// required" check even when the shared `prompt` / `prompt_file` fields
		// are absent — otherwise the loader's lenient partition rejects the
		// subscription and the whole pipeline disappears from the UI on save.
		//
		// If either field is *present* we validate its elements strictly and
		// surface an explicit error on malformed entries — rather than silently
		// treating a malformed array as "absent" and letting dispatch fall
		// through to the shared prompt with no indication anything's wrong.
		let hasFanOutPromptFiles = false;
		if (subRecord.fan_out_prompt_files !== undefined) {
			if (!Array.isArray(subRecord.fan_out_prompt_files)) {
				errors.push(`${prefix}: "fan_out_prompt_files" must be an array of strings when provided`);
			} else if (!subRecord.fan_out_prompt_files.every((v: unknown) => typeof v === 'string')) {
				errors.push(`${prefix}: "fan_out_prompt_files" must contain only strings`);
			} else if (subRecord.fan_out_prompt_files.length > 0) {
				hasFanOutPromptFiles = true;
			}
		}
		let hasFanOutPrompts = false;
		if (subRecord.fan_out_prompts !== undefined) {
			if (!Array.isArray(subRecord.fan_out_prompts)) {
				errors.push(`${prefix}: "fan_out_prompts" must be an array of strings when provided`);
			} else if (!subRecord.fan_out_prompts.every((v: unknown) => typeof v === 'string')) {
				errors.push(`${prefix}: "fan_out_prompts" must contain only strings`);
			} else if (subRecord.fan_out_prompts.length > 0) {
				hasFanOutPrompts = true;
			}
		}
		if (!hasPrompt && !hasPromptFile && !hasFanOutPromptFiles && !hasFanOutPrompts) {
			errors.push(
				`${prefix}: "prompt", "prompt_file", "fan_out_prompt_files", or "fan_out_prompts" is required`
			);
		}
	}

	validateEventSpecificFields(subRecord, prefix, errors);

	if (subRecord.fan_in_timeout_minutes !== undefined) {
		// Same bounds as `settings.timeout_minutes`. A value of `0` makes
		// `cue-fan-in-tracker` expire every fan-in immediately on arrival of
		// the first source, so the pipeline appears to do nothing.
		if (
			typeof subRecord.fan_in_timeout_minutes !== 'number' ||
			!Number.isFinite(subRecord.fan_in_timeout_minutes) ||
			!Number.isInteger(subRecord.fan_in_timeout_minutes) ||
			subRecord.fan_in_timeout_minutes < 1 ||
			subRecord.fan_in_timeout_minutes > 1440
		) {
			errors.push(
				`${prefix}: "fan_in_timeout_minutes" must be a positive integer between 1 and 1440`
			);
		}
	}

	if (subRecord.filter !== undefined) {
		if (
			typeof subRecord.filter !== 'object' ||
			subRecord.filter === null ||
			Array.isArray(subRecord.filter)
		) {
			errors.push(`${prefix}: "filter" must be a plain object`);
		} else {
			for (const [filterKey, filterVal] of Object.entries(
				subRecord.filter as Record<string, unknown>
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

	return errors;
}

function validateEventSpecificFields(
	sub: Record<string, unknown>,
	prefix: string,
	errors: string[]
): void {
	const event = sub.event as string;
	if (event === 'time.heartbeat') {
		if (
			typeof sub.interval_minutes !== 'number' ||
			!Number.isFinite(sub.interval_minutes) ||
			sub.interval_minutes <= 0 ||
			sub.interval_minutes > 10080
		) {
			errors.push(
				`${prefix}: "interval_minutes" is required and must be a positive number no greater than 10080 (7 days) for time.heartbeat events`
			);
		}
	} else if (event === 'time.scheduled') {
		if (!Array.isArray(sub.schedule_times) || sub.schedule_times.length === 0) {
			errors.push(
				`${prefix}: "schedule_times" is required and must be a non-empty array of time strings (e.g. ["09:00", "17:00"]) for time.scheduled events`
			);
		} else {
			// Accept both `H:MM` and `HH:MM`. The normalizer pads to two-digit
			// hours so downstream string comparisons (e.g. the scheduled trigger
			// source's `times.includes(currentTime)` check) match regardless of
			// what the user typed in the UI.
			const timeRegex = /^\d{1,2}:\d{2}$/;
			for (const time of sub.schedule_times as string[]) {
				if (typeof time !== 'string' || !timeRegex.test(time)) {
					errors.push(`${prefix}: schedule_times value "${time}" must be in HH:MM format`);
				} else {
					const [hours, minutes] = time.split(':').map(Number);
					if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
						errors.push(
							`${prefix}: schedule_times value "${time}" has invalid hour (0-23) or minute (0-59)`
						);
					}
				}
			}
		}
		if (sub.schedule_days !== undefined) {
			if (!Array.isArray(sub.schedule_days)) {
				errors.push(
					`${prefix}: "schedule_days" must be an array of day names (mon, tue, wed, thu, fri, sat, sun)`
				);
			} else {
				for (const day of sub.schedule_days as string[]) {
					if (!CUE_SCHEDULE_DAYS.includes(day as CueScheduleDay)) {
						errors.push(
							`${prefix}: schedule_days value "${day}" must be one of: ${CUE_SCHEDULE_DAYS.join(', ')}`
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
		} else {
			validateGlobPattern(sub.watch as string, prefix, errors);
		}
	} else if (event === 'agent.completed') {
		if (!sub.source_session) {
			errors.push(`${prefix}: "source_session" is required for agent.completed events`);
		} else if (typeof sub.source_session !== 'string' && !Array.isArray(sub.source_session)) {
			errors.push(
				`${prefix}: "source_session" must be a string or array of strings for agent.completed events`
			);
		} else if (typeof sub.source_session === 'string' && sub.source_session.trim().length === 0) {
			errors.push(
				`${prefix}: "source_session" must be a non-empty string or non-empty array of non-empty strings for agent.completed events`
			);
		} else if (Array.isArray(sub.source_session)) {
			if (sub.source_session.length === 0) {
				errors.push(
					`${prefix}: "source_session" must be a non-empty string or non-empty array of non-empty strings for agent.completed events`
				);
			} else if (
				sub.source_session.some(
					(source) => typeof source !== 'string' || source.trim().length === 0
				)
			) {
				errors.push(
					`${prefix}: "source_session" must be a non-empty string or non-empty array of non-empty strings for agent.completed events`
				);
			}
		}
		// `source_sub` narrows chain matching by the upstream subscription's
		// `triggeredBy` value. Optional — when absent the chain matches any
		// run in the source session(s). When present, reject non-string or
		// empty values so a malformed YAML entry can't silently disable the
		// self-loop filter and re-introduce the re-trigger class of bugs.
		if (sub.source_sub !== undefined) {
			if (typeof sub.source_sub === 'string') {
				if (sub.source_sub.trim().length === 0) {
					errors.push(`${prefix}: "source_sub" must be a non-empty string when provided`);
				}
			} else if (Array.isArray(sub.source_sub)) {
				if (sub.source_sub.length === 0) {
					errors.push(`${prefix}: "source_sub" must be a non-empty array when provided`);
				} else if (
					sub.source_sub.some((name) => typeof name !== 'string' || name.trim().length === 0)
				) {
					errors.push(
						`${prefix}: "source_sub" array must contain only non-empty strings when provided`
					);
				}
			} else {
				errors.push(`${prefix}: "source_sub" must be a string or array of strings when provided`);
			}
		}
	} else if (event === 'task.pending') {
		if (!sub.watch || typeof sub.watch !== 'string') {
			errors.push(
				`${prefix}: "watch" is required and must be a non-empty glob string for task.pending events`
			);
		} else {
			validateGlobPattern(sub.watch as string, prefix, errors);
		}
		if (sub.poll_minutes !== undefined) {
			if (
				typeof sub.poll_minutes !== 'number' ||
				!Number.isFinite(sub.poll_minutes) ||
				sub.poll_minutes < 1
			) {
				errors.push(`${prefix}: "poll_minutes" must be a number >= 1 for task.pending events`);
			}
		}
	} else if (event === 'github.pull_request' || event === 'github.issue') {
		if (sub.repo !== undefined && typeof sub.repo !== 'string') {
			errors.push(`${prefix}: "repo" must be a string (e.g., "owner/repo") for ${event} events`);
		}
		if (sub.poll_minutes !== undefined) {
			if (
				typeof sub.poll_minutes !== 'number' ||
				!Number.isFinite(sub.poll_minutes) ||
				sub.poll_minutes < 1
			) {
				errors.push(`${prefix}: "poll_minutes" must be a number >= 1 for ${event} events`);
			}
		}
		if (sub.gh_state !== undefined) {
			if (
				typeof sub.gh_state !== 'string' ||
				!CUE_GITHUB_STATES.includes(sub.gh_state as CueGitHubState)
			) {
				errors.push(`${prefix}: "gh_state" must be one of: ${CUE_GITHUB_STATES.join(', ')}`);
			}
			if (sub.gh_state === 'merged' && event === 'github.issue') {
				errors.push(
					`${prefix}: "gh_state" value "merged" is only valid for github.pull_request events`
				);
			}
		}
	} else if (event === 'app.startup') {
		// No additional required fields for the startup trigger.
	} else if (event === 'cli.trigger') {
		// No additional required fields — triggered manually via maestro-cli.
	} else if (
		sub.event &&
		typeof sub.event === 'string' &&
		!CUE_EVENT_TYPES.includes(event as any)
	) {
		errors.push(
			`${prefix}: unknown event type "${event}". Valid types: ${CUE_EVENT_TYPES.join(', ')}`
		);
	}
}

function validateSettings(rawSettings: unknown): string[] {
	const errors: string[] = [];
	if (rawSettings === undefined) return errors;
	if (typeof rawSettings !== 'object' || rawSettings === null || Array.isArray(rawSettings)) {
		errors.push('"settings" must be an object');
		return errors;
	}
	const settings = rawSettings as Record<string, unknown>;
	if (settings.timeout_minutes !== undefined) {
		// `0`, negative, NaN, or Infinity all reach `cue-run-manager` as a ms
		// timeout — `0` aborts every run on dispatch, `Infinity` hangs forever.
		// 1440 (24 h) is a generous upper bound; anything higher is almost
		// certainly a typo.
		if (
			typeof settings.timeout_minutes !== 'number' ||
			!Number.isFinite(settings.timeout_minutes) ||
			!Number.isInteger(settings.timeout_minutes) ||
			settings.timeout_minutes < 1 ||
			settings.timeout_minutes > 1440
		) {
			errors.push('"settings.timeout_minutes" must be a positive integer between 1 and 1440');
		}
	}
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
	if (settings.owner_agent_id !== undefined) {
		if (typeof settings.owner_agent_id !== 'string' || settings.owner_agent_id.trim() === '') {
			errors.push('"settings.owner_agent_id" must be a non-empty string (agent id or name)');
		}
	}
	return errors;
}

export function validateCueConfigDocument(config: unknown): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	// null/undefined = comments-only or empty file → treat as valid empty config
	if (config === null || config === undefined) {
		return { valid: true, errors: [] };
	}

	if (typeof config !== 'object') {
		return { valid: false, errors: ['Config must be a non-null object'] };
	}

	const cfg = config as Record<string, unknown>;

	if (!Array.isArray(cfg.subscriptions)) {
		errors.push('Config must have a "subscriptions" array');
	} else {
		const seenNames = new Set<string>();
		for (let i = 0; i < cfg.subscriptions.length; i++) {
			const sub = cfg.subscriptions[i];
			const prefix = `subscriptions[${i}]`;
			errors.push(...validateSubscription(sub, prefix));

			if (sub && typeof sub === 'object') {
				const name = (sub as Record<string, unknown>).name;
				if (typeof name === 'string') {
					const normalized = name.trim();
					if (normalized) {
						if (seenNames.has(normalized)) {
							errors.push(`${prefix}: duplicate subscription name "${normalized}"`);
						}
						seenNames.add(normalized);
					}
				}
			}
		}
	}

	errors.push(...validateSettings(cfg.settings));

	return { valid: errors.length === 0, errors };
}

/**
 * Lenient partition for the loader: returns indices of subscriptions that
 * passed validation along with per-subscription errors for the failures, plus
 * any config-level errors (missing subscriptions array, bad settings).
 *
 * Used to load valid subs while logging warnings for broken ones — one bad
 * subscription must not block an entire project's Cue config (which can be
 * shared across multiple agents in the same project root).
 */
export interface PartitionedValidation {
	configErrors: string[];
	validIndices: number[];
	subscriptionErrors: Array<{ index: number; errors: string[] }>;
}

export function partitionValidSubscriptions(config: unknown): PartitionedValidation {
	const result: PartitionedValidation = {
		configErrors: [],
		validIndices: [],
		subscriptionErrors: [],
	};

	if (config === null || config === undefined) {
		// comments-only or empty file — no config errors, no subscriptions
		return result;
	}

	if (typeof config !== 'object') {
		result.configErrors.push('Config must be a non-null object');
		return result;
	}

	const cfg = config as Record<string, unknown>;

	if (!Array.isArray(cfg.subscriptions)) {
		result.configErrors.push('Config must have a "subscriptions" array');
		return result;
	}

	const seenNames = new Set<string>();
	for (let i = 0; i < cfg.subscriptions.length; i++) {
		const sub = cfg.subscriptions[i];
		const prefix = `subscriptions[${i}]`;
		const subErrors = validateSubscription(sub, prefix);

		// Cross-subscription: duplicate names. Mark the duplicate as broken.
		let dupeError: string | null = null;
		if (sub && typeof sub === 'object') {
			const name = (sub as Record<string, unknown>).name;
			if (typeof name === 'string') {
				const normalized = name.trim();
				if (normalized) {
					if (seenNames.has(normalized)) {
						dupeError = `${prefix}: duplicate subscription name "${normalized}" — skipped`;
					} else {
						seenNames.add(normalized);
					}
				}
			}
		}

		const allErrors = dupeError ? [...subErrors, dupeError] : subErrors;
		if (allErrors.length === 0) {
			result.validIndices.push(i);
		} else {
			result.subscriptionErrors.push({ index: i, errors: allErrors });
		}
	}

	result.configErrors.push(...validateSettings(cfg.settings));

	return result;
}
