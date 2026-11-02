/**
 * @file dotEnv.test.ts
 * @description Tests for the `.env` text <-> env-var records pair.
 *
 * The invariant under test throughout: Advanced mode edits the SAME records
 * the row editor edits, so a record serialized and parsed back is unchanged,
 * and a line that cannot be committed is reported rather than silently lost.
 */

import { describe, it, expect } from 'vitest';
import {
	envVarRecordsFingerprint,
	parseDotEnv,
	serializeDotEnv,
	validateEnvVarEntry,
	validateEnvVarValue,
} from '../../shared/dotEnv';

describe('parseDotEnv', () => {
	it('reads KEY=value lines', () => {
		const result = parseDotEnv('FOO=bar\nBAZ=qux');
		expect(result.vars).toEqual({ FOO: 'bar', BAZ: 'qux' });
		expect(result.disabledVars).toEqual({});
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it('accepts a leading export', () => {
		expect(parseDotEnv('export FOO=bar\nexport   BAZ=qux').vars).toEqual({
			FOO: 'bar',
			BAZ: 'qux',
		});
	});

	it('ignores blank lines and comments', () => {
		const result = parseDotEnv('\n# provider setup\nFOO=bar\n\n   \n# done');
		expect(result.vars).toEqual({ FOO: 'bar' });
		expect(result.errors).toEqual([]);
	});

	it('splits on the first = only', () => {
		expect(parseDotEnv('KEY=a=b').vars).toEqual({ KEY: 'a=b' });
	});

	it('keeps an empty value', () => {
		expect(parseDotEnv('KEY=').vars).toEqual({ KEY: '' });
	});

	it('trims whitespace around the name and the value', () => {
		expect(parseDotEnv('  KEY =  value  ').vars).toEqual({ KEY: 'value' });
	});

	it('handles CRLF line endings', () => {
		expect(parseDotEnv('FOO=bar\r\nBAZ=qux\r\n').vars).toEqual({ FOO: 'bar', BAZ: 'qux' });
	});

	it('keeps quotes verbatim, single and double', () => {
		expect(parseDotEnv('A="hello world"\nB=\'x y\'').vars).toEqual({
			A: '"hello world"',
			B: "'x y'",
		});
	});

	it('reports a line with no = and still commits the rest', () => {
		const result = parseDotEnv('FOO=bar\nnot an assignment\nBAZ=qux');
		expect(result.vars).toEqual({ FOO: 'bar', BAZ: 'qux' });
		expect(result.errors).toEqual([{ line: 2, message: 'Expected KEY=value.' }]);
	});

	it('reports a missing name', () => {
		expect(parseDotEnv('=value').errors).toEqual([
			{ line: 1, message: 'Missing variable name before "=".' },
		]);
	});

	it('reports an invalid name and does not commit it', () => {
		const result = parseDotEnv('1BAD=x\nMY-VAR=y\nGOOD=z');
		expect(result.vars).toEqual({ GOOD: 'z' });
		expect(result.errors.map((issue) => issue.line)).toEqual([1, 2]);
		expect(result.errors[0].message).toContain('Invalid variable name');
	});

	it('applies the caller value rule per line', () => {
		const result = parseDotEnv('A=$(whoami)\nB="$(whoami)"\nCLAUDE_CONFIG_DIR=relative/dir', {
			validateValue: validateEnvVarValue,
		});
		expect(result.vars).toEqual({ B: '"$(whoami)"' });
		expect(result.errors).toEqual([
			{ line: 1, message: expect.stringContaining('disallowed special characters') },
			{ line: 3, message: 'CLAUDE_CONFIG_DIR must be an absolute path (starting with /).' },
		]);
	});

	it('enforces no value rule when the caller passes none', () => {
		expect(parseDotEnv('A=$(whoami)').vars).toEqual({ A: '$(whoami)' });
	});

	describe('duplicates', () => {
		it('lets the last one win and warns on it', () => {
			const result = parseDotEnv('FOO=1\nBAR=x\nFOO=2');
			expect(result.vars).toEqual({ FOO: '2', BAR: 'x' });
			expect(result.warnings).toEqual([
				{ line: 3, message: 'FOO is already set on line 1. This line wins.' },
			]);
		});

		it('does not let an invalid later line displace a valid earlier one', () => {
			const result = parseDotEnv('FOO=ok\nFOO=$(bad)', { validateValue: validateEnvVarValue });
			expect(result.vars).toEqual({ FOO: 'ok' });
			expect(result.errors).toHaveLength(1);
			expect(result.warnings).toEqual([]);
		});
	});

	describe('parked variables', () => {
		it('reads a commented assignment as parked when parking is on', () => {
			const result = parseDotEnv('FOO=bar\n# OFF=value\n#TIGHT=x', { parked: true });
			expect(result.vars).toEqual({ FOO: 'bar' });
			expect(result.disabledVars).toEqual({ OFF: 'value', TIGHT: 'x' });
		});

		it('treats the same line as a plain comment when parking is off', () => {
			const result = parseDotEnv('FOO=bar\n# OFF=value');
			expect(result.vars).toEqual({ FOO: 'bar' });
			expect(result.disabledVars).toEqual({});
			expect(result.errors).toEqual([]);
		});

		it('leaves prose comments alone even when parking is on', () => {
			const result = parseDotEnv('# see the docs = here\n# just a note\n# 9LIVES=no', {
				parked: true,
			});
			expect(result.disabledVars).toEqual({});
			expect(result.errors).toEqual([]);
		});

		it('never puts one key in both records: the live copy wins, with a warning', () => {
			const result = parseDotEnv('# FOO=parked\nFOO=live', { parked: true });
			expect(result.vars).toEqual({ FOO: 'live' });
			expect(result.disabledVars).toEqual({});
			expect(result.warnings).toEqual([
				{
					line: 1,
					message: 'FOO is also set on line 2, so this switched-off copy is ignored.',
				},
			]);
		});

		it('validates a parked value like a live one', () => {
			const result = parseDotEnv('# CODEX_HOME=relative', {
				parked: true,
				validateValue: validateEnvVarValue,
			});
			expect(result.disabledVars).toEqual({});
			expect(result.errors).toEqual([
				{ line: 1, message: 'CODEX_HOME must be an absolute path (starting with /).' },
			]);
		});
	});

	describe('multiline values', () => {
		const pem = [
			'BEFORE=1',
			'KEY="-----BEGIN PRIVATE KEY-----',
			'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC',
			'Zm9vYmFy==',
			'-----END PRIVATE KEY-----"',
			'AFTER=2',
		].join('\n');

		it('reports the block once, on the line that opened the quote', () => {
			const result = parseDotEnv(pem);
			expect(result.errors).toEqual([
				{
					line: 2,
					message:
						'Multiline values are not supported. The quote opened here closes on line 5, so nothing through line 5 is saved.',
				},
			]);
		});

		it('does not misread the swallowed lines as variables', () => {
			// `Zm9vYmFy==` would otherwise parse as the variable Zm9vYmFy.
			expect(parseDotEnv(pem).vars).toEqual({ BEFORE: '1', AFTER: '2' });
		});

		it('does not take an escaped quote for the end of the value', () => {
			// `\"` on the opening line is part of the value, so the quote is still
			// open and INNER belongs to the block rather than being its own variable.
			const result = parseDotEnv('CONFIG="say \\"hello\\"\nINNER=value\n"\nAFTER=1');
			expect(result.vars).toEqual({ AFTER: '1' });
			expect(result.errors).toEqual([
				{ line: 1, message: expect.stringContaining('closes on line 3') },
			]);
		});

		it('does not close the block on a line that ends in an escaped quote', () => {
			const result = parseDotEnv('K="a\nb\\"\nc"\nAFTER=1');
			expect(result.vars).toEqual({ AFTER: '1' });
			expect(result.errors).toEqual([
				{ line: 1, message: expect.stringContaining('closes on line 3') },
			]);
		});

		it('commits a value whose escaped quotes close on the same line', () => {
			const result = parseDotEnv('A="a \\"b\\" c"');
			expect(result.vars).toEqual({ A: '"a \\"b\\" c"' });
			expect(result.errors).toEqual([]);
		});

		it('closes on a final base64 chunk rather than saving it as a variable', () => {
			// `Kw=="` reads as the assignment Kw, which is why "stop at the first
			// line that looks like KEY=value" is the wrong rule.
			const result = parseDotEnv('BLOB="AAAA\nBBBB\nKw=="\nAFTER=1');
			expect(result.vars).toEqual({ AFTER: '1' });
			expect(result.errors.map((issue) => issue.line)).toEqual([1]);
		});

		it('does not let a later quoted assignment close an earlier lone quote', () => {
			// BAR="x" ends in a quote but opens one too, so it is its own variable
			// and FOO between them is not swallowed.
			const result = parseDotEnv('KEY="abc\nFOO=1\nBAR="x"');
			expect(result.vars).toEqual({ KEY: '"abc', FOO: '1', BAR: '"x"' });
			expect(result.errors).toEqual([]);
		});

		it('keeps a lone opening quote verbatim when nothing closes it', () => {
			// The row editor accepts this value, so the text mode must not drop it.
			const result = parseDotEnv('ODD="abc\nNEXT=1');
			expect(result.vars).toEqual({ ODD: '"abc', NEXT: '1' });
			expect(result.errors).toEqual([]);
		});
	});

	it('warns that an inline comment is part of the value', () => {
		const result = parseDotEnv('URL=https://example.com # prod\nHASH=abc#123\nQ="a # b"');
		expect(result.vars).toEqual({
			URL: 'https://example.com # prod',
			HASH: 'abc#123',
			Q: '"a # b"',
		});
		expect(result.warnings).toEqual([{ line: 1, message: expect.stringContaining('URL') }]);
	});
});

describe('serializeDotEnv', () => {
	it('writes live variables, then parked ones as commented assignments', () => {
		expect(serializeDotEnv({ FOO: 'bar', BAZ: 'a=b' }, { OFF: 'x' })).toBe(
			'FOO=bar\nBAZ=a=b\n# OFF=x'
		);
	});

	it('skips an unnamed row', () => {
		expect(serializeDotEnv({ '': '', FOO: 'bar' })).toBe('FOO=bar');
	});

	it('is empty for empty records', () => {
		expect(serializeDotEnv({})).toBe('');
	});

	it('writes a key held in both records once, live', () => {
		expect(serializeDotEnv({ FOO: 'live' }, { FOO: 'parked' })).toBe('FOO=live');
	});
});

describe('round trip', () => {
	it('returns the records it was given', () => {
		const vars = {
			ANTHROPIC_BASE_URL: 'https://gateway.example.com/v1?a=b&c=d',
			CLAUDE_CONFIG_DIR: '/Users/me/.claude-work',
			QUOTED: '"has $pecial; chars"',
			EMPTY: '',
		};
		const disabledVars = { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' };

		const result = parseDotEnv(serializeDotEnv(vars, disabledVars), { parked: true });

		expect(result.vars).toEqual(vars);
		expect(result.disabledVars).toEqual(disabledVars);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
	});

	it('preserves variable order', () => {
		const text = 'ZED=1\nALPHA=2\nMID=3';
		expect(serializeDotEnv(parseDotEnv(text).vars)).toBe(text);
	});
});

describe('envVarRecordsFingerprint', () => {
	it('ignores order and unnamed rows', () => {
		expect(envVarRecordsFingerprint({ A: '1', B: '2', '': '' })).toBe(
			envVarRecordsFingerprint({ B: '2', A: '1' })
		);
	});

	it('tells a parked variable from a live one', () => {
		expect(envVarRecordsFingerprint({ A: '1' })).not.toBe(envVarRecordsFingerprint({}, { A: '1' }));
	});
});

describe('validateEnvVarEntry', () => {
	it('accepts a blank name, which is a row not named yet', () => {
		expect(validateEnvVarEntry('', 'anything $(here)')).toBeNull();
	});

	it('checks the name before the value', () => {
		expect(validateEnvVarEntry('1BAD', '$(x)')).toContain('Invalid variable name');
	});

	it('accepts a Windows absolute path for a path variable', () => {
		expect(validateEnvVarEntry('CODEX_HOME', 'C:\\Users\\me\\.codex')).toBeNull();
	});
});
