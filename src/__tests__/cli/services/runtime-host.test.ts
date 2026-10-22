/**
 * The detached host on a temp data directory: the real runtime, the real server, and the real
 * discovery file, with Cue replaced (the engine has its own tests) and the clock real. What is
 * proven here is the order a host starts and stops in, and that what it publishes is attachable.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostCue } from '../../../cli/services/host-cue';
import {
	HostPromptsMissingError,
	HostStartError,
	startRuntimeHost,
	type RunningHost,
} from '../../../cli/services/runtime-host';
import {
	createWsMaestroClient,
	readCliServerInfoFrom,
	requestHostStatus,
	requestHostStop,
	writeCliServerInfoTo,
} from '../../../shared/maestro-lib';

describe('startRuntimeHost', () => {
	let dir: string;
	let running: RunningHost[];
	let lines: string[];

	const options = () => ({
		paths: {
			userDataDir: dir,
			productionDataDir: dir,
			settingsFile: path.join(dir, 'maestro-settings.json'),
			cliServerFile: path.join(dir, 'cli-server.json'),
		},
		moduleDirectory: dir,
		version: '1.2.3',
		log: (line: string) => lines.push(line),
	});

	const idleCue = (): HostCue => ({
		state: () => ({ state: 'disabled' as const }),
		activeRuns: () => 0,
		stop: async () => undefined,
	});
	// The temp directory is no bundle, so the prompt probe is answered for it.
	const noCue = { startCue: async () => idleCue(), promptsLoad: () => true };

	async function start(): Promise<RunningHost> {
		const host = await startRuntimeHost(options(), noCue);
		running.push(host);
		return host;
	}

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-host-'));
		fs.writeFileSync(
			path.join(dir, 'maestro-sessions.json'),
			JSON.stringify({
				sessions: [
					{
						id: 'a1',
						name: 'Alpha',
						toolType: 'claude-code',
						cwd: dir,
						projectRoot: dir,
						aiTabs: [{ id: 't1', agentSessionId: null, name: null, logs: [] }],
						activeTabId: 't1',
					},
				],
				activeSessionId: 'a1',
			})
		);
		running = [];
		lines = [];
	});

	afterEach(async () => {
		for (const host of running) await host.stop();
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('publishes an attachable discovery file, owner-only, once it is listening', async () => {
		const host = await start();
		const info = readCliServerInfoFrom(dir);
		expect(info).toMatchObject({
			port: host.server.port,
			token: host.token,
			pid: process.pid,
			version: '1.2.3',
			hostKind: 'headless',
		});
		expect(info?.cliSecret).toBeTruthy();
		if (process.platform !== 'win32') {
			expect(fs.statSync(path.join(dir, 'cli-server.json')).mode & 0o777).toBe(0o600);
		}
		expect(host.runtime.lock.mode).toBe('host');

		const client = createWsMaestroClient({ userDataDir: dir, reconcileIntervalMs: 0 });
		try {
			const attached = await client.connection.connect();
			expect(attached.ok && attached.value.label).toBe(`headless pid ${process.pid}`);
			const agents = await client.agents.list();
			expect(agents.ok && agents.value.map((agent) => agent.name)).toEqual(['Alpha']);
		} finally {
			await client.connection.close();
		}

		const report = await requestHostStatus(dir);
		expect(report).toMatchObject({
			pid: process.pid,
			version: '1.2.3',
			cue: { state: 'disabled' },
		});
	});

	it('unpublishes first on stop, releases the lock, and closes the port', async () => {
		const host = await start();
		await host.stop();
		await host.stopped;

		expect(readCliServerInfoFrom(dir)).toBeNull();
		expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
		await expect(requestHostStatus(dir)).rejects.toThrow();
		// A host that has stopped can be started again on the same directory.
		const again = await start();
		expect(readCliServerInfoFrom(dir)?.port).toBe(again.server.port);
	});

	it('stop is idempotent and does not remove the discovery file of a newer host', async () => {
		const host = await start();
		// Another host published since: its file is not ours to delete.
		writeCliServerInfoTo(dir, {
			port: 1,
			token: 't',
			pid: process.pid + 1,
			startedAt: Date.now(),
		});
		await Promise.all([host.stop(), host.stop()]);
		expect(readCliServerInfoFrom(dir)?.pid).toBe(process.pid + 1);
	});

	it('stops when the server asks to', async () => {
		const host = await start();
		expect(await requestHostStop(dir, {})).toEqual({ stopping: true });
		await host.stopped;
		expect(lines[lines.length - 1]).toBe('Host stopped.');
	});

	it('refuses a directory a live desktop is serving', async () => {
		// Any live pid that is not this process stands in for the desktop.
		writeCliServerInfoTo(dir, { port: 9, token: 't', pid: process.ppid, startedAt: Date.now() });
		await expect(startRuntimeHost(options(), noCue)).rejects.toBeInstanceOf(HostStartError);
		// Nothing was served and the other host's file is untouched.
		expect(readCliServerInfoFrom(dir)?.pid).toBe(process.ppid);
	});

	it('refuses to start from a bundle whose prompts cannot load, before it takes the directory', async () => {
		// `dir` holds no prompts/core, which is the bundle copied without its prompts.
		const createRuntime = vi.fn();
		await expect(
			startRuntimeHost(options(), { startCue: async () => idleCue(), createRuntime })
		).rejects.toBeInstanceOf(HostPromptsMissingError);
		await expect(
			startRuntimeHost(options(), { startCue: async () => idleCue(), createRuntime })
		).rejects.toThrow(/prompts/);

		expect(createRuntime).not.toHaveBeenCalled();
		expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
		expect(readCliServerInfoFrom(dir)).toBeNull();
	});

	it('starts from a checkout, where the prompts are found from the bundle directory', async () => {
		// `dist/cli` is where the CLI bundle sits in a checkout; the probe is the real one.
		const host = await startRuntimeHost(
			{ ...options(), moduleDirectory: path.resolve(__dirname, '../../../../dist/cli') },
			{ startCue: async () => idleCue() }
		);
		running.push(host);
		expect(readCliServerInfoFrom(dir)?.pid).toBe(process.pid);
	});

	describe('Cue in the host', () => {
		it('hands Cue the runtime it serves', async () => {
			const startCue = vi.fn(async () => idleCue());
			const host = await startRuntimeHost(options(), { ...noCue, startCue });
			running.push(host);

			expect(startCue).toHaveBeenCalledWith({
				userDataDir: dir,
				settingsFile: path.join(dir, 'maestro-settings.json'),
				runtime: host.runtime,
			});
		});

		it('reports a Cue run as work and will not stop over it without force', async () => {
			let cueRuns = 1;
			const host = await startRuntimeHost(options(), {
				...noCue,
				startCue: async () => ({ ...idleCue(), activeRuns: () => cueRuns }),
			});
			running.push(host);

			expect((await requestHostStatus(dir)).work).toMatchObject({ turns: 0, cueRuns: 1 });
			// The same work in process, which is what a signal drain waits on.
			expect(host.work()).toEqual({ turns: 0, runs: [], rounds: 0, consults: 0, cueRuns: 1 });
			expect(await requestHostStop(dir, {})).toMatchObject({
				stopping: false,
				reason: 'work-in-flight',
				work: { cueRuns: 1 },
			});
			// Still serving: the refusal stopped nothing.
			expect(readCliServerInfoFrom(dir)?.pid).toBe(process.pid);

			cueRuns = 0;
			expect(await requestHostStop(dir, {})).toEqual({ stopping: true });
			await host.stopped;
		});

		it('on a forced stop ends the Cue runs and waits for them before the runtime closes', async () => {
			const seen: string[] = [];
			let cueStopped!: () => void;
			const host = await startRuntimeHost(options(), {
				...noCue,
				startCue: async () => ({
					...idleCue(),
					activeRuns: () => 1,
					stop: () =>
						new Promise<void>((resolve) => {
							// The runtime still holds the directory while Cue's runs are being ended.
							seen.push(
								fs.existsSync(path.join(dir, 'maestro-runtime.lock'))
									? 'cue-stop:locked'
									: 'cue-stop'
							);
							cueStopped = () => {
								seen.push('cue-stopped');
								resolve();
							};
						}),
				}),
			});
			running.push(host);

			expect(await requestHostStop(dir, { force: true })).toEqual({ stopping: true });
			await vi.waitFor(() => expect(seen).toEqual(['cue-stop:locked']));
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(true);
			expect(lines).not.toContain('Host stopped.');

			cueStopped();
			await host.stopped;
			expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
			expect(lines[lines.length - 1]).toBe('Host stopped.');
		});

		it('finishes stopping when Cue fails to stop, and says so', async () => {
			const host = await startRuntimeHost(options(), {
				...noCue,
				startCue: async () => ({
					...idleCue(),
					stop: async () => {
						throw new Error('db closed');
					},
				}),
			});
			await host.stop();
			expect(lines).toContain('Stopping Cue failed: db closed');
			expect(fs.existsSync(path.join(dir, 'maestro-runtime.lock'))).toBe(false);
		});
	});
});
