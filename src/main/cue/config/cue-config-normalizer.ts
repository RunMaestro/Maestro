import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import {
	type CueAction,
	type CueCommand,
	type CueConfig,
	type CueGitHubState,
	type CueScheduleDay,
	type CueSettings,
	type CueSubscription,
	CUE_GITHUB_STATES,
	CUE_SCHEDULE_DAYS,
	DEFAULT_CUE_SETTINGS,
} from '../../../shared/cue';

export interface PromptSpec {
	inline?: string;
	file?: string;
}

export interface CueSubscriptionDocument extends CueSubscription {
	promptSpec: PromptSpec;
	outputPromptSpec?: PromptSpec;
}

export interface CueConfigDocument {
	subscriptions: CueSubscriptionDocument[];
	settings: CueSettings;
	no_ancestor_fallback?: boolean;
}

function readPromptFile(projectRoot: string, promptFile: string): string | undefined {
	// Defense-in-depth path containment: the YAML that specifies `prompt_file`
	// is project-owned, but a typo or hand-edit of `../../etc/passwd` should not
	// cause an arbitrary host file to be slurped and later substituted into an
	// agent prompt. Mirror the write-side guard in `cue-config-repository.ts`.
	const normalizedRoot = path.resolve(projectRoot);
	const absPath = path.isAbsolute(promptFile)
		? path.resolve(promptFile)
		: path.resolve(normalizedRoot, promptFile);
	// Canonicalize both paths via realpath before the containment check. This
	// asks the OS for the true path and handles, in one shot: case-insensitive
	// filesystems (macOS APFS/HFS+, Windows NTFS), Unicode normalization
	// differences (NFC vs NFD), and symlinks that could otherwise escape the
	// root without tripping a lowercase `startsWith` guard. `path.relative`
	// returns '' when the paths are equal (treated as inside — reading the
	// root directory as a file will simply fail downstream), a `..`-prefixed
	// path for POSIX escapes, and an absolute path on Windows when `realPath`
	// lives on a different drive or UNC share (no common base) — so we reject
	// any absolute rel too.
	let canonicalPath: string;
	try {
		const realRoot = fs.realpathSync.native(normalizedRoot);
		const realPath = fs.realpathSync.native(absPath);
		const rel = path.relative(realRoot, realPath);
		if (rel !== '' && (path.isAbsolute(rel) || rel.split(path.sep)[0] === '..')) {
			return undefined;
		}
		canonicalPath = realPath;
	} catch {
		return undefined;
	}
	try {
		// Read the canonicalized path, not absPath. If `promptFile` was a symlink
		// that pointed inside the root at check time, reading `absPath` would
		// re-follow the symlink at read time — letting an attacker swap the
		// symlink's target between the check and the read. Reading `realPath`
		// pins us to the file we actually validated.
		return fs.readFileSync(canonicalPath, 'utf-8');
	} catch {
		return undefined;
	}
}

function normalizeFilter(
	filterValue: unknown
): Record<string, string | number | boolean> | undefined {
	if (!filterValue || typeof filterValue !== 'object' || Array.isArray(filterValue)) {
		return undefined;
	}

	const filterObj: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(filterValue as Record<string, unknown>)) {
		if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
			filterObj[key] = value;
			continue;
		}
		return undefined;
	}

	return filterObj;
}

/**
 * Read a `command` field from a raw YAML subscription. Returns the parsed
 * CueCommand or undefined if the field is missing or shaped incorrectly (the
 * validator will flag invalid shapes; we just don't surface garbage).
 */
function normalizeCommand(rawCommand: unknown): CueCommand | undefined {
	if (!rawCommand || typeof rawCommand !== 'object' || Array.isArray(rawCommand)) {
		return undefined;
	}
	const cmd = rawCommand as Record<string, unknown>;
	if (cmd.mode === 'shell' && typeof cmd.shell === 'string' && cmd.shell.trim().length > 0) {
		// Reject empty/whitespace-only shell strings here to match the
		// validator. Without this, a normalized `{ mode: 'shell', shell: '' }`
		// could reach the executor and fail with a generic "no shell command"
		// error after validation has already passed.
		return { mode: 'shell', shell: cmd.shell };
	}
	if (cmd.mode === 'cli' && cmd.cli && typeof cmd.cli === 'object' && !Array.isArray(cmd.cli)) {
		const cli = cmd.cli as Record<string, unknown>;
		if (cli.command === 'send' && typeof cli.target === 'string') {
			return {
				mode: 'cli',
				cli: {
					command: 'send',
					target: cli.target,
					message: typeof cli.message === 'string' ? cli.message : undefined,
				},
			};
		}
	}
	return undefined;
}

function normalizeSubscription(
	sub: Record<string, unknown>,
	projectRoot: string
): CueSubscriptionDocument {
	const promptSpec: PromptSpec = {
		inline: typeof sub.prompt === 'string' ? sub.prompt : undefined,
		file: typeof sub.prompt_file === 'string' ? sub.prompt_file : undefined,
	};

	const outputPromptSpec: PromptSpec | undefined =
		typeof sub.output_prompt === 'string' || typeof sub.output_prompt_file === 'string'
			? {
					inline: typeof sub.output_prompt === 'string' ? sub.output_prompt : undefined,
					file: typeof sub.output_prompt_file === 'string' ? sub.output_prompt_file : undefined,
				}
			: undefined;

	const action: CueAction | undefined =
		sub.action === 'command' || sub.action === 'prompt' ? (sub.action as CueAction) : undefined;
	const command = normalizeCommand(sub.command);

	const resolvedPrompt =
		promptSpec.inline ??
		(promptSpec.file ? (readPromptFile(projectRoot, promptSpec.file) ?? '') : '');
	// For command actions, the dispatcher uses `prompt` only as a sentinel that
	// the subscription has work to do. Back-fill from the command spec so the
	// subscription isn't silently dropped by the "no prompt → skip" gate.
	const commandSentinel = command
		? command.mode === 'shell'
			? command.shell
			: command.cli.target
		: '';
	const prompt = action === 'command' && !resolvedPrompt ? commandSentinel : resolvedPrompt;
	const outputPrompt =
		outputPromptSpec?.inline ??
		(outputPromptSpec?.file ? readPromptFile(projectRoot, outputPromptSpec.file) : undefined);

	// Resolve per-agent fan-out prompts. `fan_out_prompt_files` takes
	// precedence over inline `fan_out_prompts` — each slot is expanded from
	// its `.md` file so the runtime dispatch path keeps reading one
	// authoritative field (`fan_out_prompts[i]`). Falls back to the inline
	// array for legacy YAML written before Commit 7. When neither field is
	// present (e.g. a shared-prompt fan-out), `fan_out_prompts` stays
	// undefined and dispatch uses the shared `prompt`.
	const fanOutPromptFiles =
		Array.isArray(sub.fan_out_prompt_files) &&
		sub.fan_out_prompt_files.every((value: unknown) => typeof value === 'string')
			? (sub.fan_out_prompt_files as string[])
			: undefined;
	const inlineFanOutPrompts =
		Array.isArray(sub.fan_out_prompts) &&
		sub.fan_out_prompts.every((value: unknown) => typeof value === 'string')
			? (sub.fan_out_prompts as string[])
			: undefined;
	const resolvedFanOutPrompts = fanOutPromptFiles
		? fanOutPromptFiles.map((filePath, i) => {
				const fromFile = readPromptFile(projectRoot, filePath);
				if (typeof fromFile === 'string') return fromFile;
				// File missing/unreadable — fall back to the inline array at
				// the same index (if a caller dual-wrote both) or an empty
				// string. Dispatch still has `prompt` as a final fallback.
				return inlineFanOutPrompts?.[i] ?? '';
			})
		: inlineFanOutPrompts;

	return {
		name: String(sub.name ?? ''),
		event: String(sub.event ?? '') as CueSubscription['event'],
		enabled: sub.enabled !== false,
		promptSpec,
		outputPromptSpec,
		prompt,
		output_prompt: outputPrompt,
		action,
		command,
		interval_minutes: typeof sub.interval_minutes === 'number' ? sub.interval_minutes : undefined,
		schedule_times:
			Array.isArray(sub.schedule_times) &&
			sub.schedule_times.every((value: unknown) => typeof value === 'string')
				? (sub.schedule_times as string[])
				: undefined,
		schedule_days:
			Array.isArray(sub.schedule_days) &&
			sub.schedule_days.every(
				(value: unknown) =>
					typeof value === 'string' && CUE_SCHEDULE_DAYS.includes(value as CueScheduleDay)
			)
				? (sub.schedule_days as CueScheduleDay[])
				: undefined,
		watch: typeof sub.watch === 'string' ? sub.watch : undefined,
		source_session:
			typeof sub.source_session === 'string' || Array.isArray(sub.source_session)
				? (sub.source_session as string | string[])
				: undefined,
		source_session_ids:
			typeof sub.source_session_ids === 'string' ||
			(Array.isArray(sub.source_session_ids) &&
				sub.source_session_ids.every((value: unknown) => typeof value === 'string'))
				? (sub.source_session_ids as string | string[])
				: undefined,
		source_sub:
			typeof sub.source_sub === 'string' ||
			(Array.isArray(sub.source_sub) &&
				sub.source_sub.every((value: unknown) => typeof value === 'string'))
				? (sub.source_sub as string | string[])
				: undefined,
		fan_out:
			Array.isArray(sub.fan_out) && sub.fan_out.every((value: unknown) => typeof value === 'string')
				? (sub.fan_out as string[])
				: undefined,
		fan_out_prompts: resolvedFanOutPrompts,
		fan_out_prompt_files: fanOutPromptFiles,
		filter: normalizeFilter(sub.filter),
		repo: typeof sub.repo === 'string' ? sub.repo : undefined,
		poll_minutes: typeof sub.poll_minutes === 'number' ? sub.poll_minutes : undefined,
		gh_state:
			typeof sub.gh_state === 'string' && CUE_GITHUB_STATES.includes(sub.gh_state as CueGitHubState)
				? (sub.gh_state as CueGitHubState)
				: undefined,
		agent_id: typeof sub.agent_id === 'string' ? sub.agent_id : undefined,
		label: typeof sub.label === 'string' ? sub.label : undefined,
		fan_in_timeout_minutes:
			typeof sub.fan_in_timeout_minutes === 'number' ? sub.fan_in_timeout_minutes : undefined,
		fan_in_timeout_on_fail:
			sub.fan_in_timeout_on_fail === 'break' || sub.fan_in_timeout_on_fail === 'continue'
				? sub.fan_in_timeout_on_fail
				: undefined,
		include_output_from:
			Array.isArray(sub.include_output_from) &&
			sub.include_output_from.every((value: unknown) => typeof value === 'string')
				? (sub.include_output_from as string[])
				: undefined,
		forward_output_from:
			Array.isArray(sub.forward_output_from) &&
			sub.forward_output_from.every((value: unknown) => typeof value === 'string')
				? (sub.forward_output_from as string[])
				: undefined,
		cli_output:
			typeof sub.cli_output === 'object' &&
			sub.cli_output !== null &&
			typeof (sub.cli_output as Record<string, unknown>).target === 'string' &&
			((sub.cli_output as Record<string, unknown>).target as string).trim() !== ''
				? { target: String((sub.cli_output as Record<string, unknown>).target).trim() }
				: undefined,
		// Passthrough the per-pipeline color so the renderer can round-trip
		// it through `cue:getGraphData`. Only hex strings of the form
		// `#RRGGBB` are accepted; malformed values are dropped here rather
		// than rendering a bad color on load.
		pipeline_color:
			typeof sub.pipeline_color === 'string' && /^#[0-9a-fA-F]{6}$/.test(sub.pipeline_color)
				? sub.pipeline_color
				: undefined,
		// Passthrough the per-pipeline name so the renderer groups
		// subscriptions by the explicit field rather than the brittle
		// suffix convention.
		pipeline_name:
			typeof sub.pipeline_name === 'string' && sub.pipeline_name.length > 0
				? sub.pipeline_name
				: undefined,
	};
}

function normalizeSettings(rawSettings: Record<string, unknown> | undefined): CueSettings {
	return {
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
}

export function parseCueConfigDocument(raw: string, projectRoot: string): CueConfigDocument | null {
	const parsed = yaml.load(raw) as Record<string, unknown> | null;
	if (!parsed || typeof parsed !== 'object') {
		return null;
	}

	const subscriptions: CueSubscriptionDocument[] = [];
	const rawSubscriptions = parsed.subscriptions;
	if (Array.isArray(rawSubscriptions)) {
		for (const sub of rawSubscriptions) {
			if (sub && typeof sub === 'object') {
				subscriptions.push(normalizeSubscription(sub as Record<string, unknown>, projectRoot));
			}
		}
	}

	return {
		subscriptions,
		settings: normalizeSettings(parsed.settings as Record<string, unknown> | undefined),
		no_ancestor_fallback:
			typeof parsed.no_ancestor_fallback === 'boolean' ? parsed.no_ancestor_fallback : undefined,
	};
}

export interface MaterializedCueConfig {
	config: CueConfig;
	/**
	 * Non-fatal warnings surfaced during materialization (e.g. prompt_file references
	 * pointing at files that could not be read). Callers should log these to the user.
	 */
	warnings: string[];
}

export function materializeCueConfig(document: CueConfigDocument): MaterializedCueConfig {
	const warnings: string[] = [];

	const subscriptions = document.subscriptions.map((sub) => {
		// Surface unresolved prompt_file references as warnings — the file existed
		// in the YAML but readPromptFile() returned undefined / empty.
		if (sub.promptSpec.file && !sub.promptSpec.inline && !sub.prompt) {
			warnings.push(
				`"${sub.name}" has prompt_file "${sub.promptSpec.file}" but the file was not found or resolved to empty/unreadable content — subscription will fail on trigger`
			);
		}
		if (sub.outputPromptSpec?.file && !sub.outputPromptSpec.inline && sub.output_prompt == null) {
			warnings.push(
				`"${sub.name}" has output_prompt_file "${sub.outputPromptSpec.file}" but the file was not found or resolved to empty/unreadable content`
			);
		}

		const { promptSpec: _promptSpec, outputPromptSpec: _outputPromptSpec, ...subscription } = sub;
		return subscription as CueSubscription;
	});

	return {
		config: {
			subscriptions,
			settings: document.settings,
			...(document.no_ancestor_fallback !== undefined
				? { no_ancestor_fallback: document.no_ancestor_fallback }
				: {}),
		},
		warnings,
	};
}
