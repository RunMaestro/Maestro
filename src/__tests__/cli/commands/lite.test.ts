import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { registerLiteCommands } from '../../../cli/commands/lite';

const directories: string[] = [];
const previousExitCode = process.exitCode;
afterEach(async () => {
	process.exitCode = previousExitCode;
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		await rm(directory, { recursive: true, force: true });
});

async function invoke(args: string[]): Promise<{ success: boolean; error: string }> {
	const program = new Command().exitOverride();
	registerLiteCommands(program);
	const log = vi.spyOn(console, 'log').mockImplementation(() => {});
	await program.parseAsync(args, { from: 'user' });
	return JSON.parse(String(log.mock.calls[0]?.[0]));
}

describe('Lite CLI contracts', () => {
	it.each([['profile', 'remove', 'host'], ['profile', 'reset-identity', 'host'], ['close']])(
		'refuses destructive %j without explicit --yes before attempting discovery',
		async (...verb) => {
			const result = await invoke([
				'lite',
				...verb,
				'--user-data',
				path.join(os.tmpdir(), 'unused-lite-path'),
			]);
			expect(result).toEqual({
				success: false,
				error: 'This destructive Lite action requires --yes.',
			});
			expect(process.exitCode).toBe(1);
		}
	);

	it('uses the explicit final isolated path for acknowledged flags and reports discovery failure as JSON', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'maestro-lite-cli-'));
		directories.push(directory);
		const result = await invoke([
			'lite',
			'--user-data',
			directory,
			'profile',
			'remove',
			'host',
			'--yes',
			'--json',
		]);
		expect(result.success).toBe(false);
		expect(result.error).toContain(`Cannot discover running Maestro Lite at ${directory}.`);
		expect(result.error).not.toContain(path.join(directory, 'Lite'));
		expect(process.exitCode).toBe(1);
	});

	it('rejects a blank explicit isolated path instead of targeting the CLI working directory', async () => {
		const result = await invoke(['lite', '--user-data', ' ', 'status']);
		expect(result).toEqual({ success: false, error: 'Lite user-data path must not be empty.' });
		expect(process.exitCode).toBe(1);
	});

	it('reports malformed profile JSON before attempting a native write', async () => {
		const directory = await mkdtemp(path.join(os.tmpdir(), 'maestro-lite-cli-'));
		directories.push(directory);
		const file = path.join(directory, 'profile.json');
		await writeFile(file, '{invalid profile}');
		const result = await invoke([
			'lite',
			'--user-data',
			directory,
			'profile',
			'save',
			'--file',
			file,
		]);
		expect(result.success).toBe(false);
		expect(result.error).toMatch(/JSON|property name/i);
		expect(result.error).not.toMatch(/discover/);
		expect(process.exitCode).toBe(1);
	});
});
