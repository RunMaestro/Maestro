/**
 * Director's Notes structured narrative schema + parser.
 *
 * Phase 02 made every NUMBER deterministic. This module owns the QUALITATIVE
 * half: the typed JSON structure the Director's Notes agent emits instead of a
 * markdown blob. Rich Mode renders this structure as styled `SectionCard`s; the
 * main-process IPC handler parses the raw agent output through here.
 *
 * `parseDirectorNotesNarrative` is the SINGLE source of truth for turning the
 * agent's raw string into a validated `DirectorNotesNarrative`. It never throws
 * and never guesses a partial structure: on any structural problem it returns
 * `{ ok: false, error }` with a precise message so the renderer can surface an
 * overt failure (raw output still reachable) rather than silently degrading.
 *
 * Pure and dependency-free so it can be unit-tested in isolation (Phase 05) and
 * imported from both the main process and the renderer.
 */

/** The three fixed narrative section kinds, matching the prompt contract. */
export type NarrativeSectionKind = 'accomplishments' | 'challenges' | 'nextSteps';

/** Optional per-item severity used to style bullet emphasis in Rich Mode. */
export type NarrativeItemSeverity = 'info' | 'warn' | 'critical';

/** A single bullet within a narrative section. */
export interface NarrativeItem {
	/** The bullet text (required). */
	text: string;
	/** Optional severity; `critical` renders with error emphasis. */
	severity?: NarrativeItemSeverity;
	/** Optional agent/session name this item relates to, shown as a pill. */
	agent?: string;
}

/** A titled group of bullets of a single kind. */
export interface NarrativeSection {
	kind: NarrativeSectionKind;
	title: string;
	items: NarrativeItem[];
}

/** The full structured narrative the agent returns (version 1). */
export interface DirectorNotesNarrative {
	version: 1;
	sections: NarrativeSection[];
}

/** Discriminated result of {@link parseDirectorNotesNarrative}. */
export type ParseNarrativeResult =
	| { ok: true; narrative: DirectorNotesNarrative }
	| { ok: false; error: string };

const VALID_KINDS: ReadonlySet<string> = new Set<NarrativeSectionKind>([
	'accomplishments',
	'challenges',
	'nextSteps',
]);

const VALID_SEVERITIES: ReadonlySet<string> = new Set<NarrativeItemSeverity>([
	'info',
	'warn',
	'critical',
]);

/** Narrow an unknown value to a plain (non-array, non-null) object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a single item object. Returns the typed item on success, or an error
 * string (scoped with the section/item location) on any structural problem.
 */
function validateItem(
	raw: unknown,
	sectionIndex: number,
	itemIndex: number
): { ok: true; item: NarrativeItem } | { ok: false; error: string } {
	const where = `sections[${sectionIndex}].items[${itemIndex}]`;
	if (!isPlainObject(raw)) {
		return { ok: false, error: `${where} must be an object.` };
	}
	if (typeof raw.text !== 'string') {
		return { ok: false, error: `${where}.text must be a string.` };
	}

	const item: NarrativeItem = { text: raw.text };

	if (raw.severity !== undefined) {
		if (typeof raw.severity !== 'string' || !VALID_SEVERITIES.has(raw.severity)) {
			return {
				ok: false,
				error: `${where}.severity must be one of "info", "warn", "critical".`,
			};
		}
		item.severity = raw.severity as NarrativeItemSeverity;
	}

	if (raw.agent !== undefined) {
		if (typeof raw.agent !== 'string') {
			return { ok: false, error: `${where}.agent must be a string.` };
		}
		item.agent = raw.agent;
	}

	return { ok: true, item };
}

/**
 * Validate a single section object. Returns the typed section on success, or an
 * error string on any structural problem.
 */
function validateSection(
	raw: unknown,
	sectionIndex: number
): { ok: true; section: NarrativeSection } | { ok: false; error: string } {
	const where = `sections[${sectionIndex}]`;
	if (!isPlainObject(raw)) {
		return { ok: false, error: `${where} must be an object.` };
	}
	if (typeof raw.kind !== 'string' || !VALID_KINDS.has(raw.kind)) {
		return {
			ok: false,
			error: `${where}.kind must be one of "accomplishments", "challenges", "nextSteps".`,
		};
	}
	if (typeof raw.title !== 'string') {
		return { ok: false, error: `${where}.title must be a string.` };
	}
	if (!Array.isArray(raw.items)) {
		return { ok: false, error: `${where}.items must be an array.` };
	}

	const items: NarrativeItem[] = [];
	for (let i = 0; i < raw.items.length; i++) {
		const result = validateItem(raw.items[i], sectionIndex, i);
		if (!result.ok) return result;
		items.push(result.item);
	}

	return {
		ok: true,
		section: { kind: raw.kind as NarrativeSectionKind, title: raw.title, items },
	};
}

/**
 * Slice out the first complete, brace-balanced JSON object in `raw`.
 *
 * Scanning to the matching close brace (tracking string state so a `{`/`}`
 * inside a bullet's text doesn't move the depth counter) rather than to the
 * LAST `}` in the response: agents routinely append a closing code fence or a
 * trailing "Note: ..." sentence, and a naive `lastIndexOf('}')` swallows that
 * epilogue into the slice and fails an otherwise-valid object.
 */
function extractFirstJsonObject(raw: string): string | null {
	const start = raw.indexOf('{');
	if (start === -1) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < raw.length; i++) {
		const char = raw[i];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') inString = true;
		else if (char === '{') depth++;
		else if (char === '}') {
			depth--;
			if (depth === 0) return raw.slice(start, i + 1);
		}
	}

	return null;
}

/**
 * Tolerantly extract and strictly validate the structured narrative from the
 * agent's raw output.
 *
 * Extraction tolerates a leading code fence or stray prose, plus any epilogue
 * after the object, by taking the first brace-balanced object in the response.
 * Validation is strict: `version` must be the number 1, `sections` must be an
 * array of well-formed sections, and every item must have a string `text` plus
 * only the allowed optional `severity`/`agent` fields. Any deviation yields
 * `{ ok: false, error }` with a precise message - the function never throws and
 * never returns a partially-built structure.
 */
export function parseDirectorNotesNarrative(raw: string): ParseNarrativeResult {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		return { ok: false, error: 'Response was empty.' };
	}

	const jsonText = extractFirstJsonObject(raw);
	if (jsonText === null) {
		return { ok: false, error: 'No JSON object found in the response.' };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `Response is not valid JSON: ${detail}` };
	}

	if (!isPlainObject(parsed)) {
		return { ok: false, error: 'Top-level value must be a JSON object.' };
	}
	if (parsed.version !== 1) {
		return { ok: false, error: 'Field "version" must be the number 1.' };
	}
	if (!Array.isArray(parsed.sections)) {
		return { ok: false, error: 'Field "sections" must be an array.' };
	}

	const sections: NarrativeSection[] = [];
	for (let i = 0; i < parsed.sections.length; i++) {
		const result = validateSection(parsed.sections[i], i);
		if (!result.ok) return result;
		sections.push(result.section);
	}

	return { ok: true, narrative: { version: 1, sections } };
}

/** Render one bullet as Markdown, mirroring Rich Mode's emphasis without colors. */
function narrativeItemToMarkdown(item: NarrativeItem): string {
	// `critical` reads as bold (Rich Mode shows it red + bold); `warn`/`info`
	// stay plain. An item's `agent` is appended as a light italic attribution -
	// the prose analogue of Rich Mode's agent pill.
	const text = item.severity === 'critical' ? `**${item.text}**` : item.text;
	const attribution = item.agent ? ` _(${item.agent})_` : '';
	return `- ${text}${attribution}`;
}

/**
 * Render a parsed narrative as clean Markdown prose. This is the qualitative
 * counterpart to {@link parseDirectorNotesNarrative}: the agent now emits the
 * structured JSON object, so Director's Notes "Plain Mode" (and the Copy/Save
 * outputs) feed the raw string back through here to reproduce the pre-Rich-Mode
 * reading experience instead of dumping the JSON.
 *
 * Each section becomes a `##` heading followed by a bullet list. Empty sections
 * still render their heading plus a "Nothing to report." note so the three-part
 * Accomplishments / Challenges / Next Steps structure is always recognizable.
 */
export function narrativeToMarkdown(narrative: DirectorNotesNarrative): string {
	const blocks = narrative.sections.map((section) => {
		const lines = [`## ${section.title}`, ''];
		if (section.items.length === 0) {
			lines.push('_Nothing to report._');
		} else {
			for (const item of section.items) {
				lines.push(narrativeItemToMarkdown(item));
			}
		}
		return lines.join('\n');
	});
	return blocks.join('\n\n').trim() + '\n';
}
