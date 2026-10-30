import { describe, expect, it } from 'vitest';
import {
	cmdShellArgProblem,
	cmdShellArgsRefusal,
} from '../../../../shared/maestro-lib/launch/windows-command';

// The cmd.exe behaviour these pin is read from documented parser rules, not run
// here: only the windows-latest CI leg has a real cmd.exe. main has no
// maestro-lib yet and keeps a private copy of this rule in cue-spawn-builder.ts,
// whose tests run the same cases: change both together until main has it.
describe('cmdShellArgProblem', () => {
	it.each([
		['a trailing percent', '100%'],
		['a URL escape', '%20'],
		['a percent in prose', '50% off'],
		['an empty pair', '%%'],
		['a doubled trailing percent', '100%%'],
		['a plain argument', '--print'],
		['an argument with spaces and quotes', 'say "hi" & more'],
	])('lets %s through', (_label, arg) => {
		expect(cmdShellArgProblem(arg)).toBeNull();
	});

	it.each([
		['a plain variable', '%PATH%'],
		['a name with parentheses', '%ProgramFiles(x86)%'],
		['a substring form', '%PATH:~0,3%'],
		['a substitution form', '%X:a=b%'],
		['a name with a space', '%a b%'],
		['a drive variable', '%=C:%'],
		['a pair inside doubled percents', '%%PATH%%'],
		['a pair inside a value', '--settings=%APPDATA%\\claude.json'],
		['two lone percents in one argument', '50% off, then 20% more'],
	])('refuses %s', (_label, arg) => {
		expect(cmdShellArgProblem(arg)).toBe(
			'it contains a %NAME% pair, which cmd.exe expands as a variable'
		);
	});

	it.each(['first\nsecond', 'first\r\nsecond', 'first\rsecond'])(
		'refuses a line break (%j)',
		(arg) => {
			expect(cmdShellArgProblem(arg)).toBe(
				'it contains a line break, which ends a cmd.exe command line'
			);
		}
	);

	it('refuses a caret', () => {
		expect(cmdShellArgProblem('match ^main$')).toBe(
			'it contains ^, which cmd.exe would pass on doubled'
		);
	});
});

describe('cmdShellArgsRefusal', () => {
	const SECRET = 'sk-%SECRET%-value';

	it('is null when every argument is safe', () => {
		expect(cmdShellArgsRefusal(['--print', '100%', '%20', '50% off'])).toBeNull();
	});

	it('names a --flag=value argument by its flag and never quotes the value', () => {
		const refusal = cmdShellArgsRefusal(['--print', `--api-key=${SECRET}`]);

		expect(refusal).toBe(
			'cannot pass the value of --api-key intact: it contains a %NAME% pair, which cmd.exe expands as a variable'
		);
		expect(refusal).not.toContain('SECRET');
	});

	it('names the value of a --flag value pair by its flag', () => {
		const refusal = cmdShellArgsRefusal(['--print', '--api-key', SECRET]);

		expect(refusal).toContain('cannot pass the value of --api-key intact');
		expect(refusal).not.toContain('SECRET');
	});

	it('names an argument that follows no flag by its position', () => {
		const refusal = cmdShellArgsRefusal(['--print', '--', 'ab^cd']);

		expect(refusal).toContain('cannot pass argument 3 intact');
		expect(refusal).not.toContain('ab^cd');
	});

	it('does not name a value by a flag that carries a value of its own', () => {
		const refusal = cmdShellArgsRefusal(['-pSECRET', '%APPDATA%']);

		expect(refusal).toContain('cannot pass argument 2 intact');
		expect(refusal).not.toContain('SECRET');
	});

	it('calls one of the prompt arguments "the prompt"', () => {
		const prompt = 'Use %USERPROFILE% as the root';

		expect(cmdShellArgsRefusal(['--print', '--', prompt], new Set([prompt]))).toContain(
			'cannot pass the prompt intact'
		);
	});

	it('reports the first argument cmd.exe cannot carry', () => {
		expect(cmdShellArgsRefusal(['a^b', '%PATH%'])).toContain('argument 1');
	});
});
