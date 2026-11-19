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
