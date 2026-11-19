/**
 * @file playbook-params.test.ts
 * @description The CLI's playbook parameter input: `--param` / `--params-file`
 * parsing, the answer layering a headless run uses, the undeclared-name and
 * validation refusals, and the cleanup of Maestro's missing-parameters halt
 * marker that `playbook configure --set` performs, and the writing of that
 * marker when an automation run lacks answers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	PlaybookParamInputError,
	checkParamAnswers,
	mergeParamValues,
	parseParamAssignments,
	readParamsFile,
	reportPlaybookParams,
	resolveRunParams,
	stripMissingParamsHaltMarkersFromPlaybook,
	writeMissingParamsHaltMarker,
} from '../../../cli/services/playbook-params';
import { buildMissingParamsHaltMarker } from '../../../shared/autorunMarkers';
import { resolvePlaybookParamSpecs } from '../../../shared/playbookParams';
import type { Playbook } from '../../../shared/types';

const PROMPT = [
	'<!-- CONFIGURE: The pull request to review -->',
	'**PR_URL:** `https://github.com/OWNER/REPO/pull/XXX`',
	'',
	'<!-- CONFIGURE: How many items to process -->',
	'**MAX_ITEMS:** `25`',
].join('\n');

function playbook(overrides: Partial<Playbook> = {}): Playbook {
	return {
		id: 'pb-1',
		name: 'Review',
		createdAt: 0,
		updatedAt: 0,
		documents: [{ filename: 'first', resetOnCompletion: false }],
		loopEnabled: false,
		prompt: PROMPT,
		...overrides,
	};
}

let tmp: string;
beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-playbook-params-'));
});
afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseParamAssignments', () => {
	it('splits on the first = and keeps the value verbatim', () => {
		expect(parseParamAssignments(['PR_URL=https://x.test/?a=1', 'MAX_ITEMS='], '--param')).toEqual({
			PR_URL: 'https://x.test/?a=1',
			MAX_ITEMS: '',
		});
	});

	it.each(['PR_URL', '=value', 'pr_url=1', 'A=1'])('refuses %s', (entry) => {
		expect(() => parseParamAssignments([entry], '--param')).toThrow(PlaybookParamInputError);
	});
});

describe('readParamsFile', () => {
	it('reads a JSON object, turning numbers and booleans into text', () => {
		const file = path.join(tmp, 'params.json');
		fs.writeFileSync(file, JSON.stringify({ MAX_ITEMS: 5, DRY: true, PR_URL: 'https://x.test/1' }));
		expect(readParamsFile(file)).toEqual({
			MAX_ITEMS: '5',
			DRY: 'true',
			PR_URL: 'https://x.test/1',
		});
	});

	it.each([
		['not JSON', '{'],
		['an array', '["A"]'],
		['a nested value', '{"MAX_ITEMS":{"n":1}}'],
		['an illegal name', '{"max":"1"}'],
	])('refuses a file holding %s', (_label, text) => {
		const file = path.join(tmp, 'params.json');
		fs.writeFileSync(file, text);
		expect(() => readParamsFile(file)).toThrow(PlaybookParamInputError);
	});

	it('refuses a file that does not exist', () => {
		expect(() => readParamsFile(path.join(tmp, 'missing.json'))).toThrow(/cannot read/);
	});
});

describe('checkParamAnswers', () => {
	const specs = resolvePlaybookParamSpecs(PROMPT, [{ name: 'MAX_ITEMS', type: 'number', min: 1 }]);

	it('names an undeclared parameter and the declared ones', () => {
		expect(checkParamAnswers(specs, { MAX_ITEM: '3' })).toEqual([
			'MAX_ITEM is not a parameter of this playbook (declared: PR_URL, MAX_ITEMS).',
		]);
	});

	it('reports a value its spec refuses, and skips a blank (clearing) answer', () => {
		expect(checkParamAnswers(specs, { MAX_ITEMS: '0', PR_URL: '' })).toEqual([
			'MAX_ITEMS must be at least 1.',
		]);
	});
});

describe('mergeParamValues', () => {
	it('lets later layers win and a blank answer remove the name', () => {
		expect(mergeParamValues({ A_A: '1', B_B: '2' }, { B_B: '3' }, { A_A: ' ' })).toEqual({
			B_B: '3',
		});
	});
});

describe('resolveRunParams', () => {
	it('reports the required parameter with only a placeholder default as missing', () => {
		const result = resolveRunParams(playbook(), {});
		expect(result.missing.map((spec) => spec.name)).toEqual(['PR_URL']);
	});

	it('layers saved answers, then --params-file, then --param', () => {
		const file = path.join(tmp, 'params.json');
		fs.writeFileSync(file, JSON.stringify({ PR_URL: 'https://x.test/file', MAX_ITEMS: '9' }));
		const result = resolveRunParams(
			playbook({ parameterValues: { PR_URL: 'https://x.test/saved', MAX_ITEMS: '3' } }),
			{ paramsFile: file, param: ['PR_URL=https://x.test/flag'] }
		);
		expect(result.values).toEqual({ PR_URL: 'https://x.test/flag', MAX_ITEMS: '9' });
		expect(result.missing).toEqual([]);
	});

	it('refuses a --param for a name the playbook does not declare', () => {
		expect(() => resolveRunParams(playbook(), { param: ['PR_LINK=https://x.test'] })).toThrow(
			/PR_LINK is not a parameter/
		);
	});
});

describe('reportPlaybookParams', () => {
	it('lists each spec with its saved answer or default', () => {
		const specs = resolvePlaybookParamSpecs(PROMPT, undefined);
		expect(reportPlaybookParams(specs, { PR_URL: 'https://x.test/1' })).toEqual([
			{
				name: 'PR_URL',
				type: 'string',
				required: true,
				help: 'The pull request to review',
				value: 'https://x.test/1',
			},
			{
				name: 'MAX_ITEMS',
				type: 'string',
				required: false,
				help: 'How many items to process',
				default: '25',
			},
		]);
	});
});

describe('stripMissingParamsHaltMarkersFromPlaybook', () => {
	it("removes Maestro's marker, keeps other halts, and skips absent documents", () => {
		const marker = buildMissingParamsHaltMarker(['PR_URL']);
		fs.writeFileSync(path.join(tmp, 'first.md'), `${marker}\n# First\n- [ ] task\n`);
		fs.writeFileSync(path.join(tmp, 'second.md'), '<!-- maestro:halt: build broken -->\n');
		const cleared = stripMissingParamsHaltMarkersFromPlaybook(tmp, {
			documents: [
				{ filename: 'first', resetOnCompletion: false },
				{ filename: 'second', resetOnCompletion: false },
				{ filename: 'absent', resetOnCompletion: false },
			],
		});
		expect(cleared).toEqual(['first']);
		expect(fs.readFileSync(path.join(tmp, 'first.md'), 'utf-8')).toBe('# First\n- [ ] task\n');
		expect(fs.readFileSync(path.join(tmp, 'second.md'), 'utf-8')).toBe(
			'<!-- maestro:halt: build broken -->\n'
		);
	});
});

describe('writeMissingParamsHaltMarker', () => {
	const docs = {
		documents: [
			{ filename: 'first', resetOnCompletion: false },
			{ filename: 'second', resetOnCompletion: false },
		],
	};

	it('marks only the first document, and configuring removes the marker again', () => {
		fs.writeFileSync(path.join(tmp, 'first.md'), '# First\n- [ ] task\n');
		fs.writeFileSync(path.join(tmp, 'second.md'), '# Second\n');

		expect(writeMissingParamsHaltMarker(tmp, docs, ['PR_URL'])).toBe('first');

		const marked = fs.readFileSync(path.join(tmp, 'first.md'), 'utf-8');
		expect(marked).toBe(`# First\n- [ ] task\n\n${buildMissingParamsHaltMarker(['PR_URL'])}\n`);
		expect(fs.readFileSync(path.join(tmp, 'second.md'), 'utf-8')).toBe('# Second\n');

		expect(stripMissingParamsHaltMarkersFromPlaybook(tmp, docs)).toEqual(['first']);
		expect(fs.readFileSync(path.join(tmp, 'first.md'), 'utf-8')).toBe('# First\n- [ ] task\n');
	});

	it('replaces an earlier marker instead of stacking a second one', () => {
		fs.writeFileSync(path.join(tmp, 'first.md'), '# First\n');
		writeMissingParamsHaltMarker(tmp, docs, ['PR_URL', 'MAX_ITEMS']);
		writeMissingParamsHaltMarker(tmp, docs, ['PR_URL']);

		const content = fs.readFileSync(path.join(tmp, 'first.md'), 'utf-8');
		expect(content.match(/maestro:halt/g)).toHaveLength(1);
		expect(content).toContain(buildMissingParamsHaltMarker(['PR_URL']));
	});

	it('returns null when the first document is absent or there are no documents', () => {
		expect(writeMissingParamsHaltMarker(tmp, docs, ['PR_URL'])).toBeNull();
		expect(writeMissingParamsHaltMarker(tmp, { documents: [] }, ['PR_URL'])).toBeNull();
	});
});
