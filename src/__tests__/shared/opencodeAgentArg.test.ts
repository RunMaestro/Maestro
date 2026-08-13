/**
 * Tests for src/shared/opencodeAgentArg.ts
 *
 * The OpenCode agent picker stores its value inside the per-agent Custom CLI
 * Args string, so these helpers must round-trip cleanly and never disturb the
 * other arguments a user has typed there.
 */

import { describe, it, expect } from 'vitest';
import { readOpenCodeAgentArg, writeOpenCodeAgentArg } from '../../shared/opencodeAgentArg';

describe('readOpenCodeAgentArg', () => {
	it('returns empty string for undefined or empty input', () => {
		expect(readOpenCodeAgentArg(undefined)).toBe('');
		expect(readOpenCodeAgentArg('')).toBe('');
	});

	it('returns empty string when no --agent flag is present', () => {
		expect(readOpenCodeAgentArg('--model anthropic/claude-sonnet-4-20250514')).toBe('');
	});

	it('reads the `--agent name` form', () => {
		expect(readOpenCodeAgentArg('--agent prometheus')).toBe('prometheus');
	});

	it('reads the `--agent=name` form', () => {
		expect(readOpenCodeAgentArg('--agent=prometheus')).toBe('prometheus');
	});

	it('reads the value from the middle of a longer arg string', () => {
		expect(readOpenCodeAgentArg('--foo bar --agent sisyphus --baz')).toBe('sisyphus');
	});

	it('unquotes a quoted value', () => {
		expect(readOpenCodeAgentArg('--agent "my agent"')).toBe('my agent');
		expect(readOpenCodeAgentArg("--agent='my agent'")).toBe('my agent');
	});

	it('ignores a dangling --agent with no value', () => {
		expect(readOpenCodeAgentArg('--agent')).toBe('');
		expect(readOpenCodeAgentArg('--agent --verbose')).toBe('');
	});
});

describe('writeOpenCodeAgentArg', () => {
	it('appends the flag when the arg string is empty', () => {
		expect(writeOpenCodeAgentArg('', 'prometheus')).toBe('--agent prometheus');
		expect(writeOpenCodeAgentArg(undefined, 'prometheus')).toBe('--agent prometheus');
	});

	it('appends the flag while preserving existing args', () => {
		expect(writeOpenCodeAgentArg('--verbose --foo bar', 'plan')).toBe(
			'--verbose --foo bar --agent plan'
		);
	});

	it('replaces an existing value in place', () => {
		expect(writeOpenCodeAgentArg('--foo --agent build --bar', 'plan')).toBe(
			'--foo --agent plan --bar'
		);
	});

	it('normalizes the `--agent=name` form when replacing', () => {
		expect(writeOpenCodeAgentArg('--agent=build --bar', 'plan')).toBe('--agent plan --bar');
	});

	it('removes the flag when the name is empty or whitespace', () => {
		expect(writeOpenCodeAgentArg('--foo --agent build --bar', '')).toBe('--foo --bar');
		expect(writeOpenCodeAgentArg('--agent build', '   ')).toBe('');
	});

	it('collapses duplicate --agent flags down to the first position', () => {
		expect(writeOpenCodeAgentArg('--agent build --foo --agent other', 'plan')).toBe(
			'--agent plan --foo'
		);
	});

	it('drops a dangling --agent with no value', () => {
		expect(writeOpenCodeAgentArg('--foo --agent', 'plan')).toBe('--foo --agent plan');
	});

	it('quotes values containing whitespace', () => {
		expect(writeOpenCodeAgentArg('', 'my agent')).toBe('--agent "my agent"');
	});

	it('trims the provided name', () => {
		expect(writeOpenCodeAgentArg('', '  plan  ')).toBe('--agent plan');
	});

	it('round-trips through read', () => {
		const written = writeOpenCodeAgentArg('--model gpt-5.2', 'oracle');
		expect(readOpenCodeAgentArg(written)).toBe('oracle');
	});

	// tokenize() has no escape syntax, so a quote in the name cannot round-trip.
	// Stripping keeps the argument list well-formed; emitting it raw split the
	// name in two and turned the tail into a separate argument.
	it('strips quote characters instead of corrupting the argument list', () => {
		const written = writeOpenCodeAgentArg('--print', 'my"agent');
		expect(readOpenCodeAgentArg(written)).toBe('myagent');
		expect(written).toContain('--print');
	});

	it('strips single quotes too', () => {
		const written = writeOpenCodeAgentArg('--print', "o'brien");
		expect(readOpenCodeAgentArg(written)).toBe('obrien');
	});

	it('still quotes a name containing whitespace', () => {
		const written = writeOpenCodeAgentArg('', 'my agent');
		expect(readOpenCodeAgentArg(written)).toBe('my agent');
	});

	it('leaves a plain name unquoted', () => {
		expect(writeOpenCodeAgentArg('', 'build')).toBe('--agent build');
	});
});
