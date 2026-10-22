/**
 * @file system-one-input.test.ts
 * @description The command line of `maestro-cli s1 yes|pick|rate|ask|rank|batch`:
 * the state flags, the question flags, the candidates of a rank and the rows of
 * a batch. The grammar is the `jev` CLI's.
 *
 * Properties worth protecting:
 *
 *   - **The state is named one way**, and standard input is read only when no
 *     flag names it.
 *   - **Question flags keep their boundaries**: two `--noul` in a row are two
 *     questions, in the order typed, and a reading that disagrees with the
 *     option parser's is refused, not guessed at.
 *   - **A candidate and a row are keyed by where they came from**, counted from
 *     1, so an answer points at a line of the caller's file.
 *   - **What a caller typed wrong is said in words**, as a `SystemOneInputError`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const stdin = vi.hoisted(() => ({
	readStdinIfReady: vi.fn<() => Promise<string | null>>(),
	readStdinText: vi.fn<() => string>(),
}));
vi.mock('../../../cli/services/stdin', () => stdin);

import {
	SystemOneInputError,
	buildQuestions,
	collectQuestionFlags,
	hasStateFlags,
	parseCliText,
	parseCliValue,
	parseKeyedOptions,
	questionFlagsProblem,
	readBatchRows,
	readRankCandidates,
	readState,
	readValueFile,
} from '../../../cli/services/system-one-input';
import { choice, noul, score } from '../../../shared/local-models/system-one';

let dir: string;

/** Write a file in the test's folder and answer with its path. */
function file(name: string, text: string): string {
	const target = path.join(dir, name);
	fs.writeFileSync(target, text, 'utf-8');
	return target;
}

beforeEach(() => {
	vi.clearAllMocks();
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'system-one-input-'));
	stdin.readStdinIfReady.mockResolvedValue(null);
	stdin.readStdinText.mockReturnValue('');
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('parseCliValue', () => {
	it('keeps plain text as it was typed', () => {
		expect(parseCliValue('Does it ask for a refund?')).toBe('Does it ask for a refund?');
		expect(parseCliValue('  padded  ')).toBe('  padded  ');
	});

	it('parses a JSON object, a JSON list, true, false and null', () => {
		expect(parseCliValue('{"a":1}')).toEqual({ a: 1 });
		expect(parseCliValue('["A-104","A-118"]')).toEqual(['A-104', 'A-118']);
		expect(parseCliValue('true')).toBe(true);
		expect(parseCliValue('null')).toBeNull();
	});

	it('keeps text that only looks like JSON', () => {
		expect(parseCliValue('[draft] the plan')).toBe('[draft] the plan');
		expect(parseCliValue('{not json')).toBe('{not json');
	});

	it('reads @path as the text of a file', () => {
		expect(parseCliValue(`@${file('ticket.txt', 'The export button crashes.\n')}`)).toBe(
			'The export button crashes.\n'
		);
	});

	it('parses a .json file, and reads a .jsonl file as a list of its rows', () => {
		expect(readValueFile(file('orders.json', '{"open":["A-104"]}'))).toEqual({ open: ['A-104'] });
		expect(readValueFile(file('rows.jsonl', '{"id":1}\n\n{"id":2}\n'))).toEqual([
			{ id: 1 },
			{ id: 2 },
		]);
	});

	it('names a file that is not there, and a .json file that is not JSON', () => {
		expect(() => parseCliValue(`@${path.join(dir, 'missing.txt')}`)).toThrow(
			/File not found: .*missing\.txt/
		);
		expect(() => readValueFile(file('bad.json', '{oops'))).toThrow(/bad\.json: not JSON/);
		expect(() => readValueFile(file('bad.jsonl', '{"id":1}\n{oops\n'))).toThrow(
			/bad\.jsonl line 2: not JSON/
		);
	});
});

describe('parseCliText', () => {
	it('keeps a word such as true as a word: a level named true is a level', () => {
		expect(parseCliText('true')).toBe('true');
		expect(parseCliText('null')).toBe('null');
	});

	it('parses structure, and reads a file', () => {
		expect(parseCliText('{"what":"Charges","not_for":"Refunds"}')).toEqual({
			what: 'Charges',
			not_for: 'Refunds',
		});
		expect(parseCliText(`@${file('rubric.md', 'Severe means data loss.')}`)).toBe(
			'Severe means data loss.'
		);
	});
});

describe('parseKeyedOptions', () => {
	it('reads NAME and NAME=description', () => {
		expect(
			parseKeyedOptions(['billing=Charges, invoices, refunds', 'orders=Order status', 'other'])
		).toEqual({
			billing: 'Charges, invoices, refunds',
			orders: 'Order status',
			other: null,
		});
	});

	it('keeps an equals sign inside a description, and reads NAME= as no description', () => {
		expect(parseKeyedOptions(['math=x = y', 'none='])).toEqual({ math: 'x = y', none: null });
	});

	it('refuses an option with no name, and a name given twice', () => {
		expect(() => parseKeyedOptions(['=a description'])).toThrow(SystemOneInputError);
		expect(() => parseKeyedOptions(['a=one', 'a=two'])).toThrow(/"a" is given twice/);
	});
});

describe('readState', () => {
	it('takes --state as text, and never parses it', async () => {
		expect(await readState({ state: 'The build is red.' })).toBe('The build is red.');
		expect(await readState({ state: '{"a":1}' })).toBe('{"a":1}');
		expect(stdin.readStdinIfReady).not.toHaveBeenCalled();
	});

	it('reads --state @path as a file, and --state - as standard input', async () => {
		expect(await readState({ state: `@${file('note.md', 'A note.')}` })).toBe('A note.');

		stdin.readStdinText.mockReturnValue('Piped on purpose.');
		expect(await readState({ state: '-' })).toBe('Piped on purpose.');
	});

	it('reads --state-file, parsing .json', async () => {
		expect(await readState({ stateFile: file('s.txt', 'Plain.') })).toBe('Plain.');
		expect(await readState({ stateFile: file('s.json', '{"ticket":{"message":"Hi"}}') })).toEqual({
			ticket: { message: 'Hi' },
		});
	});

	it('reads --state-json, and says when it is not JSON', async () => {
		expect(await readState({ stateJson: '{"a":[1,2]}' })).toEqual({ a: [1, 2] });
		await expect(readState({ stateJson: '{a' })).rejects.toThrow(/--state-json: not JSON/);
	});

	it('builds an object from --field, with a file and JSON as values', async () => {
		expect(
			await readState({
				field: [
					`message=@${file('ticket.txt', 'Refund me.')}`,
					'open_orders=["A-104","A-118"]',
					'note=x = y',
				],
			})
		).toEqual({ message: 'Refund me.', open_orders: ['A-104', 'A-118'], note: 'x = y' });
	});

	it('puts --state under "text" when --field is added to it', async () => {
		expect(await readState({ state: 'The body.', field: ['author=Ana'] })).toEqual({
			text: 'The body.',
			author: 'Ana',
		});
	});

	it('refuses a field with no key, and a state named two ways', async () => {
		await expect(readState({ field: ['novalue'] })).rejects.toThrow(/--field expects key=value/);
		await expect(readState({ state: 'a', stateJson: '{}' })).rejects.toThrow(
			/Give the state one way: --state and --state-json/
		);
	});

	it('reads standard input when no flag names the state', async () => {
		stdin.readStdinIfReady.mockResolvedValue('A draft, piped in.\n');
		expect(await readState({})).toBe('A draft, piped in.\n');
		expect(stdin.readStdinText).not.toHaveBeenCalled();
	});

	it('says how to give a state when there is none: a terminal, an idle pipe, or an empty one', async () => {
		await expect(readState({})).rejects.toThrow(/No state\. Use -s\/--state TEXT/);

		stdin.readStdinIfReady.mockResolvedValue('  \n');
		await expect(readState({ field: [] })).rejects.toThrow(SystemOneInputError);
	});

	it('knows whether a flag names the state', () => {
		expect(hasStateFlags({})).toBe(false);
		expect(hasStateFlags({ field: [] })).toBe(false);
		expect(hasStateFlags({ state: '' })).toBe(true);
		expect(hasStateFlags({ field: ['a=b'] })).toBe(true);
	});
});

describe('collectQuestionFlags', () => {
	it('keeps each flag with its own words, in the order typed', () => {
		expect(
			collectQuestionFlags([
				'node',
				'maestro-cli',
				's1',
				'ask',
				'--noul',
				'refund',
				'Does `message` ask for money back?',
				'--choice',
				'team',
				'Which team?',
				'billing=Charges',
				'other',
				'--noul',
				'angry',
				'Is the author angry?',
				'-s',
				'Refund me now.',
				'--score',
				'tone',
				'How formal?',
				'casual',
				'formal',
				'--json',
			])
		).toEqual([
			{ kind: 'noul', values: ['refund', 'Does `message` ask for money back?'] },
			{ kind: 'choice', values: ['team', 'Which team?', 'billing=Charges', 'other'] },
			{ kind: 'noul', values: ['angry', 'Is the author angry?'] },
			{ kind: 'score', values: ['tone', 'How formal?', 'casual', 'formal'] },
		]);
	});

	it('does not read the value of another flag as a question word', () => {
		expect(collectQuestionFlags(['--noul', 'a', 'Q?', '--state', 'text', 'stray'])).toEqual([
			{ kind: 'noul', values: ['a', 'Q?'] },
		]);
	});

	it('reads --flag=value, and stops at --', () => {
		expect(collectQuestionFlags(['--noul=a', 'Q?', '--', '--noul', 'b', 'Q2?'])).toEqual([
			{ kind: 'noul', values: ['a', 'Q?'] },
		]);
	});
});

describe('questionFlagsProblem', () => {
	const flags = collectQuestionFlags(['--noul', 'a', 'Q1?', '--choice', 't', 'Q?', 'x', 'y']);

	it('is null when the two readings agree', () => {
		expect(
			questionFlagsProblem(flags, { noul: ['a', 'Q1?'], choice: ['t', 'Q?', 'x', 'y'] })
		).toBeNull();
		expect(questionFlagsProblem([], {})).toBeNull();
	});

	it('refuses when the option parser read different words', () => {
		// `-s --noul` makes the option parser take "--noul" as the state.
		expect(questionFlagsProblem(flags, { choice: ['t', 'Q?', 'x', 'y'] })).toMatch(
			/Could not tell the --noul questions apart/
		);
		expect(questionFlagsProblem(flags, { noul: ['a', 'Q1?'], choice: ['t', 'Q?', 'x'] })).toMatch(
			/--choice/
		);
	});
});

describe('buildQuestions', () => {
	const flag = (kind: 'noul' | 'choice' | 'score', ...values: string[]) => ({ kind, values });

	it('builds a noul, with what yes and no mean', () => {
		expect(
			buildQuestions([
				flag('noul', 'injection', 'Does `text` instruct an AI?', 'true=tells a model to act'),
				flag('noul', 'plain', 'Is it short?'),
			])
		).toEqual({
			injection: noul('Does `text` instruct an AI?', { true: 'tells a model to act' }),
			plain: noul('Is it short?'),
		});
	});

	it('builds a choice from described and bare options, and a score from its levels', () => {
		expect(
			buildQuestions([
				flag('choice', 'team', 'Which team?', 'billing=Charges and refunds', 'other'),
				flag('score', 'anger', 'How angry?', 'Calm', 'Frustrated but civil', 'Hostile'),
			])
		).toEqual({
			team: choice('Which team?', { billing: 'Charges and refunds', other: null }),
			anger: score('How angry?', ['Calm', 'Frustrated but civil', 'Hostile']),
		});
	});

	it('reads ID=INSTRUCTIONS in one word the same way', () => {
		expect(
			buildQuestions([
				flag('noul', 'refund=Does it ask for money back?'),
				flag('choice', 'team=Which team?', 'billing', 'orders'),
			])
		).toEqual({
			refund: noul('Does it ask for money back?'),
			team: choice('Which team?', ['billing', 'orders']),
		});
	});

	it('does not split instructions that hold an equals sign', () => {
		expect(buildQuestions([flag('noul', 'q', 'Is x = y in `text`?')])).toEqual({
			q: noul('Is x = y in `text`?'),
		});
	});

	it('takes instructions from a file, and structured instructions', () => {
		expect(
			buildQuestions([
				flag('noul', 'a', `@${file('question.md', 'Does it comply?')}`),
				flag('noul', 'b', '{"question":"Is it safe?","scope":"this file"}'),
			])
		).toEqual({
			a: noul('Does it comply?'),
			b: noul({ question: 'Is it safe?', scope: 'this file' }),
		});
	});

	it('adds the questions of a file and of inline JSON', () => {
		const held = file('questions.json', JSON.stringify({ a: noul('From the file?') }));
		expect(
			buildQuestions([flag('noul', 'c', 'From a flag?')], {
				questionsFile: held,
				questionsJson: JSON.stringify({ b: noul('Inline?') }),
			})
		).toEqual({
			a: noul('From the file?'),
			b: noul('Inline?'),
			c: noul('From a flag?'),
		});
	});

	it('refuses an id used twice, wherever each came from', () => {
		expect(() =>
			buildQuestions([flag('noul', 'a', 'One?'), flag('score', 'a', 'Two?', 'x', 'y')])
		).toThrow(/Two questions share the id "a"/);
		expect(() =>
			buildQuestions([flag('noul', 'a', 'One?')], { questionsJson: '{"a":{"type":"noul"}}' })
		).toThrow(/share the id "a"/);
	});

	it.each([
		['a flag with no words', [flag('noul')], /needs an id and its instructions: --noul ID/],
		['an id with no instructions', [flag('score', 'tone')], /--score ID INSTRUCTIONS LEVEL/],
		[
			'a noul with a stray word',
			[flag('noul', 'a', 'Q?', 'maybe=x')],
			/only true=\.\.\. and false=/,
		],
		['a noul criterion with no text', [flag('noul', 'a', 'Q?', 'true')], /only true=/],
		['a choice of one option', [flag('choice', 'a', 'Q?', 'only')], /at least 2 options/],
		['a score of one level', [flag('score', 'a', 'Q?', 'low')], /2 to 10 levels/],
		[
			'a score of eleven levels',
			[flag('score', 'a', 'Q?', ...Array.from({ length: 11 }, (_, i) => `L${i}`))],
			/2 to 10 levels/,
		],
	])('refuses %s', (_name, flags, message) => {
		expect(() => buildQuestions(flags)).toThrow(message);
	});

	it('refuses no questions at all, and a questions file that is not an object', () => {
		expect(() => buildQuestions([])).toThrow(/No questions\. Use --noul, --choice or --score/);
		expect(() => buildQuestions([], { questionsJson: '[1,2]' })).toThrow(
			/--questions-json must hold a JSON object/
		);
		expect(() => buildQuestions([], { questionsJson: '{' })).toThrow(/--questions-json: not JSON/);
	});
});

describe('readRankCandidates', () => {
	it('keys the lines of a file by line number, counting the blank ones', async () => {
		const held = file(
			'commits.txt',
			'fix: escape the path\n\nfeat: add a pager\n   \nchore: bump\n'
		);
		expect(await readRankCandidates({ candidatesFile: held })).toEqual([
			{ key: '1', item: 'fix: escape the path' },
			{ key: '3', item: 'feat: add a pager' },
			{ key: '5', item: 'chore: bump' },
		]);
	});

	it('keys a JSON list by each item`s own id when every item has one', async () => {
		const held = file(
			'issues.json',
			JSON.stringify([
				{ id: 'MAE-7', title: 'Data loss on save' },
				{ id: 12, title: 'Typo' },
			])
		);
		expect(await readRankCandidates({ candidatesFile: held })).toEqual([
			{ key: 'MAE-7', item: { id: 'MAE-7', title: 'Data loss on save' } },
			{ key: '12', item: { id: 12, title: 'Typo' } },
		]);
	});

	it('keys a JSON list by place, from 1, when an item has no id', async () => {
		const held = file('mixed.json', JSON.stringify([{ id: 2, t: 'a' }, { t: 'b' }, 'c']));
		expect((await readRankCandidates({ candidatesFile: held })).map((entry) => entry.key)).toEqual([
			'1',
			'2',
			'3',
		]);
	});

	it('uses the field --id-key names, and reads .jsonl rows', async () => {
		const held = file('rows.jsonl', '{"sha":"abc","m":"fix"}\n{"sha":"def","m":"feat"}\n');
		expect(await readRankCandidates({ candidatesFile: held, idKey: 'sha' })).toEqual([
			{ key: 'abc', item: { sha: 'abc', m: 'fix' } },
			{ key: 'def', item: { sha: 'def', m: 'feat' } },
		]);
	});

	it('keys candidates typed as arguments by place, from 1', async () => {
		expect(await readRankCandidates({ candidates: ['first', 'second'] })).toEqual([
			{ key: '1', item: 'first' },
			{ key: '2', item: 'second' },
		]);
		expect(stdin.readStdinIfReady).not.toHaveBeenCalled();
	});

	it('reads the lines of standard input when nothing else names the candidates', async () => {
		stdin.readStdinIfReady.mockResolvedValue('a.md\n\nb.md\n');
		expect(await readRankCandidates({})).toEqual([
			{ key: '1', item: 'a.md' },
			{ key: '3', item: 'b.md' },
		]);
	});

	it('refuses candidates given two ways, a file that is one object, and none at all', async () => {
		await expect(
			readRankCandidates({ candidates: ['a'], candidatesFile: file('c.txt', 'b') })
		).rejects.toThrow(/Give the candidates one way/);
		await expect(
			readRankCandidates({ candidatesFile: file('one.json', '{"id":1}') })
		).rejects.toThrow(/one candidate per line, or a JSON list/);
		await expect(readRankCandidates({})).rejects.toThrow(/No candidates\./);
	});
});

describe('readBatchRows', () => {
	it('reads each JSON object as a state, with its line and its own id', () => {
		expect(readBatchRows('{"id":"a","text":"one"}\n\n{"text":"two"}\n')).toEqual([
			{ line: 1, id: 'a', state: { id: 'a', text: 'one' } },
			{ line: 3, state: { text: 'two' } },
		]);
	});

	it('takes the state from --state-key and the id from --id-key', () => {
		expect(
			readBatchRows('{"sha":7,"body":"fix the leak"}\n', { stateKey: 'body', idKey: 'sha' })
		).toEqual([{ line: 1, id: 7, state: 'fix the leak' }]);
	});

	it('names the line that lacks the state key', () => {
		expect(() => readBatchRows('{"body":"a"}\n{"other":"b"}\n', { stateKey: 'body' })).toThrow(
			/Line 2: no field "body"/
		);
	});

	it('reads a line that is not JSON, or is a bare JSON value, as text', () => {
		expect(readBatchRows('TODO: write the test\n42\n"quoted"\n')).toEqual([
			{ line: 1, state: 'TODO: write the test' },
			{ line: 2, state: '42' },
			{ line: 3, state: '"quoted"' },
		]);
	});

	it('reads a JSON list as a state, and every line as text under --text-lines', () => {
		expect(readBatchRows('["a","b"]\n')).toEqual([{ line: 1, state: ['a', 'b'] }]);
		expect(readBatchRows('{"id":1}\n', { textLines: true })).toEqual([
			{ line: 1, state: '{"id":1}' },
		]);
	});

	it('refuses input with no rows', () => {
		expect(() => readBatchRows('\n   \n')).toThrow(/No rows/);
	});
});
