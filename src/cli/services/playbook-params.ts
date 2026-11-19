// Playbook parameters on the CLI: the run-scoped `--param` / `--params-file`
// answers, the saved `playbook configure --set` answers, the missing-required
// precondition a headless run checks before anything spawns, and the cleanup
// of the halt marker Maestro writes when an automation run lacked answers.
//
// Specs, validation, and the precondition itself come from
// `src/shared/playbookParams.ts`, the same module both Auto Run engines use, so
// the CLI cannot disagree with them about what is declared or missing.

import * as fs from 'fs';
import * as path from 'path';
import type { Playbook } from '../../shared/types';
import {
	PLAYBOOK_PARAM_NAME_REGEX,
	collectUnresolvedRequired,
	readPlaybookParamOverlay,
	readPlaybookParamValues,
	resolvePlaybookParamSpecs,
	validatePlaybookParamValue,
	type PlaybookParamSpec,
	type PlaybookParamValues,
} from '../../shared/playbookParams';
import {
	stripMissingParamsHaltMarkers,
	withMissingParamsHaltMarker,
} from '../../shared/autorunMarkers';
import { resolveCliPath } from '../utils/parse';

/** A bad `--param`, `--params-file`, or `--set`. The caller reports it and exits 2. */
export class PlaybookParamInputError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PlaybookParamInputError';
	}
}

/** The specs a saved playbook declares: its prompt's prose form merged with its overlay. */
export function playbookParamSpecs(playbook: Playbook): PlaybookParamSpec[] {
	return resolvePlaybookParamSpecs(
		playbook.prompt ?? '',
		readPlaybookParamOverlay(playbook.parameterOverlay)
	);
}

/** The answers saved on a playbook record, with anything malformed dropped. */
export function storedParamValues(playbook: Playbook): PlaybookParamValues {
	return readPlaybookParamValues(playbook.parameterValues) ?? {};
}

function assertParamName(name: string, source: string): void {
	if (!PLAYBOOK_PARAM_NAME_REGEX.test(name)) {
		throw new PlaybookParamInputError(
			`${source}: "${name}" is not a parameter name (UPPER_SNAKE_CASE, at least two characters).`
		);
	}
}

/**
 * Parse repeated `NAME=VALUE` flags. The value is everything after the first
 * `=`, kept verbatim (it may itself contain `=`). `NAME=` is a blank answer,
 * which clears the name.
 */
export function parseParamAssignments(entries: string[], flag: string): PlaybookParamValues {
	const values: PlaybookParamValues = {};
	for (const entry of entries) {
		const eq = entry.indexOf('=');
		if (eq <= 0) {
			throw new PlaybookParamInputError(`${flag} expects NAME=VALUE, got "${entry}".`);
		}
		const name = entry.slice(0, eq).trim();
		assertParamName(name, flag);
		values[name] = entry.slice(eq + 1);
	}
	return values;
}

/**
 * Read a `--params-file`: a JSON object of `NAME: value`. Numbers and booleans
 * become their text, since the substitution target is text; any other value
 * type is refused rather than guessed at.
 */
export function readParamsFile(input: string): PlaybookParamValues {
	const filePath = resolveCliPath(input);
	let text: string;
	try {
		text = fs.readFileSync(filePath, 'utf-8');
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new PlaybookParamInputError(`--params-file: cannot read ${filePath}: ${reason}`);
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new PlaybookParamInputError(`--params-file: ${filePath} is not valid JSON.`);
	}
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw new PlaybookParamInputError(
			`--params-file: ${filePath} must hold a JSON object of NAME: value pairs.`
		);
	}
	const values: PlaybookParamValues = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		assertParamName(name, '--params-file');
		if (typeof value === 'string') {
			values[name] = value;
		} else if (
			(typeof value === 'number' && Number.isFinite(value)) ||
			typeof value === 'boolean'
		) {
			values[name] = String(value);
		} else {
			throw new PlaybookParamInputError(
				`--params-file: ${name} must be a string, number, or boolean.`
			);
		}
	}
	return values;
}

/**
 * Problems with answers the user typed: a name the playbook does not declare
 * (a typo would otherwise be ignored and the run would use the default), or a
 * value its spec refuses. A blank answer is not checked, because it clears.
 */
export function checkParamAnswers(
	specs: PlaybookParamSpec[],
	answers: PlaybookParamValues
): string[] {
	const byName = new Map(specs.map((spec) => [spec.name, spec]));
	const problems: string[] = [];
	for (const [name, value] of Object.entries(answers)) {
		const spec = byName.get(name);
		if (!spec) {
			const declared = specs.map((s) => s.name).join(', ');
			problems.push(
				`${name} is not a parameter of this playbook (${declared ? `declared: ${declared}` : 'it declares none'}).`
			);
			continue;
		}
		if (value.trim() === '') continue;
		const problem = validatePlaybookParamValue(spec, value);
		if (problem) problems.push(problem);
	}
	return problems;
}

/** Layer answer sets, later layers winning. A blank answer removes the name. */
export function mergeParamValues(...layers: PlaybookParamValues[]): PlaybookParamValues {
	const merged: PlaybookParamValues = {};
	for (const layer of layers) {
		for (const [name, value] of Object.entries(layer)) {
			if (value.trim() === '') delete merged[name];
			else merged[name] = value;
		}
	}
	return merged;
}

/** What one headless run resolves its parameters to. */
export interface RunParamResolution {
	specs: PlaybookParamSpec[];
	/** Saved answers, then `--params-file`, then `--param`. Never written back. */
	values: PlaybookParamValues;
	/** Required specs that still resolve to nothing; non-empty refuses the run. */
	missing: PlaybookParamSpec[];
}

/**
 * Resolve a run's parameter answers: the playbook's saved answers, overridden
 * by `--params-file`, overridden by `--param`. Throws
 * {@link PlaybookParamInputError} for malformed or undeclared input.
 */
export function resolveRunParams(
	playbook: Playbook,
	options: { param?: string[]; paramsFile?: string }
): RunParamResolution {
	const specs = playbookParamSpecs(playbook);
	const fromFile = options.paramsFile ? readParamsFile(options.paramsFile) : {};
	const fromFlags = parseParamAssignments(options.param ?? [], '--param');
	const problems = checkParamAnswers(specs, { ...fromFile, ...fromFlags });
	if (problems.length > 0) throw new PlaybookParamInputError(problems.join('\n'));
	const values = mergeParamValues(storedParamValues(playbook), fromFile, fromFlags);
	return { specs, values, missing: collectUnresolvedRequired(specs, values) };
}

/** One parameter as `playbook configure` reports it. */
export interface PlaybookParamReport {
	name: string;
	type: PlaybookParamSpec['type'];
	required: boolean;
	help?: string;
	default?: string;
	/** The saved answer, when there is one. */
	value?: string;
}

export function reportPlaybookParams(
	specs: PlaybookParamSpec[],
	values: PlaybookParamValues
): PlaybookParamReport[] {
	return specs.map((spec) => {
		const report: PlaybookParamReport = {
			name: spec.name,
			type: spec.type,
			required: spec.required,
		};
		if (spec.help) report.help = spec.help;
		if (spec.default !== undefined) report.default = spec.default;
		if (values[spec.name] !== undefined) report.value = values[spec.name];
		return report;
	});
}

/**
 * Remove the missing-parameters halt marker Maestro wrote into a playbook's
 * documents (only Maestro's own, tagged marker; a person's halt stays). A
 * document that is absent locally (an SSH-remote folder) is skipped. Returns
 * the filenames it changed.
 */
export function stripMissingParamsHaltMarkersFromPlaybook(
	folderPath: string,
	playbook: Pick<Playbook, 'documents'>
): string[] {
	const cleared: string[] = [];
	for (const doc of playbook.documents) {
		const filePath = path.join(folderPath, `${doc.filename}.md`);
		let content: string;
		try {
			content = fs.readFileSync(filePath, 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
			throw error;
		}
		const next = stripMissingParamsHaltMarkers(content);
		if (next === null) continue;
		fs.writeFileSync(filePath, next, 'utf-8');
		cleared.push(doc.filename);
	}
	return cleared;
}

/**
 * Write the missing-parameters halt marker into a playbook's first document, so
 * the next scheduled fire refuses with `HALT_MARKER_PRESENT` instead of failing
 * the same way again on every fire. Only an automation run calls this; a person
 * at a shell reads the error and answers. `playbook configure --set` removes the
 * marker once nothing required is missing
 * ({@link stripMissingParamsHaltMarkersFromPlaybook}). Returns the filename it
 * marked, or null when the playbook has no documents or the first one is absent
 * locally (an SSH-remote folder).
 */
export function writeMissingParamsHaltMarker(
	folderPath: string,
	playbook: Pick<Playbook, 'documents'>,
	names: string[]
): string | null {
	const first = playbook.documents[0];
	if (!first || names.length === 0) return null;
	const filePath = path.join(folderPath, `${first.filename}.md`);
	let content: string;
	try {
		content = fs.readFileSync(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
		throw error;
	}
	const next = withMissingParamsHaltMarker(content, names);
	if (next !== content) fs.writeFileSync(filePath, next, 'utf-8');
	return first.filename;
}
