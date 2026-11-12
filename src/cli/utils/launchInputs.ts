/**
 * Playbook Launch on the command line: turn `--input KEY=VALUE` flags and an `--input-file` into
 * launch answers, and print a launch spec or a launch record as text.
 *
 * Pure rules (the one file read is `readLaunchInputFile`). The values are checked afterwards by the
 * same `resolveLaunchValues` / `validateLaunchValues` the launch modal uses, so a CLI launch and a
 * click launch accept and refuse the same answers.
 */

import * as fs from 'fs';
import { buildLaunchOutro } from '../../shared/launchOutro';
import type {
	PlaybookLaunchInput,
	PlaybookLaunchRecord,
	PlaybookLaunchSpec,
	PlaybookLaunchValues,
} from '../../shared/marketplace-types';
import { isLaunchValuesObject } from '../../shared/playbookLaunch';
import type { TemplateSessionInfo } from '../../shared/templateVariables';
import { parseCliBool, resolveCliPath } from './parse';

/**
 * Answers as the CLI holds them: typed by input, not yet checked against the spec. A value from
 * `--input-file` is JSON of any shape, so `validateLaunchValues` still checks every value's type.
 */
export type LaunchAnswerMap = Partial<PlaybookLaunchValues>;

/** Names of the inputs a spec declares, for an error that tells the person what they can pass. */
function declaredNames(spec: PlaybookLaunchSpec): string {
	return spec.inputs.length > 0 ? spec.inputs.map((input) => input.name).join(', ') : '(none)';
}

/** The input a name refers to, or an error naming the inputs that exist. */
function findInput(spec: PlaybookLaunchSpec, name: string): PlaybookLaunchInput | string {
	const input = spec.inputs.find((candidate) => candidate.name === name);
	return input ?? `Unknown input "${name}". This playbook takes: ${declaredNames(spec)}`;
}

/**
 * One `--input` value as the type of its input: a boolean takes yes/no/true/false, a number its
 * decimal form (anything else becomes NaN, which validation refuses), a multiselect a comma list,
 * and every other type the text as typed.
 */
function typedFlagValue(
	input: PlaybookLaunchInput,
	raw: string
): string | number | boolean | string[] {
	switch (input.type) {
		case 'boolean':
			return parseCliBool(raw, input.name);
		case 'number':
			return raw.trim() === '' ? Number.NaN : Number(raw);
		case 'multiselect':
			return raw
				.split(',')
				.map((item) => item.trim())
				.filter((item) => item !== '');
		default:
			return raw;
	}
}

/**
 * Read repeated `--input KEY=VALUE` flags. The first `=` splits key from value, so a value may hold
 * more. Every problem is collected, so one run lists them all.
 *
 * @throws Error with one line per problem
 */
export function parseInputFlags(
	spec: PlaybookLaunchSpec,
	entries: readonly string[]
): LaunchAnswerMap {
	const answers: LaunchAnswerMap = {};
	const problems: string[] = [];
	for (const entry of entries) {
		const at = entry.indexOf('=');
		if (at <= 0) {
			problems.push(`Invalid --input "${entry}". Expected KEY=VALUE`);
			continue;
		}
		const found = findInput(spec, entry.slice(0, at).trim());
		if (typeof found === 'string') {
			problems.push(found);
			continue;
		}
		try {
			answers[found.name] = typedFlagValue(found, entry.slice(at + 1));
		} catch (error) {
			problems.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (problems.length > 0) throw new Error(problems.join('\n'));
	return answers;
}

/**
 * Read `--input-file`: a JSON object keyed by input name, with each value already the right JSON
 * type (a number, a boolean, a list for a multiselect).
 *
 * @throws Error when the file cannot be read, is not JSON, is not an object, or names an input the
 *   playbook does not declare
 */
export function readLaunchInputFile(spec: PlaybookLaunchSpec, file: string): LaunchAnswerMap {
	const resolved = resolveCliPath(file);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot read --input-file ${resolved}: ${reason}`);
	}
	if (!isLaunchValuesObject(parsed)) {
		throw new Error(`--input-file ${resolved} must hold a JSON object keyed by input name`);
	}
	const problems = Object.keys(parsed)
		.map((name) => findInput(spec, name))
		.filter((found): found is string => typeof found === 'string');
	if (problems.length > 0) throw new Error(problems.join('\n'));
	return { ...parsed } as LaunchAnswerMap;
}

/** The answers to launch with: the file first, then the flags, so a flag overrides the file. */
export function collectLaunchAnswers(
	spec: PlaybookLaunchSpec,
	options: { input?: readonly string[]; inputFile?: string }
): LaunchAnswerMap {
	const fromFile = options.inputFile ? readLaunchInputFile(spec, options.inputFile) : {};
	const fromFlags = parseInputFlags(spec, options.input ?? []);
	return { ...fromFile, ...fromFlags };
}

/** `field: message` for each failing input, in the order the spec declares them. */
export function formatFieldErrors(
	spec: PlaybookLaunchSpec,
	errors: Readonly<Record<string, string>>
): string[] {
	return spec.inputs
		.filter((input) => errors[input.name] !== undefined)
		.map((input) => `${input.name}: ${errors[input.name]}`);
}

function describeDefault(input: PlaybookLaunchInput): string {
	const value = input.default;
	if (value === undefined) return '';
	return Array.isArray(value) ? value.join(',') : String(value);
}

/** One input as the line `show` prints: name, type, whether it is required, default and options. */
function describeInput(input: PlaybookLaunchInput): string[] {
	const parts = [input.type, input.required ? 'required' : 'optional'];
	const defaultValue = describeDefault(input);
	if (defaultValue !== '') parts.push(`default ${defaultValue}`);
	if (input.advanced) parts.push('advanced');
	const lines = [`  ${input.name}  (${parts.join(', ')})`];
	lines.push(`      ${input.label}${input.help ? `: ${input.help}` : ''}`);
	if (input.options && input.options.length > 0) {
		lines.push(`      options: ${input.options.map((option) => option.value).join(', ')}`);
	}
	return lines;
}

/** What `marketplace show` prints about launching: the inputs, or that the playbook is download only. */
export function describeLaunchSpec(spec: PlaybookLaunchSpec | undefined): string[] {
	if (!spec) return ['Launch: download only (this playbook has no launch support)'];
	const lines = ['Launch: supported'];
	const { preconditions } = spec;
	if (preconditions?.platforms?.length)
		lines.push(`  Platforms: ${preconditions.platforms.join(', ')}`);
	for (const need of preconditions?.requires ?? []) lines.push(`  Requires: ${need}`);
	if (preconditions?.maestroCli) lines.push(`  maestro-cli: ${preconditions.maestroCli}`);
	if (preconditions?.confirm) {
		lines.push(`  Confirmation needed (pass --confirm): ${preconditions.confirm}`);
	}
	if (spec.inputs.length === 0) {
		lines.push('  Inputs: none (launch takes only the agent)');
		return lines;
	}
	lines.push('  Inputs:');
	for (const input of spec.inputs) lines.push(...describeInput(input));
	return lines;
}

/**
 * The launch record and its rendered outro as text, for `launch-status` and `--wait`. The outro is
 * the one the dialog shows (`buildLaunchOutro`), filled from the record, never the current manifest.
 */
export function formatLaunchStatus(
	launch: PlaybookLaunchRecord,
	agent: TemplateSessionInfo | undefined
): string[] {
	const view = buildLaunchOutro(launch, agent);
	const lines = [
		`${view.title}  [launch ${launch.launchId}]`,
		`Playbook: ${launch.playbookId}  Agent: ${launch.sessionId}`,
		`Status:   ${view.status.text}`,
	];
	for (const stat of view.stats) lines.push(`${stat.label}: ${stat.value}`);
	if (view.cleanup) lines.push(view.cleanup.text);
	if (launch.status === 'running') return lines;
	lines.push('', view.summary);
	if (view.nextSteps.length > 0) {
		lines.push('', 'Next steps:');
		for (const step of view.nextSteps) lines.push(`  - ${step.trim().replace(/\n/g, '\n    ')}`);
	}
	if (view.files.length > 0) {
		lines.push('', 'Files:');
		for (const file of view.files) lines.push(`  ${file.label}: ${file.path}`);
	}
	if (view.reportFile) lines.push('', `Report: ${view.reportFile}`);
	return lines;
}
