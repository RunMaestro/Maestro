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

/**
 * The narrative section kinds, matching the prompt contract.
 *
 * `accomplishments` / `challenges` / `nextSteps` are always requested.
 * `progress` is CONDITIONAL: the prompt only asks for it when the user has
 * filled in the Ideal End State setting, so a report generated without one has
 * exactly the three original sections. It is accepted unconditionally here -
 * the parser's job is to validate shape, not to re-derive which sections the
 * prompt asked for, and a cached report from a run that had an end state must
 * still parse after the setting is cleared.
 */
export type NarrativeSectionKind = 'accomplishments' | 'challenges' | 'nextSteps' | 'progress';

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

/**
 * Discriminated result of {@link recoverDirectorNotesNarrative}. `reason`
 * explains what had to be salvaged so the UI can say so out loud.
 */
export type RecoverNarrativeResult =
	| {
			ok: true;
			narrative: DirectorNotesNarrative;
			reason: string;
			/**
			 * True when the repair cost the report NOTHING: every section and bullet
			 * the agent wrote survived and only syntax was rebuilt. Callers use this
			 * to decide whether the user needs to see a failure banner at all - a
			 * complete report should not be presented as a damaged one.
			 */
			lossless: boolean;
	  }
	| { ok: false; error: string };

const VALID_KINDS: ReadonlySet<string> = new Set<NarrativeSectionKind>([
	'accomplishments',
	'challenges',
	'nextSteps',
	'progress',
]);

/** Human-readable kind list, kept in sync with {@link VALID_KINDS} for errors. */
const VALID_KINDS_MESSAGE = [...VALID_KINDS].map((k) => `"${k}"`).join(', ');

/** Fallback headings when a salvaged section is missing its `title`. */
const DEFAULT_SECTION_TITLES: Record<NarrativeSectionKind, string> = {
	accomplishments: 'Accomplishments',
	challenges: 'Challenges',
	nextSteps: 'Next Steps',
	progress: 'Progress Toward Ideal End State',
};

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
			error: `${where}.kind must be one of ${VALID_KINDS_MESSAGE}.`,
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
 * Shown when the output is JSON-shaped but no narrative reached the reading
 * surface and no specific parse error came with it - the shape of a result
 * cached before the narrative fields existed. Generic on purpose: we know the
 * output is not a readable report, but not why.
 */
export const STRUCTURED_OUTPUT_UNPARSED_MESSAGE =
	'This report was returned as structured output that could not be read back. Regenerate it to get a fresh report.';

/**
 * Does this raw output even CLAIM to be the structured narrative?
 *
 * The Director's Notes prompt is a user-customizable core prompt persisted to
 * `userData/core-prompts-customizations.json`, so a profile can easily hold a
 * prompt that asks for markdown while the running build's parser expects JSON,
 * or the reverse. Neither is a malformed narrative - the agent did exactly what
 * the prompt it was given asked for. Shape is the only honest discriminator.
 *
 * The rule is deliberately narrow: after an optional leading code fence, the
 * output must START with `{`. The prompt says "return a single JSON object and
 * nothing else", so a genuine structured response always does. A markdown
 * report starts with a heading or prose - and critically, a markdown report
 * that merely CONTAINS a fenced JSON example still starts with prose, so it is
 * correctly treated as markdown. `extractFirstJsonObject` is intentionally not
 * used here: it scans anywhere in the string and would misread that example as
 * a botched narrative.
 *
 * Callers use this to decide what a parse failure MEANS: JSON-shaped means the
 * narrative really is broken and the user should see the error; anything else
 * is prose and should simply be rendered as markdown.
 */
export function looksLikeStructuredOutput(raw: string): boolean {
	if (typeof raw !== 'string') return false;

	let text = raw.trim();
	if (text.length === 0) return false;

	// Agents sometimes fence the object despite being told not to.
	if (text.startsWith('```')) {
		const newlineIndex = text.indexOf('\n');
		if (newlineIndex === -1) return false;
		text = text.slice(newlineIndex + 1).trimStart();
	}

	return text.startsWith('{');
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
		// An unterminated object is the common failure (an agent stopping at its
		// output limit), and it is NOT the same as prose with no object at all.
		// Saying "no JSON object found" about a response that visibly starts with
		// one sends the reader hunting for the wrong problem.
		return {
			ok: false,
			error: raw.includes('{')
				? 'The JSON object was never closed - the response was cut off before it finished.'
				: 'No JSON object found in the response.',
		};
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

/**
 * Rebuild a JSON object whose tail was cut off mid-stream.
 *
 * A synopsis run costs minutes of agent time and emits one very long single-line
 * object, so a response that dies partway through is the difference between a
 * readable report and nothing at all. Scan to the last COMPLETE nested container
 * (an item or a section object), cut there, and close the containers that are
 * still open. Cutting at a completed `}`/`]` is what makes this safe: it drops
 * any half-written string, dangling key, or trailing comma along with it.
 *
 * `lossless` distinguishes the two very different shapes of "truncated". An
 * agent writing right up against its output limit routinely finishes the whole
 * structure and loses only the final `}`: every section and bullet is present,
 * `sections` closed on its own, and the repair is pure punctuation. That is a
 * COMPLETE report and must not be shown to the user as a damaged one. A cut in
 * the middle of the bullet list is the real thing - content is gone - and
 * `lossless` is false. The test is exact: the cut discarded nothing but
 * whitespace, and the only frame left to close was the top-level object.
 *
 * Returns `null` when the input is not truncated (the top-level object closes on
 * its own, so the strict path already had its shot) or when nothing completed.
 */
function closeTruncatedJsonObject(raw: string): { text: string; lossless: boolean } | null {
	const start = raw.indexOf('{');
	if (start === -1) return null;

	const stack: string[] = [];
	let inString = false;
	let escaped = false;
	// Index of the last `}`/`]` that closed a NESTED container, plus the frames
	// still open at that point - the cut site and the closers it needs.
	let cutIndex = -1;
	let cutStack: string[] = [];

	for (let i = start; i < raw.length; i++) {
		const char = raw[i];

		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}

		if (char === '"') inString = true;
		else if (char === '{' || char === '[') stack.push(char);
		else if (char === '}' || char === ']') {
			stack.pop();
			// The top-level object closed: this response is not truncated.
			if (stack.length === 0) return null;
			cutIndex = i;
			cutStack = [...stack];
		}
	}

	if (cutIndex === -1) return null;

	const lossless = cutStack.length === 1 && raw.slice(cutIndex + 1).trim().length === 0;
	const closers = cutStack
		.reverse()
		.map((open) => (open === '{' ? '}' : ']'))
		.join('');
	return { text: raw.slice(start, cutIndex + 1) + closers, lossless };
}

/**
 * Escape raw control characters that appear INSIDE strings. A literal newline in
 * a bullet is invalid JSON (the prompt forbids it, models do it anyway) and is
 * otherwise a total loss for an entire report.
 */
function escapeControlCharsInStrings(jsonText: string): string {
	const ESCAPES: Record<string, string> = {
		'\n': '\\n',
		'\r': '\\r',
		'\t': '\\t',
		'\b': '\\b',
		'\f': '\\f',
	};

	let out = '';
	let inString = false;
	let escaped = false;

	for (const char of jsonText) {
		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;

			if (!escaped && char < ' ') {
				out += ESCAPES[char] ?? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
				continue;
			}
		} else if (char === '"') {
			inString = true;
		}

		out += char;
	}

	return out;
}

/**
 * Validate leniently: keep every item and section that is usable and DROP the
 * rest, rather than failing the whole document the way
 * {@link parseDirectorNotesNarrative} does. Returns `null` only when the value
 * is not narrative-shaped at all.
 */
function validateNarrativeLenient(
	parsed: unknown
): { narrative: DirectorNotesNarrative; dropped: number } | null {
	if (!isPlainObject(parsed) || !Array.isArray(parsed.sections)) return null;

	let dropped = 0;
	const sections: NarrativeSection[] = [];

	for (const rawSection of parsed.sections) {
		if (!isPlainObject(rawSection) || typeof rawSection.kind !== 'string') {
			dropped++;
			continue;
		}
		if (!VALID_KINDS.has(rawSection.kind)) {
			dropped++;
			continue;
		}
		const kind = rawSection.kind as NarrativeSectionKind;

		const items: NarrativeItem[] = [];
		for (const rawItem of Array.isArray(rawSection.items) ? rawSection.items : []) {
			if (!isPlainObject(rawItem) || typeof rawItem.text !== 'string' || !rawItem.text.trim()) {
				dropped++;
				continue;
			}
			const item: NarrativeItem = { text: rawItem.text };
			// A bad severity/agent only costs that field, never the bullet.
			if (typeof rawItem.severity === 'string' && VALID_SEVERITIES.has(rawItem.severity)) {
				item.severity = rawItem.severity as NarrativeItemSeverity;
			}
			if (typeof rawItem.agent === 'string') item.agent = rawItem.agent;
			items.push(item);
		}

		sections.push({
			kind,
			title: typeof rawSection.title === 'string' ? rawSection.title : DEFAULT_SECTION_TITLES[kind],
			items,
		});
	}

	if (sections.length === 0) return null;
	return { narrative: { version: 1, sections }, dropped };
}

/**
 * Best-effort salvage of output the strict parser rejected.
 *
 * Call this ONLY after {@link parseDirectorNotesNarrative} returns `{ ok: false }`.
 * It repairs the two failures that actually cost users a report - a response cut
 * off mid-stream and raw control characters inside strings - then validates
 * leniently, dropping individual malformed bullets instead of the document.
 *
 * Recovery reports what it did: `reason` states what was repaired, and
 * `lossless` says whether that repair cost the report any content. A lossless
 * repair (only syntax rebuilt) yields a COMPLETE report, so callers should not
 * dress it up as a failure; anything else should be surfaced next to the
 * narrative. When nothing usable survives, this returns `{ ok: false }` and the
 * caller shows the strict parse error instead.
 */
export function recoverDirectorNotesNarrative(raw: string): RecoverNarrativeResult {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		return { ok: false, error: 'Response was empty.' };
	}

	// Ordered by fidelity: the untouched object first, then each repair. Each
	// candidate remembers which repairs produced it so the reason we report is
	// the one that actually applied.
	const truncationRepair = closeTruncatedJsonObject(raw);
	const candidates: Array<{
		text: string;
		wasTruncated: boolean;
		lostContent: boolean;
		wasEscaped: boolean;
	}> = [];
	for (const [text, wasTruncated, lostContent] of [
		[extractFirstJsonObject(raw), false, false],
		[truncationRepair?.text ?? null, true, truncationRepair ? !truncationRepair.lossless : false],
	] as const) {
		if (text === null) continue;
		candidates.push({ text, wasTruncated, lostContent, wasEscaped: false });
		candidates.push({
			text: escapeControlCharsInStrings(text),
			wasTruncated,
			lostContent,
			wasEscaped: true,
		});
	}

	for (const candidate of candidates) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(candidate.text);
		} catch {
			continue;
		}

		const lenient = validateNarrativeLenient(parsed);
		if (!lenient) continue;

		const reasons: string[] = [];
		if (candidate.wasTruncated) {
			reasons.push(
				candidate.lostContent
					? 'the response was cut off before it finished'
					: 'the response was missing its closing punctuation'
			);
		}
		if (candidate.wasEscaped) {
			reasons.push('the response contained line breaks that are not valid inside JSON');
		}
		if (lenient.dropped > 0) {
			reasons.push(
				`${lenient.dropped} ${lenient.dropped === 1 ? 'bullet was' : 'bullets were'} malformed and dropped`
			);
		}
		if (reasons.length === 0) reasons.push('the response did not match the expected shape exactly');

		// Only a mid-report cut or a dropped bullet actually costs content.
		// Rebuilding syntax - closing punctuation, escaping a stray line break -
		// leaves every word the agent wrote intact.
		const lossless = !candidate.lostContent && lenient.dropped === 0;

		return {
			ok: true,
			narrative: lenient.narrative,
			lossless,
			reason: lossless
				? `Repaired the response before reading it: ${reasons.join(', and ')}. No report content was lost.`
				: `Recovered what could be read: ${reasons.join(', and ')}.`,
		};
	}

	return { ok: false, error: 'No recoverable narrative content found in the response.' };
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
 * still render their heading plus a "Nothing to report." note so the report's
 * section structure is always recognizable.
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
