/**
 * @file launchInputs.test.ts
 * @description Playbook Launch on the CLI: `--input` and `--input-file` parsing, the field error
 * lines, the launch spec text for `marketplace show`, and the status text for `launch-status`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	collectLaunchAnswers,
	describeLaunchSpec,
	formatFieldErrors,
	formatLaunchStatus,
	parseInputFlags,
	readLaunchInputFile,
} from '../../../cli/utils/launchInputs';
import type { PlaybookLaunchSpec } from '../../../shared/marketplace-types';
import { createMockLaunchRecord } from '../../helpers';

const SPEC: PlaybookLaunchSpec = {
	preconditions: { platforms: ['darwin'], requires: ['gh logged in'], confirm: 'I understand' },
	inputs: [
		{ name: 'PR_URL', label: 'Pull request', type: 'url', required: true },
		{ name: 'MAX_LOC', label: 'Max LOC', type: 'number', default: 500, advanced: true },
		{ name: 'WIRE_ALIAS', label: 'Wire alias', type: 'boolean', default: true },
		{
			name: 'SEVERITY',
			label: 'Severity',
			type: 'multiselect',
			default: ['HIGH'],
			options: [{ value: 'HIGH' }, { value: 'LOW' }],
		},
		{ name: 'NOTES', label: 'Notes', type: 'text', help: 'Anything extra' },
	],
	outro: { summary: 'Done for {{PR_URL}}.', nextSteps: ['Review it'] },
};

describe('parseInputFlags', () => {
	it('types each value by its input and splits only at the first =', () => {
		expect(
			parseInputFlags(SPEC, [
				'PR_URL=https://example.com/pr/1?a=b',
				'MAX_LOC=80',
				'WIRE_ALIAS=no',
				'SEVERITY=HIGH, LOW',
				'NOTES=',
			])
		).toEqual({
			PR_URL: 'https://example.com/pr/1?a=b',
			MAX_LOC: 80,
			WIRE_ALIAS: false,
			SEVERITY: ['HIGH', 'LOW'],
			NOTES: '',
		});
	});

	it('reads a number that is not a number as NaN, which validation refuses', () => {
		expect(parseInputFlags(SPEC, ['MAX_LOC=lots']).MAX_LOC).toBeNaN();
		expect(parseInputFlags(SPEC, ['MAX_LOC=']).MAX_LOC).toBeNaN();
	});

	it('lists every problem at once: a missing =, an unknown input, a bad boolean', () => {
		expect(() => parseInputFlags(SPEC, ['PR_URL', 'NOPE=1', 'WIRE_ALIAS=maybe'])).toThrow(
			/Invalid --input "PR_URL"[\s\S]*Unknown input "NOPE"[\s\S]*WIRE_ALIAS expects true or false/
		);
	});

	it('names the inputs the playbook does take when one is unknown', () => {
		expect(() => parseInputFlags(SPEC, ['NOPE=1'])).toThrow(/takes: PR_URL, MAX_LOC/);
		expect(() => parseInputFlags({ ...SPEC, inputs: [] }, ['NOPE=1'])).toThrow(/takes: \(none\)/);
	});
});

describe('readLaunchInputFile and collectLaunchAnswers', () => {
	const dirs: string[] = [];
	function writeInput(content: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-inputs-'));
		dirs.push(dir);
		const file = path.join(dir, 'inputs.json');
		fs.writeFileSync(file, content);
		return file;
	}
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reads a JSON object of already-typed values', () => {
		const file = writeInput('{"MAX_LOC": 90, "SEVERITY": ["LOW"]}');
		expect(readLaunchInputFile(SPEC, file)).toEqual({ MAX_LOC: 90, SEVERITY: ['LOW'] });
	});

	it('refuses a missing file, bad JSON, a non-object and an unknown input', () => {
		expect(() => readLaunchInputFile(SPEC, path.join(os.tmpdir(), 'no-such-launch.json'))).toThrow(
			/Cannot read --input-file/
		);
		expect(() => readLaunchInputFile(SPEC, writeInput('{oops'))).toThrow(/Cannot read/);
		expect(() => readLaunchInputFile(SPEC, writeInput('[1]'))).toThrow(/must hold a JSON object/);
		expect(() => readLaunchInputFile(SPEC, writeInput('{"NOPE": 1}'))).toThrow(
			/Unknown input "NOPE"/
		);
	});

	it('lets a --input flag override the file', () => {
		const file = writeInput('{"MAX_LOC": 90, "NOTES": "from file"}');
		expect(collectLaunchAnswers(SPEC, { inputFile: file, input: ['MAX_LOC=10'] })).toEqual({
			MAX_LOC: 10,
			NOTES: 'from file',
		});
	});
});

describe('formatFieldErrors', () => {
	it('prints each failing input in the order the spec declares them', () => {
		expect(
			formatFieldErrors(SPEC, { NOTES: 'Enter text', PR_URL: 'This field is required' })
		).toEqual(['PR_URL: This field is required', 'NOTES: Enter text']);
	});
});

describe('describeLaunchSpec', () => {
	it('says a playbook without a launch block is download only', () => {
		expect(describeLaunchSpec(undefined)).toEqual([
			'Launch: download only (this playbook has no launch support)',
		]);
	});

	it('lists preconditions and each input with type, required, default and options', () => {
		const text = describeLaunchSpec(SPEC).join('\n');
		expect(text).toContain('Platforms: darwin');
		expect(text).toContain('Requires: gh logged in');
		expect(text).toContain('Confirmation needed (pass --confirm): I understand');
		expect(text).toContain('PR_URL  (url, required)');
		expect(text).toContain('MAX_LOC  (number, optional, default 500, advanced)');
		expect(text).toContain('SEVERITY  (multiselect, optional, default HIGH)');
		expect(text).toContain('options: HIGH, LOW');
		expect(text).toContain('Notes: Anything extra');
	});

	it('says a launch with no inputs takes only the agent', () => {
		expect(describeLaunchSpec({ ...SPEC, inputs: [], preconditions: undefined })).toContain(
			'  Inputs: none (launch takes only the agent)'
		);
	});
});

describe('formatLaunchStatus', () => {
	it('prints only the numbers-so-far for a run that is still going', () => {
		const lines = formatLaunchStatus(createMockLaunchRecord(), undefined);
		expect(lines.join('\n')).toContain('Status:   Still running.');
		expect(lines.join('\n')).not.toContain('Mapped the market.');
	});

	it('prints the outro, filled from the record, once the run ended', () => {
		const lines = formatLaunchStatus(
			createMockLaunchRecord({
				status: 'completed',
				cleanup: 'done',
				completion: { completedTasks: 3, totalTasks: 3, elapsedTimeMs: 65_000, wasStopped: false },
				spec: {
					inputs: [{ name: 'TOPIC', label: 'Topic', type: 'text' }],
					outro: {
						summary: 'Mapped {{TOPIC}}.',
						nextSteps: ['Open the index'],
						files: [{ label: 'Index', path: '/v/INDEX.md' }],
					},
				},
				values: { TOPIC: 'fintech' },
			}),
			undefined
		).join('\n');
		expect(lines).toContain('Status:   Completed');
		expect(lines).toContain('Mapped fintech.');
		expect(lines).toContain('Next steps:\n  - Open the index');
		expect(lines).toContain('Index: /v/INDEX.md');
		expect(lines).toContain('Cleanup: the task documents were removed.');
	});
});
