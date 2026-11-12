/**
 * Tests for src/shared/literalCommand.ts
 *
 * The reader is conservative on purpose: a command it cannot be sure of comes
 * back as null, because callers use it to decide what a command DID (which
 * program ran, whether two calls were the same). A wrong answer is worse than
 * none, so every shell feature that could change the meaning is a refusal.
 */

import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../../shared/canonicalJson';
import {
	literalCommandTokens,
	readCommandCall,
	readLiteralCommand,
	type CommandCall,
} from '../../shared/literalCommand';

describe('literalCommandTokens', () => {
	it('splits on unquoted blanks and keeps quoted words whole', () => {
		expect(literalCommandTokens("rg 'npm test' checks.log")).toEqual([
			'rg',
			'npm test',
			'checks.log',
		]);
		expect(literalCommandTokens('git commit -m "a  b"')).toEqual(['git', 'commit', '-m', 'a  b']);
		expect(literalCommandTokens('echo a\tb')).toEqual(['echo', 'a', 'b']);
	});

	it('keeps the spaces inside a quoted argument, and drops the ones between arguments', () => {
		expect(literalCommandTokens("npm test -- -t 'alpha  beta'")).toEqual([
			'npm',
			'test',
			'--',
			'-t',
			'alpha  beta',
		]);
		expect(literalCommandTokens('npm    test')).toEqual(['npm', 'test']);
	});

	it('resolves escapes and joined quoting the way a shell does', () => {
		expect(literalCommandTokens('echo a\\ b')).toEqual(['echo', 'a b']);
		expect(literalCommandTokens(`echo "it's" 'say "hi"'`)).toEqual(['echo', "it's", 'say "hi"']);
		expect(literalCommandTokens("echo pre'mid dle'post")).toEqual(['echo', 'premid dlepost']);
		expect(literalCommandTokens("echo ''")).toEqual(['echo', '']);
	});

	it('records which words were written as unquoted NAME=value assignments', () => {
		const assignments = new Set<number>();
		expect(literalCommandTokens('CI=1 NODE_ENV=test npm test', assignments)).toEqual([
			'CI=1',
			'NODE_ENV=test',
			'npm',
			'test',
		]);
		expect([...assignments]).toEqual([0, 1]);

		const quoted = new Set<number>();
		literalCommandTokens("'CI=1' npm test", quoted);
		expect(quoted.size).toBe(0);
	});

	it.each([
		['a semicolon', 'cd a; npm test'],
		['and', 'cd a && npm test'],
		['or', 'npm test || true'],
		['a pipe', 'npm test | tail -5'],
		['a background marker', 'npm test &'],
		['an output redirect', 'npm test > out.log'],
		['an input redirect', 'npm test < in.txt'],
		['a subshell', '(cd a && npm test)'],
		['a comment', 'echo hi # npm test'],
		['a glob', 'ls src/*.ts'],
		['a question glob', 'ls src/?.ts'],
		['a bracket', 'ls src/[ab].ts'],
		['a brace', 'echo {a,b}'],
		['a home shortcut', 'ls ~/src'],
		['a variable', 'echo $HOME'],
		['a command substitution', 'echo `date`'],
		['a dollar substitution', 'echo "$(date)"'],
		['a line break', 'npm test\nnpm run lint'],
		['an unclosed quote', "echo 'oops"],
		['a trailing backslash', 'echo oops\\'],
	])('refuses %s', (_name, command) => {
		expect(literalCommandTokens(command)).toBeNull();
	});

	it('reads an empty command as no words', () => {
		expect(literalCommandTokens('')).toEqual([]);
		expect(literalCommandTokens('   ')).toEqual([]);
	});

	it('does not evaluate or refuse an operator that is only quoted text', () => {
		expect(literalCommandTokens('echo "a && b | c; d"')).toEqual(['echo', 'a && b | c; d']);
		expect(literalCommandTokens("grep '#' file")).toEqual(['grep', '#', 'file']);
	});
});

describe('readLiteralCommand', () => {
	it('returns the program and arguments after any leading assignments', () => {
		expect(readLiteralCommand('CI=1 npx vitest run src/a.test.ts')?.words).toEqual([
			'npx',
			'vitest',
			'run',
			'src/a.test.ts',
		]);
		expect(readLiteralCommand('  npm test  ')?.words).toEqual(['npm', 'test']);
	});

	it('treats a quoted NAME=value as the program, not as an assignment', () => {
		expect(readLiteralCommand("'CI=1' npm test")?.words).toEqual(['CI=1', 'npm', 'test']);
	});

	it('treats a NAME=value that follows the program as an argument, not an assignment', () => {
		expect(readLiteralCommand('make test CC=gcc')?.words).toEqual(['make', 'test', 'CC=gcc']);
	});

	it('gives equal keys to the same invocation, whatever the spacing between arguments', () => {
		expect(readLiteralCommand('npm   test -- -t x')?.key).toBe(
			readLiteralCommand('npm test -- -t x')?.key
		);
		expect(readLiteralCommand("npm test -- -t 'x'")?.key).toBe(
			readLiteralCommand('npm test -- -t x')?.key
		);
	});

	it('gives different keys to different arguments, including spacing INSIDE an argument', () => {
		expect(readLiteralCommand("npm test -- -t 'alpha  beta'")?.key).not.toBe(
			readLiteralCommand("npm test -- -t 'alpha beta'")?.key
		);
		expect(readLiteralCommand('npm test -- -t Alpha')?.key).not.toBe(
			readLiteralCommand('npm test -- -t alpha')?.key
		);
		expect(readLiteralCommand('CI=1 npm test')?.key).not.toBe(readLiteralCommand('npm test')?.key);
	});

	it('builds its key with canonicalJson, keeping assignments and directories apart from the arguments', () => {
		const read = readLiteralCommand("cd a && CI=1 npm test -- 'x y'");
		expect(read?.key).toBe(
			canonicalJson({ argv: ['npm', 'test', '--', 'x y'], cd: ['a'], set: ['CI=1'] })
		);
		expect(readLiteralCommand('npm test')?.key).toBe(canonicalJson({ argv: ['npm', 'test'] }));
	});

	it('reads past a leading literal `cd <path> &&` and keeps the directory in the key', () => {
		const here = readLiteralCommand('cd packages/app && npx vitest run');
		expect(here?.words).toEqual(['npx', 'vitest', 'run']);
		expect(here?.key).not.toBe(readLiteralCommand('npx vitest run')?.key);
		expect(here?.key).not.toBe(readLiteralCommand('cd packages/web && npx vitest run')?.key);
		expect(readLiteralCommand("cd 'my app' && ls")?.words).toEqual(['ls']);
		expect(readLiteralCommand('cd "my app" && ls')?.key).toBe(
			readLiteralCommand("cd 'my app' && ls")?.key
		);
		expect(readLiteralCommand('cd a && cd b && make test')?.words).toEqual(['make', 'test']);
	});

	it.each([
		['a cd joined by a semicolon', 'cd a; npm test'],
		['a cd joined by ||', 'cd a || npm test'],
		['a cd with an expansion', 'cd $APP && npm test'],
		['a cd to a home shortcut', 'cd ~/app && npm test'],
		['a cd after the command', 'npm test && cd a'],
		['a command chained after the cd', 'cd a && npm test && echo ok'],
		['a piped command after the cd', 'cd a && npm test | tail -5'],
		['a redirected command', 'npm test 2>&1'],
		['only assignments', 'CI=1'],
		['nothing', ''],
	])('reads nothing from %s', (_name, command) => {
		expect(readLiteralCommand(command)).toBeNull();
	});
});

describe('readCommandCall', () => {
	const key = (call: CommandCall): string => readCommandCall(call).key;

	describe('a command line', () => {
		it('gives the words and the key of readLiteralCommand, whatever context is absent', () => {
			const read = readCommandCall({ text: "CI=1 npm   test -- -t 'a b'" });
			expect(read.words).toEqual(['npm', 'test', '--', '-t', 'a b']);
			expect(read.key).toBe(canonicalJson({ argv: read.words, set: ['CI=1'] }));
		});
	});

	describe('an argv array', () => {
		it('keeps each element as one argument, so a space inside one is not a boundary', () => {
			const joined = readCommandCall({
				text: "npm test -- -t 'alpha beta'",
				argv: ['npm', 'test', '--', '-t', 'alpha beta'],
			});
			const split = readCommandCall({
				text: 'npm test -- -t alpha beta',
				argv: ['npm', 'test', '--', '-t', 'alpha', 'beta'],
			});

			expect(joined.words).toEqual(['npm', 'test', '--', '-t', 'alpha beta']);
			expect(split.words).toEqual(['npm', 'test', '--', '-t', 'alpha', 'beta']);
			expect(joined.key).not.toBe(split.key);
		});

		it('is the same invocation as the line a shell would split into those arguments', () => {
			expect(key({ text: 'npm test', argv: ['npm', 'test'] })).toBe(key({ text: 'npm   test' }));
			expect(key({ text: 'shown', argv: ['npm', 'test', '--', '-t', 'alpha beta'] })).toBe(
				key({ text: "npm test -- -t 'alpha beta'" })
			);
		});

		it('takes its identity from the elements, never from the display text', () => {
			expect(key({ text: 'one thing', argv: ['npm', 'test'] })).toBe(
				key({ text: 'another thing', argv: ['npm', 'test'] })
			);
		});

		it('reads no shell syntax in an element', () => {
			const read = readCommandCall({ text: 'x', argv: ['echo', 'a;b | c', '$HOME', '*.ts'] });
			expect(read.words).toEqual(['echo', 'a;b | c', '$HOME', '*.ts']);
		});

		it('does not read a NAME=value element as an assignment', () => {
			const argv = readCommandCall({ text: 'CI=1 npm test', argv: ['CI=1', 'npm', 'test'] });
			const line = readCommandCall({ text: 'CI=1 npm test' });

			expect(argv.words).toEqual(['CI=1', 'npm', 'test']);
			expect(line.words).toEqual(['npm', 'test']);
			expect(argv.key).not.toBe(line.key);
		});

		it('cannot be read when empty, and is then keyed by its text', () => {
			const read = readCommandCall({ text: ' x ', argv: [] });
			expect(read.words).toBeNull();
			expect(read.key).toBe(canonicalJson({ text: 'x' }));
		});
	});

	describe('the directory and variables a call names', () => {
		it('put the directory in the key, for a line, an argv array and an unreadable line alike', () => {
			for (const call of [
				{ text: 'npm test' },
				{ text: 'npm test', argv: ['npm', 'test'] },
				{ text: 'npm test | tail -5' },
			]) {
				expect(key({ ...call, cwd: '/repo/one' })).not.toBe(key({ ...call, cwd: '/repo/two' }));
				expect(key({ ...call, cwd: '/repo/one' })).toBe(key({ ...call, cwd: '/repo/one' }));
			}
		});

		it('keep a call that names a directory apart from one that names none', () => {
			expect(key({ text: 'npm test', cwd: '/repo/one' })).not.toBe(key({ text: 'npm test' }));
			expect(key({ text: 'npm test | tail', cwd: '/repo/one' })).not.toBe(
				key({ text: 'npm test | tail' })
			);
		});

		it('treat a blank directory as none', () => {
			expect(key({ text: 'npm test', cwd: '' })).toBe(key({ text: 'npm test' }));
		});

		it('put the variables in the key, in any order, and an empty set is no set', () => {
			const ci = { text: 'npm test', env: { CI: '1', NODE_ENV: 'test' } };
			expect(key(ci)).toBe(key({ text: 'npm test', env: { NODE_ENV: 'test', CI: '1' } }));
			expect(key(ci)).not.toBe(key({ text: 'npm test', env: { CI: '1' } }));
			expect(key(ci)).not.toBe(key({ text: 'npm test', env: { CI: '0', NODE_ENV: 'test' } }));
			expect(key({ text: 'npm test', env: {} })).toBe(key({ text: 'npm test' }));
		});

		it('do not change the words', () => {
			const read = readCommandCall({ text: 'npm test', cwd: '/repo', env: { CI: '1' } });
			expect(read.words).toEqual(['npm', 'test']);
		});

		it('stay apart from a leading `cd` the command line itself holds', () => {
			expect(key({ text: 'cd /repo/one && npm test' })).not.toBe(
				key({ text: 'npm test', cwd: '/repo/one' })
			);
		});
	});

	describe('a call that cannot be read', () => {
		it('has no words, and is the same invocation only by exact text', () => {
			const same = readCommandCall({ text: 'npm test | tail -5' });
			expect(same.words).toBeNull();
			expect(key({ text: ' npm test | tail -5 ' })).toBe(same.key);
			expect(key({ text: 'npm test | tail -9' })).not.toBe(same.key);
			expect(key({ text: 'npm  test | tail -5' })).not.toBe(same.key);
		});

		it('can never take the key of a readable call, even one whose JSON it spells out', () => {
			expect(key({ text: 'npm test | tail' })).not.toBe(key({ text: 'npm test' }));
			expect(key({ text: '{"argv":["npm","test"]}' })).not.toBe(key({ text: 'npm test' }));
		});
	});
});
