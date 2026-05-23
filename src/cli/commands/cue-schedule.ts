/**
 * `maestro-cli cue schedule` — author one-shot `time.once` subscriptions in
 * an agent's `.maestro/cue.yaml`. The CLI is the primary surface for the
 * `time.once` event (Phase 03 of the Cue once-trigger feature). Agents use
 * this command whenever a user asks for a delayed prompt or reminder (e.g.
 * "in 20 minutes do X" or "remind me at 4pm to push the rc branch").
 *
 * Three modes are selected by flags (modes #2 and #3 are filled in by the
 * companion task in this phase — list/cancel land in a follow-up edit):
 *  - default: create one or two `time.once` subscriptions (one per action).
 *  - `--list`: enumerate every pending `time.once` task across all agents.
 *  - `--cancel <name>`: remove a specific pending task by name.
 *
 * Writes go directly to the agent's `<projectRoot>/.maestro/cue.yaml` so the
 * CLI does not require the Maestro desktop app to be running. The Cue
 * engine picks up the new file via its YAML watcher whenever it is active.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { readSessions } from '../services/storage';
import { generateUUID } from '../../shared/uuid';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { CUE_CONFIG_PATH, LEGACY_CUE_CONFIG_PATH, MAESTRO_DIR } from '../../shared/maestro-paths';
import type { SessionInfo } from '../../shared/types';

export interface CueScheduleOptions {
	in?: string;
	at?: string;
	list?: boolean;
	cancel?: string;
	agent?: string;
	prompt?: string;
	notify?: boolean;
	sticky?: boolean;
	message?: string;
	name?: string;
	label?: string;
	pipeline?: string;
	graceMinutes?: string;
	keepOnFailure?: boolean;
	json?: boolean;
}

const DEFAULT_PIPELINE_NAME = 'Tasks';
const LABEL_MAX_LENGTH = 60;
const SHORT_UUID_LENGTH = 8;

/** Parse a duration string like `30s`, `20m`, `2h`, `1d` into milliseconds. */
function parseDuration(input: string): number | null {
	const match = /^(\d+)([smhd])$/.exec(input.trim());
	if (!match) return null;
	const n = parseInt(match[1], 10);
	if (!Number.isFinite(n) || n < 0) return null;
	const unit = match[2];
	const multiplier =
		unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
	return n * multiplier;
}

/**
 * Parse `--at` input. Accepts ISO-8601 with explicit timezone (Z or ±HH:MM)
 * OR a naive local form `YYYY-MM-DD HH:MM[:SS]` (interpreted in the system's
 * local timezone). Returns `null` when unparseable.
 */
function parseAt(input: string): Date | null {
	const trimmed = input.trim();
	// Local naive form — explicitly construct in local TZ so the resulting
	// Date matches the user's wall clock.
	const local = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
	if (local) {
		const year = parseInt(local[1], 10);
		const month = parseInt(local[2], 10);
		const day = parseInt(local[3], 10);
		const hour = parseInt(local[4], 10);
		const minute = parseInt(local[5], 10);
		const second = local[6] ? parseInt(local[6], 10) : 0;
		const date = new Date(year, month - 1, day, hour, minute, second);
		return Number.isFinite(date.getTime()) ? date : null;
	}
	// ISO-8601 (with or without TZ offset). Date.parse handles both, but we
	// rely on the trimmed string carrying a TZ — the engine validator
	// rejects naive ISO timestamps anyway, so we don't try to second-guess.
	const ms = Date.parse(trimmed);
	if (!Number.isFinite(ms)) return null;
	return new Date(ms);
}

/** First 8 hex characters of a fresh UUID v4 (dashes stripped). */
function shortUuid(): string {
	return generateUUID().replace(/-/g, '').slice(0, SHORT_UUID_LENGTH);
}

/** Auto-generated subscription name: `task-YYYY-MM-DD-HHmm-<shortUuid>`. */
function formatAutoName(fireAt: Date): string {
	const yyyy = String(fireAt.getFullYear());
	const mm = String(fireAt.getMonth() + 1).padStart(2, '0');
	const dd = String(fireAt.getDate()).padStart(2, '0');
	const hh = String(fireAt.getHours()).padStart(2, '0');
	const mi = String(fireAt.getMinutes()).padStart(2, '0');
	return `task-${yyyy}-${mm}-${dd}-${hh}${mi}-${shortUuid()}`;
}

/** Collapse whitespace and truncate to the label length budget. */
function truncateLabel(text: string): string {
	const collapsed = text.replace(/\s+/g, ' ').trim();
	if (collapsed.length <= LABEL_MAX_LENGTH) return collapsed;
	return collapsed.slice(0, LABEL_MAX_LENGTH - 1).trimEnd() + '…';
}

/** Render `ms` as a compact human duration (`5m 30s`, `2h 15m`, `expired`). */
function formatRelativeDuration(ms: number): string {
	if (ms < 0) return 'expired';
	const totalSeconds = Math.floor(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) {
		const seconds = totalSeconds % 60;
		return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
	}
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) {
		const minutes = totalMinutes % 60;
		return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`;
	}
	const days = Math.floor(totalHours / 24);
	const hours = totalHours % 24;
	return hours === 0 ? `${days}d` : `${days}d ${hours}h`;
}

/**
 * Resolve `--agent` (display name OR id OR id prefix) to a `SessionInfo`.
 * Returns `null` when no match exists. Throws on ambiguous id-prefix matches.
 *
 * Lookup order: exact id → exact name → unique id prefix. Names are matched
 * case-sensitively to mirror the renderer's display behavior.
 */
function resolveAgent(input: string, sessions: SessionInfo[]): SessionInfo | null {
	const byId = sessions.find((s) => s.id === input);
	if (byId) return byId;
	const byName = sessions.find((s) => s.name === input);
	if (byName) return byName;
	const idPrefixMatches = sessions.filter((s) => s.id.startsWith(input));
	if (idPrefixMatches.length === 1) return idPrefixMatches[0];
	if (idPrefixMatches.length > 1) {
		throw new Error(
			`Ambiguous agent identifier "${input}" — matches multiple IDs (${idPrefixMatches
				.map((s) => `${s.id.slice(0, 8)} (${s.name})`)
				.join(', ')})`
		);
	}
	return null;
}

/**
 * Extract the leading comment block from raw YAML — every line at the top of
 * the file that is blank or starts with `#`. Mirrors `cue-self-destruct.ts`
 * so a hand-authored `# Pipeline: …` header survives the round-trip.
 */
function extractLeadingCommentBlock(raw: string): string {
	const lines = raw.split('\n');
	const header: string[] = [];
	for (const line of lines) {
		const trimmed = line.trimStart();
		if (trimmed.length === 0 || trimmed.startsWith('#')) {
			header.push(line);
			continue;
		}
		break;
	}
	if (header.length === 0) return '';
	return header.join('\n') + '\n';
}

function existingCueConfigPath(projectRoot: string): string | null {
	const canonical = path.join(projectRoot, CUE_CONFIG_PATH);
	if (fs.existsSync(canonical)) return canonical;
	const legacy = path.join(projectRoot, LEGACY_CUE_CONFIG_PATH);
	if (fs.existsSync(legacy)) return legacy;
	return null;
}

/**
 * Append `newSubs` to `<projectRoot>/.maestro/cue.yaml`. Creates the file
 * and `.maestro/` directory if either is missing. When a legacy
 * `maestro-cue.yaml` is the only file present, contents are migrated to the
 * canonical path (mirroring the engine's own writers).
 *
 * Returns the absolute path that was written and whether the file was newly
 * created.
 */
function appendSubscriptionsToYaml(
	projectRoot: string,
	newSubs: Record<string, unknown>[]
): { filePath: string; created: boolean } {
	const canonicalPath = path.join(projectRoot, CUE_CONFIG_PATH);
	const existing = existingCueConfigPath(projectRoot);

	let parsed: Record<string, unknown> = { subscriptions: [] };
	let header = '';

	if (existing) {
		const raw = fs.readFileSync(existing, 'utf-8');
		header = extractLeadingCommentBlock(raw);
		const loaded = yaml.load(raw);
		if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) {
			parsed = loaded as Record<string, unknown>;
		}
	}

	const existingSubs = Array.isArray(parsed.subscriptions)
		? (parsed.subscriptions as unknown[])
		: [];
	parsed.subscriptions = [...existingSubs, ...newSubs];

	const dumped = yaml.dump(parsed, { lineWidth: -1, noRefs: true, sortKeys: false });
	const output = header + dumped;

	const maestroDir = path.join(projectRoot, MAESTRO_DIR);
	if (!fs.existsSync(maestroDir)) {
		fs.mkdirSync(maestroDir, { recursive: true });
	}
	fs.writeFileSync(canonicalPath, output, 'utf-8');

	// Migrate away from the legacy path on the same write so we don't leave
	// two competing config files behind.
	if (existing && existing !== canonicalPath) {
		try {
			fs.unlinkSync(existing);
		} catch {
			// best-effort migration — leaving the legacy file in place is
			// acceptable; the canonical file now wins on read.
		}
	}

	return { filePath: canonicalPath, created: !existing };
}

function errorOut(message: string, options: CueScheduleOptions, code?: string): never {
	if (options.json) {
		console.log(JSON.stringify({ ok: false, error: message, ...(code ? { code } : {}) }));
	} else {
		console.error(`Error: ${message}`);
	}
	process.exit(1);
}

/** CLI entry point. Routes to the create/list/cancel branch based on flags. */
export async function cueSchedule(options: CueScheduleOptions): Promise<void> {
	if (options.list) {
		errorOut('cue schedule --list is not yet implemented', options, 'NOT_IMPLEMENTED');
	}
	if (options.cancel !== undefined) {
		errorOut('cue schedule --cancel is not yet implemented', options, 'NOT_IMPLEMENTED');
	}
	await runCreate(options);
}

async function runCreate(options: CueScheduleOptions): Promise<void> {
	if (!options.in && !options.at) {
		errorOut('one of --in or --at is required', options, 'MISSING_TIME');
	}
	if (options.in && options.at) {
		errorOut('--in and --at are mutually exclusive', options, 'CONFLICTING_TIME');
	}

	let fireAtDate: Date;
	if (options.in) {
		const ms = parseDuration(options.in);
		if (ms === null) {
			errorOut(
				`--in: unrecognized duration "${options.in}" (expected <n>s|m|h|d, e.g. 20m)`,
				options,
				'BAD_DURATION'
			);
		}
		fireAtDate = new Date(Date.now() + ms);
	} else {
		const parsed = parseAt(options.at!);
		if (!parsed) {
			errorOut(
				`--at: unrecognized timestamp "${options.at}" (expected ISO-8601 with timezone or "YYYY-MM-DD HH:MM")`,
				options,
				'BAD_TIMESTAMP'
			);
		}
		fireAtDate = parsed;
	}
	// toISOString always produces `…Z`, satisfying the validator's TZ-offset
	// requirement without DST surprises across machine boundaries.
	const fireAt = fireAtDate.toISOString();

	if (!options.agent) {
		errorOut('--agent <id-or-name> is required', options, 'MISSING_AGENT');
	}
	const sessions = readSessions();
	let agent: SessionInfo | null;
	try {
		agent = resolveAgent(options.agent, sessions);
	} catch (err) {
		errorOut(err instanceof Error ? err.message : String(err), options, 'AMBIGUOUS_AGENT');
	}
	if (!agent) {
		errorOut(`agent "${options.agent}" not found`, options, 'AGENT_NOT_FOUND');
	}

	const promptText = options.prompt ?? '';
	const hasPrompt = promptText.length > 0;
	const hasNotify = options.notify === true;
	if (!hasPrompt && !hasNotify) {
		errorOut('one of --prompt or --notify (or both) is required', options, 'MISSING_ACTION');
	}
	if (options.sticky && !hasNotify) {
		errorOut('--sticky requires --notify', options, 'STICKY_WITHOUT_NOTIFY');
	}

	let graceMinutes: number | undefined;
	if (options.graceMinutes !== undefined) {
		const n = Number(options.graceMinutes);
		if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 10080) {
			errorOut(
				`--grace-minutes: must be an integer in [0, 10080], got "${options.graceMinutes}"`,
				options,
				'BAD_GRACE'
			);
		}
		graceMinutes = n;
	}

	const baseName =
		options.name && options.name.length > 0 ? options.name : formatAutoName(fireAtDate);
	const pipelineName =
		options.pipeline && options.pipeline.length > 0 ? options.pipeline : DEFAULT_PIPELINE_NAME;

	const labelSource =
		(options.label && options.label.length > 0 ? options.label : undefined) ??
		(hasPrompt ? promptText : undefined) ??
		(options.message && options.message.length > 0 ? options.message : undefined) ??
		`Task ${baseName}`;
	const label = truncateLabel(labelSource);

	const dual = hasPrompt && hasNotify;
	const subs: Record<string, unknown>[] = [];

	if (hasPrompt) {
		const sub: Record<string, unknown> = {
			name: dual ? `${baseName}-prompt` : baseName,
			event: 'time.once',
			enabled: true,
			action: 'prompt',
			prompt: promptText,
			fire_at: fireAt,
			agent_id: agent.id,
			pipeline_name: pipelineName,
			label,
		};
		if (graceMinutes !== undefined) sub.grace_minutes = graceMinutes;
		if (options.keepOnFailure === true) sub.self_destruct_on_failure = false;
		subs.push(sub);
	}

	if (hasNotify) {
		const notifyMessage =
			(options.message && options.message.length > 0 ? options.message : undefined) ??
			(options.label && options.label.length > 0 ? options.label : undefined) ??
			(hasPrompt ? promptText : undefined) ??
			'Task fired';
		const notifyConfig: Record<string, unknown> = { message: notifyMessage };
		if (options.sticky === true) notifyConfig.sticky = true;

		const sub: Record<string, unknown> = {
			name: dual ? `${baseName}-notify` : baseName,
			event: 'time.once',
			enabled: true,
			action: 'notify',
			fire_at: fireAt,
			agent_id: agent.id,
			pipeline_name: pipelineName,
			label,
			notify: notifyConfig,
		};
		if (graceMinutes !== undefined) sub.grace_minutes = graceMinutes;
		if (options.keepOnFailure === true) sub.self_destruct_on_failure = false;
		subs.push(sub);
	}

	try {
		appendSubscriptionsToYaml(agent.projectRoot, subs);
	} catch (err) {
		errorOut(
			`failed to write cue.yaml: ${err instanceof Error ? err.message : String(err)}`,
			options,
			'WRITE_FAILED'
		);
	}

	const names = subs.map((s) => s.name as string);
	const relativeIn = formatRelativeDuration(fireAtDate.getTime() - Date.now());
	const agentDisplay = agent.name || getAgentDisplayName(agent.toolType);

	if (options.json) {
		console.log(
			JSON.stringify({
				ok: true,
				names,
				fire_at: fireAt,
				agent_id: agent.id,
				pipeline_name: pipelineName,
			})
		);
		return;
	}

	if (names.length === 1) {
		console.log(
			`Scheduled task '${names[0]}' to fire at ${fireAt} (in ${relativeIn}) on agent ${agentDisplay}`
		);
	} else {
		console.log(
			`Scheduled tasks ${names.map((n) => `'${n}'`).join(', ')} to fire at ${fireAt} (in ${relativeIn}) on agent ${agentDisplay}`
		);
	}
}
