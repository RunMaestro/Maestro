/**
 * Message pins: messages a person marks in an AI tab so they can jump back to
 * them from the pin panel.
 *
 * A pin belongs to ONE tab. It lives on the tab (`AITab.pinnedMessages`), so
 * the closed-tab stack carries it, and it is mirrored to the provider
 * session's origin record, so reopening the conversation from History or the
 * sessions browser brings it back too. Forking a tab or sending it to another
 * agent does not copy it.
 *
 * Only two kinds of entry can be pinned: the person's own messages (`user`)
 * and agent replies (`stdout`). Tool calls, thinking, errors and system
 * notices cannot.
 *
 * The hard part is identity. A pin records the id of the transcript row it was
 * made on, but that id does not survive every path back to the tab: a tab that
 * is closed and reopened, or resumed from History, is rebuilt from the
 * provider's transcript, and its rows get the transcript's ids, not the ones a
 * live turn generated. So a pin also records what the message said and when,
 * and `resolvePinnedRow` falls back to those when the id is gone. Shared
 * because main validates stored pins and the CLI prints them.
 */

import { stripMarkdown } from './markdown';

/** Entry sources a pin may point at: the person's messages and agent replies. */
export const PINNABLE_SOURCES = ['user', 'stdout'] as const;

export type PinnableSource = (typeof PINNABLE_SOURCES)[number];

/** Most pins one tab keeps. The oldest pin is dropped past this. */
export const MAX_MESSAGE_PINS = 200;

/** Length of the stored excerpt (plain text, single line). */
export const MESSAGE_PIN_EXCERPT_CHARS = 280;

/** Longest automatic or user-chosen pin label. */
export const MESSAGE_PIN_LABEL_MAX_CHARS = 120;

/**
 * How much of the excerpt has to agree for a content match. Shorter than the
 * excerpt on purpose: a reply rebuilt from the transcript can differ from the
 * streamed one near its end (blocks joined differently), almost never at its
 * start.
 */
const MATCH_KEY_CHARS = 120;

/** Raw text read before stripping markdown, so a huge reply stays cheap. */
const EXCERPT_SOURCE_CHARS = 2000;

/** One pinned message. */
export interface MessagePin {
	/** The pin's own id. Stable across renames and re-resolution. */
	id: string;
	/** Id of the transcript row the pin was made on. */
	logId: string;
	source: PinnableSource;
	/** The message's own timestamp (ms epoch), not when it was pinned. */
	timestamp: number;
	/** Label taken from the message's first line when it was pinned. */
	title: string;
	/** Label the person gave the pin. Wins over `title` when set. */
	label?: string;
	/** Leading plain text of the message, for matching and filtering. */
	excerpt: string;
	/** When the pin was made (ms epoch). */
	pinnedAt: number;
}

/** The fields of a transcript row a pin is made from and resolved against. */
export interface PinnableRow {
	id: string;
	source: string;
	timestamp: number;
	text: string;
}

/** Whether entries from `source` can be pinned. */
export function isPinnableSource(source: unknown): source is PinnableSource {
	return typeof source === 'string' && PINNABLE_SOURCES.includes(source as PinnableSource);
}

/** Whether `row` can be pinned: a message or reply with some text. */
export function isPinnableRow(row: PinnableRow): boolean {
	return isPinnableSource(row.source) && row.text.trim().length > 0;
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** Plain-text lines of the start of a message, markdown removed. */
function plainLines(text: string): string[] {
	return stripMarkdown(text.slice(0, EXCERPT_SOURCE_CHARS))
		.split('\n')
		.map((line) => collapseWhitespace(line))
		.filter((line) => line.length > 0 && line !== '---');
}

/** The leading plain text of a message, on one line, as a pin stores it. */
export function messagePinExcerpt(text: string): string {
	return plainLines(text).join(' ').slice(0, MESSAGE_PIN_EXCERPT_CHARS);
}

/** The automatic label for a message: its first line of plain text. */
export function messagePinTitle(text: string): string {
	const first = plainLines(text)[0] ?? '';
	return clip(first, MESSAGE_PIN_LABEL_MAX_CHARS);
}

/** What the pin panel shows for a pin: the person's label, else the title. */
export function messagePinLabel(pin: MessagePin): string {
	const label = pin.label?.trim();
	if (label) return label;
	return pin.title || pin.excerpt || 'Pinned message';
}

/** Build a pin for `row`. */
export function createMessagePin(row: PinnableRow, id: string, now: number): MessagePin {
	if (!isPinnableSource(row.source)) {
		throw new Error(`Entries from "${row.source}" cannot be pinned`);
	}
	return {
		id,
		logId: row.id,
		source: row.source,
		timestamp: row.timestamp,
		title: messagePinTitle(row.text),
		excerpt: messagePinExcerpt(row.text),
		pinnedAt: now,
	};
}

/**
 * Find the row a pin points at, or null when it is not in `rows`.
 *
 * Tiers, best first:
 *   1. The row id the pin was made on: the tab was not rebuilt since.
 *   2. Same source and the same leading text, nearest in time: the tab was
 *      rebuilt from the transcript, which assigns new ids and the provider's
 *      own timestamps. Nearest-in-time picks the right one of several
 *      identical messages ("continue" sent five times).
 *
 * Null means the message is not loaded (older than what the tab has read back)
 * or no longer exists. The pin is kept either way: the panel still lists it.
 */
export function resolvePinnedRow<T extends PinnableRow>(pin: MessagePin, rows: T[]): T | null {
	const byId = rows.find((row) => row.id === pin.logId);
	if (byId) return byId;

	const key = pin.excerpt.slice(0, MATCH_KEY_CHARS);
	if (!key) return null;
	let best: T | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const row of rows) {
		if (row.source !== pin.source) continue;
		if (messagePinExcerpt(row.text).slice(0, MATCH_KEY_CHARS) !== key) continue;
		const distance = Math.abs(row.timestamp - pin.timestamp);
		if (distance < bestDistance) {
			best = row;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * Resolve every pin at once. Returns pin id -> row for the pins that resolve.
 *
 * Two pins never claim the same row: if both resolve to one row (the same
 * message pinned before and after a rebuild), the first keeps it.
 */
export function resolvePinnedRows<T extends PinnableRow>(
	pins: MessagePin[],
	rows: T[]
): Map<string, T> {
	const resolved = new Map<string, T>();
	if (pins.length === 0 || rows.length === 0) return resolved;
	const claimed = new Set<string>();
	for (const pin of pins) {
		const row = resolvePinnedRow(pin, rows);
		if (!row || claimed.has(row.id)) continue;
		claimed.add(row.id);
		resolved.set(pin.id, row);
	}
	return resolved;
}

/**
 * The pin that sits on `row`, if any. `rows` is everything pins resolve
 * against, so the answer agrees with `resolvePinnedRows` (which never lets two
 * pins claim one row).
 */
export function findPinForRow(
	pins: MessagePin[],
	row: PinnableRow,
	rows: PinnableRow[]
): MessagePin | null {
	for (const [pinId, resolved] of resolvePinnedRows(pins, rows)) {
		if (resolved.id === row.id) return pins.find((pin) => pin.id === pinId) ?? null;
	}
	return null;
}

/** Pins in transcript order (oldest message first). */
export function sortMessagePins(pins: MessagePin[]): MessagePin[] {
	return [...pins].sort((a, b) => a.timestamp - b.timestamp || a.pinnedAt - b.pinnedAt);
}

/**
 * Add a pin for `row`, keeping at most `MAX_MESSAGE_PINS`. When the cap is
 * reached the pin made longest ago is dropped.
 */
export function addMessagePin(pins: MessagePin[], pin: MessagePin): MessagePin[] {
	const next = sortMessagePins([...pins, pin]);
	if (next.length <= MAX_MESSAGE_PINS) return next;
	const oldest = next.reduce((a, b) => (b.pinnedAt < a.pinnedAt ? b : a));
	return next.filter((p) => p.id !== oldest.id);
}

/** `pins` without the pin `pinId`. The same array when nothing matched. */
export function removeMessagePin(pins: MessagePin[], pinId: string): MessagePin[] {
	return pins.some((pin) => pin.id === pinId) ? pins.filter((pin) => pin.id !== pinId) : pins;
}

/**
 * Rename a pin. A blank label clears it, so the pin shows its title again.
 * The same array when nothing matched.
 */
export function renameMessagePin(
	pins: MessagePin[],
	pinId: string,
	label: string | null
): MessagePin[] {
	const trimmed = collapseWhitespace(label ?? '').slice(0, MESSAGE_PIN_LABEL_MAX_CHARS);
	if (!pins.some((pin) => pin.id === pinId)) return pins;
	return pins.map((pin) => {
		if (pin.id !== pinId) return pin;
		if (!trimmed) {
			const { label: _dropped, ...rest } = pin;
			return rest;
		}
		return { ...pin, label: trimmed };
	});
}

/**
 * Whether a pin matches the panel's filter. Case-insensitive and
 * whitespace-separated terms must ALL appear somewhere in the label, the
 * title, or the message text (`fullText` when the message is loaded, else the
 * stored excerpt).
 */
export function messagePinMatchesFilter(
	pin: MessagePin,
	query: string,
	fullText?: string
): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const haystack = [pin.label ?? '', pin.title, fullText ?? pin.excerpt].join('\n').toLowerCase();
	return terms.every((term) => haystack.includes(term));
}

/**
 * Narrow stored or wire data to valid pins. Drops malformed entries rather
 * than failing, since this reads disk and IPC from any app version.
 */
export function normalizeMessagePins(raw: unknown): MessagePin[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const pins: MessagePin[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const value = item as Record<string, unknown>;
		if (typeof value.id !== 'string' || !value.id || seen.has(value.id)) continue;
		if (typeof value.logId !== 'string' || !value.logId) continue;
		if (!isPinnableSource(value.source)) continue;
		if (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) continue;
		const excerpt = typeof value.excerpt === 'string' ? value.excerpt : '';
		const title = typeof value.title === 'string' ? value.title : '';
		const label =
			typeof value.label === 'string' && value.label.trim()
				? value.label.trim().slice(0, MESSAGE_PIN_LABEL_MAX_CHARS)
				: undefined;
		seen.add(value.id);
		pins.push({
			id: value.id,
			logId: value.logId,
			source: value.source,
			timestamp: value.timestamp,
			title: title.slice(0, MESSAGE_PIN_LABEL_MAX_CHARS),
			...(label ? { label } : {}),
			excerpt: excerpt.slice(0, MESSAGE_PIN_EXCERPT_CHARS),
			pinnedAt:
				typeof value.pinnedAt === 'number' && Number.isFinite(value.pinnedAt)
					? value.pinnedAt
					: value.timestamp,
		});
		if (pins.length >= MAX_MESSAGE_PINS) break;
	}
	return sortMessagePins(pins);
}
