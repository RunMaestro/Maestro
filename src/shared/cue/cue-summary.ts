/**
 * Human-friendly descriptors for completed Cue runs.
 *
 * Used by the Right Panel History list (HistoryEntry.summary) and the
 * Cue Modal's Activity Log row so both views describe a run identically:
 * subscription name, agent that ran it, and a short event-payload detail
 * (issue/PR title, file changed, task count, etc.).
 *
 * Pure / runtime-agnostic - safe to import from main and renderer alike.
 */

import { stripMarkdown } from '../markdown';
import { stripAnsiCodes } from '../stringUtils';
import type { CueEvent, CueEventType, CueRunResult } from './contracts';

/**
 * Canonical, user-facing label for each Cue event type. Single source of truth
 * shared by main and renderer; the pipeline editor re-exports this as
 * `EVENT_LABELS`. Keep in sync with the `CueEventType` union in contracts.ts.
 */
export const CUE_EVENT_LABELS: Record<CueEventType, string> = {
	'app.startup': 'App Startup',
	'time.heartbeat': 'Heartbeat Timer',
	'time.scheduled': 'Scheduled',
	'time.once': 'One-Time',
	'file.changed': 'File Change',
	'agent.completed': 'Agent Completed',
	'github.pull_request': 'Pull Request',
	'github.issue': 'GitHub Issue',
	'github.label': 'GitHub Label',
	'task.pending': 'Pending Task',
	'cli.trigger': 'CLI Trigger',
	'plugin.event': 'Plugin event',
	'webhook.received': 'Webhook',
};

/**
 * Humanize a raw Cue event type string (`time.heartbeat`) into a display label
 * (`Heartbeat Timer`). Unknown/legacy types are prettified by title-casing the
 * dotted segments so the UI never surfaces machine jargon. Safe on undefined.
 */
export function humanizeCueEventType(type: string | undefined | null): string {
	if (!type) return 'Trigger';
	const known = CUE_EVENT_LABELS[type as CueEventType];
	if (known) return known;
	return type
		.split('.')
		.map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(' ');
}

/**
 * Format a recurring interval (in minutes) as a compact cadence label:
 * `every 3 min`, `hourly`, `every 2 hr`.
 */
function formatCueInterval(minutes: number): string {
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return hours === 1 ? 'hourly' : `every ${hours} hr`;
	}
	return `every ${minutes} min`;
}

/**
 * Short, event-type-specific detail extracted from the payload, suitable for
 * inlining in a list-row title. Returns undefined when the event has no
 * meaningful payload (app.startup, bare heartbeats, etc.).
 */
export function getCueEventDetail(event: CueEvent): string | undefined {
	const payload = event.payload ?? {};

	switch (event.type) {
		case 'github.pull_request':
		case 'github.issue': {
			const number = payload.number;
			const title = payload.title ? String(payload.title).trim() : '';
			if (number == null || number === '') return title || undefined;
			return title ? `#${number} ${title}` : `#${number}`;
		}

		case 'github.label': {
			// The label is what distinguishes one of these runs from the next,
			// so it leads even when the item number is missing.
			const label = payload.label ? String(payload.label).trim() : '';
			const number = payload.number;
			if (number == null || number === '') return label || undefined;
			return label ? `${label} on #${number}` : `#${number}`;
		}

		case 'file.changed': {
			const file = payload.file ?? payload.filename ?? payload.path;
			if (!file) return undefined;
			return String(file).split('/').pop() ?? String(file);
		}

		case 'task.pending': {
			const filename = payload.filename ?? payload.path;
			if (!filename) return undefined;
			const name = String(filename).split('/').pop() ?? String(filename);
			const count = Number(payload.taskCount ?? 0);
			if (!Number.isFinite(count) || count <= 0) return name;
			return `${name} (${count} ${count === 1 ? 'task' : 'tasks'})`;
		}

		case 'agent.completed': {
			const src = payload.sourceSession;
			return src ? `from ${String(src)}` : undefined;
		}

		case 'cli.trigger': {
			const prompt = payload.cliPrompt;
			if (!prompt) return undefined;
			const oneLine = String(prompt).replace(/\s+/g, ' ').trim();
			return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
		}

		case 'time.heartbeat':
		case 'time.scheduled':
		case 'time.once': {
			const mins = Number(payload.interval_minutes ?? payload.intervalMinutes ?? payload.interval);
			return Number.isFinite(mins) && mins > 0 ? formatCueInterval(mins) : undefined;
		}

		default:
			return undefined;
	}
}

/**
 * Splits a subscription name written under the `<base>-chain-N` / `<base>-fanin`
 * convention into its base label and chain position (if any). Handles the
 * fan-in tracker's `<base>:<other>` keys by stripping the colon-suffixed half
 * before inspecting the chain suffix.
 *
 * Used as a fallback when `pipeline_name` isn't set on the subscription
 * (legacy YAML, manually-authored chains, or fan-in synthetic names).
 */
export function parseSubscriptionName(name: string): {
	base: string;
	chainIndex?: number;
	fanin: boolean;
} {
	const root = name.split(':')[0] ?? name;

	const chainMatch = root.match(/^(.*)-chain-(\d+)$/);
	if (chainMatch) {
		return { base: chainMatch[1], chainIndex: Number(chainMatch[2]), fanin: false };
	}

	if (root.endsWith('-fanin')) {
		return { base: root.slice(0, -'-fanin'.length), fanin: true };
	}

	return { base: root, fanin: false };
}

/**
 * Compact one-line summary of a Cue run for list views.
 *
 * Format: `"<trigger>" · <agent>[ #N] - <detail>`
 * - `<trigger>` is `pipelineName` when set, else the base subscription name
 *   (with `-chain-N` / `-fanin` stripped). This mirrors the user-facing
 *   pipeline label they see in the Cue Modal so chains are identified by
 *   their pipeline, not their internal `Maestro-chain-2` plumbing name.
 * - `<agent>` is the running session name. Omitted when it duplicates the
 *   trigger (i.e. the agent IS the pipeline anchor).
 * - ` #N` is appended to the agent label when the subscription was a chain
 *   step (`-chain-N`), so two history rows from the same pipeline + same
 *   agent stay distinguishable. `(fan-in)` is used for fan-in sinks.
 * - `<detail>` is the event-specific payload synopsis (issue/PR title,
 *   file changed, task count, etc.) and is omitted when none is meaningful.
 *
 * Examples:
 *   `"PR Triage Main" · rc #2 - #891 Feature: Support arbitrary CLI agents…`
 *   `"Issue Triage" · rc - #909 fix(cli): register copilot-cli…`
 *   `"Maestro" · rc #2 - #891 Feature: …` (legacy YAML, no pipeline_name)
 *   `"Hourly Sync"` (no agent distinction, no payload)
 */
export function buildCueRunSummary(
	result: Pick<CueRunResult, 'subscriptionName' | 'pipelineName' | 'sessionName' | 'event'>
): string {
	const parsed = parseSubscriptionName(result.subscriptionName);
	const triggerLabel = result.pipelineName?.trim() || parsed.base;
	const trigger = `"${triggerLabel}"`;

	const agentBase =
		result.sessionName && result.sessionName !== triggerLabel ? result.sessionName : undefined;
	const chainTag = parsed.chainIndex
		? `#${parsed.chainIndex}`
		: parsed.fanin
			? '(fan-in)'
			: undefined;

	let head = trigger;
	if (agentBase && chainTag) head = `${trigger} · ${agentBase} ${chainTag}`;
	else if (agentBase) head = `${trigger} · ${agentBase}`;
	else if (chainTag) head = `${trigger} ${chainTag}`;

	const detail = getCueEventDetail(result.event);
	return detail ? `${head} - ${detail}` : head;
}

/**
 * Extract a short excerpt from a Cue run's stdout for use as the History
 * list-row body. Returns `undefined` ONLY when the run printed nothing visible
 * (empty, whitespace, or ANSI codes alone): the persisted excerpt is the
 * "did this run say anything" signal, and History hides a completed run whose
 * excerpt is NULL (`CUE_EVENT_WORTH_SHOWING_SQL`). A run that answered with
 * something hard to summarize must still get a body, or it vanishes as if it
 * had been silent.
 *
 * Strips ANSI escape codes and markdown, collapses whitespace, then greedily
 * accumulates up to `maxSentences` complete sentences while staying within
 * `maxChars`. Sentence boundaries are detected as `.!?` followed by whitespace
 * and a capital letter or digit - good enough to avoid splitting on filenames
 * like `2026-05-13-AM.md` or numbers like `2.34M`.
 *
 * Two fallbacks keep visible output from collapsing to nothing:
 * - Stripping markdown left no text. That happens when the answer is only a
 *   table (bare, or wrapped in a fence, inline code or emphasis), which
 *   stripMarkdown() drops on purpose, so it runs again with the table's cells
 *   flattened into text instead. Anything else markup-only (an empty fence,
 *   an image with no alt) falls back to the raw text.
 * - Not even the first sentence fits the cap. The text is clipped instead.
 */
export function extractCueOutputExcerpt(
	stdout: string | undefined | null,
	opts: { maxChars?: number; maxSentences?: number } = {}
): string | undefined {
	if (!stdout) return undefined;
	const maxChars = opts.maxChars ?? 240;
	const maxSentences = opts.maxSentences ?? 2;

	const plain = stripAnsiCodes(stdout);
	const text =
		collapseWhitespace(stripMarkdown(plain)) ||
		collapseWhitespace(stripMarkdown(plain, { tables: 'flatten' })) ||
		collapseWhitespace(plain);
	if (!text) return undefined;

	const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z0-9])/);

	let result = '';
	let count = 0;
	for (const sentence of sentences) {
		if (count >= maxSentences) break;
		const trimmed = sentence.trim();
		if (!trimmed) continue;
		const candidate = result ? `${result} ${trimmed}` : trimmed;
		if (candidate.length > maxChars) break;
		result = candidate;
		count++;
	}

	return result || clipExcerpt(text, maxChars);
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Clip whitespace-collapsed `text` to at most `maxChars`, ellipsis included.
 * Breaks on the last word boundary when that keeps at least half the budget;
 * a single unbroken token (a URL, a hash) is cut mid-token instead, stepping
 * back off a dangling high surrogate so an emoji is never split in half.
 */
function clipExcerpt(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const wordEnd = text.lastIndexOf(' ', maxChars - 1);
	const clipped =
		wordEnd >= maxChars / 2
			? text.slice(0, wordEnd)
			: text.slice(0, maxChars - 1).replace(/[\uD800-\uDBFF]$/, '');
	return `${clipped}…`;
}
