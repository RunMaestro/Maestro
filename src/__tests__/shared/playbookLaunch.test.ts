/**
 * Tests for the playbook launch module: parsing a manifest `launch` block, resolving and
 * validating answers, serializing values, rewriting a playbook prompt, deciding whether Launch is
 * offered, and rendering the outro.
 *
 * The Research/Market fixtures under src/__tests__/fixtures/playbook-launch/ are the shipped
 * prompt and launch block of that Exchange playbook, copied from Maestro-Playbooks manifest.json.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
	applyLaunchInputs,
	isLaunchAvailable,
	parseLaunchSpec,
	renderLaunchOutro,
	resolveLaunchValues,
	serializeLaunchValue,
	validateLaunchValues,
	type PlaybookLaunchTarget,
} from '../../shared/playbookLaunch';
import { TEMPLATE_VARIABLES } from '../../shared/templateVariables';
import type {
	MarketplacePlaybook,
	PlaybookLaunchInput,
	PlaybookLaunchSpec,
} from '../../shared/marketplace-types';

type Raw = Record<string, unknown>;

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'playbook-launch');
// A Windows checkout may turn the fixture's line endings into CRLF.
const marketPrompt = fs
	.readFileSync(path.join(FIXTURES, 'research-market.prompt.txt'), 'utf8')
	.replace(/\r\n/g, '\n');
const marketLaunch: unknown = JSON.parse(
	fs.readFileSync(path.join(FIXTURES, 'research-market.launch.json'), 'utf8')
);

// ----------------------------------------------------------------------------
// Factories
// ----------------------------------------------------------------------------

/** A raw (manifest-shaped) input. Override any field, or set one to `undefined` to drop it. */
function rawInput(overrides: Raw = {}): Raw {
	return { name: 'TOPIC', label: 'Topic', type: 'text', ...overrides };
}

/** A raw (manifest-shaped) launch block that parses cleanly until a field is overridden. */
function rawLaunch(overrides: Raw = {}): Raw {
	return {
		inputs: [rawInput()],
		outro: { summary: 'Done.', nextSteps: ['Read the report.'] },
		...overrides,
	};
}

function parseSpec(raw: unknown): PlaybookLaunchSpec {
	const { spec, errors } = parseLaunchSpec(raw);
	expect(errors).toEqual([]);
	if (!spec) throw new Error('expected parseLaunchSpec to return a spec');
	return spec;
}

/** The errors of a block that must be rejected, one string joined per problem. */
function parseErrors(raw: unknown): string[] {
	const { spec, errors } = parseLaunchSpec(raw);
	expect(spec).toBeUndefined();
	return errors;
}

/** A parsed spec with the given raw inputs, for the value-level functions. */
function specWith(...inputs: Raw[]): PlaybookLaunchSpec {
	return parseSpec(rawLaunch({ inputs }));
}

/** A typed input for serialization tests (no parsing involved). */
function inputOf(
	type: PlaybookLaunchInput['type'],
	extra: Partial<PlaybookLaunchInput> = {}
): PlaybookLaunchInput {
	return { name: 'VALUE', label: 'Value', type, ...extra };
}

const choices = [{ value: 'a' }, { value: 'b' }];

// ----------------------------------------------------------------------------
// parseLaunchSpec
// ----------------------------------------------------------------------------

describe('parseLaunchSpec: accepted blocks', () => {
	it('returns the spec and no errors for a minimal block, with no undefined keys', () => {
		const result = parseLaunchSpec(rawLaunch());
		expect(result.errors).toEqual([]);
		expect(result.spec).toStrictEqual({
			inputs: [{ name: 'TOPIC', label: 'Topic', type: 'text' }],
			outro: { summary: 'Done.', nextSteps: ['Read the report.'] },
		});
	});

	it('accepts an empty inputs list ("pick agent and go")', () => {
		expect(parseSpec(rawLaunch({ inputs: [] })).inputs).toEqual([]);
	});

	it('keeps every documented field of a full block', () => {
		const full = {
			minMaestroVersion: '0.17.0',
			intro: 'Intro **markdown**.',
			preconditions: {
				platforms: ['darwin', 'linux'],
				requires: ['gh logged in'],
				confirm: 'I understand',
				maestroCli: 'optional',
			},
			inputs: [
				{
					name: 'TOPIC',
					label: 'Topic',
					type: 'text',
					required: true,
					help: 'Three to six words',
					placeholder: 'Edge AI',
					pattern: '^[a-z ]+$',
				},
				{ name: 'BRIEF', label: 'Brief', type: 'textarea', advanced: true },
				{ name: 'SITE', label: 'Site', type: 'url' },
				{ name: 'OUT', label: 'Out', type: 'path', default: '{{AUTORUN_FOLDER}}/vault' },
				{
					name: 'COVERAGE',
					label: 'Coverage',
					type: 'number',
					default: 90,
					min: 0,
					max: 100,
					unit: '%',
				},
				{ name: 'WIRE', label: 'Wire', type: 'boolean', default: true },
				{
					name: 'SCOPE',
					label: 'Scope',
					type: 'select',
					options: [{ value: 'user', label: 'User' }, { value: 'project' }],
					default: 'user',
				},
				{
					name: 'EXTRAS',
					label: 'Extras',
					type: 'multiselect',
					options: choices,
					default: ['a'],
					emptyValue: 'none',
				},
			],
			maxLoops: 30,
			cleanup: 'keep',
			outro: {
				title: 'All done',
				summary: 'Summary',
				nextSteps: ['One', 'Two'],
				files: [{ label: 'Report', path: '{{AUTORUN_FOLDER}}/REPORT.md' }],
				reportFile: 'REPORT.md',
			},
		};
		expect(parseSpec(full)).toEqual(full);
	});

	it('accepts the unit field on a number and the emptyValue field on a multiselect', () => {
		const spec = specWith(
			{ name: 'PCT', label: 'Percent', type: 'number', default: 80, unit: '%' },
			{ name: 'KINDS', label: 'Kinds', type: 'multiselect', options: choices, emptyValue: 'none' }
		);
		expect(spec.inputs[0].unit).toBe('%');
		expect(spec.inputs[1].emptyValue).toBe('none');
	});

	it('keeps null maxLoops (unlimited) and a positive whole number', () => {
		expect(parseSpec(rawLaunch({ maxLoops: null })).maxLoops).toBeNull();
		expect(parseSpec(rawLaunch({ maxLoops: 5 })).maxLoops).toBe(5);
	});

	it.each(['required', 'optional'])('accepts preconditions.maestroCli "%s"', (mode) => {
		expect(parseSpec(rawLaunch({ preconditions: { maestroCli: mode } })).preconditions).toEqual({
			maestroCli: mode,
		});
	});

	it('ignores fields this build does not know', () => {
		const spec = parseSpec({
			futureField: 1,
			preconditions: { futureField: 1 },
			inputs: [{ ...rawInput(), futureField: 1 }],
			outro: { summary: 'Done.', nextSteps: [], futureField: 1 },
		});
		expect(JSON.stringify(spec)).not.toContain('futureField');
	});

	it('turns a single-string multiselect default into a one-item list', () => {
		const spec = specWith({
			name: 'KINDS',
			label: 'Kinds',
			type: 'multiselect',
			options: choices,
			default: 'a',
		});
		expect(spec.inputs[0].default).toEqual(['a']);
	});

	it('keeps a pattern exactly as written, slashes unescaped', () => {
		const pattern = '^https://github\\.com/[^/]+/[^/]+/pull/\\d+/?$';
		const spec = specWith({ name: 'PR_URL', label: 'PR', type: 'url', pattern });
		expect(spec.inputs[0].pattern).toBe(pattern);
	});

	it('returns a copy, so editing the spec never edits the manifest it came from', () => {
		const raw = rawLaunch({
			preconditions: { requires: ['a'] },
			inputs: [rawInput({ type: 'select', options: [{ value: 'a' }] })],
		});
		const spec = parseSpec(raw);
		spec.preconditions?.requires?.push('b');
		spec.inputs[0].options?.push({ value: 'z' });
		expect((raw.preconditions as Raw).requires).toEqual(['a']);
		expect((((raw.inputs as Raw[])[0] as Raw).options as unknown[]).length).toBe(1);
	});

	it('parses the shipped Research/Market launch block without losing anything', () => {
		expect(parseSpec(marketLaunch)).toEqual(marketLaunch);
	});
});

describe('parseLaunchSpec: rejected blocks', () => {
	it.each([null, undefined, [], 'launch', 42])('rejects a block that is %j', (raw) => {
		expect(parseLaunchSpec(raw)).toEqual({ errors: ['launch must be an object'] });
	});

	it('rejects a missing or non-list inputs field', () => {
		const expected = ['inputs must be a list (it may be empty)'];
		expect(parseErrors({ outro: { summary: 'x', nextSteps: [] } })).toEqual(expected);
		expect(parseErrors(rawLaunch({ inputs: {} }))).toEqual(expected);
	});

	it('rejects an input that is not an object', () => {
		expect(parseErrors(rawLaunch({ inputs: ['TOPIC'] }))).toEqual(['input #1 must be an object']);
	});

	describe('names', () => {
		it.each(['topic', 'Topic', '1ST', '_X', 'A-B', 'A B', '', 42])(
			'rejects the name %j (not UPPER_SNAKE_CASE)',
			(name) => {
				const errors = parseErrors(rawLaunch({ inputs: [rawInput({ name })] }));
				expect(errors).toHaveLength(1);
				expect(errors[0]).toContain('name must be UPPER_SNAKE_CASE');
			}
		);

		it('rejects a duplicate name', () => {
			expect(parseErrors(rawLaunch({ inputs: [rawInput(), rawInput()] }))).toEqual([
				'input TOPIC: duplicate name',
			]);
		});

		it('rejects every documented built-in template variable name', () => {
			const names = TEMPLATE_VARIABLES.map((entry) => entry.variable.slice(2, -2));
			expect(names.length).toBeGreaterThan(40);
			for (const name of names) {
				expect(parseErrors(rawLaunch({ inputs: [rawInput({ name })] })), name).toEqual([
					`input ${name}: collides with a built-in template variable`,
				]);
			}
		});

		it('rejects any CUE_ name, even one that is not documented', () => {
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ name: 'CUE_NEW_THING' })] }))).toEqual([
				'input CUE_NEW_THING: collides with a built-in template variable',
			]);
		});

		it.each(['AGENT_NAMES', 'MY_AGENT_NAME', 'CUE', 'CUES_LEFT', 'DATE2'])(
			'accepts %s, which only resembles a built-in',
			(name) => {
				expect(parseSpec(rawLaunch({ inputs: [rawInput({ name })] })).inputs[0].name).toBe(name);
			}
		);
	});

	describe('labels and types', () => {
		it.each([undefined, '', 3])('rejects the label %j', (label) => {
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ label })] }))).toEqual([
				'input TOPIC: label is required',
			]);
		});

		it.each(['date', 'TEXT', 'checkbox', 3, undefined])('rejects the unknown type %j', (type) => {
			const errors = parseErrors(rawLaunch({ inputs: [rawInput({ type })] }));
			expect(errors).toEqual([`input TOPIC: unknown type "${String(type)}"`]);
		});

		it.each(['required', 'help', 'placeholder', 'advanced'])(
			'rejects a %s of the wrong type',
			(field) => {
				const errors = parseErrors(rawLaunch({ inputs: [rawInput({ [field]: 7 })] }));
				expect(errors).toHaveLength(1);
				expect(errors[0]).toContain(`input TOPIC: ${field} must be`);
			}
		);
	});

	describe('options', () => {
		it.each([
			['select', undefined],
			['select', []],
			['select', 'a,b'],
			['multiselect', undefined],
			['multiselect', []],
		])('rejects a %s whose options are %j', (type, options) => {
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ type, options })] }))).toEqual([
				`input TOPIC: ${type} needs a non-empty options list`,
			]);
		});

		it('rejects options on an input that is not a select or multiselect', () => {
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ options: choices })] }))).toEqual([
				'input TOPIC: options only apply to select and multiselect',
			]);
		});

		it.each([['a'], [{ label: 'No value' }], [{ value: '' }], [{ value: 3 }]])(
			'rejects the option %j (no usable value)',
			(option) => {
				const errors = parseErrors(
					rawLaunch({ inputs: [rawInput({ type: 'select', options: [option] })] })
				);
				expect(errors).toEqual(['input TOPIC: every option needs a non-empty value']);
			}
		);

		it('rejects an option label that is not a string', () => {
			const options = [{ value: 'a', label: 3 }];
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ type: 'select', options })] }))).toEqual([
				'input TOPIC: option "a": label must be a string',
			]);
		});

		it('rejects a repeated option value', () => {
			const options = [{ value: 'a' }, { value: 'a' }];
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ type: 'select', options })] }))).toEqual([
				'input TOPIC: duplicate option value "a"',
			]);
		});
	});

	describe('defaults', () => {
		it('rejects a select default outside its options', () => {
			const input = rawInput({ type: 'select', options: choices, default: 'z' });
			expect(parseErrors(rawLaunch({ inputs: [input] }))).toEqual([
				'input TOPIC: default "z" is not one of the options',
			]);
		});

		it('rejects a multiselect default with a value outside its options', () => {
			const input = rawInput({ type: 'multiselect', options: choices, default: ['a', 'z'] });
			expect(parseErrors(rawLaunch({ inputs: [input] }))).toEqual([
				'input TOPIC: default "z" is not one of the options',
			]);
		});

		it('rejects a select default that is a list', () => {
			const input = rawInput({ type: 'select', options: choices, default: ['a'] });
			expect(parseErrors(rawLaunch({ inputs: [input] }))).toEqual([
				'input TOPIC: select default must be one option value',
			]);
		});

		it('rejects a multiselect default that holds a non-string', () => {
			const input = rawInput({ type: 'multiselect', options: choices, default: ['a', 3] });
			expect(parseErrors(rawLaunch({ inputs: [input] }))).toEqual([
				'input TOPIC: multiselect default must be option values',
			]);
		});

		it('rejects a default of the wrong type', () => {
			const cases: Array<[Raw, string]> = [
				[{ type: 'boolean', default: 'yes' }, 'boolean default must be true or false'],
				[{ type: 'number', default: '5' }, 'number default must be a number'],
				[{ type: 'text', default: 5 }, 'text default must be text'],
				[{ type: 'path', default: ['a'] }, 'path default must be text'],
			];
			for (const [overrides, message] of cases) {
				expect(parseErrors(rawLaunch({ inputs: [rawInput(overrides)] }))).toEqual([
					`input TOPIC: ${message}`,
				]);
			}
		});

		it('rejects a number default outside min and max', () => {
			expect(
				parseErrors(rawLaunch({ inputs: [rawInput({ type: 'number', default: 0, min: 1 })] }))
			).toEqual(['input TOPIC: default is below min']);
			expect(
				parseErrors(rawLaunch({ inputs: [rawInput({ type: 'number', default: 11, max: 10 })] }))
			).toEqual(['input TOPIC: default is above max']);
		});

		it('rejects a default that does not match the pattern', () => {
			const input = rawInput({ pattern: '^\\d+$', default: 'abc' });
			expect(parseErrors(rawLaunch({ inputs: [input] }))).toEqual([
				'input TOPIC: default does not match pattern',
			]);
		});

		it('rejects a default that holds a backtick', () => {
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ default: 'a`b' })] }))).toEqual([
				'input TOPIC: default cannot contain a backtick',
			]);
			const options = [{ value: 'a`b' }];
			const input = rawInput({ type: 'multiselect', options, default: ['a`b'] });
			expect(parseErrors(rawLaunch({ inputs: [input] }))).toEqual([
				'input TOPIC: default cannot contain a backtick',
			]);
		});
	});

	describe('type-specific fields', () => {
		it('rejects a pattern that is not a valid regular expression', () => {
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ pattern: '(' })] }))).toEqual([
				'input TOPIC: pattern is not a valid regular expression',
			]);
		});

		it('rejects a pattern that is not a string', () => {
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ pattern: 7 })] }))).toEqual([
				'input TOPIC: pattern must be a string',
			]);
		});

		it.each(['number', 'path', 'textarea', 'boolean'])(
			'rejects a pattern on a %s (text and url only)',
			(type) => {
				const errors = parseErrors(rawLaunch({ inputs: [rawInput({ type, pattern: '^a$' })] }));
				expect(errors).toEqual(['input TOPIC: pattern only applies to text and url']);
			}
		);

		it.each([{ min: 1 }, { max: 1 }, { unit: '%' }])(
			'rejects %j on an input that is not a number',
			(extra) => {
				expect(parseErrors(rawLaunch({ inputs: [rawInput(extra)] }))).toEqual([
					'input TOPIC: min, max and unit only apply to number',
				]);
			}
		);

		it('rejects min above max', () => {
			const input = rawInput({ type: 'number', min: 5, max: 1 });
			expect(parseErrors(rawLaunch({ inputs: [input] }))).toEqual([
				'input TOPIC: min is above max',
			]);
		});

		it('rejects a min, max or unit of the wrong type', () => {
			const input = rawInput({ type: 'number', min: '1', max: '9', unit: 3 });
			expect(parseErrors(rawLaunch({ inputs: [input] }))).toEqual([
				'input TOPIC: min must be a number',
				'input TOPIC: max must be a number',
				'input TOPIC: unit must be a string',
			]);
		});

		it('rejects a unit that holds a backtick', () => {
			const input = rawInput({ type: 'number', unit: '`' });
			expect(parseErrors(rawLaunch({ inputs: [input] }))).toEqual([
				'input TOPIC: unit cannot contain a backtick',
			]);
		});

		it('rejects emptyValue on an input that is not a multiselect', () => {
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ emptyValue: 'none' })] }))).toEqual([
				'input TOPIC: emptyValue only applies to multiselect',
			]);
		});

		it('rejects an emptyValue that is not a string or holds a backtick', () => {
			const base = { type: 'multiselect', options: choices };
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ ...base, emptyValue: 3 })] }))).toEqual([
				'input TOPIC: emptyValue must be a string',
			]);
			expect(parseErrors(rawLaunch({ inputs: [rawInput({ ...base, emptyValue: '`' })] }))).toEqual([
				'input TOPIC: emptyValue cannot contain a backtick',
			]);
		});
	});

	describe('outro', () => {
		it('rejects a missing or non-object outro', () => {
			const expected = ['outro is required (an object with a summary)'];
			expect(parseErrors({ inputs: [] })).toEqual(expected);
			expect(parseErrors({ inputs: [], outro: 'Done.' })).toEqual(expected);
		});

		it.each([undefined, '', 3])('rejects outro.summary %j', (summary) => {
			const outro = { summary, nextSteps: [] };
			expect(parseErrors(rawLaunch({ outro }))).toEqual(['outro.summary is required']);
		});

		it.each([undefined, 'one', [1], {}])('rejects outro.nextSteps %j', (nextSteps) => {
			const outro = { summary: 'Done.', nextSteps };
			expect(parseErrors(rawLaunch({ outro }))).toEqual([
				'outro.nextSteps must be a list of strings',
			]);
		});

		it('rejects outro.files that is not a list or holds an incomplete entry', () => {
			const outro = { summary: 'Done.', nextSteps: [] };
			expect(parseErrors(rawLaunch({ outro: { ...outro, files: 'REPORT.md' } }))).toEqual([
				'outro.files must be a list of label and path pairs',
			]);
			for (const entry of [{ label: 'Report' }, { path: 'REPORT.md' }, { label: '', path: 'a' }]) {
				expect(parseErrors(rawLaunch({ outro: { ...outro, files: [entry] } }))).toEqual([
					'outro.files entries need a label and a path',
				]);
			}
		});

		it('rejects an outro title or reportFile that is not a string', () => {
			const outro = { summary: 'Done.', nextSteps: [], title: 3, reportFile: 4 };
			expect(parseErrors(rawLaunch({ outro }))).toEqual([
				'outro.title must be a string',
				'outro.reportFile must be a string',
			]);
		});
	});

	describe('preconditions and settings', () => {
		it('rejects preconditions that is not an object', () => {
			expect(parseErrors(rawLaunch({ preconditions: ['darwin'] }))).toEqual([
				'preconditions must be an object',
			]);
		});

		it.each(['maybe', 'Required', true, 1, ''])(
			'rejects preconditions.maestroCli %j (only required or optional)',
			(maestroCli) => {
				expect(parseErrors(rawLaunch({ preconditions: { maestroCli } }))).toEqual([
					'preconditions.maestroCli must be "required" or "optional"',
				]);
			}
		);

		it('rejects an unknown platform or a platforms value that is not a list', () => {
			const expected = ['preconditions.platforms must be a list of darwin, linux, win32'];
			expect(parseErrors(rawLaunch({ preconditions: { platforms: ['macos'] } }))).toEqual(expected);
			expect(parseErrors(rawLaunch({ preconditions: { platforms: 'darwin' } }))).toEqual(expected);
		});

		it('rejects requires and confirm of the wrong type', () => {
			expect(parseErrors(rawLaunch({ preconditions: { requires: ['a', 1] } }))).toEqual([
				'preconditions.requires must be a list of strings',
			]);
			expect(parseErrors(rawLaunch({ preconditions: { confirm: true } }))).toEqual([
				'preconditions.confirm must be a string',
			]);
		});

		it.each([0, -1, 1.5, '3', false])('rejects maxLoops %j', (maxLoops) => {
			expect(parseErrors(rawLaunch({ maxLoops }))).toEqual([
				'maxLoops must be a positive whole number or null',
			]);
		});

		it.each(['delete', 'KEEP', true])('rejects cleanup %j', (cleanup) => {
			expect(parseErrors(rawLaunch({ cleanup }))).toEqual([
				'cleanup must be "remove-docs" or "keep"',
			]);
		});

		it('rejects minMaestroVersion and intro that are not strings', () => {
			expect(parseErrors(rawLaunch({ minMaestroVersion: 17, intro: [] }))).toEqual([
				'minMaestroVersion must be a string',
				'intro must be a string',
			]);
		});
	});

	it('reports every problem in one pass and returns no spec', () => {
		const errors = parseErrors({
			inputs: [
				rawInput({ name: 'topic' }),
				rawInput({ type: 'select' }),
				rawInput({ name: 'DATE' }),
			],
			outro: { nextSteps: [] },
			preconditions: { maestroCli: 'maybe' },
		});
		expect(errors).toEqual([
			'preconditions.maestroCli must be "required" or "optional"',
			'input topic: name must be UPPER_SNAKE_CASE',
			'input TOPIC: select needs a non-empty options list',
			'input DATE: collides with a built-in template variable',
			'outro.summary is required',
		]);
	});
});

// ----------------------------------------------------------------------------
// resolveLaunchValues
// ----------------------------------------------------------------------------

describe('resolveLaunchValues', () => {
	const spec = specWith(
		rawInput({ name: 'TOPIC', required: true }),
		rawInput({ name: 'NOTE', type: 'textarea' }),
		rawInput({ name: 'BRANCH', default: 'main' }),
		{ name: 'LIMIT', label: 'Limit', type: 'number', default: 60 },
		{ name: 'WIRE', label: 'Wire', type: 'boolean', default: true },
		{ name: 'KINDS', label: 'Kinds', type: 'multiselect', options: choices, default: ['a'] }
	);

	it('fills defaults, and leaves an optional input with no answer and no default absent', () => {
		const values = resolveLaunchValues(spec);
		expect(values).toStrictEqual({ BRANCH: 'main', LIMIT: 60, WIRE: true, KINDS: ['a'] });
		expect(values).not.toHaveProperty('TOPIC');
		expect(values).not.toHaveProperty('NOTE');
	});

	it('treats a missing answers argument and an empty one alike', () => {
		expect(resolveLaunchValues(spec, {})).toEqual(resolveLaunchValues(spec));
	});

	it('lets an answer win over the default', () => {
		const answers = {
			TOPIC: 'Edge AI',
			NOTE: 'Mind the scope',
			BRANCH: 'dev',
			LIMIT: 5,
			WIRE: false,
			KINDS: ['b'],
		};
		expect(resolveLaunchValues(spec, answers)).toStrictEqual(answers);
	});

	it('treats missing, undefined, null, empty and whitespace-only answers as no answer', () => {
		const values = resolveLaunchValues(spec, {
			TOPIC: '   ',
			NOTE: '',
			BRANCH: '',
			LIMIT: undefined,
			WIRE: null as unknown as boolean,
		});
		expect(values).toStrictEqual({ BRANCH: 'main', LIMIT: 60, WIRE: true, KINDS: ['a'] });
	});

	it('trims text answers', () => {
		expect(resolveLaunchValues(spec, { TOPIC: '  Edge AI  ' }).TOPIC).toBe('Edge AI');
	});

	it('keeps false, 0 and an empty list, because the user chose them', () => {
		const values = resolveLaunchValues(spec, { WIRE: false, LIMIT: 0, KINDS: [] });
		expect(values.WIRE).toBe(false);
		expect(values.LIMIT).toBe(0);
		expect(values.KINDS).toEqual([]);
	});

	it('drops answers for names the spec does not declare', () => {
		const values = resolveLaunchValues(spec, { UNDECLARED: 'x', toString: 'y' } as never);
		expect(Object.keys(values).sort()).toEqual(['BRANCH', 'KINDS', 'LIMIT', 'WIRE']);
	});

	it('copies lists, so the result never aliases the spec or the answers', () => {
		const answers = { KINDS: ['b'] };
		const fromAnswer = resolveLaunchValues(spec, answers);
		expect(fromAnswer.KINDS).toEqual(['b']);
		expect(fromAnswer.KINDS).not.toBe(answers.KINDS);

		const fromDefault = resolveLaunchValues(spec);
		(fromDefault.KINDS as string[]).push('b');
		expect(spec.inputs.find((input) => input.name === 'KINDS')?.default).toEqual(['a']);
	});

	it('leaves a placeholder-carrying input absent so its <UNSET> line survives', () => {
		const prompt = '**TOPIC:** `<UNSET - name the topic>`\n**BRANCH:** `main`';
		const values = resolveLaunchValues(spec);
		expect(applyLaunchInputs(prompt, spec, values)).toBe(prompt);
	});
});

// ----------------------------------------------------------------------------
// validateLaunchValues
// ----------------------------------------------------------------------------

describe('validateLaunchValues', () => {
	const spec = specWith(
		rawInput({ name: 'REQ', required: true }),
		{ name: 'COUNT', label: 'Count', type: 'number', min: 1, max: 10 },
		{ name: 'SITE', label: 'Site', type: 'url' },
		{ name: 'CODE', label: 'Code', type: 'text', pattern: '^(all|\\d+)$' },
		{
			name: 'MODE',
			label: 'Mode',
			type: 'select',
			options: [{ value: 'fast' }, { value: 'slow' }],
		},
		{ name: 'KINDS', label: 'Kinds', type: 'multiselect', options: choices },
		{ name: 'FLAG', label: 'Flag', type: 'boolean' },
		{ name: 'NOTE', label: 'Note', type: 'textarea' },
		{ name: 'DIR', label: 'Dir', type: 'path' }
	);
	const valid = { REQ: 'x' };

	it('returns an empty object when every value is valid', () => {
		const values = {
			REQ: 'x',
			COUNT: 5,
			SITE: 'https://github.com/a/b/pull/1',
			CODE: '12',
			MODE: 'fast',
			KINDS: ['a', 'b'],
			FLAG: false,
			NOTE: 'two\nlines',
			DIR: '~/Journal',
		};
		expect(validateLaunchValues(spec, values)).toEqual({});
	});

	it('skips an optional input that has no value', () => {
		expect(validateLaunchValues(spec, valid)).toEqual({});
		expect(validateLaunchValues(spec, { ...valid, SITE: '', COUNT: undefined })).toEqual({});
	});

	describe('required', () => {
		it.each([undefined, null, '', '   '])('flags a required input whose value is %j', (REQ) => {
			expect(validateLaunchValues(spec, { REQ })).toEqual({ REQ: 'This field is required' });
		});

		it('flags a required input that is missing, keyed by its name', () => {
			expect(validateLaunchValues(spec, {})).toEqual({ REQ: 'This field is required' });
		});

		it('counts false and 0 as values, and an empty multiselect list as none', () => {
			const required = specWith(
				{ name: 'FLAG', label: 'Flag', type: 'boolean', required: true },
				{ name: 'COUNT', label: 'Count', type: 'number', required: true },
				{ name: 'KINDS', label: 'Kinds', type: 'multiselect', options: choices, required: true }
			);
			expect(validateLaunchValues(required, { FLAG: false, COUNT: 0, KINDS: ['a'] })).toEqual({});
			expect(validateLaunchValues(required, { FLAG: false, COUNT: 0, KINDS: [] })).toEqual({
				KINDS: 'This field is required',
			});
			expect(validateLaunchValues(required, {})).toEqual({
				FLAG: 'This field is required',
				COUNT: 'This field is required',
				KINDS: 'This field is required',
			});
		});

		it('accepts an empty list for an optional multiselect (a deliberate none)', () => {
			expect(validateLaunchValues(spec, { ...valid, KINDS: [] })).toEqual({});
		});
	});

	describe('numbers', () => {
		it.each([
			['5', 'Enter a number'],
			[Number.NaN, 'Enter a number'],
			[Number.POSITIVE_INFINITY, 'Enter a number'],
			[true, 'Enter a number'],
			[0, 'Must be at least 1'],
			[0.5, 'Must be at least 1'],
			[11, 'Must be at most 10'],
		])('rejects %j', (COUNT, message) => {
			expect(validateLaunchValues(spec, { ...valid, COUNT })).toEqual({ COUNT: message });
		});

		it.each([1, 10, 2.5])('accepts %j (bounds are inclusive)', (COUNT) => {
			expect(validateLaunchValues(spec, { ...valid, COUNT })).toEqual({});
		});

		it('accepts any finite number when there are no bounds', () => {
			const open = specWith({ name: 'DELTA', label: 'Delta', type: 'number' });
			expect(validateLaunchValues(open, { DELTA: -1000.5 })).toEqual({});
		});
	});

	describe('urls', () => {
		it.each(['https://github.com/a/b/pull/1', 'http://localhost:3000/x?y=1#z'])(
			'accepts %s',
			(SITE) => {
				expect(validateLaunchValues(spec, { ...valid, SITE })).toEqual({});
			}
		);

		it.each([
			'github.com/a/b',
			'ftp://host/file',
			'javascript:alert(1)',
			'mailto:a@b.co',
			'not a url',
			42,
		])('rejects %j', (SITE) => {
			expect(validateLaunchValues(spec, { ...valid, SITE })).toEqual({
				SITE: SITE === 42 ? 'Enter text' : 'Enter a full http:// or https:// URL',
			});
		});

		it('applies a url pattern on top of the url shape', () => {
			const pr = specWith({
				name: 'PR_URL',
				label: 'PR',
				type: 'url',
				pattern: '^https://github\\.com/[^/]+/[^/]+/pull/\\d+/?$',
			});
			expect(validateLaunchValues(pr, { PR_URL: 'https://github.com/a/b/pull/12' })).toEqual({});
			expect(validateLaunchValues(pr, { PR_URL: 'https://example.com/a/b/pull/12' })).toEqual({
				PR_URL: 'Does not match the expected format',
			});
		});
	});

	describe('patterns', () => {
		it.each(['all', '12'])('accepts %s', (CODE) => {
			expect(validateLaunchValues(spec, { ...valid, CODE })).toEqual({});
		});

		it.each(['nope', '1 2', 'ALL'])('rejects %s', (CODE) => {
			expect(validateLaunchValues(spec, { ...valid, CODE })).toEqual({
				CODE: 'Does not match the expected format',
			});
		});
	});

	describe('choices', () => {
		it('accepts a listed select value and rejects anything else', () => {
			expect(validateLaunchValues(spec, { ...valid, MODE: 'slow' })).toEqual({});
			for (const MODE of ['medium', 'FAST', 3, ['fast']]) {
				expect(validateLaunchValues(spec, { ...valid, MODE })).toEqual({
					MODE: 'Pick one of the listed options',
				});
			}
		});

		it('accepts listed multiselect values and rejects an unknown member or a non-list', () => {
			expect(validateLaunchValues(spec, { ...valid, KINDS: ['b'] })).toEqual({});
			for (const KINDS of [['a', 'z'], 'a', [1], { 0: 'a' }]) {
				expect(validateLaunchValues(spec, { ...valid, KINDS })).toEqual({
					KINDS: 'Pick only from the listed options',
				});
			}
		});
	});

	it('requires a real boolean', () => {
		expect(validateLaunchValues(spec, { ...valid, FLAG: true })).toEqual({});
		for (const FLAG of ['true', 'yes', 1, 0]) {
			expect(validateLaunchValues(spec, { ...valid, FLAG })).toEqual({ FLAG: 'Must be yes or no' });
		}
	});

	it('requires text for text, textarea, path and url inputs', () => {
		expect(validateLaunchValues(spec, { REQ: 5, NOTE: ['a'], DIR: false })).toEqual({
			REQ: 'Enter text',
			NOTE: 'Enter text',
			DIR: 'Enter text',
		});
	});

	describe('backticks', () => {
		it('rejects a backtick in any text value, because it would close the value early', () => {
			const message = 'Cannot contain a backtick';
			expect(validateLaunchValues(spec, { REQ: 'a`b', NOTE: '`', DIR: '/tmp/`x' })).toEqual({
				REQ: message,
				NOTE: message,
				DIR: message,
			});
		});

		it('rejects a backtick inside a select or multiselect value', () => {
			const ticks = specWith(
				{ name: 'ONE', label: 'One', type: 'select', options: [{ value: 'a`b' }] },
				{ name: 'MANY', label: 'Many', type: 'multiselect', options: [{ value: 'a`b' }] }
			);
			expect(validateLaunchValues(ticks, { ONE: 'a`b', MANY: ['a`b'] })).toEqual({
				ONE: 'Cannot contain a backtick',
				MANY: 'Cannot contain a backtick',
			});
		});
	});

	it('ignores values for names the spec does not declare', () => {
		expect(validateLaunchValues(spec, { ...valid, UNDECLARED: '`' })).toEqual({});
	});

	it('does not change the values it is given', () => {
		const values = { REQ: '  x  ', KINDS: ['a'] };
		const snapshot = JSON.parse(JSON.stringify(values));
		validateLaunchValues(spec, values);
		expect(values).toEqual(snapshot);
	});

	it('validates what resolveLaunchValues produced', () => {
		const values = resolveLaunchValues(spec, { REQ: ' hello ', COUNT: 3 });
		expect(validateLaunchValues(spec, values)).toEqual({});
	});
});

// ----------------------------------------------------------------------------
// serializeLaunchValue
// ----------------------------------------------------------------------------

/**
 * Reference copy of serializeDefault() in Maestro-Playbooks scripts/validate-manifest.mjs. The
 * validator promises that launching with every default writes the exact prompt Download ships, so
 * serializeLaunchValue must match it for every input and value. If the validator changes, update
 * this copy and the function together.
 */
function referenceSerializeDefault(input: {
	type: string;
	default?: unknown;
	emptyValue?: string;
	unit?: string;
}): string {
	const value = input.default;
	if (input.type === 'boolean') return value ? 'yes' : 'no';
	if (input.type === 'multiselect') {
		const list = ([] as unknown[]).concat(value);
		return list.length ? list.join(',') : (input.emptyValue ?? '');
	}
	if (input.type === 'number') return `${value}${input.unit ?? ''}`;
	return String(value).replace(/\s*\n\s*/g, ' ');
}

describe('serializeLaunchValue', () => {
	it('writes a boolean as yes or no', () => {
		expect(serializeLaunchValue(inputOf('boolean'), true)).toBe('yes');
		expect(serializeLaunchValue(inputOf('boolean'), false)).toBe('no');
	});

	describe('multiselect', () => {
		const multi = inputOf('multiselect', { options: choices });

		it('joins the picked values with a comma, in the order given', () => {
			expect(serializeLaunchValue(multi, ['a', 'b'])).toBe('a,b');
			expect(serializeLaunchValue(multi, ['b', 'a'])).toBe('b,a');
			expect(serializeLaunchValue(multi, ['a'])).toBe('a');
		});

		it('keeps spaces inside a value', () => {
			expect(serializeLaunchValue(multi, ['VERY HIGH', 'HIGH'])).toBe('VERY HIGH,HIGH');
		});

		it('writes emptyValue when nothing is picked, else nothing', () => {
			expect(serializeLaunchValue({ ...multi, emptyValue: 'none' }, [])).toBe('none');
			expect(serializeLaunchValue(multi, [])).toBe('');
		});

		it('ignores emptyValue when something is picked', () => {
			expect(serializeLaunchValue({ ...multi, emptyValue: 'none' }, ['a'])).toBe('a');
		});
	});

	describe('number', () => {
		it('writes the decimal form', () => {
			expect(serializeLaunchValue(inputOf('number'), 80)).toBe('80');
			expect(serializeLaunchValue(inputOf('number'), 0)).toBe('0');
			expect(serializeLaunchValue(inputOf('number'), 2.5)).toBe('2.5');
			expect(serializeLaunchValue(inputOf('number'), -3)).toBe('-3');
		});

		it('appends the unit when the input has one', () => {
			expect(serializeLaunchValue(inputOf('number', { unit: '%' }), 80)).toBe('80%');
			expect(serializeLaunchValue(inputOf('number', { unit: ' px' }), 44)).toBe('44 px');
		});
	});

	describe('text', () => {
		it.each(['text', 'textarea', 'url', 'path', 'select'] as const)(
			'collapses line breaks to single spaces for %s',
			(type) => {
				const input = inputOf(type);
				expect(serializeLaunchValue(input, 'one\ntwo')).toBe('one two');
				expect(serializeLaunchValue(input, 'one \n  two')).toBe('one two');
				expect(serializeLaunchValue(input, 'one\r\ntwo')).toBe('one two');
				expect(serializeLaunchValue(input, 'one\n\n\ntwo')).toBe('one two');
			}
		);

		it('leaves text with no line break exactly as given', () => {
			const input = inputOf('text');
			expect(serializeLaunchValue(input, 'plain')).toBe('plain');
			expect(serializeLaunchValue(input, '  padded  ')).toBe('  padded  ');
			expect(serializeLaunchValue(input, 'a\rb')).toBe('a\rb');
		});

		it('turns a trailing line break into a space, as the validator does', () => {
			expect(serializeLaunchValue(inputOf('textarea'), 'one\n')).toBe('one ');
		});

		it.each([
			'/Users/pedram/Projects/Maestro/.maestro/playbooks/vault',
			'{{AUTORUN_FOLDER}}/vault',
			'~/Journal',
			'C:\\Users\\me\\Journal',
			'price $& $1 $$',
			'<UNSET - describe the market in three to six words>',
		])('writes %s unchanged', (value) => {
			expect(serializeLaunchValue(inputOf('path'), value)).toBe(value);
		});
	});

	it('matches the validator serializeDefault() for every type and value', () => {
		const cases: Array<[PlaybookLaunchInput['type'], Partial<PlaybookLaunchInput>, unknown]> = [
			['boolean', {}, true],
			['boolean', {}, false],
			['multiselect', { emptyValue: 'none' }, ['hooks', 'statusline']],
			['multiselect', { emptyValue: 'none' }, []],
			['multiselect', {}, []],
			['multiselect', {}, ['VERY HIGH', 'HIGH']],
			['number', {}, 60],
			['number', { unit: '%' }, 90],
			['number', {}, 0],
			['number', {}, 1.25],
			['text', {}, 'system'],
			['text', {}, ''],
			['text', {}, 'two\nlines'],
			['textarea', {}, 'a \r\n b'],
			['textarea', {}, 'trailing\n'],
			['path', {}, '{{AUTORUN_FOLDER}}/vault'],
			['path', {}, '~/bin/voice-memo-journal'],
			['url', {}, 'https://example.com/a?b=c'],
			['select', { options: choices }, 'a'],
		];
		for (const [type, extra, value] of cases) {
			const input = inputOf(type, extra);
			const expected = referenceSerializeDefault({ type, ...extra, default: value });
			expect(serializeLaunchValue(input, value as never), `${type} ${JSON.stringify(value)}`).toBe(
				expected
			);
		}
	});
});

// ----------------------------------------------------------------------------
// applyLaunchInputs
// ----------------------------------------------------------------------------

describe('applyLaunchInputs', () => {
	const PROMPT = [
		'# Title',
		'',
		'**TOPIC:** `<UNSET - name the topic>`',
		'**LIMIT:** `60`',
		'**NOTE:** `<UNSET - optional note>`',
		'**OUT:** `{{AUTORUN_FOLDER}}/vault`',
		'Mid-line: **LIMIT:** `99` is not a configuration line.',
		'**UNDECLARED:** `keep me`',
		'',
		'Body text with `inline code` stays.',
	].join('\n');

	const spec = specWith(
		rawInput({ name: 'TOPIC', required: true }),
		{ name: 'LIMIT', label: 'Limit', type: 'number', default: 60 },
		rawInput({ name: 'NOTE', type: 'textarea' }),
		{ name: 'OUT', label: 'Out', type: 'path', default: '{{AUTORUN_FOLDER}}/vault' },
		{ name: 'FLAG', label: 'Flag', type: 'boolean', default: true }
	);

	const lines = (text: string) => text.split('\n');

	it('rewrites only the backticked value on the matching lines', () => {
		const result = applyLaunchInputs(PROMPT, spec, { TOPIC: 'Edge AI', LIMIT: 25 });
		const expected = lines(PROMPT);
		expected[2] = '**TOPIC:** `Edge AI`';
		expected[3] = '**LIMIT:** `25`';
		expect(lines(result)).toEqual(expected);
	});

	it('leaves a line alone for an input without a value, and for an undeclared name', () => {
		const result = applyLaunchInputs(PROMPT, spec, { LIMIT: 7, UNDECLARED: 'x' });
		const changed = lines(result).filter((line, i) => line !== lines(PROMPT)[i]);
		expect(changed).toEqual(['**LIMIT:** `7`']);
	});

	it('returns the prompt untouched when there is nothing to write', () => {
		expect(applyLaunchInputs(PROMPT, spec, {})).toBe(PROMPT);
		expect(applyLaunchInputs('no config lines here', spec, { TOPIC: 'x' })).toBe(
			'no config lines here'
		);
	});

	it('writes the same prompt back when every input has its default', () => {
		expect(applyLaunchInputs(PROMPT, spec, resolveLaunchValues(spec))).toBe(PROMPT);
	});

	it('does not treat a blank string as a value', () => {
		expect(applyLaunchInputs(PROMPT, spec, { TOPIC: '', NOTE: '   ' })).toBe(PROMPT);
	});

	it('rewrites every line that configures the same name', () => {
		const twice = '**TOPIC:** `a`\ntext\n**TOPIC:** `b`';
		expect(applyLaunchInputs(twice, spec, { TOPIC: 'z' })).toBe(
			'**TOPIC:** `z`\ntext\n**TOPIC:** `z`'
		);
	});

	it('writes a value literally, so $ sequences and template tokens survive', () => {
		const value = "cost $& and $1 and $$ and $' and {{AGENT_PATH}}";
		const result = applyLaunchInputs(PROMPT, spec, { TOPIC: value });
		expect(lines(result)[2]).toBe(`**TOPIC:** \`${value}\``);
	});

	it('serializes by input type: yes or no, emptyValue, units and collapsed line breaks', () => {
		const typed = specWith(
			{ name: 'FLAG', label: 'Flag', type: 'boolean' },
			{ name: 'KINDS', label: 'Kinds', type: 'multiselect', options: choices, emptyValue: 'none' },
			{ name: 'PCT', label: 'Pct', type: 'number', unit: '%' },
			{ name: 'BRIEF', label: 'Brief', type: 'textarea' }
		);
		const prompt = [
			'**FLAG:** `yes`',
			'**KINDS:** `a`',
			'**PCT:** `90%`',
			'**BRIEF:** `<UNSET>`',
		].join('\n');
		const result = applyLaunchInputs(prompt, typed, {
			FLAG: false,
			KINDS: [],
			PCT: 75,
			BRIEF: 'first\nsecond',
		});
		expect(lines(result)).toEqual([
			'**FLAG:** `no`',
			'**KINDS:** `none`',
			'**PCT:** `75%`',
			'**BRIEF:** `first second`',
		]);
	});

	it('fills an empty pair of backticks', () => {
		expect(applyLaunchInputs('**NOTE:** ``', spec, { NOTE: 'filled' })).toBe('**NOTE:** `filled`');
	});

	it('keeps CRLF line endings', () => {
		const prompt = '**TOPIC:** `a`\r\n**LIMIT:** `1`\r\n';
		expect(applyLaunchInputs(prompt, spec, { TOPIC: 'b' })).toBe(
			'**TOPIC:** `b`\r\n**LIMIT:** `1`\r\n'
		);
	});

	it('is idempotent', () => {
		const values = { TOPIC: 'Edge AI', LIMIT: 25, NOTE: 'x' };
		const once = applyLaunchInputs(PROMPT, spec, values);
		expect(applyLaunchInputs(once, spec, values)).toBe(once);
	});

	it('leaves a default that is an absolute path unchanged', () => {
		const vault = '/Users/pedram/Projects/Maestro/.maestro/playbooks/vault';
		const pathSpec = specWith({ name: 'OUT', label: 'Out', type: 'path', default: vault });
		const prompt = `**OUT:** \`${vault}\``;
		expect(applyLaunchInputs(prompt, pathSpec, resolveLaunchValues(pathSpec))).toBe(prompt);
	});
});

// ----------------------------------------------------------------------------
// The shipped Research/Market playbook
// ----------------------------------------------------------------------------

describe('Research/Market prompt', () => {
	const spec = parseSpec(marketLaunch);

	/** Every ``**NAME:** `value` `` line of a prompt, by name (the validator reads the same lines). */
	function configuredValues(prompt: string): Map<string, string> {
		const found = new Map<string, string>();
		for (const match of prompt.matchAll(/^\*\*([A-Z0-9_]+):\*\*\s*`([^`]*)`/gm)) {
			found.set(match[1], match[2]);
		}
		return found;
	}

	it('launches with every default and writes the identical prompt', () => {
		const values = resolveLaunchValues(spec);
		expect(applyLaunchInputs(marketPrompt, spec, values)).toBe(marketPrompt);
	});

	it('keeps the <UNSET ...> placeholders of the inputs that have no default', () => {
		const result = applyLaunchInputs(marketPrompt, spec, resolveLaunchValues(spec));
		const configured = configuredValues(result);
		for (const name of ['MARKET_TOPIC', 'SCOPE_IN', 'SCOPE_OUT', 'DOMAIN_ENTITY', 'SEED_SOURCE']) {
			expect(configured.get(name), name).toMatch(/^<UNSET /);
		}
	});

	it('serializes every default to the value the prompt ships', () => {
		const shipped = configuredValues(marketPrompt);
		const defaults = spec.inputs.filter((input) => input.default !== undefined);
		expect(defaults.length).toBeGreaterThan(0);
		for (const input of defaults) {
			expect(serializeLaunchValue(input, input.default as never), input.name).toBe(
				shipped.get(input.name)
			);
		}
	});

	it('declares an input for the lines it configures, and none the prompt lacks', () => {
		const shipped = configuredValues(marketPrompt);
		expect([...shipped.keys()].sort()).toEqual(spec.inputs.map((input) => input.name).sort());
	});

	it('changes only the lines of the inputs that were answered', () => {
		const values = resolveLaunchValues(spec, {
			MARKET_TOPIC: 'Edge AI chips',
			SCOPE_IN: 'datacenter\ninference',
			OUTPUT_FOLDER: '~/vaults/edge',
			MAX_ENTITIES: 25,
		});
		expect(validateLaunchValues(spec, values)).toEqual({});

		const before = marketPrompt.split('\n');
		const after = applyLaunchInputs(marketPrompt, spec, values).split('\n');
		expect(after).toHaveLength(before.length);
		expect(after.filter((line, i) => line !== before[i])).toEqual([
			'**MARKET_TOPIC:** `Edge AI chips`',
			'**SCOPE_IN:** `datacenter inference`',
			'**OUTPUT_FOLDER:** `~/vaults/edge`',
			'**MAX_ENTITIES:** `25`',
		]);
	});

	it('asks for the market topic and nothing else when launched with defaults', () => {
		expect(validateLaunchValues(spec, resolveLaunchValues(spec))).toEqual({
			MARKET_TOPIC: 'This field is required',
		});
	});
});

// ----------------------------------------------------------------------------
// isLaunchAvailable
// ----------------------------------------------------------------------------

describe('isLaunchAvailable', () => {
	const RUNNING = '0.17.0';
	const MAC = 'darwin';
	const REMOTE_REASON =
		'This playbook drives Maestro through maestro-cli, which is not available on remote agents.';

	/** A playbook entry whose launch block carries the given raw overrides. */
	function launchable(overrides: Raw = {}): Pick<MarketplacePlaybook, 'launch'> {
		return { launch: parseSpec(rawLaunch(overrides)) };
	}

	function withCli(maestroCli: 'required' | 'optional', extra: Raw = {}) {
		return launchable({ preconditions: { maestroCli, ...extra } });
	}

	const localInstalled: PlaybookLaunchTarget = { sshRemote: false, maestroCliInstalled: true };
	const localMissing: PlaybookLaunchTarget = { sshRemote: false, maestroCliInstalled: false };
	const remoteWithCli: PlaybookLaunchTarget = { sshRemote: true, maestroCliInstalled: true };
	const remoteWithoutCli: PlaybookLaunchTarget = { sshRemote: true, maestroCliInstalled: false };

	describe('the launch block', () => {
		it('is unavailable without one, with a reason and no notes', () => {
			expect(isLaunchAvailable({}, RUNNING, MAC)).toEqual({
				available: false,
				reason: 'This playbook does not support Launch.',
				notes: [],
			});
		});

		it('is available with a bare block, with no reason', () => {
			const result = isLaunchAvailable(launchable(), RUNNING, MAC);
			expect(result).toStrictEqual({ available: true, notes: [] });
		});

		it('asks nothing of a bare block on any platform or target', () => {
			const playbook = launchable();
			for (const platform of ['darwin', 'linux', 'win32', 'freebsd']) {
				expect(isLaunchAvailable(playbook, RUNNING, platform).available).toBe(true);
				expect(isLaunchAvailable(playbook, RUNNING, platform, remoteWithoutCli).available).toBe(
					true
				);
			}
		});

		it('returns a fresh notes array on every call', () => {
			const playbook = launchable();
			const first = isLaunchAvailable(playbook, RUNNING, MAC);
			first.notes.push('mutated');
			expect(isLaunchAvailable(playbook, RUNNING, MAC).notes).toEqual([]);
		});
	});

	describe('the launch block minimum version', () => {
		const playbook = launchable({ minMaestroVersion: '0.17.0' });

		it('blocks an older build and names both versions', () => {
			const result = isLaunchAvailable(playbook, '0.16.17', MAC);
			expect(result.available).toBe(false);
			expect(result.reason).toBe('Launch needs Maestro 0.17.0 or newer (this is 0.16.17).');
			expect(result.notes).toEqual([]);
		});

		it('allows the exact version and anything newer', () => {
			expect(isLaunchAvailable(playbook, '0.17.0', MAC).available).toBe(true);
			expect(isLaunchAvailable(playbook, '0.17.1', MAC).available).toBe(true);
			expect(isLaunchAvailable(playbook, '1.0.0', MAC).available).toBe(true);
		});

		it('compares a prerelease tag without regard to case', () => {
			const rc = launchable({ minMaestroVersion: '0.16.17-rc' });
			expect(isLaunchAvailable(rc, '0.16.17-RC', MAC).available).toBe(true);
			expect(isLaunchAvailable(rc, '0.16.16', MAC).available).toBe(false);
		});

		it('fails open on a running or minimum version that is not semver', () => {
			expect(isLaunchAvailable(playbook, 'unknown', MAC).available).toBe(true);
			expect(
				isLaunchAvailable(launchable({ minMaestroVersion: 'soon' }), '0.1.0', MAC).available
			).toBe(true);
		});

		it('reads the block minimum, never the playbook top-level one', () => {
			const topLevelOnly = {
				...launchable(),
				minMaestroVersion: '99.0.0',
			} as Pick<MarketplacePlaybook, 'launch'>;
			expect(isLaunchAvailable(topLevelOnly, '0.1.0', MAC).available).toBe(true);
		});
	});

	describe('platforms', () => {
		it('blocks a platform outside the list and says which are supported', () => {
			const playbook = launchable({ preconditions: { platforms: ['darwin'] } });
			expect(isLaunchAvailable(playbook, RUNNING, 'darwin').available).toBe(true);
			for (const platform of ['linux', 'win32', 'freebsd']) {
				const result = isLaunchAvailable(playbook, RUNNING, platform);
				expect(result.available, platform).toBe(false);
				expect(result.reason, platform).toBe('This playbook runs on macOS only.');
			}
		});

		it('lists every supported platform by its display name, in the order given', () => {
			const two = launchable({ preconditions: { platforms: ['darwin', 'linux'] } });
			expect(isLaunchAvailable(two, RUNNING, 'darwin').available).toBe(true);
			expect(isLaunchAvailable(two, RUNNING, 'linux').available).toBe(true);
			expect(isLaunchAvailable(two, RUNNING, 'win32').reason).toBe(
				'This playbook runs on macOS and Linux only.'
			);

			const all = launchable({ preconditions: { platforms: ['darwin', 'linux', 'win32'] } });
			expect(isLaunchAvailable(all, RUNNING, 'freebsd').reason).toBe(
				'This playbook runs on macOS, Linux and Windows only.'
			);
		});

		it('treats an empty list as no restriction', () => {
			const playbook = launchable({ preconditions: { platforms: [] } });
			expect(isLaunchAvailable(playbook, RUNNING, 'win32').available).toBe(true);
		});
	});

	describe('maestroCli', () => {
		it.each([
			{
				name: 'required, no target yet: not judged, available',
				mode: 'required',
				target: undefined,
				available: true,
				notes: [],
			},
			{
				name: 'required, local, installed: available',
				mode: 'required',
				target: localInstalled,
				available: true,
				notes: [],
			},
			{
				name: 'required, local, not installed: blocked until it is installed',
				mode: 'required',
				target: localMissing,
				available: false,
				reason:
					'This playbook drives Maestro through maestro-cli, which is not installed. Install maestro-cli to launch it.',
			},
			{
				name: 'required, SSH remote: blocked',
				mode: 'required',
				target: remoteWithCli,
				available: false,
				reason: REMOTE_REASON,
			},
			{
				name: 'required, SSH remote, nothing installed here either: blocked for the remote',
				mode: 'required',
				target: remoteWithoutCli,
				available: false,
				reason: REMOTE_REASON,
			},
			{
				name: 'optional, no target yet: available',
				mode: 'optional',
				target: undefined,
				available: true,
				notes: [],
			},
			{
				name: 'optional, local, installed: available, nothing to say',
				mode: 'optional',
				target: localInstalled,
				available: true,
				notes: [],
			},
			{
				name: 'optional, local, not installed: available with a note',
				mode: 'optional',
				target: localMissing,
				available: true,
				notes: [
					'maestro-cli is not installed, so any step that calls it is skipped or uses a fallback.',
				],
			},
			{
				name: 'optional, SSH remote: available with a note',
				mode: 'optional',
				target: remoteWithCli,
				available: true,
				notes: [
					'maestro-cli is not available on remote agents, so any step that calls it is skipped or uses a fallback.',
				],
			},
			{
				name: 'optional, SSH remote, nothing installed here either: the remote note, once',
				mode: 'optional',
				target: remoteWithoutCli,
				available: true,
				notes: [
					'maestro-cli is not available on remote agents, so any step that calls it is skipped or uses a fallback.',
				],
			},
		] as Array<{
			name: string;
			mode: 'required' | 'optional';
			target: PlaybookLaunchTarget | undefined;
			available: boolean;
			reason?: string;
			notes?: string[];
		}>)('$name', ({ mode, target, available, reason, notes }) => {
			const result = isLaunchAvailable(withCli(mode), RUNNING, MAC, target);
			expect(result.available).toBe(available);
			expect(result.reason).toBe(reason);
			expect(result.notes).toEqual(notes ?? []);
		});

		it('ignores the install state and target of a playbook that does not use the CLI', () => {
			const playbook = launchable();
			for (const target of [localInstalled, localMissing, remoteWithCli, remoteWithoutCli]) {
				expect(isLaunchAvailable(playbook, RUNNING, MAC, target)).toStrictEqual({
					available: true,
					notes: [],
				});
			}
		});
	});

	describe('which problem is reported first', () => {
		const everythingWrong = launchable({
			minMaestroVersion: '9.0.0',
			preconditions: { platforms: ['darwin'], maestroCli: 'required' },
		});

		it('puts the version before the platform and the CLI', () => {
			expect(isLaunchAvailable(everythingWrong, RUNNING, 'linux', remoteWithCli).reason).toMatch(
				/^Launch needs Maestro 9\.0\.0/
			);
		});

		it('puts the platform before the CLI', () => {
			const playbook = launchable({
				preconditions: { platforms: ['darwin'], maestroCli: 'required' },
			});
			expect(isLaunchAvailable(playbook, RUNNING, 'linux', remoteWithCli).reason).toBe(
				'This playbook runs on macOS only.'
			);
		});

		it('drops the optional-CLI note when something else blocks the launch', () => {
			const playbook = launchable({
				preconditions: { platforms: ['darwin'], maestroCli: 'optional' },
			});
			expect(isLaunchAvailable(playbook, RUNNING, 'linux', localMissing)).toEqual({
				available: false,
				reason: 'This playbook runs on macOS only.',
				notes: [],
			});
		});
	});

	describe('a macOS-only playbook that drives maestro-cli (Message Bus)', () => {
		const playbook = launchable({
			minMaestroVersion: '0.16.17-rc',
			preconditions: {
				platforms: ['darwin'],
				maestroCli: 'required',
				confirm: 'I understand this turns on Maestro Cue and reads my Messages database.',
			},
		});

		it('launches on a local agent once maestro-cli is installed', () => {
			expect(isLaunchAvailable(playbook, '0.17.0', 'darwin', localInstalled)).toStrictEqual({
				available: true,
				notes: [],
			});
		});

		it('does not launch on Windows, on a remote agent or without the CLI', () => {
			expect(isLaunchAvailable(playbook, '0.17.0', 'win32', localInstalled).available).toBe(false);
			expect(isLaunchAvailable(playbook, '0.17.0', 'darwin', remoteWithCli).reason).toBe(
				REMOTE_REASON
			);
			expect(isLaunchAvailable(playbook, '0.17.0', 'darwin', localMissing).available).toBe(false);
		});
	});
});

// ----------------------------------------------------------------------------
// renderLaunchOutro
// ----------------------------------------------------------------------------

describe('renderLaunchOutro', () => {
	const BUILTINS = { AGENT_NAME: 'Research Bot', AUTORUN_FOLDER: '/work/.maestro/playbooks' };

	/** A parsed spec with the given inputs and a raw outro. */
	function specWithOutro(inputs: Raw[], outro: Raw): PlaybookLaunchSpec {
		return parseSpec(rawLaunch({ inputs, outro: { nextSteps: [], summary: 'Done.', ...outro } }));
	}

	describe('substitution', () => {
		it('fills input values in every outro string', () => {
			const spec = specWithOutro([rawInput({ name: 'TOPIC' })], {
				title: 'Report on {{TOPIC}}',
				summary: 'The report on **{{TOPIC}}** is ready.',
				nextSteps: ['Read the {{TOPIC}} summary.', 'Share it.'],
				files: [{ label: '{{TOPIC}} report', path: '/out/{{TOPIC}}.md' }],
				reportFile: '/out/{{TOPIC}}.md',
			});
			expect(renderLaunchOutro(spec, { TOPIC: 'Edge AI' }, {})).toStrictEqual({
				title: 'Report on Edge AI',
				summary: 'The report on **Edge AI** is ready.',
				nextSteps: ['Read the Edge AI summary.', 'Share it.'],
				files: [{ label: 'Edge AI report', path: '/out/Edge AI.md' }],
				reportFile: '/out/Edge AI.md',
			});
		});

		it('fills the built-ins the caller gives', () => {
			const spec = specWithOutro([], {
				summary: '{{AGENT_NAME}} wrote to {{AUTORUN_FOLDER}}.',
				files: [{ label: 'Log', path: '{{AUTORUN_FOLDER}}/LOG.md' }],
			});
			const outro = renderLaunchOutro(spec, {}, BUILTINS);
			expect(outro.summary).toBe('Research Bot wrote to /work/.maestro/playbooks.');
			expect(outro.files).toEqual([{ label: 'Log', path: '/work/.maestro/playbooks/LOG.md' }]);
		});

		it('matches token names and built-in keys without regard to case', () => {
			const spec = specWithOutro([rawInput({ name: 'TOPIC' })], {
				summary: '{{topic}} by {{Agent_Name}}',
			});
			const outro = renderLaunchOutro(spec, { TOPIC: 'x' }, { agent_name: 'Ann' });
			expect(outro.summary).toBe('x by Ann');
		});

		it('writes each value the way the prompt line carries it', () => {
			const spec = specWithOutro(
				[
					rawInput({ name: 'WIRE', type: 'boolean' }),
					rawInput({ name: 'NO', type: 'boolean' }),
					rawInput({ name: 'LEVELS', type: 'multiselect', options: choices }),
					rawInput({ name: 'NONE', type: 'multiselect', options: choices, emptyValue: 'none' }),
					rawInput({ name: 'COVERAGE', type: 'number', unit: '%' }),
					rawInput({ name: 'LIMIT', type: 'number' }),
					rawInput({ name: 'NOTE', type: 'textarea' }),
				],
				{
					summary: '{{WIRE}}|{{NO}}|{{LEVELS}}|{{NONE}}|{{COVERAGE}}|{{LIMIT}}|{{NOTE}}',
				}
			);
			const outro = renderLaunchOutro(
				spec,
				{
					WIRE: true,
					NO: false,
					LEVELS: ['a', 'b'],
					NONE: [],
					COVERAGE: 80,
					LIMIT: 0,
					NOTE: 'one\ntwo',
				},
				{}
			);
			expect(outro.summary).toBe('yes|no|a,b|none|80%|0|one two');
		});

		it('fills an input that has no value with empty text', () => {
			const spec = specWithOutro([rawInput({ name: 'SCOPE' })], { summary: 'Scope: [{{SCOPE}}]' });
			expect(renderLaunchOutro(spec, {}, {}).summary).toBe('Scope: []');
			expect(renderLaunchOutro(spec, { SCOPE: '   ' }, {}).summary).toBe('Scope: []');
		});

		it('leaves a token that is not an input and not a given built-in as written', () => {
			const spec = specWithOutro([rawInput({ name: 'TOPIC' })], {
				summary: '{{TOPIC}} {{AGENT_NAME}} {{TYPO}}',
			});
			expect(renderLaunchOutro(spec, { TOPIC: 'x' }, {}).summary).toBe('x {{AGENT_NAME}} {{TYPO}}');
		});

		it('ignores a value for a name the spec does not declare', () => {
			const spec = specWithOutro([], { summary: '{{EXTRA}}' });
			expect(renderLaunchOutro(spec, { EXTRA: 'smuggled' }, {}).summary).toBe('{{EXTRA}}');
		});
	});

	describe('built-ins inside a value', () => {
		it('expands them, so an outro path names the folder the run really used', () => {
			const spec = specWithOutro(
				[rawInput({ name: 'OUT', type: 'path', default: '{{AUTORUN_FOLDER}}/vault' })],
				{ summary: 'In `{{OUT}}`.', files: [{ label: 'Index', path: '{{OUT}}/INDEX.md' }] }
			);
			const outro = renderLaunchOutro(spec, resolveLaunchValues(spec), BUILTINS);
			expect(outro.summary).toBe('In `/work/.maestro/playbooks/vault`.');
			expect(outro.files[0].path).toBe('/work/.maestro/playbooks/vault/INDEX.md');
		});

		it('leaves one the caller did not give, as the run would have', () => {
			const spec = specWithOutro(
				[rawInput({ name: 'OUT', type: 'path', default: '{{AUTORUN_FOLDER}}/vault' })],
				{ summary: '{{OUT}}' }
			);
			expect(renderLaunchOutro(spec, resolveLaunchValues(spec), {}).summary).toBe(
				'{{AUTORUN_FOLDER}}/vault'
			);
		});

		it('does not expand an input token inside another input value', () => {
			const spec = specWithOutro([rawInput({ name: 'A' }), rawInput({ name: 'B' })], {
				summary: '{{A}}|{{B}}',
			});
			expect(renderLaunchOutro(spec, { A: '{{B}}', B: 'bee' }, {}).summary).toBe('{{B}}|bee');
		});

		it('inserts $ sequences in a value as typed', () => {
			const spec = specWithOutro([rawInput({ name: 'TOPIC' })], { summary: '[{{TOPIC}}]' });
			expect(renderLaunchOutro(spec, { TOPIC: 'cost $& or $1 or $$' }, {}).summary).toBe(
				'[cost $& or $1 or $$]'
			);
		});

		it('lets a built-in win over an input that shares its name', () => {
			// parseLaunchSpec rejects such a spec; a hand-built one must still render predictably.
			const spec = {
				inputs: [{ name: 'AGENT_NAME', label: 'Name', type: 'text' }],
				outro: { summary: '{{AGENT_NAME}}', nextSteps: [] },
			} as PlaybookLaunchSpec;
			expect(renderLaunchOutro(spec, { AGENT_NAME: 'typed' }, { AGENT_NAME: 'real' }).summary).toBe(
				'real'
			);
		});
	});

	describe('the result', () => {
		it('omits the title and the report file when the spec has none, and lists no files', () => {
			const spec = specWithOutro([], { summary: 'Done.', nextSteps: ['Next.'] });
			expect(renderLaunchOutro(spec, {}, {})).toStrictEqual({
				summary: 'Done.',
				nextSteps: ['Next.'],
				files: [],
			});
		});

		it('keeps next steps and files in their order', () => {
			const spec = specWithOutro([], {
				nextSteps: ['one', 'two', 'three'],
				files: [
					{ label: 'B', path: '/b' },
					{ label: 'A', path: '/a' },
				],
			});
			const outro = renderLaunchOutro(spec, {}, {});
			expect(outro.nextSteps).toEqual(['one', 'two', 'three']);
			expect(outro.files.map((file) => file.label)).toEqual(['B', 'A']);
		});

		it('changes neither the spec nor the values nor the built-ins', () => {
			const spec = specWithOutro([rawInput({ name: 'TOPIC' })], {
				title: '{{TOPIC}}',
				summary: '{{TOPIC}} {{AGENT_NAME}}',
				nextSteps: ['{{TOPIC}}'],
				files: [{ label: '{{TOPIC}}', path: '/{{TOPIC}}' }],
			});
			const values = { TOPIC: 'x' };
			const before = JSON.stringify([spec, values, BUILTINS]);
			renderLaunchOutro(spec, values, BUILTINS);
			expect(JSON.stringify([spec, values, BUILTINS])).toBe(before);
		});
	});

	describe('the shipped Research/Market outro', () => {
		const spec = parseSpec(marketLaunch);
		const builtins = { AUTORUN_FOLDER: '/runs/playbooks', AGENT_NAME: 'Research Bot' };

		it('names the topic and the vault folder the run wrote to', () => {
			const values = resolveLaunchValues(spec, { MARKET_TOPIC: 'Edge AI chips' });
			expect(renderLaunchOutro(spec, values, builtins)).toStrictEqual({
				title: 'Market vault is ready',
				summary:
					'The vault on **Edge AI chips** is in `/runs/playbooks/vault`. Open the folder in Obsidian, or browse it in the Document Graph.',
				nextSteps: [
					'Start with `INDEX.md` and `Resources/Market Map.md`.',
					'Keep or reject the cards in `Resources/Relevance Review.md`.',
					'Keep it current with `/health-check`, `/scope-audit` and `/research <entity>`.',
				],
				files: [
					{ label: 'Index', path: '/runs/playbooks/vault/INDEX.md' },
					{ label: 'Market map', path: '/runs/playbooks/vault/Resources/Market Map.md' },
					{
						label: 'Relevance review',
						path: '/runs/playbooks/vault/Resources/Relevance Review.md',
					},
				],
				reportFile: '/runs/playbooks/vault/INDEX.md',
			});
		});

		it('follows a vault folder the user chose', () => {
			const values = resolveLaunchValues(spec, {
				MARKET_TOPIC: 'Edge AI chips',
				OUTPUT_FOLDER: '~/vaults/edge',
			});
			const outro = renderLaunchOutro(spec, values, builtins);
			expect(outro.reportFile).toBe('~/vaults/edge/INDEX.md');
			expect(outro.files.map((file) => file.path)).toEqual([
				'~/vaults/edge/INDEX.md',
				'~/vaults/edge/Resources/Market Map.md',
				'~/vaults/edge/Resources/Relevance Review.md',
			]);
		});

		it('leaves no template syntax behind once the topic and folder are known', () => {
			const values = resolveLaunchValues(spec, { MARKET_TOPIC: 'Edge AI chips' });
			expect(JSON.stringify(renderLaunchOutro(spec, values, builtins))).not.toContain('{{');
		});
	});
});
