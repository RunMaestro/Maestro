import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	formatHostStatus,
	hostLogFilePath,
	hostStart,
	hostStatus,
	hostStop,
	type DetachedChild,
	type HostCommandDeps,
} from '../../../cli/commands/host';
import {
	readCliServerInfoFrom,
	writeCliServerInfoTo,
	type HostStatusReport,
	type HostStopReply,
} from '../../../shared/maestro-lib';

const report = (overrides: Partial<HostStatusReport> = {}): HostStatusReport => ({
	pid: 812,
	startedAt: 1,
	uptimeMs: 3_725_000,
	version: '1.2.3',
	lock: { pid: 812, mode: 'host', startedAt: '2026-10-04T12:00:00.000Z' },
	clients: 2,
	work: { turns: 0, runs: [] },
	cue: { state: 'running' },
	...overrides,
});

describe('maestro-cli host', () => {
	let dir: string;
	let out: string[];
	let err: string[];

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-host-cmd-'));
		out = [];
		err = [];
		process.exitCode = undefined;
		vi.spyOn(console, 'log').mockImplementation((line: unknown) => void out.push(String(line)));
		vi.spyOn(console, 'error').mockImplementation((line: unknown) => void err.push(String(line)));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	const publish = (pid: number, port = 4000) =>
		writeCliServerInfoTo(dir, {
			port,
			token: 't',
			pid,
			startedAt: Date.now(),
			cliSecret: 's',
			hostKind: 'headless',
		});

	/** Deps where the child is a pid this process owns, and time does not pass. */
	function deps(overrides: Partial<HostCommandDeps> = {}): HostCommandDeps {
		return {
			spawnDetached: vi.fn(() => ({ pid: process.pid, exited: () => undefined })),
			requestStatus: vi.fn(async () => report()),
			requestStop: vi.fn(async () => ({ stopping: true }) as HostStopReply),
			isPidAlive: (pid) => pid === process.pid,
			sleep: async () => undefined,
			cliScript: '/bundle/maestro-cli.js',
			...overrides,
		};
	}

	describe('start', () => {
		it('re-runs the bundle detached with the directory resolved, and reports what the child published', async () => {
			const spawnDetached = vi.fn((_args: string[]): DetachedChild => {
				publish(process.pid, 4321);
				return { pid: process.pid, exited: () => undefined };
			});
			await hostStart({ dataDir: dir, port: 5000 }, undefined, deps({ spawnDetached }));

			const [args, env, logFile] = spawnDetached.mock.calls[0] as unknown as [
				string[],
				NodeJS.ProcessEnv,
				string,
			];
			expect(args).toEqual([
				'/bundle/maestro-cli.js',
				'host',
				'start',
				'--foreground',
				'--data-dir',
				dir,
				'--port',
				'5000',
			]);
			expect(env.MAESTRO_USER_DATA).toBe(dir);
			expect(logFile).toBe(hostLogFilePath(dir));
			expect(out.join('\n')).toContain('Host started (pid');
			expect(out.join('\n')).toContain('port 4321');
			expect(process.exitCode).toBeUndefined();
		});

		it('does not start a second host', async () => {
			publish(process.pid);
			const d = deps();
			await hostStart({ dataDir: dir }, undefined, d);
			expect(d.spawnDetached).not.toHaveBeenCalled();
			expect(out.join('\n')).toContain('already running');
		});

		it('prints the log tail when the child dies before it is ready', async () => {
			fs.mkdirSync(path.dirname(hostLogFilePath(dir)), { recursive: true });
			fs.writeFileSync(
				hostLogFilePath(dir),
				'one\nAnother Maestro TUI holds this data directory.\n'
			);
			await hostStart(
				{ dataDir: dir },
				undefined,
				deps({ spawnDetached: () => ({ pid: 999_999, exited: () => ({ code: 1 }) }) })
			);
			expect(err.join('\n')).toContain('exited before it was ready');
			expect(err.join('\n')).toContain('holds this data directory');
			expect(process.exitCode).toBe(1);
		});

		it('fails when no process could be spawned', async () => {
			await hostStart(
				{ dataDir: dir },
				undefined,
				deps({ spawnDetached: () => ({ pid: undefined, exited: () => undefined }) })
			);
			expect(process.exitCode).toBe(1);
		});

		it('says so as JSON for a script', async () => {
			await hostStart(
				{ dataDir: dir, json: true },
				undefined,
				deps({
					spawnDetached: () => {
						publish(process.pid, 4321);
						return { pid: process.pid, exited: () => undefined };
					},
				})
			);
			expect(JSON.parse(out[0])).toMatchObject({ started: true, pid: process.pid, port: 4321 });
		});
	});

	describe('status', () => {
		it('prints the pid, uptime, lock, clients, work, and Cue', async () => {
			await hostStatus({ dataDir: dir }, deps());
			const text = out.join('\n');
			expect(text).toContain('Host: pid 812, up 1h 2m, version 1.2.3');
			expect(text).toContain('Lock: host pid 812');
			expect(text).toContain('Clients: 2');
			expect(text).toContain('Work: idle');
			expect(text).toContain('Cue: running');
		});

		it('names the work in flight and the holder of the Cue lock', () => {
			const text = formatHostStatus(
				report({
					work: {
						turns: 1,
						runs: [{ agentId: 'a1', kind: 'playbook', startedAt: 1, paused: true }],
					},
					cue: { state: 'held', mode: 'standalone', pid: 5 },
				})
			);
			expect(text).toContain('1 turn, playbook run on a1 (paused)');
			expect(text).toContain('not running here: standalone pid 5 holds the Cue lock');
		});

		it('names group chat rounds and consults a stop would cut off', () => {
			const text = formatHostStatus(
				report({ work: { turns: 0, runs: [], rounds: 2, consults: 1 } })
			);
			expect(text).toContain('Work: 0 turns, 2 group chat rounds, 1 consult');
			// A host that predates them reports neither, and that is simply idle.
			expect(formatHostStatus(report({ work: { turns: 0, runs: [] } }))).toContain('Work: idle');
		});

		it('reports no host with the not-running exit code', async () => {
			await hostStatus(
				{ dataDir: dir },
				deps({
					requestStatus: async () => {
						throw new Error('Maestro desktop app is not running');
					},
				})
			);
			expect(out.join('\n')).toBe('No host is running.');
			expect(process.exitCode).toBe(3);
		});

		it('says a live pid that does not answer is not a stopped host', async () => {
			publish(process.pid);
			await hostStatus(
				{ dataDir: dir },
				deps({
					requestStatus: async () => {
						throw new Error('Connection to Maestro timed out');
					},
				})
			);
			expect(out.join('\n')).toContain(`Pid ${process.pid} is alive but did not answer`);
			expect(process.exitCode).toBe(3);
		});
	});

	describe('stop', () => {
		it('has nothing to do without a host', async () => {
			const d = deps();
			await hostStop({ dataDir: dir }, d);
			expect(out.join('\n')).toBe('No host is running.');
			expect(d.requestStop).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		});

		it('refuses while work is in flight, and names it', async () => {
			publish(process.pid);
			await hostStop(
				{ dataDir: dir },
				deps({
					requestStop: async () => ({
						stopping: false,
						reason: 'work-in-flight',
						work: { turns: 2, runs: [] },
					}),
				})
			);
			expect(err.join('\n')).toContain('2 turns');
			expect(err.join('\n')).toContain('--force');
			expect(process.exitCode).toBe(1);
		});

		it('refuses while only a group chat round is running', async () => {
			publish(process.pid);
			await hostStop(
				{ dataDir: dir },
				deps({
					requestStop: async () => ({
						stopping: false,
						reason: 'work-in-flight',
						work: { turns: 0, runs: [], rounds: 1 },
					}),
				})
			);
			expect(err.join('\n')).toContain('1 group chat round');
			expect(process.exitCode).toBe(1);
		});

		it('passes --force through and waits for the process to go', async () => {
			publish(process.pid);
			let alive = true;
			const requestStop = vi.fn(async () => {
				setTimeout(() => (alive = false), 0);
				return { stopping: true } as HostStopReply;
			});
			await hostStop(
				{ dataDir: dir, force: true },
				deps({
					requestStop,
					isPidAlive: () => alive,
					sleep: () => new Promise((r) => setTimeout(r, 5)),
				})
			);
			expect(requestStop).toHaveBeenCalledWith(dir, { force: true });
			expect(out.join('\n')).toContain('Host stopped');
			expect(process.exitCode).toBeUndefined();
		});

		it('leaves the discovery file to the host that is stopping', async () => {
			publish(process.pid);
			await hostStop({ dataDir: dir }, deps({ isPidAlive: () => false }));
			// Only the host unpublishes itself; the command never deletes it.
			expect(readCliServerInfoFrom(dir)?.pid).toBe(process.pid);
		});
	});
});
