/**
 * @file windowsSpawnShell.test.ts
 *
 * How an agent command reaches `child_process.spawn`, with the platform stood
 * in. The arguments used are the ones a Codex agent gets when it runs on
 * another model server (Run on): they are the only ones Maestro builds that
 * once held double quotes and spaces, which Windows PowerShell does not pass to
 * a program whole. None of this ran on Windows; these cases pin what each shell
 * is handed, so the argument that reaches Codex is the one that was written.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { planSpawnShell } from '../../../../main/process-manager/utils/windowsSpawnShell';
import { GPT_OSS_20B_ID } from '../../../../shared/local-models/model-catalog';
import {
	MODEL_SERVER_ENDPOINT_ID,
	modelServerEndpoint,
} from '../../../../shared/local-models/model-server';
import { resolveRunOnLaunch } from '../../../../shared/local-models/run-on';
import { withPlatform } from '../../../helpers/pathExpect';

/** Where npm puts the Codex shim for a Windows user whose name has a space. */
const CODEX_SHIM = 'C:\\Users\\Pat Doe\\AppData\\Roaming\\npm\\codex.cmd';
const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const PROVIDER_ARG =
	"model_providers.maestro={name='Maestro',base_url='http://127.0.0.1:52100/v1',env_key='MAESTRO_RUN_ON_KEY',wire_api='responses'}";

/** The arguments of a Codex turn that runs on the Maestro model server. */
function codexRunOnArgs(): string[] {
	const resolution = resolveRunOnLaunch({
		toolType: 'codex',
		target: { type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: GPT_OSS_20B_ID },
		endpoint: modelServerEndpoint('http://127.0.0.1:52100'),
		key: 'sk-maestro-test',
	});
	if (resolution.kind !== 'inject') throw new Error('expected the Codex recipe');
	return [...resolution.args, 'exec', '--json', '-m', resolution.harnessModel];
}

/** What cmd.exe and the C runtime make of an argument `escapeCmdArg()` wrote. */
function readCmdArg(arg: string): string {
	if (!arg.startsWith('"')) return arg;
	return arg.slice(1, -1).replace(/""/g, '"').replace(/\^\^/g, '^');
}

/** What PowerShell makes of a single-quoted literal `escapePowerShellArg()` wrote. */
function readPowerShellLiteral(arg: string): string {
	if (!arg.startsWith("'")) return arg;
	return arg.slice(1, -1).replace(/''/g, "'");
}

describe('planSpawnShell', () => {
	it('builds the Codex Run on arguments this file expects', () => {
		expect(codexRunOnArgs()).toEqual([
			'-c',
			PROVIDER_ARG,
			'-c',
			"model_provider='maestro'",
			'-c',
			'model_context_window=40960',
			'exec',
			'--json',
			'-m',
			GPT_OSS_20B_ID,
		]);
	});

	it('changes nothing off Windows: no shell, the arguments as they are', () => {
		const args = codexRunOnArgs();
		for (const platform of ['darwin', 'linux'] as const) {
			withPlatform(platform, () => {
				expect(planSpawnShell('/opt/homebrew/bin/codex', args, {})).toEqual({
					command: '/opt/homebrew/bin/codex',
					args,
					shell: false,
				});
			});
		}
	});

	it('starts a Windows .exe by its full path directly, spaces and all', () => {
		const args = codexRunOnArgs();
		withPlatform('win32', () => {
			expect(planSpawnShell('C:\\Program Files\\Codex\\codex.exe', args, {})).toEqual({
				command: 'C:\\Program Files\\Codex\\codex.exe',
				args,
				shell: false,
			});
		});
	});

	it('runs a Windows .cmd shim through cmd.exe with its path quoted and each argument whole', () => {
		const args = codexRunOnArgs();
		withPlatform('win32', () => {
			const plan = planSpawnShell(CODEX_SHIM, args, {});

			expect(plan.shell).toBe(true);
			expect(plan.autoReason).toBe('batch-file');
			// The path holds a space, and cmd.exe splits an unquoted command at it.
			expect(plan.command).toBe(`"${CODEX_SHIM}"`);
			// Nothing inside an argument had to be escaped, so nothing can be
			// unescaped wrongly on the way to the program.
			expect(plan.args.map(readCmdArg)).toEqual(args);
			expect(plan.args.join(' ')).not.toContain('""');
			expect(plan.args.join(' ')).not.toContain('^');
		});
	});

	it('hands PowerShell the Codex Run on arguments as literals with no double quote and no space', () => {
		const args = codexRunOnArgs();
		withPlatform('win32', () => {
			// What the desktop asks for on Windows: every agent goes through a shell,
			// and PowerShell is preferred over cmd.exe.
			const plan = planSpawnShell(CODEX_SHIM, args, { runInShell: true, shell: POWERSHELL });

			expect(plan.shell).toBe(POWERSHELL);
			expect(plan.args[1]).toBe(
				"'model_providers.maestro={name=''Maestro'',base_url=''http://127.0.0.1:52100/v1'',env_key=''MAESTRO_RUN_ON_KEY'',wire_api=''responses''}'"
			);
			expect(plan.args[3]).toBe("'model_provider=''maestro'''");
			expect(plan.args.map(readPowerShellLiteral)).toEqual(args);
			// Windows PowerShell passes a program an argument with its double quotes
			// dropped, and quotes it only when it holds a space. With neither in the
			// value, what it passes is the value.
			for (const arg of plan.args.map(readPowerShellLiteral)) {
				expect(arg, arg).not.toMatch(/["\s]/);
			}
		});
	});
});
