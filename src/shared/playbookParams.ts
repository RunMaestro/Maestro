/**
 * Playbook parameters: the "answers" namespace of a playbook.
 *
 * A playbook's outer prompt declares per-run configuration in prose, following
 * the Outer-Prompt Lift Convention of the Maestro-Playbooks content repo
 * (`.maestro/playbooks/CONVENTION.md`):
 *
 * ```markdown
 * <!-- CONFIGURE: How many top-level items to process, or all -->
 * **MAX_ITEMS:** `25`
 * <!-- Examples / valid values:
 * - 25
 * - all
 * -->
 * ```
 *
 * and its documents reference the value as `[MAX_ITEMS]`. This module reads
 * that prose into typed specs so both Auto Run engines (the desktop renderer
 * and the CLI) can draw a form, validate it, and substitute the answers.
 *
 * Lives in `shared/` and imports no Electron, React, or Node built-ins, so the
 * CLI bundle can use it.
 */

import { forEachMarkdownLine } from './markdownTaskScan';

/** The value types a parameter can declare. Prose-only parameters are `string`. */
export type PlaybookParamType = 'string' | 'url' | 'number' | 'multi-enum';

/** One declared playbook parameter. */
export interface PlaybookParamSpec {
	/** `UPPER_SNAKE_CASE` name, referenced in documents as `[NAME]`. */
	name: string;
	/** Display label. Absent for prose specs: the name is the label. */
	label?: string;
	/** One-line description, from the `CONFIGURE` comment. */
	help?: string;
	type: PlaybookParamType;
	/** Author default. Absent when the prose default is a placeholder. */
	default?: string;
	/** True when the run cannot start without a value. */
	required: boolean;
	/** Allowed values (`multi-enum`), or example hints from prose (not enforced). */
	options?: string[];
	/** Full-match regex the value must satisfy. */
	pattern?: string;
	min?: number;
	max?: number;
	/** Where the declaration came from: the prompt prose, the manifest overlay, or both. */
	source: 'prose' | 'overlay' | 'both';
}

/** Parameter answers keyed by name. Always strings, because the substitution target is text. */
export type PlaybookParamValues = Record<string, string>;

/** A legal parameter name: uppercase, at least two characters, so `- [ ]` and `- [x]` never match. */
export const PLAYBOOK_PARAM_NAME_REGEX = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * A shipped default that LOOKS like a value but is a placeholder. The content
 * repo uses it for `PR_URL`, `PR_A_URL`, and `PR_B_URL`; running on it means
 * running the whole chain against a 404.
 */
export const PLACEHOLDER_PR_URL = 'https://github.com/OWNER/REPO/pull/XXX';

/**
 * Whether a prose default is a placeholder rather than a usable value:
 * the `<UNSET ...>` sentinel or the placeholder PR URL.
 */
export function isPlaceholderDefault(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.startsWith('<UNSET') || trimmed === PLACEHOLDER_PR_URL;
}

// `**NAME:** `default`` on its own line.
const PARAM_LINE_REGEX = /^\s*\*\*([^*]+?):\*\*\s*`([^`]*)`\s*$/;
// The body of a `<!-- CONFIGURE ... -->` comment: optional `(qualifier)`, then the help text.
const CONFIGURE_BODY_REGEX = /^CONFIGURE\b\s*(?:\(([^)]*)\))?\s*:?\s*([\s\S]*)$/;
// The body of an examples comment: `Examples:`, `Valid values:`, `Examples / valid values:`.
const EXAMPLES_BODY_REGEX = /^([^:\n]*\b(?:examples?|valid values)\b[^:\n]*):([\s\S]*)$/i;
const BULLET_REGEX = /^\s*[-*+]\s+(.+?)\s*$/;

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function stripMatchingQuotes(text: string): string {
	const match = text.match(/^(["'])(.*)\1$/);
	return match ? match[2] : text;
}

/**
 * Example hints from an examples comment body. Bullets give one hint each,
 * keeping only the text before a run of two or more spaces (the rest is a
 * column of explanation); a single line with no bullets is split on commas.
 */
function parseExampleOptions(body: string): string[] {
	const lines = body.split('\n');
	const bullets: string[] = [];
	for (const line of lines) {
		const bullet = line.match(BULLET_REGEX);
		if (bullet) bullets.push(bullet[1]);
	}

	let raw: string[];
	if (bullets.length > 0) {
		raw = bullets.map((bullet) => bullet.split(/\s{2,}/)[0]);
	} else {
		const nonBlank = lines.map((line) => line.trim()).filter(Boolean);
		raw = nonBlank.length === 1 ? nonBlank[0].split(',') : [];
	}

	const options: string[] = [];
	for (const entry of raw) {
		const option = stripMatchingQuotes(entry.trim());
		if (option && !options.includes(option)) options.push(option);
	}
	return options;
}

/**
 * Read the parameter form an outer prompt declares in prose.
 *
 * A declaration is a `<!-- CONFIGURE: help -->` comment (single or multi-line),
 * followed, with only blank lines between, by one or more `**NAME:** `default``
 * lines that share its help. An examples comment right after a declaration
 * gives the most recent parameter its `options` hints. Any other content line
 * closes the declaration.
 *
 * Rules:
 * - names must match {@link PLAYBOOK_PARAM_NAME_REGEX}; anything else is skipped
 * - an empty or placeholder default ({@link isPlaceholderDefault}) is no default
 * - a parameter with no usable default is required, unless its `CONFIGURE`
 *   qualifier says `(optional ...)`; a `(required)` qualifier always requires
 * - the first declaration of a name wins
 * - fenced code blocks are ignored, so a prompt can document the syntax
 *
 * Every spec is typed `string` with `source: 'prose'`; the manifest overlay
 * supplies stronger types.
 */
export function parsePlaybookParameterForm(prompt: string): PlaybookParamSpec[] {
	const specs: PlaybookParamSpec[] = [];
	const seen = new Set<string>();

	let commentLines: string[] | null = null;
	// The open CONFIGURE declaration, if any.
	let declaration: { help: string; qualifier: string } | null = null;
	// The spec an examples comment may attach to.
	let lastSpec: PlaybookParamSpec | null = null;

	const handleComment = (body: string) => {
		const configure = body.match(CONFIGURE_BODY_REGEX);
		if (configure) {
			declaration = {
				qualifier: collapseWhitespace(configure[1] ?? '').toLowerCase(),
				help: collapseWhitespace(configure[2]),
			};
			lastSpec = null;
			return;
		}
		const examples = body.match(EXAMPLES_BODY_REGEX);
		if (examples && lastSpec) {
			const options = parseExampleOptions(examples[2]);
			if (options.length > 0) lastSpec.options = options;
		}
		declaration = null;
		lastSpec = null;
	};

	forEachMarkdownLine(prompt, (line) => {
		if (commentLines) {
			const end = line.indexOf('-->');
			if (end === -1) {
				commentLines.push(line);
				return;
			}
			commentLines.push(line.slice(0, end));
			const body = commentLines.join('\n').trim();
			commentLines = null;
			handleComment(body);
			return;
		}

		const trimmed = line.trim();
		if (trimmed === '') return;

		if (trimmed.startsWith('<!--')) {
			const rest = trimmed.slice(4);
			const end = rest.indexOf('-->');
			if (end === -1) {
				commentLines = [rest];
			} else {
				handleComment(rest.slice(0, end).trim());
			}
			return;
		}

		const param = declaration ? line.match(PARAM_LINE_REGEX) : null;
		if (!declaration || !param) {
			declaration = null;
			lastSpec = null;
			return;
		}

		const name = param[1].trim();
		if (!PLAYBOOK_PARAM_NAME_REGEX.test(name) || seen.has(name)) {
			lastSpec = null;
			return;
		}
		seen.add(name);

		const rawDefault = param[2];
		// An empty default is no default: an empty answer silently widens a scope.
		const hasDefault = rawDefault.trim() !== '' && !isPlaceholderDefault(rawDefault);
		const { help, qualifier } = declaration;
		const required = qualifier.startsWith('required')
			? true
			: !hasDefault && !qualifier.startsWith('optional');

		const spec: PlaybookParamSpec = {
			name,
			type: 'string',
			required,
			source: 'prose',
		};
		if (help) spec.help = help;
		if (hasDefault) spec.default = rawDefault;
		specs.push(spec);
		lastSpec = spec;
	});

	return specs;
}

/**
 * A manifest's typed declaration for one parameter (`parameters[]` in the
 * Exchange manifest). It owns only what prose cannot express. There is
 * deliberately no `default` and no `help`: prose owns those, so the two
 * representations own disjoint fields and cannot contradict each other.
 */
export interface PlaybookParamOverlay {
	name: string;
	type?: PlaybookParamType;
	required?: boolean;
	options?: string[];
	pattern?: string;
	min?: number;
	max?: number;
}

/** Copy each field the overlay declares onto the spec, replacing the prose value. */
function applyOverlayFields(spec: PlaybookParamSpec, overlay: PlaybookParamOverlay): void {
	if (overlay.type !== undefined) spec.type = overlay.type;
	if (overlay.required !== undefined) spec.required = overlay.required;
	if (overlay.options !== undefined) spec.options = [...overlay.options];
	if (overlay.pattern !== undefined) spec.pattern = overlay.pattern;
	if (overlay.min !== undefined) spec.min = overlay.min;
	if (overlay.max !== undefined) spec.max = overlay.max;
}

/**
 * Merge prose specs with a manifest overlay, as a union keyed by name.
 *
 * - a prose name with no overlay entry stays as parsed (an untyped string);
 *   half-migrated is the normal steady state, so it is never dropped
 * - an overlay name with no prose entry is a declaration too: it is surfaced
 *   with `label = name`, no default, and `required` unless the overlay says
 *   otherwise (no default means no value)
 * - when both exist, the overlay's fields win for exactly the fields it
 *   declares, and `source` becomes `'both'`
 *
 * Prose order comes first, then overlay-only names in overlay order. Overlay
 * entries with an illegal name, and repeats of a name, are ignored (the first
 * wins). Inputs are not mutated.
 */
export function mergePlaybookParams(
	prose: PlaybookParamSpec[],
	overlay: PlaybookParamOverlay[]
): PlaybookParamSpec[] {
	const overlayByName = new Map<string, PlaybookParamOverlay>();
	for (const entry of overlay) {
		if (!PLAYBOOK_PARAM_NAME_REGEX.test(entry.name) || overlayByName.has(entry.name)) continue;
		overlayByName.set(entry.name, entry);
	}

	const merged: PlaybookParamSpec[] = [];
	const seen = new Set<string>();
	for (const spec of prose) {
		if (seen.has(spec.name)) continue;
		seen.add(spec.name);
		const copy: PlaybookParamSpec = { ...spec };
		if (spec.options) copy.options = [...spec.options];
		const entry = overlayByName.get(spec.name);
		if (entry) {
			applyOverlayFields(copy, entry);
			copy.source = 'both';
		}
		merged.push(copy);
	}

	for (const entry of overlayByName.values()) {
		if (seen.has(entry.name)) continue;
		seen.add(entry.name);
		const spec: PlaybookParamSpec = {
			name: entry.name,
			label: entry.name,
			type: 'string',
			required: true,
			source: 'overlay',
		};
		applyOverlayFields(spec, entry);
		merged.push(spec);
	}

	return merged;
}

/** The tokens of a `multi-enum` value: comma-separated, trimmed, blanks dropped. */
export function splitMultiEnumValue(value: string): string[] {
	return value
		.split(',')
		.map((token) => token.trim())
		.filter(Boolean);
}

/**
 * Check one answer against its spec. Returns a human-readable message, or
 * `null` when the value is acceptable.
 *
 * - a blank value fails only a required spec
 * - a placeholder ({@link isPlaceholderDefault}) is never a value
 * - `url`: parses with `new URL()` and is http(s)
 * - `number`: finite, and within `min` / `max` when declared
 * - `multi-enum`: every comma-separated token is one of `options`
 *   (case-sensitive); unchecked when the spec declares no options
 * - `pattern`: the whole (trimmed) value must match
 */
export function validatePlaybookParamValue(spec: PlaybookParamSpec, value: string): string | null {
	const trimmed = value.trim();
	if (trimmed === '') {
		return spec.required ? `${spec.name} is required.` : null;
	}
	if (isPlaceholderDefault(trimmed)) {
		return `${spec.name} is still a placeholder: replace "${trimmed}" with a real value.`;
	}

	switch (spec.type) {
		case 'url': {
			let url: URL;
			try {
				url = new URL(trimmed);
			} catch {
				return `${spec.name} must be a URL, such as https://example.com.`;
			}
			if (url.protocol !== 'http:' && url.protocol !== 'https:') {
				return `${spec.name} must be an http or https URL.`;
			}
			break;
		}
		case 'number': {
			const number = Number(trimmed);
			if (!Number.isFinite(number)) {
				return `${spec.name} must be a number.`;
			}
			if (spec.min !== undefined && number < spec.min) {
				return `${spec.name} must be at least ${spec.min}.`;
			}
			if (spec.max !== undefined && number > spec.max) {
				return `${spec.name} must be at most ${spec.max}.`;
			}
			break;
		}
		case 'multi-enum': {
			if (!spec.options || spec.options.length === 0) break;
			const tokens = splitMultiEnumValue(trimmed);
			if (tokens.length === 0) {
				return spec.required ? `${spec.name} is required.` : null;
			}
			const unknown = tokens.filter((token) => !spec.options!.includes(token));
			if (unknown.length > 0) {
				return `${spec.name} does not allow ${unknown.map((token) => `"${token}"`).join(', ')}. Choose from: ${spec.options.join(', ')}.`;
			}
			break;
		}
		case 'string':
			break;
	}

	if (spec.pattern !== undefined) {
		let regex: RegExp;
		try {
			regex = new RegExp(`^(?:${spec.pattern})$`);
		} catch {
			return `${spec.name} declares an invalid pattern: ${spec.pattern}`;
		}
		if (!regex.test(trimmed)) {
			return `${spec.name} must match the pattern ${spec.pattern}.`;
		}
	}

	return null;
}

/**
 * The value a spec resolves to for this run: the answer when it is set, else
 * the author default, else `undefined`. A blank or placeholder answer is no
 * answer. Never an empty string, because an empty answer silently widens a
 * safety scope instead of narrowing it.
 */
function resolvePlaybookParamValue(
	spec: PlaybookParamSpec,
	values: PlaybookParamValues
): string | undefined {
	const answer = Object.prototype.hasOwnProperty.call(values, spec.name)
		? values[spec.name]
		: undefined;
	if (typeof answer === 'string') {
		const trimmed = answer.trim();
		if (trimmed !== '' && !isPlaceholderDefault(trimmed)) return trimmed;
	}
	if (spec.default !== undefined && spec.default.trim() !== '') return spec.default;
	return undefined;
}

/**
 * The `[NAME]` reference regex for a set of declared names, or `null` when no
 * name is legal. A closed alternation over the declared names only (never a
 * general `[A-Z_]+` pattern), longest first, case-sensitive. The lookbehind
 * spares `[[wiki]]` links; the lookahead spares `[label](url)`, `[label][ref]`,
 * and `[[wiki]]`. Legal names are at least two uppercase characters, so
 * `- [ ]` and `- [x]` can never match.
 */
function buildParamReferenceRegex(specs: PlaybookParamSpec[]): RegExp | null {
	const names = [
		...new Set(
			specs.map((spec) => spec.name).filter((name) => PLAYBOOK_PARAM_NAME_REGEX.test(name))
		),
	];
	if (names.length === 0) return null;
	names.sort((a, b) => b.length - a.length || a.localeCompare(b));
	return new RegExp(`(?<!\\[)\\[(${names.join('|')})\\](?![(\\[])`, 'g');
}

/** The result of {@link substitutePlaybookParams}. */
export interface PlaybookParamSubstitution {
	/** The text with every resolvable reference replaced. */
	text: string;
	/** Names replaced at least once, in order of first appearance. */
	substituted: string[];
	/** Names referenced in the text with no answer and no default, left in place. */
	unresolved: string[];
}

/**
 * Replace each declared `[NAME]` in `text` with its answer, or its default when
 * there is no answer. A reference with neither stays in place and is reported
 * in `unresolved`; it is never replaced with an empty string.
 *
 * In memory only: callers hand the result to the agent and never write it back
 * to disk, so answers are never burned into the template.
 *
 * This does not expand `{{TEMPLATE}}` variables. The caller runs that pass
 * first, and template-expands parameter values at resolve time; the reverse
 * order would turn a default or an answer into a template (an injection surface).
 */
export function substitutePlaybookParams(
	text: string,
	specs: PlaybookParamSpec[],
	values: PlaybookParamValues
): PlaybookParamSubstitution {
	const regex = buildParamReferenceRegex(specs);
	if (!regex) return { text, substituted: [], unresolved: [] };

	const specByName = new Map<string, PlaybookParamSpec>();
	for (const spec of specs) {
		if (!specByName.has(spec.name)) specByName.set(spec.name, spec);
	}

	const resolved = new Map<string, string | undefined>();
	const substituted: string[] = [];
	const unresolved: string[] = [];

	// A replacer function, so `$&` or `$1` in an answer is inserted literally.
	const output = text.replace(regex, (match: string, name: string) => {
		if (!resolved.has(name)) {
			const value = resolvePlaybookParamValue(specByName.get(name)!, values);
			resolved.set(name, value);
			(value === undefined ? unresolved : substituted).push(name);
		}
		return resolved.get(name) ?? match;
	});

	return { text: output, substituted, unresolved };
}

/**
 * Every declared `[NAME]` still present in `text`, in order of first
 * appearance. Both Auto Run engines run this on the substituted body as a
 * pre-spawn check and refuse to spawn when it returns anything: zero tokens,
 * and it catches any regression in the substitution pass. An optional
 * parameter with no answer and no default also survives here; it is the
 * caller's decision whether that blocks the run.
 */
export function assertNoSurvivingParams(text: string, specs: PlaybookParamSpec[]): string[] {
	const regex = buildParamReferenceRegex(specs);
	if (!regex) return [];
	const surviving: string[] = [];
	for (const match of text.matchAll(regex)) {
		if (!surviving.includes(match[1])) surviving.push(match[1]);
	}
	return surviving;
}

/**
 * The required specs that resolve to nothing: no answer and no default. The
 * one shared answer to "can this run start"; a non-empty result is a
 * precondition failure in every engine (desktop, CLI, Cue).
 */
export function collectUnresolvedRequired(
	specs: PlaybookParamSpec[],
	values: PlaybookParamValues
): PlaybookParamSpec[] {
	return specs.filter(
		(spec) => spec.required && resolvePlaybookParamValue(spec, values) === undefined
	);
}

/** Text that is safe inside one markdown table cell: pipes escaped, line breaks kept as `<br>`. */
function escapeTableCell(text: string): string {
	return text.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

/**
 * A `## Resolved Configuration` markdown table of each parameter and the value
 * it resolves to, for appending to the outer prompt. It is the belt for
 * documents that say "read the agent prompt for `[VAR]`" and for older Maestro
 * versions; in-memory substitution is the mechanism. A parameter with no
 * value reads `<UNSET>`, the content repo's own sentinel. Names are written
 * without brackets so the table never trips {@link assertNoSurvivingParams}.
 * Returns an empty string when there are no specs.
 */
export function buildResolvedConfigurationTable(
	specs: PlaybookParamSpec[],
	values: PlaybookParamValues
): string {
	if (specs.length === 0) return '';
	const lines = ['## Resolved Configuration', '', '| Parameter | Value |', '| --- | --- |'];
	const seen = new Set<string>();
	for (const spec of specs) {
		if (seen.has(spec.name)) continue;
		seen.add(spec.name);
		const value = resolvePlaybookParamValue(spec, values);
		const cell = value === undefined ? '`<UNSET>`' : escapeTableCell(value);
		lines.push(`| \`${spec.name}\` | ${cell} |`);
	}
	return lines.join('\n');
}

const PLAYBOOK_PARAM_TYPES: readonly PlaybookParamType[] = [
	'string',
	'url',
	'number',
	'multi-enum',
];

export function isPlaybookParamType(value: unknown): value is PlaybookParamType {
	return (PLAYBOOK_PARAM_TYPES as readonly unknown[]).includes(value);
}

/**
 * Read a `parameters[]` overlay out of untrusted JSON (a marketplace manifest
 * or a ZIP `manifest.json`). Each entry needs a legal name; every other field
 * is kept only when it has the right shape, so a malformed field reads as
 * undeclared instead of reaching the merge. Returns `undefined` when the
 * input is not an array or no entry survives.
 */
export function readPlaybookParamOverlay(raw: unknown): PlaybookParamOverlay[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const overlay: PlaybookParamOverlay[] = [];
	for (const item of raw) {
		if (!item || typeof item !== 'object') continue;
		const entry = item as Record<string, unknown>;
		if (typeof entry.name !== 'string' || !PLAYBOOK_PARAM_NAME_REGEX.test(entry.name)) continue;
		const clean: PlaybookParamOverlay = { name: entry.name };
		if (isPlaybookParamType(entry.type)) clean.type = entry.type;
		if (typeof entry.required === 'boolean') clean.required = entry.required;
		if (Array.isArray(entry.options) && entry.options.every((o) => typeof o === 'string')) {
			clean.options = [...(entry.options as string[])];
		}
		if (typeof entry.pattern === 'string') clean.pattern = entry.pattern;
		if (typeof entry.min === 'number' && Number.isFinite(entry.min)) clean.min = entry.min;
		if (typeof entry.max === 'number' && Number.isFinite(entry.max)) clean.max = entry.max;
		overlay.push(clean);
	}
	return overlay.length > 0 ? overlay : undefined;
}

/**
 * Read saved parameter answers out of untrusted JSON. Keeps only legal names
 * with string values. Returns `undefined` when nothing survives.
 */
export function readPlaybookParamValues(raw: unknown): PlaybookParamValues | undefined {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const values: PlaybookParamValues = {};
	let kept = 0;
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		if (!PLAYBOOK_PARAM_NAME_REGEX.test(name) || typeof value !== 'string') continue;
		values[name] = value;
		kept++;
	}
	return kept > 0 ? values : undefined;
}
