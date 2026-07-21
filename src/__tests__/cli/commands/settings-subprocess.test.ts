import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const cliEntry = resolve(process.cwd(), 'src/cli/index.ts');
const dataDirectories: string[] = [];

function runCli(...args: string[]) {
	const dataDirectory = mkdtempSync(resolve(tmpdir(), 'maestro-settings-cli-'));
	dataDirectories.push(dataDirectory);
	return spawnSync('bun', [cliEntry, ...args], {
		cwd: process.cwd(),
		env: { ...process.env, MAESTRO_USER_DATA: dataDirectory },
		encoding: 'utf8',
	});
}

function runCliWithData(dataDirectory: string, ...args: string[]) {
	return spawnSync('bun', [cliEntry, ...args], {
		cwd: process.cwd(),
		env: { ...process.env, MAESTRO_USER_DATA: dataDirectory },
		encoding: 'utf8',
	});
}

function createDataDirectory(): string {
	const dataDirectory = mkdtempSync(resolve(tmpdir(), 'maestro-settings-cli-'));
	dataDirectories.push(dataDirectory);
	return dataDirectory;
}

function parseJsonLine(output: string): Record<string, unknown> {
	return JSON.parse(output.trim()) as Record<string, unknown>;
}

function settingsStderr(stderr: string): string {
	return stderr.replace(/^\[Logger\].*\r?\n/gm, '');
}

afterEach(() => {
	for (const dataDirectory of dataDirectories.splice(0)) {
		rmSync(dataDirectory, { recursive: true, force: true });
	}
});

describe('settings CLI subprocess contracts', () => {
	it.each([
		['colorBlindMode', 'true', true],
		['fontSize', '16', 16],
		['customThemeColors', '{"accent":"#abc"}', { accent: '#abc' }],
		['fontFamily', 'Fira Code', 'Fira Code'],
	])('writes %s with its established CLI coercion and JSONL envelope', (key, input, expected) => {
		const dataDirectory = createDataDirectory();
		const result = runCliWithData(dataDirectory, 'settings', 'set', key, input, '--json');

		expect(result.status).toBe(0);
		expect(settingsStderr(result.stderr)).toBe('');
		expect(parseJsonLine(result.stdout)).toMatchObject({
			type: 'setting_set',
			key,
			newValue: expected,
		});
		expect(
			JSON.parse(readFileSync(resolve(dataDirectory, 'maestro-settings.json'), 'utf8'))
		).toMatchObject({
			[key]: expected,
		});
	});

	it('keeps leading-zero and malformed JSON values as strings', () => {
		const dataDirectory = createDataDirectory();
		const leadingZero = runCliWithData(
			dataDirectory,
			'settings',
			'set',
			'fontFamily',
			'007',
			'--json'
		);
		const malformed = runCliWithData(
			dataDirectory,
			'settings',
			'set',
			'fontFamily',
			'{not json}',
			'--json'
		);

		expect(parseJsonLine(leadingZero.stdout)).toMatchObject({ newValue: '007' });
		expect(parseJsonLine(malformed.stdout)).toMatchObject({ newValue: '{not json}' });
	});

	it('retains success stdout and warning stderr for unknown settings', () => {
		const result = runCli('settings', 'set', 'unknownSetting', 'value');

		expect(result.status).toBe(0);
		expect(result.stdout).toBe('✓ unknownSetting = "value"\n');
		expect(settingsStderr(result.stderr)).toBe(
			'⚠ "unknownSetting" is not a known setting. Writing anyway.\n'
		);
	});

	it('retains JSON error stderr and exit code for a missing setting', () => {
		const result = runCli('settings', 'get', 'missingSetting', '--json');

		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
		expect(settingsStderr(result.stderr)).toBe(
			'{"error":"Unknown setting: \\"missingSetting\\". Use \\"maestro-cli settings list --keys-only\\" to see all available keys."}\n'
		);
	});

	it('retains JSON error stderr and exit code for malformed --raw JSON', () => {
		const result = runCli('settings', 'set', 'fontSize', 'ignored', '--raw', '{', '--json');

		expect(result.status).toBe(1);
		expect(result.stdout).toBe('');
		expect(parseJsonLine(settingsStderr(result.stderr))).toMatchObject({
			error: expect.stringMatching(/^Invalid JSON in --raw:/),
		});
	});

	it('preserves agent settings parsing and output envelopes', () => {
		const dataDirectory = createDataDirectory();
		const result = runCliWithData(
			dataDirectory,
			'settings',
			'agent',
			'set',
			'codex',
			'contextWindow',
			'128000',
			'--json'
		);

		expect(result.status).toBe(0);
		expect(settingsStderr(result.stderr)).toBe('');
		expect(parseJsonLine(result.stdout)).toMatchObject({
			type: 'setting_set',
			agentId: 'codex',
			key: 'contextWindow',
			newValue: 128000,
		});
	});
});
