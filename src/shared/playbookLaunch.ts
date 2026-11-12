/**
 * Playbook Launch
 *
 * Schema parsing, answer validation and prompt substitution behind the Playbook Exchange Launch
 * button. One module owns them so the main process (manifest merge, import, launch), the renderer
 * (launch modal), the CLI and the Exchange validator agree on what a `launch` block is and how an
 * answer reaches a playbook. Pure functions only: no Node and no Electron imports.
 *
 * How an answer reaches a playbook: each input's `name` matches a ``**NAME:** `value` `` line in
 * the manifest `prompt`. Launching rewrites only the text between the backticks of those lines in
 * the prompt that is saved and run. Task documents are never rewritten (they read `[NAME]` from the
 * prompt), and a built-in such as `{{AUTORUN_FOLDER}}` inside a value is left for the Auto Run
 * engine to expand at run time. An input with no answer leaves its line exactly as shipped, which
 * keeps any placeholder (such as `<UNSET ...>`) the playbook already halts on.
 *
 * `serializeLaunchValue` is a port of `serializeDefault()` in Maestro-Playbooks
 * `scripts/validate-manifest.mjs`. That script promises that launching with every default writes
 * the exact prompt Download ships, so the two must stay byte-identical in behavior.
 *
 * Two more helpers decide what the user sees around a launch: `isLaunchAvailable` says whether
 * Launch is offered (and why not), and `renderLaunchOutro` fills the outro the run ends with.
 */

import { formatPlatformName } from './formatters';
import { meetsMinVersion } from './marketplace-compatibility';
import type {
	MarketplacePlaybook,
	PlaybookLaunchInput,
	PlaybookLaunchSpec,
	PlaybookLaunchValues,
} from './marketplace-types';
import { definedOnly } from './objectUtils';
import { substituteTemplateTokens, TEMPLATE_VARIABLES } from './templateVariables';

type LaunchInputType = PlaybookLaunchInput['type'];
type LaunchOption = NonNullable<PlaybookLaunchInput['options']>[number];
type LaunchAnswer = PlaybookLaunchValues[string];
type LaunchPreconditions = NonNullable<PlaybookLaunchSpec['preconditions']>;
type LaunchPlatform = NonNullable<LaunchPreconditions['platforms']>[number];
type LaunchOutro = PlaybookLaunchSpec['outro'];
type UnknownRecord = Record<string, unknown>;

/**
 * Answers as a form or a CLI holds them. Any input may be missing, and a form may hold
 * `undefined` for one the user never touched.
 */
export type PlaybookLaunchAnswers = Readonly<Partial<PlaybookLaunchValues>>;

/** The outcome of {@link parseLaunchSpec}. */
export interface ParsedLaunchSpec {
	/** The normalized spec. Present only when `errors` is empty. */
	spec?: PlaybookLaunchSpec;
	/** Why the block was rejected, one entry per problem. Empty when `spec` is set. */
	errors: string[];
}

/** The agent a launch would run on, as far as {@link isLaunchAvailable} needs to know. */
export interface PlaybookLaunchTarget {
	/** The agent works on an SSH remote. The `maestro-cli` on this machine cannot reach it. */
	sshRemote: boolean;
	/** `maestro-cli` is installed on this machine. Not asked of an SSH-remote agent. */
	maestroCliInstalled: boolean;
}

/** The outcome of {@link isLaunchAvailable}. */
export interface PlaybookLaunchAvailability {
	available: boolean;
	/** Why Launch is off, as a sentence for a tooltip. Set only when `available` is false. */
	reason?: string;
	/** Things to tell the user that do not stop the launch. Always empty when `available` is false. */
	notes: string[];
}

/** The outro of a launch with every `{{TOKEN}}` filled in. See {@link renderLaunchOutro}. */
export interface RenderedLaunchOutro {
	/** The spec's title, or `undefined` when it has none (the caller falls back to the playbook title). */
	title?: string;
	/** Markdown. */
	summary: string;
	/** Markdown bullets, one per entry. */
	nextSteps: string[];
	/** Outputs to offer as Open buttons. Empty when the spec lists none. */
	files: Array<{ label: string; path: string }>;
	/** The file whose first heading section is the verdict, when the spec names one. */
	reportFile?: string;
}

// ============================================================================
// Constants
// ============================================================================

const INPUT_TYPES: readonly LaunchInputType[] = [
	'text',
	'textarea',
	'url',
	'path',
	'number',
	'boolean',
	'select',
	'multiselect',
];
const PLATFORMS: readonly LaunchPlatform[] = ['darwin', 'linux', 'win32'];
const MAESTRO_CLI_MODES = ['required', 'optional'] as const;
const CLEANUP_MODES = ['remove-docs', 'keep'] as const;

/** UPPER_SNAKE_CASE starting with a letter. The same rule as the Exchange validator. */
const INPUT_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/**
 * A configuration line in a prompt: ``**NAME:** `value` ``. Group 1 is everything up to and
 * including the opening backtick, group 2 is the name, group 3 is the closing backtick. Mirrors
 * `configureLines()` in the Exchange validator, so both read the same lines.
 */
const CONFIGURATION_LINE = /^(\*\*([A-Z][A-Z0-9_]*):\*\*\s*`)[^`]*(`)/gm;

/** Names of the documented built-in template variables. */
const BUILT_IN_VARIABLE_NAMES: ReadonlySet<string> = new Set(
	TEMPLATE_VARIABLES.map((entry) => entry.variable.slice(2, -2))
);

// ============================================================================
// Shared helpers
// ============================================================================

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(isString);
}

function isInputType(value: unknown): value is LaunchInputType {
	return INPUT_TYPES.includes(value as LaunchInputType);
}

function isLaunchPlatform(value: unknown): value is LaunchPlatform {
	return PLATFORMS.includes(value as LaunchPlatform);
}

function readOwn<T>(source: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
}

/**
 * A name an input may not use: any documented built-in in `TEMPLATE_VARIABLES`, or any `CUE_`
 * variable (the dynamic `CUE_OUTPUT_*` names are not in that list but are reserved the same way).
 */
function isReservedInputName(name: string): boolean {
	return name.startsWith('CUE_') || BUILT_IN_VARIABLE_NAMES.has(name);
}

/**
 * True when a string, or a string inside a list, holds a backtick. A backtick would close the
 * value early on a configuration line.
 */
function containsBacktick(value: unknown): boolean {
	return Array.isArray(value)
		? value.some(containsBacktick)
		: isString(value) && value.includes('`');
}

/**
 * Whether an answer exists. Missing, `null` and whitespace-only text are not answers. `false`, `0`
 * and an empty list are: the user chose them (an empty list is a deliberate "none").
 */
function hasAnswer(value: unknown): value is LaunchAnswer {
	if (value === undefined || value === null) return false;
	return !(isString(value) && value.trim() === '');
}

function copyAnswer(value: LaunchAnswer): LaunchAnswer {
	return Array.isArray(value) ? [...value] : value;
}

function compilePattern(source: string): RegExp | undefined {
	try {
		return new RegExp(source);
	} catch (error) {
		// Only a malformed pattern is an expected failure; anything else is a bug to surface.
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

function isHttpUrl(value: string): boolean {
	try {
		const { protocol } = new URL(value);
		return protocol === 'http:' || protocol === 'https:';
	} catch {
		// `new URL` throws only for text that is not a URL.
		return false;
	}
}

// ============================================================================
// parseLaunchSpec
// ============================================================================

type Fail = (message: string) => void;

/** A `Fail` that puts `prefix` in front of every message it reports. */
function scoped(fail: Fail, prefix: string): Fail {
	return (message) => fail(`${prefix}${message}`);
}

function readOptionalString(source: UnknownRecord, key: string, fail: Fail): string | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (isString(value)) return value;
	fail(`${key} must be a string`);
	return undefined;
}

function readOptionalBoolean(source: UnknownRecord, key: string, fail: Fail): boolean | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value === 'boolean') return value;
	fail(`${key} must be true or false`);
	return undefined;
}

function readOptionalNumber(source: UnknownRecord, key: string, fail: Fail): number | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	fail(`${key} must be a number`);
	return undefined;
}

function readOptionalList<T>(
	source: UnknownRecord,
	key: string,
	guard: (value: unknown) => value is T,
	expectation: string,
	fail: Fail
): T[] | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (Array.isArray(value) && value.every(guard)) return [...value];
	fail(`${key} must be ${expectation}`);
	return undefined;
}

function readOptionalChoice<T extends string>(
	source: UnknownRecord,
	key: string,
	allowed: readonly T[],
	fail: Fail
): T | undefined {
	const value = source[key];
	if (value === undefined) return undefined;
	if (isString(value) && (allowed as readonly string[]).includes(value)) return value as T;
	fail(`${key} must be ${allowed.map((choice) => `"${choice}"`).join(' or ')}`);
	return undefined;
}

function parsePreconditions(raw: unknown, fail: Fail): LaunchPreconditions | undefined {
	if (raw === undefined) return undefined;
	if (!isRecord(raw)) {
		fail('preconditions must be an object');
		return undefined;
	}
	const failHere = scoped(fail, 'preconditions.');
	return definedOnly({
		platforms: readOptionalList(
			raw,
			'platforms',
			isLaunchPlatform,
			`a list of ${PLATFORMS.join(', ')}`,
			failHere
		),
		requires: readOptionalList(raw, 'requires', isString, 'a list of strings', failHere),
		confirm: readOptionalString(raw, 'confirm', failHere),
		maestroCli: readOptionalChoice(raw, 'maestroCli', MAESTRO_CLI_MODES, failHere),
	});
}

function parseOptions(raw: unknown, type: LaunchInputType, fail: Fail): LaunchOption[] | undefined {
	if (type !== 'select' && type !== 'multiselect') {
		if (raw !== undefined) fail('options only apply to select and multiselect');
		return undefined;
	}
	if (!Array.isArray(raw) || raw.length === 0) {
		fail(`${type} needs a non-empty options list`);
		return undefined;
	}
	const seen = new Set<string>();
	const options: LaunchOption[] = [];
	for (const item of raw as unknown[]) {
		if (!isRecord(item) || !isString(item.value) || item.value === '') {
			fail('every option needs a non-empty value');
		} else if (item.label !== undefined && !isString(item.label)) {
			fail(`option "${item.value}": label must be a string`);
		} else if (seen.has(item.value)) {
			fail(`duplicate option value "${item.value}"`);
		} else {
			seen.add(item.value);
			options.push(definedOnly({ value: item.value, label: item.label }));
		}
	}
	return options;
}

/**
 * The `pattern` of a text or url input as written (a JS regex source), or `undefined` when it has
 * none or is bad. The source is kept verbatim: a compiled `RegExp.source` would re-escape it.
 */
function parsePattern(raw: unknown, type: LaunchInputType, fail: Fail): string | undefined {
	if (raw === undefined) return undefined;
	if (type !== 'text' && type !== 'url') {
		fail('pattern only applies to text and url');
		return undefined;
	}
	if (!isString(raw)) {
		fail('pattern must be a string');
		return undefined;
	}
	if (!compilePattern(raw)) {
		fail('pattern is not a valid regular expression');
		return undefined;
	}
	return raw;
}

interface NumberFields {
	min?: number;
	max?: number;
	unit?: string;
}

function parseNumberFields(entry: UnknownRecord, type: LaunchInputType, fail: Fail): NumberFields {
	if (type !== 'number') {
		if (entry.min !== undefined || entry.max !== undefined || entry.unit !== undefined) {
			fail('min, max and unit only apply to number');
		}
		return {};
	}
	const fields = definedOnly({
		min: readOptionalNumber(entry, 'min', fail),
		max: readOptionalNumber(entry, 'max', fail),
		unit: readOptionalString(entry, 'unit', fail),
	});
	if (fields.min !== undefined && fields.max !== undefined && fields.min > fields.max) {
		fail('min is above max');
	}
	if (containsBacktick(fields.unit)) fail('unit cannot contain a backtick');
	return fields;
}

function parseEmptyValue(raw: unknown, type: LaunchInputType, fail: Fail): string | undefined {
	if (raw === undefined) return undefined;
	if (type !== 'multiselect') {
		fail('emptyValue only applies to multiselect');
		return undefined;
	}
	if (!isString(raw)) {
		fail('emptyValue must be a string');
		return undefined;
	}
	if (containsBacktick(raw)) fail('emptyValue cannot contain a backtick');
	return raw;
}

/** What a default is checked against: the input's type and the fields parsed before it. */
interface DefaultContext extends NumberFields {
	type: LaunchInputType;
	options?: LaunchOption[];
	pattern?: RegExp;
}

function parseChoiceDefault(
	raw: unknown,
	context: DefaultContext,
	fail: Fail
): string | string[] | undefined {
	const multiple = context.type === 'multiselect';
	// A multiselect may name a single value; it is normalized to a one-item list.
	const picked: unknown[] = Array.isArray(raw) ? raw : [raw];
	if (!picked.every(isString) || (!multiple && Array.isArray(raw))) {
		fail(
			multiple
				? 'multiselect default must be option values'
				: 'select default must be one option value'
		);
		return undefined;
	}
	const known = new Set(context.options?.map((option) => option.value));
	for (const value of picked) {
		if (!known.has(value)) fail(`default "${value}" is not one of the options`);
	}
	return multiple ? picked : picked[0];
}

function parseDefault(raw: unknown, context: DefaultContext, fail: Fail): LaunchAnswer | undefined {
	if (raw === undefined) return undefined;
	let value: LaunchAnswer | undefined;
	switch (context.type) {
		case 'boolean':
			if (typeof raw === 'boolean') value = raw;
			else fail('boolean default must be true or false');
			break;
		case 'number':
			if (typeof raw !== 'number' || !Number.isFinite(raw)) {
				fail('number default must be a number');
			} else {
				if (context.min !== undefined && raw < context.min) fail('default is below min');
				if (context.max !== undefined && raw > context.max) fail('default is above max');
				value = raw;
			}
			break;
		case 'select':
		case 'multiselect':
			value = parseChoiceDefault(raw, context, fail);
			break;
		default:
			if (!isString(raw)) {
				fail(`${context.type} default must be text`);
			} else {
				if (context.pattern && !context.pattern.test(raw)) fail('default does not match pattern');
				value = raw;
			}
	}
	if (containsBacktick(value)) fail('default cannot contain a backtick');
	return value;
}

function parseInput(
	entry: unknown,
	index: number,
	seen: Set<string>,
	fail: Fail
): PlaybookLaunchInput | undefined {
	if (!isRecord(entry)) {
		fail(`input #${index + 1} must be an object`);
		return undefined;
	}
	const name = isString(entry.name) ? entry.name : '';
	const failInput = scoped(fail, `input ${name || `#${index + 1}`}: `);
	if (!INPUT_NAME_PATTERN.test(name)) {
		failInput('name must be UPPER_SNAKE_CASE');
		return undefined;
	}
	if (seen.has(name)) failInput('duplicate name');
	seen.add(name);
	if (isReservedInputName(name)) failInput('collides with a built-in template variable');
	const label = isString(entry.label) ? entry.label : '';
	if (label === '') failInput('label is required');
	const type = entry.type;
	if (!isInputType(type)) {
		failInput(`unknown type "${String(type)}"`);
		return undefined;
	}

	const options = parseOptions(entry.options, type, failInput);
	const pattern = parsePattern(entry.pattern, type, failInput);
	const numberFields = parseNumberFields(entry, type, failInput);
	const emptyValue = parseEmptyValue(entry.emptyValue, type, failInput);
	const defaultValue = parseDefault(
		entry.default,
		{
			type,
			options,
			pattern: pattern === undefined ? undefined : compilePattern(pattern),
			...numberFields,
		},
		failInput
	);
	return definedOnly({
		name,
		label,
		type,
		default: defaultValue,
		required: readOptionalBoolean(entry, 'required', failInput),
		help: readOptionalString(entry, 'help', failInput),
		placeholder: readOptionalString(entry, 'placeholder', failInput),
		options,
		unit: numberFields.unit,
		emptyValue,
		min: numberFields.min,
		max: numberFields.max,
		pattern,
		advanced: readOptionalBoolean(entry, 'advanced', failInput),
	});
}

function parseInputs(raw: unknown, fail: Fail): PlaybookLaunchInput[] | undefined {
	if (!Array.isArray(raw)) {
		fail('inputs must be a list (it may be empty)');
		return undefined;
	}
	const seen = new Set<string>();
	const inputs: PlaybookLaunchInput[] = [];
	(raw as unknown[]).forEach((entry, index) => {
		const input = parseInput(entry, index, seen, fail);
		if (input) inputs.push(input);
	});
	return inputs;
}

function parseMaxLoops(raw: unknown, fail: Fail): number | null | undefined {
	// null is meaningful: unlimited loops.
	if (raw === undefined || raw === null) return raw;
	if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
	fail('maxLoops must be a positive whole number or null');
	return undefined;
}

function parseOutroFiles(raw: unknown, fail: Fail): LaunchOutro['files'] {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		fail('files must be a list of label and path pairs');
		return undefined;
	}
	const files: NonNullable<LaunchOutro['files']> = [];
	for (const item of raw as unknown[]) {
		if (isRecord(item) && isString(item.label) && item.label && isString(item.path) && item.path) {
			files.push({ label: item.label, path: item.path });
		} else {
			fail('files entries need a label and a path');
		}
	}
	return files;
}

function parseOutro(raw: unknown, fail: Fail): LaunchOutro | undefined {
	if (!isRecord(raw)) {
		fail('outro is required (an object with a summary)');
		return undefined;
	}
	const failOutro = scoped(fail, 'outro.');
	const title = readOptionalString(raw, 'title', failOutro);
	const summary = isString(raw.summary) ? raw.summary : '';
	if (summary === '') failOutro('summary is required');
	const nextSteps = raw.nextSteps;
	if (!isStringList(nextSteps)) failOutro('nextSteps must be a list of strings');
	const files = parseOutroFiles(raw.files, failOutro);
	const reportFile = readOptionalString(raw, 'reportFile', failOutro);
	if (summary === '' || !isStringList(nextSteps)) return undefined;
	return definedOnly({ title, summary, nextSteps: [...nextSteps], files, reportFile });
}

/**
 * Parse the `launch` block of a manifest entry (`raw` is the value of the `launch` key).
 *
 * The block comes from a fetched manifest, so nothing about it is trusted. A valid block returns a
 * fresh, normalized spec that carries only the fields this build knows (unknown fields are
 * ignored); a multiselect default written as one string becomes a one-item list. An invalid block
 * returns every problem it found and no spec, so the caller can log a warning and leave the
 * playbook download-only.
 *
 * Rejected: a block or input that is not an object; a name that is not UPPER_SNAKE_CASE, repeats,
 * or collides with a built-in template variable (any `TEMPLATE_VARIABLES` name or `CUE_*`); an
 * unknown type; a select or multiselect without options; a default outside the options, outside
 * the number range, off the pattern or holding a backtick; a `pattern` that is not a valid regular
 * expression; a missing `outro.summary`; a `preconditions.maestroCli` other than `required` or
 * `optional`. The optional `unit` (number) and `emptyValue` (multiselect) fields are accepted.
 */
export function parseLaunchSpec(raw: unknown): ParsedLaunchSpec {
	if (!isRecord(raw)) return { errors: ['launch must be an object'] };
	const errors: string[] = [];
	const fail: Fail = (message) => {
		errors.push(message);
	};

	const minMaestroVersion = readOptionalString(raw, 'minMaestroVersion', fail);
	const intro = readOptionalString(raw, 'intro', fail);
	const preconditions = parsePreconditions(raw.preconditions, fail);
	const inputs = parseInputs(raw.inputs, fail);
	const maxLoops = parseMaxLoops(raw.maxLoops, fail);
	const cleanup = readOptionalChoice(raw, 'cleanup', CLEANUP_MODES, fail);
	const outro = parseOutro(raw.outro, fail);

	if (errors.length > 0 || !inputs || !outro) return { errors };
	return {
		errors,
		spec: definedOnly({
			minMaestroVersion,
			intro,
			preconditions,
			inputs,
			maxLoops,
			cleanup,
			outro,
		}),
	};
}

// ============================================================================
// resolveLaunchValues and validateLaunchValues
// ============================================================================

/**
 * Whether `value` can hold launch values: an object keyed by input name, not `null` and not a
 * list. Values that cross IPC, the web bridge or the CLI are checked with this before
 * {@link resolveLaunchValues} reads them. Each value is then checked by {@link validateLaunchValues}.
 */
export function isLaunchValuesObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return isRecord(value);
}

/**
 * Turn the answers a user gave into the values to launch with: each declared input takes its
 * answer, else its default, else stays absent. An optional input with neither is simply missing
 * from the result, which leaves its configuration line as shipped.
 *
 * Text answers are trimmed. An answer that is missing, `null` or only whitespace counts as no
 * answer, so a cleared field falls back to its default; `false`, `0` and an empty multiselect list
 * are answers. Answers for names the spec does not declare are dropped. Arrays are copied, so the
 * result never aliases the spec or the caller's answers.
 */
export function resolveLaunchValues(
	spec: PlaybookLaunchSpec,
	answers: PlaybookLaunchAnswers = {}
): PlaybookLaunchValues {
	const values: PlaybookLaunchValues = {};
	for (const input of spec.inputs) {
		const answer = readOwn(answers, input.name);
		if (hasAnswer(answer)) {
			values[input.name] = isString(answer) ? answer.trim() : copyAnswer(answer);
		} else if (input.default !== undefined) {
			values[input.name] = copyAnswer(input.default);
		}
	}
	return values;
}

function validateNumber(input: PlaybookLaunchInput, value: unknown): string | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number';
	if (input.min !== undefined && value < input.min) return `Must be at least ${input.min}`;
	if (input.max !== undefined && value > input.max) return `Must be at most ${input.max}`;
	return undefined;
}

function isOptionValue(input: PlaybookLaunchInput, value: unknown): boolean {
	return input.options?.some((option) => option.value === value) === true;
}

function validateText(input: PlaybookLaunchInput, value: unknown): string | undefined {
	if (!isString(value)) return 'Enter text';
	if (input.type === 'url' && !isHttpUrl(value)) return 'Enter a full http:// or https:// URL';
	if (input.pattern !== undefined && !compilePattern(input.pattern)?.test(value)) {
		return 'Does not match the expected format';
	}
	return undefined;
}

function validateLaunchValue(input: PlaybookLaunchInput, value: unknown): string | undefined {
	const answered = hasAnswer(value);
	if (input.required && (!answered || (Array.isArray(value) && value.length === 0))) {
		return 'This field is required';
	}
	if (!answered) return undefined;
	if (containsBacktick(value)) return 'Cannot contain a backtick';
	switch (input.type) {
		case 'number':
			return validateNumber(input, value);
		case 'boolean':
			return typeof value === 'boolean' ? undefined : 'Must be yes or no';
		case 'select':
			return isString(value) && isOptionValue(input, value)
				? undefined
				: 'Pick one of the listed options';
		case 'multiselect':
			return Array.isArray(value) && value.every((item) => isOptionValue(input, item))
				? undefined
				: 'Pick only from the listed options';
		default:
			return validateText(input, value);
	}
}

/**
 * Check launch values against a spec. Returns the error message for each failing input, keyed by
 * input name; an empty object means every value is valid.
 *
 * The values are not trusted to have the right runtime types (they may arrive over IPC, the web
 * bridge or the CLI), so each is type-checked as well as range-checked. A required input needs a
 * value (an empty multiselect list does not count); an optional input with no value is skipped.
 * Number inputs honor `min` and `max`, text and url inputs honor `pattern`, url inputs must be
 * http(s) URLs, select and multiselect values must be listed options, and no value may contain a
 * backtick, because a backtick would close the value on its configuration line.
 *
 * Pass the output of {@link resolveLaunchValues} to validate what will actually be written.
 */
export function validateLaunchValues(
	spec: PlaybookLaunchSpec,
	values: Readonly<Record<string, unknown>>
): Record<string, string> {
	const errors: Record<string, string> = {};
	for (const input of spec.inputs) {
		const message = validateLaunchValue(input, readOwn(values, input.name));
		if (message !== undefined) errors[input.name] = message;
	}
	return errors;
}

// ============================================================================
// serializeLaunchValue and applyLaunchInputs
// ============================================================================

/**
 * The text written between the backticks of a configuration line for one input's value.
 *
 * - boolean: `yes` or `no`
 * - multiselect: the picked values joined with `,` in the order given, or the input's
 *   `emptyValue` (else nothing) when none are picked
 * - number: its decimal form followed by the input's `unit`, when it has one (80 and `%` is `80%`)
 * - anything else: the text with every line break (and the spaces around it) collapsed to one space
 *
 * A port of `serializeDefault()` in the Exchange validator; keep the two byte-identical.
 */
export function serializeLaunchValue(input: PlaybookLaunchInput, value: LaunchAnswer): string {
	if (input.type === 'boolean') return value ? 'yes' : 'no';
	if (input.type === 'multiselect') {
		const picked = Array.isArray(value) ? value : [value];
		return picked.length > 0 ? picked.join(',') : (input.emptyValue ?? '');
	}
	if (input.type === 'number') return `${value}${input.unit ?? ''}`;
	return String(value).replace(/\s*\n\s*/g, ' ');
}

/**
 * Write the user's values into a playbook prompt. For each declared input that has a value, the
 * text between the backticks of its ``**NAME:** `value` `` lines becomes the serialized value.
 * Every other line, and every input without a value, is left exactly as it was. Only a prompt is
 * rewritten: task documents are never touched.
 *
 * The values must already have passed {@link validateLaunchValues}. A value is written literally,
 * so `$&`, `$1` and `{{TOKEN}}` text in it reach the prompt as typed.
 */
export function applyLaunchInputs(
	prompt: string,
	spec: PlaybookLaunchSpec,
	values: PlaybookLaunchAnswers
): string {
	const written = new Map<string, string>();
	for (const input of spec.inputs) {
		const value = readOwn(values, input.name);
		if (hasAnswer(value)) written.set(input.name, serializeLaunchValue(input, value));
	}
	if (written.size === 0) return prompt;
	// A replacer function, not a replacement string, so `$` sequences in a value stay literal.
	return prompt.replace(CONFIGURATION_LINE, (line, head: string, name: string, tail: string) => {
		const text = written.get(name);
		return text === undefined ? line : `${head}${text}${tail}`;
	});
}

// ============================================================================
// isLaunchAvailable
// ============================================================================

const MAESTRO_CLI_REMOTE_REASON =
	'This playbook drives Maestro through maestro-cli, which is not available on remote agents.';
const MAESTRO_CLI_MISSING_REASON =
	'This playbook drives Maestro through maestro-cli, which is not installed. Install maestro-cli to launch it.';
const MAESTRO_CLI_REMOTE_NOTE =
	'maestro-cli is not available on remote agents, so any step that calls it is skipped or uses a fallback.';
const MAESTRO_CLI_MISSING_NOTE =
	'maestro-cli is not installed, so any step that calls it is skipped or uses a fallback.';

function unavailable(reason: string): PlaybookLaunchAvailability {
	return { available: false, reason, notes: [] };
}

/** "macOS", "macOS and Linux", "macOS, Linux and Windows". */
function joinWithAnd(items: readonly string[]): string {
	return items.length < 2
		? items.join('')
		: `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * What a `maestroCli` precondition means for one target. A playbook that needs the CLI cannot run
 * on a remote agent (the CLI is on this machine only) or before the CLI is installed; one that
 * only prefers it still runs, so the user is told what they lose instead.
 */
function checkMaestroCli(
	mode: NonNullable<LaunchPreconditions['maestroCli']>,
	target: PlaybookLaunchTarget
): { reason?: string; note?: string } {
	if (target.sshRemote) {
		return mode === 'required'
			? { reason: MAESTRO_CLI_REMOTE_REASON }
			: { note: MAESTRO_CLI_REMOTE_NOTE };
	}
	if (target.maestroCliInstalled) return {};
	return mode === 'required'
		? { reason: MAESTRO_CLI_MISSING_REASON }
		: { note: MAESTRO_CLI_MISSING_NOTE };
}

/**
 * Whether the Launch button is offered for a playbook, and if not, why.
 *
 * Unavailable when the playbook has no `launch` block (one that `parseLaunchSpec` rejected counts
 * as none, because the caller drops it); the block's own `minMaestroVersion`
 * is above the running version (the same fail-open comparison as the Exchange's compatibility
 * gate, {@link meetsMinVersion}); `preconditions.platforms` lists platforms and `platform` is not
 * one (an empty list restricts nothing); or `preconditions.maestroCli` is `required` and the target
 * is an SSH-remote agent or `maestro-cli` is not installed. An `optional` `maestroCli` that is
 * missing never blocks: it adds a note instead. The first problem found is the one reported.
 *
 * Without a `target` (the Exchange tile, before an agent is picked) only the spec, version and
 * platform are checked. The launch modal asks again, with a target, each time its Run on choice
 * changes. The playbook's own top-level `minMaestroVersion` is not read here: Download is gated on
 * it by `isCompatible`, and a caller offering Launch applies that gate too.
 *
 * `platform` is the OS Maestro runs on (`process.platform`, or `window.maestro.platform` in the
 * renderer), not the OS of an SSH remote.
 */
export function isLaunchAvailable(
	playbook: Pick<MarketplacePlaybook, 'launch'>,
	runningVersion: string,
	platform: string,
	target?: PlaybookLaunchTarget
): PlaybookLaunchAvailability {
	const spec = playbook.launch;
	if (!spec) return unavailable('This playbook does not support Launch.');

	const minVersion = spec.minMaestroVersion;
	if (!meetsMinVersion(minVersion, runningVersion)) {
		return unavailable(`Launch needs Maestro ${minVersion} or newer (this is ${runningVersion}).`);
	}

	const platforms: readonly string[] = spec.preconditions?.platforms ?? [];
	if (platforms.length > 0 && !platforms.includes(platform)) {
		return unavailable(
			`This playbook runs on ${joinWithAnd(platforms.map(formatPlatformName))} only.`
		);
	}

	const notes: string[] = [];
	const maestroCli = spec.preconditions?.maestroCli;
	if (target && maestroCli) {
		const { reason, note } = checkMaestroCli(maestroCli, target);
		if (reason !== undefined) return unavailable(reason);
		if (note !== undefined) notes.push(note);
	}
	return { available: true, notes };
}

// ============================================================================
// renderLaunchOutro
// ============================================================================

/**
 * The `{{NAME}}` values an outro can use: every built-in the caller supplied, and every declared
 * input at its serialized value (empty when it has none, so no template syntax leaks into the
 * text). Names are uppercased because the substitution engine matches case-insensitively.
 *
 * A built-in inside an input's value (`{{AUTORUN_FOLDER}}/vault`) is expanded here, because the
 * substitution runs once and would otherwise paste the raw token into the outro. That matches the
 * run, where the Auto Run engine expands the same token in the prompt, so an outro path names the
 * folder the run really wrote to. A built-in that shares an input's name wins; a valid spec has
 * none, because `parseLaunchSpec` rejects the collision.
 */
function buildOutroReplacements(
	spec: PlaybookLaunchSpec,
	values: PlaybookLaunchAnswers,
	builtins: Readonly<Record<string, string>>
): Record<string, string> {
	const known: Record<string, string> = {};
	for (const [name, value] of Object.entries(builtins)) known[name.toUpperCase()] = value;

	const fromInputs: Record<string, string> = {};
	for (const input of spec.inputs) {
		const value = readOwn(values, input.name);
		fromInputs[input.name] = hasAnswer(value)
			? substituteTemplateTokens(serializeLaunchValue(input, value), known)
			: '';
	}
	return { ...fromInputs, ...known };
}

/**
 * Fill the outro a launch ends with. Every string of `spec.outro` (title, summary, each next step,
 * each file's label and path, the report file) has its `{{NAME}}` tokens replaced: an input's name
 * with the value it was launched with, in the form it was written to the prompt (see
 * {@link serializeLaunchValue}), and a built-in such as `{{AGENT_NAME}}` or `{{AUTORUN_FOLDER}}`
 * with the value the caller gives in `builtins`. The caller owns those values because they depend on
 * the agent the run used and on when the outro is drawn.
 *
 * A declared input with no value fills as empty text. A token that is neither an input nor in
 * `builtins` is left as written, so a typo stays visible. Values go in as typed: the result is
 * markdown, and a path is not checked here, so open one only through the usual file-open path.
 *
 * `values` is what the launch record holds (the output of {@link resolveLaunchValues}).
 */
export function renderLaunchOutro(
	spec: PlaybookLaunchSpec,
	values: PlaybookLaunchAnswers,
	builtins: Readonly<Record<string, string>>
): RenderedLaunchOutro {
	const replacements = buildOutroReplacements(spec, values, builtins);
	const fill = (text: string): string => substituteTemplateTokens(text, replacements);
	const { outro } = spec;
	return definedOnly({
		title: outro.title === undefined ? undefined : fill(outro.title),
		summary: fill(outro.summary),
		nextSteps: outro.nextSteps.map(fill),
		files: (outro.files ?? []).map((file) => ({ label: fill(file.label), path: fill(file.path) })),
		reportFile: outro.reportFile === undefined ? undefined : fill(outro.reportFile),
	});
}
