// Snooze commands - park a tab until a chosen moment and manage what is parked,
// mirroring the Snooze dialog (Opt+Cmd+S), the Snoozed Tabs list, and its
// history log. Every verb rides the one `snooze_command` message; the desktop
// renderer owns the authoritative snooze state, so these fail with the usual
// "not running" error when the app is down.
//
// The `<when>` expression is parsed HERE, against this machine's clock, by the
// same `parseSnoozeInput` the dialog uses - so "2h", "tomorrow", "next fri 3pm"
// and "aug 5" all mean what they mean in the UI, a typo fails before a round
// trip, and what goes on the wire is an unambiguous instant.

import {
	sendSimpleCommand,
	failCommand,
	resolveAgentOrFail,
	resolveTabEntry,
	type SimpleResult,
} from '../services/session-command';
import { formatSuccess } from '../output/formatter';
import { isQuiet } from '../output/verbosity';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import { formatSnoozeCountdown, formatSnoozeTarget, parseSnoozeInput } from '../../shared/snooze';
import type {
	SnoozeCommandRequest,
	SnoozeHistorySummary,
	SnoozedTabSummary,
} from '../../shared/snoozeCommands';

export interface SnoozeOptions {
	agent?: string;
	note?: string;
	wakePrompt?: string;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
	limit?: string;
}

interface SnoozeResponse extends SimpleResult {
	snooze?: SnoozedTabSummary;
	snoozes?: SnoozedTabSummary[];
	history?: SnoozeHistorySummary[];
	tabId?: string;
	wasDuplicate?: boolean;
}

/** Send one snooze verb and hand back the desktop's answer. */
async function sendSnooze(request: SnoozeCommandRequest, json?: boolean): Promise<SnoozeResponse> {
	try {
		const result = (await sendSimpleCommand(
			{ type: 'snooze_command', ...request },
			'snooze_command_result'
		)) as SnoozeResponse;
		if (!result.success) failCommand(result.error || 'Snooze command failed', json);
		return result;
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
}

/**
 * Resolve a `<when>` expression, or fail with the parser's own message.
 *
 * Failing here rather than on the far side is the point: the phrase is the part
 * a human most often gets wrong, and "Couldn't read "tomorrrow" as a date"
 * beats a tab silently parked at an instant that never arrives.
 */
function resolveWakeAt(when: string, json?: boolean): number {
	const parsed = parseSnoozeInput(when);
	if (!parsed.ok) return failCommand(parsed.error, json);
	return parsed.at;
}

/**
 * The `--note` / `--wake-prompt` pair, as the wire wants them.
 *
 * An absent flag stays absent (on a reschedule that means "keep what is
 * there"), while `--note ""` is a real instruction to clear the note, so the
 * empty string must survive the trip.
 */
function contentFields(options: SnoozeOptions): Pick<SnoozeCommandRequest, 'note' | 'wakePrompt'> {
	return {
		...(options.note !== undefined ? { note: options.note } : {}),
		...(options.wakePrompt !== undefined ? { wakePrompt: options.wakePrompt } : {}),
	};
}

/**
 * Find the agent that owns a snooze, by exact id or unique prefix.
 *
 * A snooze id alone does not say which agent holds it, and the CLI has no local
 * copy of the parked list - so this asks the desktop, exactly as `resolveTabOwner`
 * asks it which agent owns a tab.
 */
async function resolveSnooze(snoozeId: string, json?: boolean): Promise<SnoozedTabSummary> {
	const result = await sendSnooze({ action: 'list' }, json);
	const all = result.snoozes ?? [];
	const exact = all.find((s) => s.snoozeId === snoozeId);
	if (exact) return exact;
	const matches = all.filter((s) => s.snoozeId.startsWith(snoozeId));
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		return failCommand(`Ambiguous snooze id '${snoozeId}' (${matches.length} matches)`, json);
	}
	return failCommand(`No snoozed tab with id ${snoozeId}`, json);
}

/** One row of `snooze list`, for a human. */
function describeSnooze(s: SnoozedTabSummary): string {
	const kind = s.type === 'group' ? `group of ${s.memberCount ?? 0}` : s.type;
	const lines = [
		`  ${s.snoozeId}  ${s.label}`,
		`    ${kind} · ${s.agentName} · ${formatSnoozeTarget(s.wakeAt)} (${formatSnoozeCountdown(s.wakeAt)})`,
	];
	if (s.note) lines.push(`    note: ${s.note}`);
	if (s.wakePrompt) lines.push(`    wake prompt: ${s.wakePrompt}`);
	return lines.join('\n');
}

/**
 * `maestro-cli snooze tab <tab-id> <when>` - park a tab or tiled group.
 *
 * The tab id is resolved against the open AI tabs first, which is what gives it
 * the `active` keyword and prefix matching. A file, terminal, browser, or group
 * id is not in that list, so those are passed through verbatim and need
 * `--agent` to say who owns them - the renderer resolves the rest.
 */
export async function snoozeTabCommand(
	tabId: string,
	when: string,
	options: SnoozeOptions
): Promise<void> {
	const wakeAt = resolveWakeAt(when, options.json);

	let sessionId: string;
	let targetId = tabId;
	try {
		const entry = await resolveTabEntry(tabId, options.agent);
		sessionId = entry.agentId;
		targetId = entry.tabId;
	} catch (error) {
		if (!options.agent) {
			return failCommand(
				`${error instanceof Error ? error.message : String(error)}. Pass --agent <id> to snooze a file, terminal, browser, or group tab.`,
				options.json
			);
		}
		sessionId = resolveAgentOrFail(options.agent, options.json);
	}

	const result = await sendSnooze(
		{
			action: 'snooze',
			sessionId,
			targetId,
			wakeAt,
			...contentFields(options),
			background: resolveBackgroundFlag(options, 'snooze'),
		},
		options.json
	);

	if (options.json) {
		console.log(JSON.stringify({ success: true, snooze: result.snooze ?? null }, null, 2));
		return;
	}
	if (isQuiet()) return;
	console.log(
		formatSuccess(
			`Snoozed "${result.snooze?.label ?? targetId}" until ${formatSnoozeTarget(wakeAt)}`
		)
	);
	if (result.snooze) console.log(`  Snooze: ${result.snooze.snoozeId}`);
}

/** `maestro-cli snooze list` - every parked tab, soonest wake first. */
export async function snoozeList(options: SnoozeOptions): Promise<void> {
	const sessionId = options.agent ? resolveAgentOrFail(options.agent, options.json) : undefined;
	const result = await sendSnooze(
		{ action: 'list', ...(sessionId ? { sessionId } : {}) },
		options.json
	);
	const snoozes = result.snoozes ?? [];

	if (options.json) {
		console.log(JSON.stringify({ success: true, snoozes, count: snoozes.length }, null, 2));
		return;
	}
	if (snoozes.length === 0) {
		console.log('No snoozed tabs.');
		return;
	}
	console.log(`${snoozes.length} snoozed tab${snoozes.length === 1 ? '' : 's'}:`);
	for (const s of snoozes) console.log(describeSnooze(s));
}

/** Shared driver for the three verbs addressed by snooze id. */
async function snoozeIdAction(
	snoozeId: string,
	options: SnoozeOptions,
	build: (target: SnoozedTabSummary) => {
		request: SnoozeCommandRequest;
		report: (result: SnoozeResponse) => string;
	}
): Promise<void> {
	const target = await resolveSnooze(snoozeId, options.json);
	const { request, report } = build(target);
	const result = await sendSnooze(request, options.json);

	if (options.json) {
		console.log(
			JSON.stringify(
				{
					success: true,
					snooze: result.snooze ?? null,
					...(result.tabId ? { tabId: result.tabId } : {}),
					...(result.wasDuplicate ? { wasDuplicate: true } : {}),
				},
				null,
				2
			)
		);
		return;
	}
	if (!isQuiet()) console.log(formatSuccess(report(result)));
}

/** `maestro-cli snooze wake <snooze-id>` - bring a parked tab back right now. */
export async function snoozeWake(snoozeId: string, options: SnoozeOptions): Promise<void> {
	await snoozeIdAction(snoozeId, options, (target) => ({
		request: { action: 'wake', sessionId: target.agentId, targetId: target.snoozeId },
		// `wasDuplicate` is not a failure: an equivalent tab was already open, so
		// the snooze is resolved and the caller is pointed at the tab that has it.
		report: (result) =>
			result.wasDuplicate
				? `"${target.label}" was already open in tab ${result.tabId}`
				: `Restored "${target.label}"${result.tabId ? ` as tab ${result.tabId}` : ''}`,
	}));
}

/** `maestro-cli snooze dismiss <snooze-id>` - drop a snooze and its tab. */
export async function snoozeDismiss(snoozeId: string, options: SnoozeOptions): Promise<void> {
	await snoozeIdAction(snoozeId, options, (target) => ({
		request: {
			action: 'dismiss',
			sessionId: target.agentId,
			targetId: target.snoozeId,
			background: resolveBackgroundFlag(options, 'snooze-dismiss'),
		},
		report: () => `Dismissed "${target.label}"`,
	}));
}

/** `maestro-cli snooze reschedule <snooze-id> <when>` - move a snooze. */
export async function snoozeReschedule(
	snoozeId: string,
	when: string,
	options: SnoozeOptions
): Promise<void> {
	const wakeAt = resolveWakeAt(when, options.json);
	await snoozeIdAction(snoozeId, options, (target) => ({
		request: {
			action: 'reschedule',
			sessionId: target.agentId,
			targetId: target.snoozeId,
			wakeAt,
			...contentFields(options),
		},
		report: () => `"${target.label}" now returns ${formatSnoozeTarget(wakeAt)}`,
	}));
}

/** `maestro-cli snooze history` - snoozes that have already resolved. */
export async function snoozeHistory(options: SnoozeOptions): Promise<void> {
	let limit: number | undefined;
	if (options.limit !== undefined) {
		const parsed = Number(options.limit);
		if (!Number.isInteger(parsed) || parsed < 0) {
			return failCommand(
				`Invalid --limit "${options.limit}". Use a non-negative integer.`,
				options.json
			);
		}
		limit = parsed;
	}

	const result = await sendSnooze(
		{ action: 'history', ...(limit !== undefined ? { limit } : {}) },
		options.json
	);
	const history = result.history ?? [];

	if (options.json) {
		console.log(JSON.stringify({ success: true, history, count: history.length }, null, 2));
		return;
	}
	if (history.length === 0) {
		console.log('No resolved snoozes yet.');
		return;
	}
	for (const entry of history) {
		console.log(`  ${entry.label}`);
		console.log(
			`    ${entry.resolution} · ${entry.agentName || 'unknown agent'} · ${formatSnoozeTarget(entry.resolvedAt)}`
		);
		if (entry.note) console.log(`    note: ${entry.note}`);
	}
}
