/**
 * Tests for src/shared/literalCommand.ts
 *
 * The reader is conservative on purpose: a command it cannot be sure of comes
 * back as null, because callers use it to decide what a command DID (which
 * program ran, whether two calls were the same). A wrong answer is worse than
 * none, so every shell feature that could change the meaning is a refusal.
 */

import { describe, it, expect } from 'vitest';
import { literalCommandTokens, readLiteralCommand } from '../../shared/literalCommand';

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
