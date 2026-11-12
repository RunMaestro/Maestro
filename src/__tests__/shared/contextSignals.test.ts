/**
 * Tests for src/shared/contextSignals.ts
 *
 * The signals say "this call repeated" and "this tab is (not) ready to continue".
 * Both are claims a person may act on, so the tests are mostly about when the
 * module must stay quiet: a retry after an edit, a retry the agent corrected, a
 * poll of live state, a transcript that does not carry the evidence. A signal
 * that cries wolf teaches people to ignore the one that matters.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	buildContextSignals,
	formatContextSignals,
	signalsToWire,
	SIGNAL_LIMITS,
	type ContextSignals,
	type ContextSignalsInput,
	type SignalEntry,
} from '../../shared/contextSignals';
import { describeContinuationRouting } from '../../shared/continuationRouting';
import { MAX_PERSISTED_TOOL_OUTPUT_CHARS } from '../../shared/toolOutput';

let sequence = 0;
beforeEach(() => {
	sequence = 0;
});
const nextId = () => `e${++sequence}`;

function tool(
	name: string,
	input: unknown,
	status?: string,
	output?: unknown,
	extra = {}
): SignalEntry {
	return {
		id: nextId(),
		source: 'tool',
		text: name,
		metadata: {
			toolState: {
				...(status ? { status } : {}),
				...(input === undefined ? {} : { input }),
				...(output === undefined ? {} : { output }),
				...extra,
			},
		},
	};
}
const bash = (command: string, status = 'failed', output: unknown = 'FAIL boom') =>
	tool('Bash', { command }, status, output);
/** A shell call that was seen starting and never seen ending: no status, no output. */
const unfinished = (command: string) => tool('Bash', { command });
/** A failed shell call whose output was not stored. */
const failedNoOutput = (command: string) => tool('Bash', { command }, 'failed');
const read = (path: string, output: unknown = 'file text', status = 'completed') =>
	tool('Read', { file_path: path }, status, output);
const edit = (path = 'a.ts', status = 'completed') =>
	tool('Edit', { file_path: path, old_string: 'a', new_string: 'b' }, status, 'ok');
const user = (text = 'please continue'): SignalEntry => ({ id: nextId(), source: 'user', text });
const ai = (text: string): SignalEntry => ({ id: nextId(), source: 'ai', text });
const compaction = (status: string): SignalEntry => ({
	id: nextId(),
	source: 'system',
	text: 'Compacted the conversation',
	contextCompaction: { status },
});

const signalsOf = (
	entries: readonly SignalEntry[],
	extra: Partial<ContextSignalsInput> = {}
): ContextSignals =>
	buildContextSignals({ entries, tabState: 'idle', digest: { openFailures: 0 }, ...extra });
const runsOf = (entries: readonly SignalEntry[], extra: Partial<ContextSignalsInput> = {}) =>
	signalsOf(entries, extra).repetition;
const repeat = <T>(count: number, make: () => T): T[] => Array.from({ length: count }, make);
const readiness = (signals: ContextSignals, id: string) => {
	const found = signals.readiness.find((signal) => signal.id === id);
	if (!found) throw new Error(`no readiness signal ${id}`);
	return found;
};

describe('repeated failure', () => {
	it('names the same call failing three times in a row, with the entries it rests on', () => {
		const entries = [user('fix it'), ...repeat(3, () => bash('npm test'))];
		const [run, ...rest] = runsOf(entries);
		expect(rest).toEqual([]);
		expect(run).toMatchObject({
			kind: 'repeated-failure',
			call: 'npm test',
			tool: 'shell',
			count: 3,
			ongoing: true,
			outputs: 'identical',
		});
		expect(run.refs.map((ref) => [ref.label, ref.entryId, ref.ordinal])).toEqual([
			['tool #2', 'e2', 2],
			['tool #3', 'e3', 3],
			['tool #4', 'e4', 4],
		]);
		expect(run.endedBy).toBeUndefined();
	});

	it.each([
		[1, 0],
		[2, 0],
		[3, 1],
		[4, 1],
		[9, 1],
	])('counts %i identical failures as %i run(s)', (failures, runs) => {
		expect(runsOf(repeat(failures, () => bash('npm test')))).toHaveLength(runs);
	});

	it('keeps the count of a long run and cites only its first three and last three entries', () => {
		const [run] = runsOf(repeat(8, () => bash('npm test')));
		expect(run.count).toBe(8);
		expect(run.refs.map((ref) => ref.ordinal)).toEqual([1, 2, 3, 6, 7, 8]);
	});

	it('reads a non-zero exit code as a failure even when the provider says completed', () => {
		const entries = repeat(3, () =>
			tool('exec_command', { cmd: 'make' }, 'completed', 'oops', { exitCode: 2 })
		);
		expect(runsOf(entries)).toHaveLength(1);
	});

	it('is not ended by reads, searches or commands that only print', () => {
		const between = [
			read('src/a.ts'),
			tool('Grep', { pattern: 'x' }, 'completed', 'hit'),
			bash('cat src/a.ts', 'completed', 'text'),
			bash('ls -la', 'completed', 'files'),
			bash('git diff', 'completed', ''),
			bash('rg --files', 'completed', 'a'),
		];
		const entries = [
			bash('npm test'),
			...between.slice(0, 2),
			bash('npm test'),
			...between.slice(2),
			bash('npm test'),
		];
		expect(runsOf(entries)).toHaveLength(1);
		expect(runsOf(entries)[0].count).toBe(3);
	});

	describe('what the failure text shows', () => {
		it('says the text was identical, varied, or not stored', () => {
			const same = runsOf(repeat(3, () => bash('make', 'failed', 'error: x')))[0];
			const varied = runsOf(['one', 'two', 'three'].map((text) => bash('make', 'failed', text)))[0];
			const missing = runsOf([
				bash('make', 'failed', 'a'),
				failedNoOutput('make'),
				bash('make', 'failed', 'a'),
			])[0];
			expect(same.outputs).toBe('identical');
			expect(varied.outputs).toBe('varies');
			expect(varied.uncertainty.join(' ')).toMatch(/failure text changed/);
			expect(missing.outputs).toBe('not-stored');
			expect(missing.uncertainty.join(' ')).toMatch(/was not stored/);
		});

		it('compares the output exactly as stored: a colour code, a space or a line ending is part of it', () => {
			const red = String.fromCharCode(27) + '[31merror: x' + String.fromCharCode(27) + '[0m';
			const outputsOf = (texts: string[]) =>
				runsOf(texts.map((text) => bash('make', 'failed', text)))[0].outputs;
			expect(outputsOf([red, red, red])).toBe('identical');
			expect(outputsOf([red, 'error: x', red])).toBe('varies');
			expect(outputsOf([' x', 'x', 'x '])).toBe('varies');
			expect(outputsOf(['x', 'x\n', 'x'])).toBe('varies');
			expect(outputsOf(['a\r\nb', 'a\nb', 'a\r\nb'])).toBe('varies');
		});

		it('says when stored output is cut, so identical text past the cut is not claimed', () => {
			const long = 'x'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS);
			const [run] = runsOf(repeat(3, () => bash('make', 'failed', long)));
			expect(run.uncertainty.join(' ')).toMatch(/cut at 4,000 characters/);
		});
	});

	describe('uncertainty and provenance', () => {
		it('carries the standing limits on every observation', () => {
			const [run] = runsOf(repeat(3, () => bash('npm test')));
			const text = run.uncertainty.join(' ');
			expect(text).toMatch(/compaction the provider did on its own is not visible/);
			expect(text).toMatch(/normal polling/);
			expect(text).toMatch(/outside this transcript/);
		});

		it('notes a call of the same invocation that never reported an end', () => {
			const entries = [
				bash('npm test'),
				unfinished('npm test'),
				bash('npm test'),
				bash('npm test'),
			];
			const [run] = runsOf(entries);
			expect(run.count).toBe(3);
			expect(run.uncertainty.join(' ')).toMatch(
				/1 call of the same invocation never reported an end/
			);
		});
	});
});

describe('the same call, and only the same call', () => {
	it('treats different arguments, directories, variables and argv boundaries as different calls', () => {
		const calls: Array<[string, () => SignalEntry, () => SignalEntry]> = [
			['arguments', () => bash("npm test -- -t 'a'"), () => bash("npm test -- -t 'b'")],
			[
				'directory',
				() => tool('exec_command', { cmd: 'npm test', workdir: '/one' }, 'failed', 'x'),
				() => tool('exec_command', { cmd: 'npm test', workdir: '/two' }, 'failed', 'x'),
			],
			[
				'variables',
				() => tool('exec_command', { cmd: 'npm test', env: { CI: '1' } }, 'failed', 'x'),
				() => tool('exec_command', { cmd: 'npm test', env: { CI: '0' } }, 'failed', 'x'),
			],
			[
				'argv boundaries',
				() => tool('shell', { command: ['npm', 'test', '--', '-t', 'alpha beta'] }, 'failed', 'x'),
				() =>
					tool('shell', { command: ['npm', 'test', '--', '-t', 'alpha', 'beta'] }, 'failed', 'x'),
			],
			[
				'tool input',
				() => tool('Edit', { file_path: 'a.ts', old_string: 'one' }, 'failed', 'no match'),
				() => tool('Edit', { file_path: 'a.ts', old_string: 'two' }, 'failed', 'no match'),
			],
		];
		for (const [label, first, second] of calls) {
			sequence = 0;
			const runs = runsOf([...repeat(3, first), ...repeat(3, second)]);
			// Two runs of three, never one run of six.
			expect(
				runs.map((run) => run.count),
				label
			).toEqual([3, 3]);
		}
	});

	it('treats spacing between arguments and key order in an input as no difference', () => {
		expect(runsOf([bash('npm test'), bash('npm   test'), bash('npm  test')])).toHaveLength(1);
		const first = () =>
			tool('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }, 'failed', 'no match');
		const second = () =>
			tool('Edit', { new_string: 'y', old_string: 'x', file_path: 'a.ts' }, 'failed', 'no match');
		expect(runsOf([first(), second(), first()])[0].count).toBe(3);
	});

	it('does not compare message length or wording, whatever the assistant says', () => {
		const same = 'I will try the tests again now.';
		const entries = [
			user(),
			...repeat(6, () => ai(same)),
			...repeat(2, () => ai('x'.repeat(same.length))),
		];
		const signals = signalsOf(entries);
		expect(signals.repetition).toEqual([]);
		expect(signals.counts.toolCalls).toBe(0);
	});
});

describe('what ends a run', () => {
	it('a finished edit between attempts: test, edit, retest is not a loop', () => {
		const entries = [
			bash('npm test'),
			edit(),
			bash('npm test'),
			edit(),
			bash('npm test'),
			edit(),
			bash('npm test'),
		];
		expect(runsOf(entries)).toEqual([]);
	});

	it('names the edit that ended a run that was already long enough', () => {
		const entries = [...repeat(3, () => bash('npm test')), edit('b.ts'), bash('npm test')];
		const [run, ...rest] = runsOf(entries);
		expect(rest).toEqual([]);
		expect(run).toMatchObject({ count: 3, ongoing: false });
		expect(run.endedBy).toMatchObject({ reason: 'edit', ref: { label: 'tool #4' } });
	});

	it('a failed edit changed nothing and does not end the run', () => {
		const entries = [
			bash('npm test'),
			edit('a.ts', 'failed'),
			bash('npm test'),
			edit('a.ts', 'failed'),
			bash('npm test'),
		];
		expect(runsOf(entries)).toHaveLength(1);
	});

	it('a new user message ends a run: the user asked again, the agent did not repeat itself', () => {
		expect(
			runsOf([bash('npm test'), bash('npm test'), user('try once more'), bash('npm test')])
		).toEqual([]);
		const [run] = runsOf([...repeat(3, () => bash('npm test')), user('try once more')]);
		expect(run.endedBy?.reason).toBe('user-message');
	});

	it('a completed compaction ends a run, and a pending one does not', () => {
		expect(
			runsOf([bash('npm test'), bash('npm test'), compaction('done'), bash('npm test')])
		).toEqual([]);
		expect(
			runsOf([bash('npm test'), bash('npm test'), compaction('pending'), bash('npm test')])
		).toHaveLength(1);
		const [run] = runsOf([...repeat(3, () => bash('npm test')), compaction('done')]);
		expect(run.endedBy).toMatchObject({ reason: 'compaction', ref: { label: 'system #4' } });
	});

	it('a success of the same call ends it: the retry worked', () => {
		const [run, ...rest] = runsOf([
			...repeat(3, () => bash('npm test')),
			bash('npm test', 'completed', '12 passed'),
			bash('npm test'),
		]);
		expect(rest).toEqual([]);
		expect(run.endedBy).toMatchObject({ reason: 'success', ref: { label: 'tool #4' } });
	});

	it('a corrected retry is not a repeat: the second command differs', () => {
		const entries = [
			bash('npm test -- --run'),
			bash('npm test -- --run'),
			bash('npm test -- --run src/a.test.ts', 'completed', '3 passed'),
		];
		expect(runsOf(entries)).toEqual([]);
	});

	it.each([
		['an install', () => bash('npm install', 'completed', 'added 3 packages')],
		['a checkout', () => bash('git checkout -- src/a.ts', 'completed', '')],
		['an in-place edit by sed', () => bash("sed -i 's/a/b/' src/a.ts", 'completed', '')],
		['a piped command', () => bash('cat a | head -3', 'completed', 'x')],
		['an MCP tool', () => tool('mcp__issues__create_issue', { title: 't' }, 'completed', 'ok')],
		[
			'a subagent',
			() => tool('Task', { description: 'fix it', prompt: 'do' }, 'completed', 'done'),
		],
		[
			'a tool Maestro has no name for',
			() => tool('FrobnicateFiles', { path: 'a' }, 'completed', 'ok'),
		],
	])('%s may change what the retry sees, so it ends the run', (_name, step) => {
		const entries = [
			bash('npm test'),
			bash('npm test'),
			step(),
			bash('npm test'),
			bash('npm test'),
		];
		expect(runsOf(entries)).toEqual([]);
		const [run] = runsOf([...repeat(3, () => bash('npm test')), step()]);
		expect(run.endedBy?.reason).toBe('other-change');
	});

	it('a deliberate wait between attempts ends the run: the retry follows a wait, not a blind repeat', () => {
		const sleep = (command: string) => bash(command, 'completed', '');
		for (const wait of ['sleep 30', 'sleep 5 && echo done', 'FOO=1 sleep 2']) {
			sequence = 0;
			expect(
				runsOf([
					bash('npm test'),
					bash('npm test'),
					sleep(wait),
					bash('npm test'),
					bash('npm test'),
				]),
				wait
			).toEqual([]);
		}
		const [run] = runsOf([...repeat(3, () => bash('npm test')), bash('sleep 10', 'completed', '')]);
		expect(run.endedBy).toMatchObject({ reason: 'waiting', ref: { label: 'tool #4' } });
		expect(
			formatContextSignals(
				signalsOf([...repeat(3, () => bash('npm test')), bash('sleep 10', 'completed', '')])
			)
		).toMatch(/ended by a wait between attempts at tool #4/);
	});

	it('a word that only contains sleep is not a wait', () => {
		const entries = [
			bash('npm test'),
			bash('echo sleep', 'completed', 'sleep'),
			bash('npm test'),
			bash('npm test'),
		];
		expect(runsOf(entries)).toHaveLength(1);
	});

	it('a call that carries no input, but may change files, also ends it', () => {
		const entries = [
			bash('npm test'),
			bash('npm test'),
			tool('Bash', undefined, 'completed', 'x'),
			bash('npm test'),
		];
		expect(runsOf(entries)).toEqual([]);
	});

	it('separates two runs of one call by what ended the first', () => {
		const entries = [
			...repeat(3, () => bash('npm test')),
			edit(),
			...repeat(4, () => bash('npm test')),
		];
		const runs = runsOf(entries);
		expect(runs.map((run) => [run.count, run.ongoing])).toEqual([
			[4, true],
			[3, false],
		]);
	});
});

describe('polling is not repetition', () => {
	it.each([
		'git status',
		'git fetch origin',
		'gh run view 123',
		'gh pr checks 45',
		'kubectl get pods -n web',
		'docker ps',
		'docker compose logs api',
		'ps aux',
		'curl -sf http://localhost:3000/health',
		'wget -q http://localhost:3000/',
		'sleep 5 && curl -sf http://localhost:3000/health',
		'until curl -sf http://localhost:3000/health; do sleep 1; done',
		'watch -n1 ls dist',
		'tail -f server.log',
		'pm2 status',
		'systemctl status api',
		'journalctl -u api -n 20',
		'API_KEY=x curl http://localhost:3000',
		'sudo systemctl status api',
		'nc -z localhost 5432',
	])('never counts a failing "%s" as a loop', (command) => {
		const signals = signalsOf(repeat(5, () => bash(command)));
		expect(signals.repetition).toEqual([]);
		expect(signals.counts.liveState).toBe(5);
		expect(signals.counts.compared).toBe(0);
	});

	it.each(['BashOutput', 'WebFetch', 'WebSearch'])('never counts %s as a loop', (name) => {
		const input =
			name === 'BashOutput'
				? { bash_id: 'b1' }
				: name === 'WebFetch'
					? { url: 'http://x' }
					: { query: 'q' };
		const entries = repeat(5, () => tool(name, input, 'failed', 'not ready'));
		expect(runsOf(entries)).toEqual([]);
	});

	it('does not read a word inside another command as the start of a poll', () => {
		for (const command of ['pytest -k watch', 'grep -r curl src', 'echo sleep', 'npm run ps']) {
			sequence = 0;
			expect(runsOf(repeat(3, () => bash(command))), command).toHaveLength(1);
		}
	});

	it('a live check between attempts does not end a run', () => {
		const entries = [
			bash('npm test'),
			bash('git status', 'completed', 'clean'),
			bash('npm test'),
			bash('curl -s http://x', 'completed', '{}'),
			bash('npm test'),
		];
		expect(runsOf(entries)).toHaveLength(1);
	});

	it('a poll whose answer changes is not a repeated read', () => {
		const entries = ['starting', 'starting', 'ready', 'ready'].map((text) =>
			read('status.json', text)
		);
		expect(runsOf(entries)).toEqual([]);
	});

	it('says so in the report: live checks are left out and the limit is stated', () => {
		const text = formatContextSignals(signalsOf(repeat(4, () => bash('git status'))));
		expect(text).toMatch(/4 calls read live state and were not counted/);
		expect(text).toMatch(/Repeating a check of live state is normal polling/);
	});
});

describe('repeated reads', () => {
	it('names a file read that returned the same text three times', () => {
		const [run] = runsOf(repeat(3, () => read('src/a.ts')));
		expect(run).toMatchObject({
			kind: 'repeated-result',
			tool: 'read',
			count: 3,
			ongoing: true,
			outputs: 'identical',
		});
		expect(run.call).toMatch(/Read .*a\.ts/);
	});

	describe('the stored text is compared exactly, not tidied up first', () => {
		const readsOf = (outputs: string[]) => outputs.map((output) => read('/synthetic/a.py', output));
		const resultRuns = (outputs: string[]) =>
			runsOf(readsOf(outputs)).filter((run) => run.kind === 'repeated-result');

		it('is a repeat only when every stored text is the same text', () => {
			expect(resultRuns(['x', 'x', 'x'])).toHaveLength(1);
			expect(resultRuns(['x', 'y', 'z'])).toEqual([]);
		});

		it.each([
			['a leading and a trailing space', [' x', 'x', 'x ']],
			['a trailing newline', ['x', 'x\n', 'x']],
			['a line ending', ['a\r\nb', 'a\nb', 'a\r\nb']],
			['a tab for spaces', ['a  b', 'a\tb', 'a  b']],
			['indentation', ['  x', 'x', '  x']],
			['letter case', ['X', 'x', 'X']],
			['a colour code', ['x', String.fromCharCode(27) + '[0mx', 'x']],
			['blank text and none at all', ['', ' ', '\n']],
		])(
			'is no repeat when the texts differ by %s: whitespace is part of a source file',
			(_label, outputs) => {
				expect(resultRuns(outputs)).toEqual([]);
			}
		);

		it('restarts at the first text that differs, and counts the run that follows', () => {
			const [run, ...rest] = resultRuns(['x ', 'x', 'x', 'x']);
			expect(rest).toEqual([]);
			expect(run.count).toBe(3);
			expect(run.refs.map((ref) => ref.ordinal)).toEqual([2, 3, 4]);
		});

		it('keeps the shown call free of the text it compared', () => {
			const [run] = resultRuns(['x', 'x', 'x']);
			expect(run.call).toBe('Read /synthetic/a.py');
		});
	});

	it('starts over when the text changes, the file changes, or an edit lands', () => {
		expect(runsOf([read('a.ts', 'one'), read('a.ts', 'two'), read('a.ts', 'two')])).toEqual([]);
		expect(runsOf([read('a.ts'), read('b.ts'), read('a.ts')])).toEqual([]);
		expect(runsOf([read('a.ts'), read('a.ts'), edit('a.ts'), read('a.ts')])).toEqual([]);
		expect(runsOf([read('a.ts'), read('a.ts'), user('and again'), read('a.ts')])).toEqual([]);
	});

	it('treats a different range as a different read', () => {
		const range = (offset: number) =>
			tool('Read', { file_path: 'a.ts', offset, limit: 50 }, 'completed', 'lines');
		expect(runsOf([range(1), range(51), range(101)])).toEqual([]);
		expect(runsOf(repeat(3, () => range(1)))).toHaveLength(1);
	});

	it('does not count a read whose text was not stored, and does not guess it was the same', () => {
		expect(runsOf(repeat(4, () => tool('Read', { file_path: 'a.ts' }, 'completed')))).toEqual([]);
	});

	it('does not count shell commands that print a file or a directory', () => {
		expect(runsOf(repeat(4, () => bash('cat a.ts', 'completed', 'same')))).toEqual([]);
		expect(runsOf(repeat(4, () => bash('ls', 'completed', 'same')))).toEqual([]);
	});

	it('says when the stored text is cut', () => {
		const [run] = runsOf(
			repeat(3, () => read('big.ts', 'y'.repeat(MAX_PERSISTED_TOOL_OUTPUT_CHARS)))
		);
		expect(run.uncertainty.join(' ')).toMatch(/cut at 4,000 characters/);
	});

	it('a failed read then successful identical reads: the failure run and the read run are separate', () => {
		const entries = [read('a.ts', 'no such file', 'failed'), ...repeat(3, () => read('a.ts'))];
		const runs = runsOf(entries);
		expect(runs).toHaveLength(1);
		expect(runs[0].kind).toBe('repeated-result');
	});
});

describe('missing telemetry', () => {
	it('cannot compare a call with no input, and says how many it could not compare', () => {
		const entries: SignalEntry[] = [
			{ id: 'a', source: 'tool', text: 'Bash' },
			{ id: 'b', source: 'tool', text: 'Bash', metadata: {} },
			{ id: 'c', source: 'tool', text: 'Bash', metadata: { toolState: null } },
			{ id: 'd', source: 'tool', text: 'Bash', metadata: { toolState: { status: 'failed' } } },
		];
		const signals = signalsOf(entries);
		expect(signals.repetition).toEqual([]);
		expect(signals.counts).toMatchObject({ toolCalls: 4, unidentified: 4, compared: 0 });
		expect(signals.unknowns.map((u) => u.field)).toContain('calls');
		expect(readiness(signals, 'repetition').status).toBe('unknown');
	});

	it('does not read a call with no end as a failure or a success', () => {
		const signals = signalsOf([
			unfinished('npm test'),
			unfinished('npm test'),
			unfinished('npm test'),
		]);
		expect(signals.repetition).toEqual([]);
		expect(signals.counts.unfinished).toBe(3);
		expect(signals.unknowns.find((u) => u.field === 'outcomes')?.reason).toMatch(
			/3 tool calls never reported an end/
		);
	});

	it('survives hostile shapes without throwing and without inventing a repeat', () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const entries: SignalEntry[] = [
			tool('Bash', circular, 'failed', 'x'),
			tool('Bash', { command: () => 1 }, 'failed', 'x'),
			tool('Edit', { file_path: 'a', n: 10n }, 'failed', 'x'),
			tool('Bash', { command: ['npm', 3] }, 'failed', 'x'),
			tool('Bash', 'npm test', 'failed', 'x'),
			tool('Read', { file_path: 'a' }, 'completed', { not: 'a string' }),
			{ id: 'z', source: 'tool', text: '', metadata: { toolState: { input: {}, output: 42 } } },
		];
		expect(() => signalsOf(entries)).not.toThrow();
		expect(signalsOf(entries).repetition).toEqual([]);
	});

	it('an empty transcript is unknown, not healthy', () => {
		const signals = signalsOf([]);
		expect(signals.repetition).toEqual([]);
		expect(signals.unknowns[0]).toEqual({
			field: 'entries',
			reason: 'The tab has no transcript entries.',
		});
	});

	it('no usage record means the context fill is unknown, and says that is not low use', () => {
		for (const context of [
			undefined,
			null,
			{ tokens: Number.NaN, window: 200_000, percent: 10 },
			{ tokens: 5, window: -1, percent: 1 },
		]) {
			const pressure = readiness(signalsOf([user()], { context }), 'pressure');
			expect(pressure.status).toBe('unknown');
			expect(pressure.statement).toMatch(/not the same as low use/);
		}
	});

	it('no digest means checks and failures are unknown, never clear', () => {
		const signals = buildContextSignals({ entries: [user(), edit()], tabState: 'idle' });
		expect(readiness(signals, 'unverified-edits').status).toBe('unknown');
		expect(readiness(signals, 'open-failures').status).toBe('unknown');
	});
});

describe('readiness', () => {
	describe('activity', () => {
		it('is open while a turn runs, a call has no end, or the newest request has no reply', () => {
			expect(
				readiness(signalsOf([user(), ai('ok')], { tabState: 'busy' }), 'activity').status
			).toBe('open');
			expect(readiness(signalsOf([user(), unfinished('ls')]), 'activity').status).toBe('open');
			const unanswered = readiness(signalsOf([user('do the thing')]), 'activity');
			expect(unanswered.status).toBe('open');
			expect(unanswered.statement).toMatch(/newest request has no reply yet/);
			expect(unanswered.refs.map((ref) => ref.label)).toEqual(['user #1']);
		});

		it('is clear only when the tab is known to be idle and nothing is waiting', () => {
			expect(readiness(signalsOf([user(), ai('done')]), 'activity').status).toBe('clear');
			expect(
				readiness(signalsOf([user(), ai('done')], { tabState: undefined }), 'activity').status
			).toBe('unknown');
		});
	});

	describe('unverified edits', () => {
		it('is clear with no edit, and open with an edit and no passing check', () => {
			expect(readiness(signalsOf([user(), ai('hi')]), 'unverified-edits').status).toBe('clear');
			const open = readiness(signalsOf([user(), edit(), edit('b.ts')]), 'unverified-edits');
			expect(open.status).toBe('open');
			expect(open.statement).toMatch(/2 file edits and no passing check/);
		});

		it('is clear when a check passed after the last edit, and open for edits after it', () => {
			const entries = [
				user(),
				edit(),
				bash('npm test', 'completed', '5 passed'),
				edit('b.ts'),
				edit('c.ts'),
			];
			const after = readiness(
				signalsOf(entries, { digest: { openFailures: 0, lastVerifiedOrdinal: 3 } }),
				'unverified-edits'
			);
			expect(after.status).toBe('open');
			expect(after.statement).toMatch(/2 file edits since the last passing check \(entry #3\)/);
			expect(after.refs.map((ref) => ref.label)).toEqual(['tool #5', 'tool #3']);
			const clear = readiness(
				signalsOf(entries.slice(0, 3), { digest: { openFailures: 0, lastVerifiedOrdinal: 3 } }),
				'unverified-edits'
			);
			expect(clear.status).toBe('clear');
			expect(clear.statement).toMatch(/after the last file edit \(entry #2\)/);
		});

		it('does not count a failed edit, and ignores a passing check that is not in the transcript', () => {
			expect(
				readiness(signalsOf([user(), edit('a.ts', 'failed')]), 'unverified-edits').status
			).toBe('clear');
			const lost = readiness(
				signalsOf([user(), edit()], { digest: { openFailures: 0, lastVerifiedOrdinal: 99 } }),
				'unverified-edits'
			);
			expect(lost.status).toBe('open');
			expect(lost.statement).toMatch(/no passing check/);
		});

		it('is unknown, not "no check", when the digest budget cut every passing check it found', () => {
			const cut = readiness(
				signalsOf([user(), edit()], { digest: { openFailures: 0, verifiedOmitted: true } }),
				'unverified-edits'
			);
			expect(cut.status).toBe('unknown');
			expect(cut.refs.map((ref) => ref.label)).toEqual(['tool #2']);
			// A known newest check wins over the flag, and no edit needs no check.
			expect(
				readiness(
					signalsOf([user(), edit(), bash('npm test', 'completed', '3 passed')], {
						digest: { openFailures: 0, lastVerifiedOrdinal: 3, verifiedOmitted: true },
					}),
					'unverified-edits'
				).status
			).toBe('clear');
			expect(
				readiness(
					signalsOf([user()], { digest: { openFailures: 0, verifiedOmitted: true } }),
					'unverified-edits'
				).status
			).toBe('clear');
		});

		it('says an edit by a shell command is not counted', () => {
			expect(readiness(signalsOf([user()]), 'unverified-edits').uncertainty.join(' ')).toMatch(
				/shell command is not/
			);
		});
	});

	it('open failures follow the digest, and are unknown without it', () => {
		const open = readiness(signalsOf([user()], { digest: { openFailures: 2 } }), 'open-failures');
		expect(open.status).toBe('open');
		expect(open.statement).toMatch(/2 unresolved failures/);
		expect(readiness(signalsOf([user()]), 'open-failures').status).toBe('clear');
	});

	describe('position since the last compaction', () => {
		it('reports how many entries follow a completed compaction', () => {
			const found = readiness(
				signalsOf([user(), compaction('done'), user('go'), ai('ok'), ai('more')]),
				'since-compaction'
			);
			expect(found.status).toBe('info');
			expect(found.statement).toMatch(/entry #2; 3 entries follow it/);
			expect(found.refs.map((ref) => ref.label)).toEqual(['system #2']);
		});

		it('is open for a compaction that has not finished, and says the provider may have compacted alone', () => {
			const pending = readiness(signalsOf([user(), compaction('pending')]), 'since-compaction');
			expect(pending.status).toBe('open');
			expect(pending.uncertainty.join(' ')).toMatch(/provider may have compacted/);
			expect(
				readiness(
					signalsOf([user(), compaction('done'), compaction('pending')]),
					'since-compaction'
				).status
			).toBe('open');
			expect(
				readiness(
					signalsOf([user(), compaction('pending'), compaction('done')]),
					'since-compaction'
				).status
			).toBe('info');
			expect(readiness(signalsOf([user()]), 'since-compaction').statement).toMatch(
				/No completed compaction/
			);
		});
	});

	describe('pressure', () => {
		it('quotes the provider reading and does not turn it into a verdict', () => {
			const found = readiness(
				signalsOf([user()], { context: { tokens: 150_000, window: 200_000, percent: 75 } }),
				'pressure'
			);
			expect(found.status).toBe('info');
			expect(found.statement).toBe(
				'The provider reported about 75% of a 200,000-token window in use (150,000 tokens) at the end of the latest turn.'
			);
			expect(found.uncertainty.join(' ')).toMatch(/latest reading/);
		});
	});

	it('repetition is open for an ongoing run, clear with a count of what was compared, and unknown without comparable calls', () => {
		expect(readiness(signalsOf(repeat(3, () => bash('npm test'))), 'repetition')).toMatchObject({
			status: 'open',
		});
		const clear = readiness(signalsOf([bash('ls', 'completed', 'a'), read('a.ts')]), 'repetition');
		expect(clear.status).toBe('clear');
		expect(clear.statement).toMatch(/2 calls compared/);
		expect(readiness(signalsOf([unfinished('npm test')]), 'repetition').status).toBe('unknown');
		expect(readiness(signalsOf([user()]), 'repetition').status).toBe('clear');
	});
});

describe('advice is report data', () => {
	it('is a sentence in a report for each open reading, and acts on nothing', () => {
		const signals = signalsOf([user(), edit(), ...repeat(3, () => bash('npm test'))], {
			digest: { openFailures: 1 },
		});
		expect(signals.advice.map((item) => item.about)).toEqual([
			'repetition',
			'unverified-edits',
			'open-failures',
		]);
		expect(signals.advice[0].text).toMatch(/failed 3 times in a row with no file edit between/);
		expect(signals.mode).toBe('observation');
		expect(signals.note).toMatch(
			/nothing here blocks a call, changes a prompt, switches a model or sends anything/
		);
	});

	it('says a repeated read returned the same text, and names the read once', () => {
		const signals = signalsOf(repeat(3, () => read('src/a.ts')));
		expect(signals.advice).toEqual([
			{
				about: 'repetition',
				text: '`Read src/a.ts` returned the same text 3 times in a row; the transcript already holds it.',
			},
		]);
	});

	it('gives no advice about a run that already ended', () => {
		const signals = signalsOf(
			[...repeat(3, () => bash('npm test')), edit(), bash('npm test', 'completed', '3 passed')],
			{
				digest: { openFailures: 0, lastVerifiedOrdinal: 5 },
			}
		);
		expect(signals.repetition[0].ongoing).toBe(false);
		expect(signals.advice).toEqual([]);
	});

	it('gives no advice about a clear transcript', () => {
		expect(signalsOf([user(), ai('hello')]).advice).toEqual([]);
	});
});

describe('routing facts', () => {
	it('reports them as given, with the standing reservation, and does not choose or change them', () => {
		const routing = describeContinuationRouting({ toolType: 'claude-code' });
		const text = formatContextSignals(signalsOf([user()], { routing }));
		expect(text).toMatch(
			/Configured routing \(read from the settings as they stand now, not from a launch: nothing below says where a turn will actually go\)/
		);
		expect(text).toMatch(/Run on: Provider\./);
		expect(signalsOf([user()], { routing }).routing).toBe(routing);
		expect(signalsOf([user()]).routing).toBeNull();
		expect(formatContextSignals(signalsOf([user()]))).not.toMatch(/Configured routing/);
	});
});

describe('the report and the contract', () => {
	function everyKey(value: unknown, keys: string[] = []): string[] {
		if (Array.isArray(value)) value.forEach((item) => everyKey(item, keys));
		else if (value && typeof value === 'object') {
			for (const [key, item] of Object.entries(value)) {
				keys.push(key);
				everyKey(item, keys);
			}
		}
		return keys;
	}

	const busyEntries = (): SignalEntry[] => [
		user('fix it'),
		edit(),
		...repeat(3, () => bash('npm test')),
		read('a.ts'),
		read('a.ts'),
		read('a.ts'),
	];

	it('invents no score, probability, confidence or saving, and counts nothing as saved', () => {
		const signals = signalsOf(busyEntries(), {
			context: { tokens: 1, window: 2, percent: 50 },
			routing: describeContinuationRouting({ toolType: 'claude-code' }),
		});
		expect(
			everyKey(signals)
				.filter((key) => key !== 'countsAsSavings')
				.filter((key) => /score|probab|confiden|saving|grade|accuracy/i.test(key))
		).toEqual([]);
		expect(signals.accounting).toEqual({ countsAsSavings: false });
		expect(JSON.stringify(signals)).not.toMatch(/\bsav(?:e|ed|ing|ings)\b|\bprobab|\bconfiden/i);
	});

	it('is deterministic, keeps no state between calls, and never changes its input', () => {
		const entries = busyEntries();
		const frozen = structuredClone(entries);
		const deepFreeze = <T>(value: T): T => {
			if (value && typeof value === 'object') {
				Object.values(value).forEach(deepFreeze);
				Object.freeze(value);
			}
			return value;
		};
		deepFreeze(entries);
		const first = signalsOf(entries);
		expect(signalsOf(entries)).toEqual(first);
		expect(entries).toEqual(frozen);
		expect(signalsOf(entries.slice(0, 2))).not.toEqual(first);
		expect(signalsOf(entries)).toEqual(first);
	});

	it('lists the newest runs, and counts the rest', () => {
		const entries = Array.from({ length: 12 }, (_, n) =>
			repeat(3, () => bash(`npm test -- ${n}`))
		).flat();
		const signals = signalsOf(entries);
		expect(signals.repetition).toHaveLength(SIGNAL_LIMITS.maxObservations);
		expect(signals.omittedRepetition).toBe(2);
		expect(signals.repetition[0].call).toBe('npm test -- 11');
		const limited = signalsOf(entries, { limits: { maxObservations: 1 } });
		expect(limited.repetition).toHaveLength(1);
		expect(limited.omittedRepetition).toBe(11);
		expect(formatContextSignals(limited)).toMatch(/11 older runs are not listed/);
	});

	it('takes the threshold from the limits, and never below what it is told', () => {
		const entries = repeat(2, () => bash('npm test'));
		expect(runsOf(entries)).toEqual([]);
		expect(runsOf(entries, { limits: { minRepeats: 2 } })).toHaveLength(1);
		expect(signalsOf(entries).limits).toEqual({ ...SIGNAL_LIMITS });
	});

	it('shows model and tool text as inert data: no control characters, no backticks, secrets redacted', () => {
		const chr = (code: number) => String.fromCharCode(code);
		const escape = chr(27);
		const override = chr(0x202e);
		const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
		const command = `echo \`id\` ${secret} ${escape}[2J${override}evil`;
		const signals = signalsOf(repeat(3, () => bash(command)));
		const text = formatContextSignals(signals);
		const [run] = signals.repetition;
		expect(run.call).not.toContain('`');
		expect(run.call).not.toContain(escape);
		expect(run.call).not.toContain(override);
		expect(text).not.toContain(secret);
		const hostile = [
			...Array.from({ length: 9 }, (_, n) => n),
			...Array.from({ length: 21 }, (_, n) => n + 11),
			127,
			...Array.from({ length: 5 }, (_, n) => 0x202a + n),
			...Array.from({ length: 4 }, (_, n) => 0x2066 + n),
		];
		expect(hostile.filter((code) => text.includes(chr(code)))).toEqual([]);
	});

	it('writes no em dash or en dash', () => {
		const banned = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);
		const text = formatContextSignals(
			signalsOf(busyEntries(), {
				routing: describeContinuationRouting({ toolType: 'claude-code' }),
			})
		);
		expect(text).not.toMatch(banned);
		expect(JSON.stringify(signalsToWire(signalsOf(busyEntries())))).not.toMatch(banned);
	});

	it('formats repetition, readiness, advice and the standing limits as plain text', () => {
		const text = formatContextSignals(signalsOf(busyEntries()));
		expect(text).toMatch(/^Signals: Direct observations from this tab's transcript/);
		expect(text).toMatch(
			/- repeated failure x3, not yet ended: `npm test` \(tool #3, tool #4, tool #5\); the same failure text each time\./
		);
		expect(text).toMatch(
			/- repeated read x3, not yet ended: `Read .*a\.ts` \(tool #6, tool #7, tool #8\); the same text each time\./
		);
		expect(text).toMatch(/- activity \[clear\]: No turn is running in this tab/);
		expect(text).toMatch(/Advice \(a report, not an action\):/);
		expect(text).toMatch(/What these cannot establish:/);
		expect(formatContextSignals(signalsOf([user(), ai('hi')]))).toMatch(
			/- None found among 0 calls compared\./
		);
	});

	it('names what ended a run in the text', () => {
		const text = formatContextSignals(
			signalsOf([...repeat(3, () => bash('npm test')), edit('b.ts')])
		);
		expect(text).toMatch(/ended by a file edit at tool #4/);
	});

	describe('the wire form', () => {
		it('is strings and counts: the same observations, readiness and unknowns, no object graph', () => {
			const signals = signalsOf(busyEntries(), {
				routing: describeContinuationRouting({ toolType: 'claude-code' }),
			});
			const wire = signalsToWire(signals);
			expect(wire.repetition.find((item) => item.kind === 'repeated-failure')).toMatchObject({
				kind: 'repeated-failure',
				call: 'npm test',
				count: 3,
				ongoing: true,
				outputs: 'identical',
				refs: ['tool #3', 'tool #4', 'tool #5'],
			});
			expect(wire.readiness.map((r) => r.id)).toEqual(signals.readiness.map((r) => r.id));
			expect(wire.routing.length).toBeGreaterThan(0);
			expect(wire.advice).toEqual(signals.advice.map((a) => a.text));
			expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
		});

		it('records what ended a run and carries no routing when none was read', () => {
			const wire = signalsToWire(signalsOf([...repeat(3, () => bash('npm test')), edit()]));
			expect(wire.repetition[0].endedBy).toBe('edit at tool #4');
			expect(wire.routing).toEqual([]);
		});
	});
});
