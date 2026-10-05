/**
 * @file bundle-import.test.ts
 * @description `maestro-cli bundle import` against real zips and a temp data
 * dir: text and JSON output, the JSON `code` of each refusal, and the exit code
 * a script branches on (2 for a usage problem, 1 for any other refusal).
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { bundleImport, type BundleImportOptions } from '../../../cli/commands/bundle';
import { ExitCode } from '../../../cli/exit-codes';
import { acquireCueEngineLock, releaseCueEngineLock } from '../../../main/cue/cue-engine-lock';
import { readSessionsStoreFile } from '../../../main/stores/sessions-store-file';
import { writeCueBundle } from '../../helpers/cueBundleFixture';

const VERSION = '0.18.6-RC';

let tmp: string;
let dataDir: string;
let projRoot: string;
let bundle: string;
let logSpy: MockInstance;
let errorSpy: MockInstance;
let exitSpy: MockInstance;

function stdout(): string {
	return logSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

function stderr(): string {
	return errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

function snapshot(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return (fs.readdirSync(dir, { recursive: true }) as string[]).sort();
}

async function run(options: BundleImportOptions, file = bundle): Promise<void> {
	await bundleImport(VERSION, file, { workspace: [`proj=${projRoot}`], dataDir, ...options });
}

/** Run an import expected to exit, returning the exit code. */
async function runExit(options: BundleImportOptions, file = bundle): Promise<number> {
	await expect(run(options, file)).rejects.toThrow('__exit__');
	return exitSpy.mock.calls[0][0] as number;
}

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-bundle-import-')));
	dataDir = path.join(tmp, 'data');
	projRoot = path.join(tmp, 'proj');
	fs.mkdirSync(projRoot);
	bundle = writeCueBundle(path.join(tmp, 'b.zip'));
	logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
	errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
	exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
		throw new Error('__exit__');
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('bundle import', () => {
	it('imports and summarizes agents, files, cue.yaml, and the secrets still to set', async () => {
		await run({});
		expect(exitSpy).not.toHaveBeenCalled();
		const out = stdout();
		expect(out).toContain(`Imported pipeline "Fixture" into ${dataDir} (created)`);
		expect(out).toContain(`Alpha (claude-code) new, works in ${projRoot}`);
		expect(out).toContain('Files: 1 new, 0 overwritten, 0 unchanged');
		expect(out).toContain('cue.yaml (proj): added tick, hook');
		expect(out).toMatch(/API_KEY {2}NOT SET {2}\(agent:Alpha\)/);
		expect(out).toMatch(/HOOK_SECRET {2}NOT SET {2}\(webhook:hook\)/);
		expect(out).not.toContain('is not set in this environment');
		expect(readSessionsStoreFile(dataDir).sessions.map((s) => s.id)).toEqual(['agent-a']);
	});

	// The deliberate exception to the data-dir guard: export and the Cue engine
	// verbs refuse a directory that does not exist, while import is how a fresh
	// server gets one. With no --data-dir it provisions the resolved directory.
	it('provisions a missing data dir resolved from MAESTRO_USER_DATA', async () => {
		const saved = process.env.MAESTRO_USER_DATA;
		const fresh = path.join(tmp, 'fresh-server');
		process.env.MAESTRO_USER_DATA = fresh;
		try {
			await bundleImport(VERSION, bundle, { workspace: [`proj=${projRoot}`] });
			expect(exitSpy).not.toHaveBeenCalled();
			expect(readSessionsStoreFile(fresh).sessions.map((s) => s.id)).toEqual(['agent-a']);
		} finally {
			if (saved === undefined) delete process.env.MAESTRO_USER_DATA;
			else process.env.MAESTRO_USER_DATA = saved;
		}
	});

	it('emits the plan as JSON', async () => {
		await run({ json: true });
		const payload = JSON.parse(stdout());
		expect(payload).toMatchObject({ success: true, applied: true, dryRun: false });
		expect(payload.plan.agents).toEqual([
			expect.objectContaining({ id: 'agent-a', action: 'create' }),
		]);
	});

	it('lists dropped environment variables', async () => {
		const file = writeCueBundle(path.join(tmp, 'env.zip'), {
			files: (files) => {
				const agent = JSON.parse(files.get('agents/agent-a.json')!);
				agent.env.values = { REGION: 'eu', LD_PRELOAD: 'x.so' };
				files.set('agents/agent-a.json', JSON.stringify(agent));
			},
		});
		await run({}, file);
		expect(stdout()).toContain('Dropped environment variables:\n  Alpha: LD_PRELOAD');
	});

	describe('--dry-run', () => {
		it('writes nothing, reports conflicts, and exits 0', async () => {
			await run({});
			fs.writeFileSync(path.join(projRoot, '.maestro/prompts/tick.md'), 'changed');
			const before = { data: snapshot(dataDir), proj: snapshot(projRoot) };
			logSpy.mockClear();

			await run({ dryRun: true });

			expect(exitSpy).not.toHaveBeenCalled();
			expect({ data: snapshot(dataDir), proj: snapshot(projRoot) }).toEqual(before);
			const out = stdout();
			expect(out).toContain('Would import pipeline "Fixture"');
			expect(out).toContain('Conflicts:');
			expect(out).toContain('[agent] Agent agent-a ("Alpha") already exists');
			expect(out).toContain('Pass --force to overwrite them.');
		});
	});

	describe('conflicts', () => {
		beforeEach(async () => {
			await run({});
			logSpy.mockClear();
		});

		it('refuses with exit 1, lists them, and says how to proceed', async () => {
			expect(await runExit({})).toBe(ExitCode.GeneralError);
			expect(stderr()).toContain('Error: The import conflicts with existing data');
			expect(stderr()).toContain('[agent] Agent agent-a ("Alpha") already exists');
			expect(stderr()).toContain('--force to overwrite');
		});

		it('carries the conflict list in the JSON details', async () => {
			expect(await runExit({ json: true })).toBe(ExitCode.GeneralError);
			const payload = JSON.parse(stdout());
			expect(payload).toMatchObject({ success: false, code: 'CONFLICTS' });
			expect(payload.details.conflicts).toEqual([
				expect.objectContaining({ kind: 'agent', target: 'agent-a' }),
			]);
		});

		it('overwrites them with --force', async () => {
			await run({ force: true });
			expect(exitSpy).not.toHaveBeenCalled();
			expect(stdout()).toContain('Conflicts (overwritten):');
		});
	});

	describe('refusals', () => {
		it('refuses shell commands when asked, with exit 1 and a code', async () => {
			const file = writeCueBundle(path.join(tmp, 'shell.zip'), {
				cue: (doc) => {
					doc.subscriptions.push({
						name: 'cleanup',
						event: 'time.heartbeat',
						agent_id: 'agent-a',
						interval_minutes: 60,
						action: 'command',
						command: { mode: 'shell', shell: 'rm -rf build' },
						prompt: 'x',
					});
				},
			});
			expect(await runExit({ rejectShellCommands: true, json: true }, file)).toBe(
				ExitCode.GeneralError
			);
			const payload = JSON.parse(stdout());
			expect(payload.code).toBe('SHELL_COMMANDS_REFUSED');
			expect(payload.details.shellCommands).toEqual([
				{ workspace: 'proj', subscription: 'cleanup', command: 'rm -rf build' },
			]);
			expect(fs.existsSync(dataDir)).toBe(false);

			exitSpy.mockClear();
			expect(await runExit({ rejectShellCommands: true }, file)).toBe(ExitCode.GeneralError);
			expect(stderr()).toContain('proj / cleanup: rm -rf build');
		});

		it('treats a malformed --workspace as a usage error (exit 2)', async () => {
			expect(await runExit({ workspace: ['proj'], json: true })).toBe(ExitCode.InvalidUsage);
			expect(JSON.parse(stdout())).toMatchObject({ code: 'INVALID_OPTIONS' });
		});

		it('names the missing --workspace flag for an unmapped workspace (exit 2)', async () => {
			expect(await runExit({ workspace: [] })).toBe(ExitCode.InvalidUsage);
			expect(stderr()).toContain('--workspace proj=<local folder>');
		});

		it('refuses while a Cue engine runs on the data dir (exit 1)', async () => {
			fs.mkdirSync(dataDir);
			expect(acquireCueEngineLock('standalone', dataDir).acquired).toBe(true);
			try {
				expect(await runExit({ json: true })).toBe(ExitCode.GeneralError);
				expect(JSON.parse(stdout()).code).toBe('ENGINE_RUNNING');
			} finally {
				releaseCueEngineLock(dataDir);
			}
		});

		it('reports an unreadable bundle with its code', async () => {
			expect(await runExit({ json: true }, path.join(tmp, 'missing.zip'))).toBe(
				ExitCode.GeneralError
			);
			expect(JSON.parse(stdout()).code).toBe('BUNDLE_UNREADABLE');
		});
	});

	describe('--agent-path', () => {
		it("writes the provider's binary path", async () => {
			const bin = path.join(tmp, 'claude');
			fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
			await run({ agentPath: [`claude-code=${bin}`] });
			const configs = JSON.parse(
				fs.readFileSync(path.join(dataDir, 'maestro-agent-configs.json'), 'utf-8')
			);
			expect(configs.configs['claude-code'].customPath).toBe(bin);
			expect(stdout()).toContain(`Binary for claude-code: ${bin} (create)`);
		});

		it('reports a different existing path as a conflict', async () => {
			fs.mkdirSync(dataDir);
			fs.writeFileSync(
				path.join(dataDir, 'maestro-agent-configs.json'),
				JSON.stringify({ configs: { 'claude-code': { customPath: '/old/claude' } } })
			);
			expect(await runExit({ agentPath: ['claude-code=/new/claude'], json: true })).toBe(
				ExitCode.GeneralError
			);
			expect(JSON.parse(stdout()).details.conflicts).toEqual([
				expect.objectContaining({ kind: 'agent-path', target: 'claude-code' }),
			]);
		});

		it('rejects an unknown tool as a usage error (exit 2)', async () => {
			expect(await runExit({ agentPath: ['nope=/bin/x'], json: true })).toBe(ExitCode.InvalidUsage);
			expect(JSON.parse(stdout()).code).toBe('INVALID_OPTIONS');
		});
	});
});
