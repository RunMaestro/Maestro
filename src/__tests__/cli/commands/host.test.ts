import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createSignalDrain,
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
	type HostWork,
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

	/** Deps where the child is a pid this process owns, and time passes only by sleeping. */
	function deps(overrides: Partial<HostCommandDeps> = {}): HostCommandDeps {
		let clock = 0;
		return {
			spawnDetached: vi.fn(() => ({ pid: process.pid, exited: () => undefined })),
			requestStatus: vi.fn(async () => report()),
			requestStop: vi.fn(async () => ({ stopping: true }) as HostStopReply),
			isPidAlive: (pid) => pid === process.pid,
			sleep: async (ms) => {
				clock += ms;
			},
			now: () => clock,
			cliScript: '/bundle/maestro-cli.js',
			...overrides,
		};
	}

	const busy = (work: Partial<HostWork> = {}): HostStopReply => ({
		stopping: false,
		reason: 'work-in-flight',
		work: { turns: 1, runs: [], ...work },
	});

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

		it('says the desktop app holds the directory, and fails, instead of calling it a running host', async () => {
			// A desktop's discovery file has no `hostKind`.
			writeCliServerInfoTo(dir, {
				port: 4000,
				token: 't',
				pid: process.pid,
				startedAt: Date.now(),
			});
			const d = deps();
			await hostStart({ dataDir: dir }, undefined, d);

			expect(d.spawnDetached).not.toHaveBeenCalled();
			expect(err.join('\n')).toContain('desktop app is running on this data directory');
			expect(out.join('\n')).not.toContain('already running');
			expect(process.exitCode).toBe(1);
		});

		it('says the same as JSON, with a non-zero exit', async () => {
			writeCliServerInfoTo(dir, {
				port: 4000,
				token: 't',
				pid: process.pid,
				startedAt: Date.now(),
			});
			await hostStart({ dataDir: dir, json: true }, undefined, deps());

			expect(JSON.parse(out[0])).toMatchObject({
				started: false,
				reason: 'desktop-running',
				pid: process.pid,
			});
			expect(process.exitCode).toBe(1);
		});

		const startedWith = (requestStatus: HostCommandDeps['requestStatus'], json = false) =>
			hostStart(
				{ dataDir: dir, json },
				undefined,
				deps({
					requestStatus,
					spawnDetached: () => {
						publish(process.pid, 4321);
						return { pid: process.pid, exited: () => undefined };
					},
				})
			);

		it('says where Cue stands once the host is up', async () => {
			await startedWith(async () => report());
			expect(out.join('\n')).toContain('Host started (pid');
			expect(out.join('\n')).toContain('Cue: running');
		});

		it('says the host is up but Cue is not, with the reason, when Cue failed to start', async () => {
			await startedWith(async () =>
				report({ cue: { state: 'failed', reason: 'better-sqlite3 could not be loaded' } })
			);
			const text = out.join('\n');
			expect(text).toContain('Host started (pid');
			expect(text).toContain('Cue: not running: better-sqlite3 could not be loaded');
			expect(text).toContain('The host is up, but Cue is not');
			// The host itself did start, and the output says exactly that.
			expect(process.exitCode).toBeUndefined();
		});

		it('puts the Cue state in the JSON a script reads', async () => {
			await startedWith(
				async () => report({ cue: { state: 'failed', reason: 'no sqlite' } }),
				true
			);
			expect(JSON.parse(out[0])).toMatchObject({
				started: true,
				cue: { state: 'failed', reason: 'no sqlite' },
			});
		});

		it('does not claim a Cue state it could not read', async () => {
			await startedWith(async () => {
				throw new Error('Connection to Maestro timed out');
			});
			expect(out.join('\n')).toContain('Cue: unknown');
			expect(out.join('\n')).toContain('timed out');
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

		it('names the Cue runs a stop would cut off', () => {
			const text = formatHostStatus(report({ work: { turns: 0, runs: [], cueRuns: 1 } }));
			expect(text).toContain('Work: 0 turns, 1 Cue run');
			expect(formatHostStatus(report({ work: { turns: 0, runs: [], cueRuns: 0 } }))).toContain(
				'Work: idle'
			);
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

	describe('start --stop-grace', () => {
		it('hands the grace period to the detached child', async () => {
			const spawnDetached = vi.fn((_args: string[]): DetachedChild => {
				publish(process.pid, 4321);
				return { pid: process.pid, exited: () => undefined };
			});
			await hostStart({ dataDir: dir, stopGrace: '45' }, undefined, deps({ spawnDetached }));
			const [args] = spawnDetached.mock.calls[0] as unknown as [string[]];
			expect(args.slice(-2)).toEqual(['--stop-grace', '45']);
		});

		it('refuses a grace that is not a number of seconds, before starting anything', async () => {
			const spawnDetached = vi.fn();
			await hostStart({ dataDir: dir, stopGrace: 'soon' }, undefined, deps({ spawnDetached }));
			expect(err.join('\n')).toContain('--stop-grace');
			expect(process.exitCode).toBe(2);
			expect(spawnDetached).not.toHaveBeenCalled();
		});
	});

	describe('a signal to a foreground host', () => {
		/** A host whose work is whatever `work` says, and whose stop and Cue drain are recorded. */
		function drainable(work: () => HostWork) {
			let finish!: () => void;
			const stopped = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const order: string[] = [];
			const stop = vi.fn(async () => {
				order.push('stop');
				finish();
			});
			const cue = {
				drain: vi.fn(async (_timeoutMs: number) => void order.push('cue.drain')),
				forceStop: vi.fn(() => void order.push('cue.forceStop')),
			};
			return { host: { work, stop, stopped, cue }, stop, cue, order };
		}
		/** A clock that moves only when the drain sleeps. */
		function clock() {
			let now = 0;
			const lines: string[] = [];
			return {
				lines,
				elapsed: () => now,
				deps: {
					now: () => now,
					sleep: async (ms: number) => {
						now += ms;
					},
					log: (line: string) => void lines.push(line),
				},
			};
		}
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

		it('stops at once when nothing is running', async () => {
			const { host, stop } = drainable(() => ({ turns: 0, runs: [] }));
			const time = clock();
			createSignalDrain(host, 30_000, time.deps)('SIGTERM');
			await settle();
			expect(stop).toHaveBeenCalledTimes(1);
			expect(time.elapsed()).toBe(0);
		});

		it('waits for the work in flight to finish, and only then stops', async () => {
			let checks = 0;
			// Busy for the first three looks: a turn, then an Auto Run, then a Cue run.
			const { host, stop } = drainable(() => {
				checks += 1;
				if (checks === 1) return { turns: 1, runs: [] };
				if (checks === 2)
					return {
						turns: 0,
						runs: [{ agentId: 'a1', kind: 'playbook', startedAt: 1, paused: false }],
					};
				if (checks === 3) return { turns: 0, runs: [], cueRuns: 1 };
				return { turns: 0, runs: [] };
			});
			const time = clock();
			createSignalDrain(host, 30_000, time.deps)('SIGTERM');
			await settle();
			expect(stop).toHaveBeenCalledTimes(1);
			expect(checks).toBe(4);
			expect(time.elapsed()).toBeLessThan(30_000);
			expect(time.lines[0]).toContain('waiting up to 30s');
			expect(time.lines[0]).toContain('1 turn');
		});

		it('stops with the work still running once the grace period is over, and says so', async () => {
			const { host, stop } = drainable(() => ({ turns: 0, runs: [], consults: 1 }));
			const time = clock();
			createSignalDrain(host, 5_000, time.deps)('SIGINT');
			await settle();
			expect(stop).toHaveBeenCalledTimes(1);
			expect(time.elapsed()).toBe(5_000);
			expect(time.lines.join('\n')).toContain('grace period ran out');
			expect(time.lines.join('\n')).toContain('1 consult');
		});

		it('starts the Cue drain on the first signal, with the grace, before it waits for anything', async () => {
			const { host, stop, cue } = drainable(() => ({ turns: 1, runs: [] }));
			const time = clock();
			const handler = createSignalDrain(host, 30_000, {
				...time.deps,
				sleep: () => new Promise<void>(() => undefined),
			});
			handler('SIGTERM');
			// Disarmed at once, while the host is still waiting on its turn.
			expect(cue.drain).toHaveBeenCalledWith(30_000);
			await settle();
			expect(stop).not.toHaveBeenCalled();
			expect(cue.forceStop).not.toHaveBeenCalled();
		});

		it('force-stops Cue on a second signal, then stops the host', async () => {
			const { host, cue, order } = drainable(() => ({ turns: 0, runs: [], cueRuns: 1 }));
			const time = clock();
			const handler = createSignalDrain(host, 30_000, {
				...time.deps,
				sleep: () => new Promise<void>(() => undefined),
			});
			handler('SIGTERM');
			await settle();
			handler('SIGINT');
			expect(cue.drain).toHaveBeenCalledTimes(1);
			expect(order).toEqual(['cue.drain', 'cue.forceStop', 'stop']);
		});

		it('still stops the host when the Cue drain fails', async () => {
			const { host, stop, cue } = drainable(() => ({ turns: 0, runs: [] }));
			cue.drain.mockRejectedValueOnce(new Error('db closed'));
			const time = clock();
			createSignalDrain(host, 30_000, time.deps)('SIGTERM');
			await settle();
			expect(stop).toHaveBeenCalledTimes(1);
			expect(time.lines.join('\n')).toContain('Draining Cue failed: db closed');
		});

		it('stops at once on a second signal', async () => {
			const { host, stop } = drainable(() => ({ turns: 1, runs: [] }));
			// A sleep that never ends: only the second signal can stop the host.
			const time = clock();
			const handler = createSignalDrain(host, 30_000, {
				...time.deps,
				sleep: () => new Promise<void>(() => undefined),
			});
			handler('SIGTERM');
			await settle();
			expect(stop).not.toHaveBeenCalled();
			handler('SIGTERM');
			expect(stop).toHaveBeenCalledTimes(1);
			expect(time.lines.join('\n')).toContain('again: stopping now');
		});

		it('with a grace of 0 stops at once, as before', async () => {
			const { host, stop } = drainable(() => ({ turns: 2, runs: [] }));
			const time = clock();
			createSignalDrain(host, 0, time.deps)('SIGTERM');
			await settle();
			expect(stop).toHaveBeenCalledTimes(1);
			expect(time.elapsed()).toBe(0);
		});
	});

	describe('stop --wait', () => {
		it('waits for the work to finish, then stops', async () => {
			publish(process.pid);
			let alive = true;
			const replies = [busy(), busy({ turns: 0, cueRuns: 1 })];
			const requestStop = vi.fn(async (): Promise<HostStopReply> => {
				const next = replies.shift();
				if (next) return next;
				alive = false;
				return { stopping: true };
			});
			await hostStop({ dataDir: dir, wait: '60' }, deps({ requestStop, isPidAlive: () => alive }));
			expect(requestStop).toHaveBeenCalledTimes(3);
			expect(requestStop).toHaveBeenLastCalledWith(dir, { force: undefined });
			expect(out.join('\n')).toContain('Waiting up to 1m');
			expect(out.join('\n')).toContain('Host stopped');
			expect(process.exitCode).toBeUndefined();
		});

		it('fails with the work named, and does not force, when the time runs out', async () => {
			publish(process.pid);
			const d = deps({ requestStop: vi.fn(async () => busy({ turns: 2 })) });
			await hostStop({ dataDir: dir, wait: '5' }, d);
			expect(err.join('\n')).toContain('still in flight after 5s');
			expect(err.join('\n')).toContain('2 turns');
			expect(err.join('\n')).toContain('--force');
			expect(d.requestStop).not.toHaveBeenCalledWith(dir, { force: true });
			expect(d.now()).toBe(5_000);
			expect(process.exitCode).toBe(5);
		});

		it('waits 300 seconds when given no number', async () => {
			publish(process.pid);
			const d = deps({ requestStop: vi.fn(async () => busy()) });
			await hostStop({ dataDir: dir, wait: true, json: true }, d);
			expect(d.now()).toBe(300_000);
			expect(JSON.parse(out.join('\n'))).toMatchObject({ stopped: false, timedOut: true });
			expect(process.exitCode).toBe(5);
		});

		it('refuses a wait that is not a number of seconds', async () => {
			publish(process.pid);
			const d = deps();
			await hostStop({ dataDir: dir, wait: '-3' }, d);
			expect(err.join('\n')).toContain('--wait');
			expect(d.requestStop).not.toHaveBeenCalled();
			expect(process.exitCode).toBe(2);
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

		it('refuses while only a Cue run is in flight', async () => {
			publish(process.pid);
			await hostStop(
				{ dataDir: dir },
				deps({
					requestStop: async () => ({
						stopping: false,
						reason: 'work-in-flight',
						work: { turns: 0, runs: [], cueRuns: 2 },
					}),
				})
			);
			expect(err.join('\n')).toContain('2 Cue runs');
			expect(err.join('\n')).toContain('--force');
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
