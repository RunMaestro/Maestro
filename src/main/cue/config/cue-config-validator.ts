import picomatch from 'picomatch';
import {
	CUE_EVENT_TYPES,
	CUE_GITHUB_STATES,
	CUE_SCHEDULE_DAYS,
	type CueGitHubState,
	type CueScheduleDay,
} from '../../../shared/cue';

function validateGlobPattern(pattern: string, prefix: string, errors: string[]): void {
	try {
		picomatch(pattern);
	} catch (error) {
		errors.push(
			`${prefix}: "watch" value "${pattern}" is not a valid glob pattern: ${error instanceof Error ? error.message : String(error)}`
		);
	}
}

export function validateCueConfigDocument(config: unknown): { valid: boolean; errors: string[] } {
	const errors: string[] = [];

	if (!config || typeof config !== 'object') {
		return { valid: false, errors: ['Config must be a non-null object'] };
	}

	const cfg = config as Record<string, unknown>;

	if (!Array.isArray(cfg.subscriptions)) {
		errors.push('Config must have a "subscriptions" array');
	} else {
		const seenNames = new Set<string>();
		for (let i = 0; i < cfg.subscriptions.length; i++) {
			const sub = cfg.subscriptions[i] as Record<string, unknown>;
			const prefix = `subscriptions[${i}]`;

			if (!sub || typeof sub !== 'object') {
				errors.push(`${prefix}: must be an object`);
				continue;
			}

			const normalized = sub.name && typeof sub.name === 'string' ? String(sub.name).trim() : '';
			if (!normalized) {
				errors.push(`${prefix}: "name" is required and must be a non-empty string`);
			} else if (seenNames.has(normalized)) {
				errors.push(`${prefix}: duplicate subscription name "${normalized}"`);
			} else {
				seenNames.add(normalized);
			}

			if (!sub.event || typeof sub.event !== 'string') {
				errors.push(`${prefix}: "event" is required and must be a string`);
			}

			if (sub.prompt !== undefined && typeof sub.prompt !== 'string') {
				errors.push(`${prefix}: "prompt" must be a string when provided`);
			}
			if (sub.prompt_file !== undefined && typeof sub.prompt_file !== 'string') {
				errors.push(`${prefix}: "prompt_file" must be a string when provided`);
			}

			const hasPrompt = typeof sub.prompt === 'string';
			const hasPromptFile = typeof sub.prompt_file === 'string';
			if (!hasPrompt && !hasPromptFile) {
				errors.push(`${prefix}: "prompt" or "prompt_file" is required`);
			}

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
					const timeRegex = /^\d{2}:\d{2}$/;
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
				} else if (
					typeof sub.source_session === 'string' &&
					sub.source_session.trim().length === 0
				) {
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
					errors.push(
						`${prefix}: "repo" must be a string (e.g., "owner/repo") for ${event} events`
					);
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
		if (typeof cfg.settings !== 'object' || cfg.settings === null || Array.isArray(cfg.settings)) {
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
