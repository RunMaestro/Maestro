// Source: src/__tests__/cli/commands/cue-engine-sqlite.test.ts
// Source: src/__tests__/cli/commands/cue-engine-start-refusal.test.ts
import { beforeAll, afterAll } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
describe('cue-engine-sqlite', () => {
	let createStandaloneCueEngine: (typeof import('../../../cli/services/cue-standalone-engine'))['createStandaloneCueEngine'];
	let cueEngineStart: (typeof import('../../../cli/commands/cue-engine'))['cueEngineStart'];
	// Each original suite starts with a fresh CLI logger and native loader.
	const consoleMethods = {
		log: console.log,
		debug: console.debug,
		info: console.info,
		warn: console.warn,
		error: console.error,
	};
	beforeAll(async () => {
		vi.resetModules();
		vi.doMock('better-sqlite3', async () => {
			const { SqliteUnavailableError } = await import('../../../cli/utils/native-sqlite');
			return {
				default: class {
					constructor() {
						throw new SqliteUnavailableError(UNAVAILABLE_MESSAGE, []);
					}
				},
			};
		});
		vi.doMock('../../../cli/services/cue-standalone-engine', async (importOriginal) => ({
			...(await importOriginal<typeof import('../../../cli/services/cue-standalone-engine')>()),
			createStandaloneCueEngine: vi.fn(() => {
				throw new Error('the engine must not be created when SQLite cannot load');
			}),
		}));
		({ createStandaloneCueEngine } = await import('../../../cli/services/cue-standalone-engine'));
		({ cueEngineStart } = await import('../../../cli/commands/cue-engine'));
	});
	afterAll(() => {
		vi.doUnmock('better-sqlite3');
		vi.doUnmock('../../../cli/services/cue-standalone-engine');
		vi.resetModules();
		Object.assign(console, consoleMethods);
	});

	const UNAVAILABLE_MESSAGE =
		"Maestro's database module (better-sqlite3) cannot be loaded under Node.js v22.22.1 (NODE_MODULE_VERSION 127).\n" +
		'The better-sqlite3 it found was compiled for NODE_MODULE_VERSION 145.';

	let tmp: string;
	let savedUserData: string | undefined;
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let stderrSpy: MockInstance;

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-cue-sqlite-')));
		savedUserData = process.env.MAESTRO_USER_DATA;
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = savedUserData;
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	describe('cue engine start with an unloadable better-sqlite3', () => {
		it("prints the loader's message and exits 1", async () => {
			await expect(cueEngineStart({ dataDir: tmp })).rejects.toThrow('__exit__');
			expect(process.exit).toHaveBeenCalledWith(1);
			expect(errorSpy).toHaveBeenCalledWith(`[Cue] ${UNAVAILABLE_MESSAGE}`);
			expect(createStandaloneCueEngine).not.toHaveBeenCalled();
			expect(fs.existsSync(path.join(tmp, 'cue.db'))).toBe(false);
		});

		it('reports sqlite_unavailable as the only stdout output under --json', async () => {
			await expect(cueEngineStart({ dataDir: tmp, json: true })).rejects.toThrow('__exit__');
			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
				error: 'sqlite_unavailable',
				message: UNAVAILABLE_MESSAGE,
			});
		});

		it('logs the data dir and the failure as JSON lines under --log-format json', async () => {
			await expect(cueEngineStart({ dataDir: tmp, logFormat: 'json' })).rejects.toThrow('__exit__');
			const lines = stderrSpy.mock.calls.map((c) => JSON.parse(String(c[0])));
			expect(lines[0]).toMatchObject({
				level: 'info',
				message: `Data directory: ${tmp} (from --data-dir)`,
			});
			expect(lines.at(-1)).toMatchObject({ level: 'error' });
			expect(lines.at(-1).message).toBe(UNAVAILABLE_MESSAGE);
			expect(logSpy).not.toHaveBeenCalled();
		});
	});
});
describe('cue-engine-start-refusal', () => {
	const engine = {
		start: vi.fn(),
		stop: vi.fn(),
		getStatus: vi.fn(() => ({})),
		triggerSubscription: vi.fn(),
	};
	let cueEngineStart: (typeof import('../../../cli/commands/cue-engine'))['cueEngineStart'];
	// Each original suite starts with a fresh CLI logger and native loader.
	const consoleMethods = {
		log: console.log,
		debug: console.debug,
		info: console.info,
		warn: console.warn,
		error: console.error,
	};
	beforeAll(async () => {
		vi.resetModules();
		vi.doMock('better-sqlite3', () => ({
			default: class {
				close() {}
			},
		}));
		vi.doMock('../../../main/cue/cue-readiness', async (importOriginal) => ({
			...(await importOriginal<typeof import('../../../main/cue/cue-readiness')>()),
			checkCueReadiness: vi.fn(async () => ({
				ready: true,
				checkedAt: '2026-10-15T12:00:00.000Z',
				agents: 0,
				workspaces: 0,
				subscriptions: 0,
				gaps: [],
			})),
		}));
		vi.doMock('../../../cli/services/cue-standalone-engine', async (importOriginal) => ({
			...(await importOriginal<typeof import('../../../cli/services/cue-standalone-engine')>()),
			createStandaloneCueEngine: vi.fn(async () => engine),
		}));
		vi.doMock('../../../cli/services/cue-trigger-inbox', () => ({
			startCueTriggerInbox: vi.fn(() => () => {}),
		}));
		({ cueEngineStart } = await import('../../../cli/commands/cue-engine'));
	});
	afterAll(() => {
		vi.doUnmock('better-sqlite3');
		vi.doUnmock('../../../main/cue/cue-readiness');
		vi.doUnmock('../../../cli/services/cue-standalone-engine');
		vi.doUnmock('../../../cli/services/cue-trigger-inbox');
		vi.resetModules();
		Object.assign(console, consoleMethods);
	});

	/** This process's PID namespace inode, read the same way the lock module reads it. */
	function currentPidNsInode(): number | undefined {
		if (process.platform !== 'linux') return undefined;
		try {
			return fs.statSync('/proc/self/ns/pid').ino;
		} catch {
			return undefined;
		}
	}

	let tmp: string;
	let savedUserData: string | undefined;
	let spies: MockInstance[];

	beforeEach(() => {
		tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-engine-refusal-')));
		fs.writeFileSync(path.join(tmp, 'maestro-sessions.json'), '{"sessions":[]}');
		savedUserData = process.env.MAESTRO_USER_DATA;
		spies = [
			vi.spyOn(console, 'log').mockImplementation(() => {}),
			vi.spyOn(console, 'error').mockImplementation(() => {}),
			vi.spyOn(console, 'warn').mockImplementation(() => {}),
			vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
			vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
		];
		vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (savedUserData === undefined) delete process.env.MAESTRO_USER_DATA;
		else process.env.MAESTRO_USER_DATA = savedUserData;
		fs.rmSync(tmp, { recursive: true, force: true });
		process.exitCode = undefined;
	});

	function everythingPrinted(): string {
		return spies
			.flatMap((spy) => spy.mock.calls.map((call) => call.map(String).join(' ')))
			.join('\n');
	}

	/** The one JSON line the refusal printed. */
	function refusalJson(): Record<string, unknown> {
		const line = everythingPrinted()
			.split('\n')
			.find((l) => l.includes('"started":false'));
		expect(line).toBeDefined();
		return JSON.parse(line!.slice(line!.indexOf('{')));
	}

	function writeLock(fields: Record<string, unknown>): void {
		const now = new Date().toISOString();
		fs.writeFileSync(
			path.join(tmp, 'cue-engine.lock'),
			JSON.stringify({ mode: 'standalone', startedAt: now, heartbeatAt: now, ...fields })
		);
	}

	describe('cue engine start refused by a held lock', () => {
		it('names a different running process and how to stop it', async () => {
			const child: ChildProcess = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)']);
			try {
				await new Promise((resolve) => child.once('spawn', resolve));
				writeLock({ pid: child.pid, token: 'other-engine' });

				await cueEngineStart({ dataDir: tmp });

				expect(process.exitCode).toBe(1);
				const printed = everythingPrinted();
				expect(printed).toContain(`pid ${child.pid} is a different process that is still running`);
				expect(printed).toContain('maestro-cli cue engine stop');
			} finally {
				child.kill();
			}
		});

		// Off Linux, or without /proc, the namespace cannot be proven, so a lock
		// naming our own pid is not taken at once: the message says why it waits.
		it('says the recorded pid is our own and when the lock frees', async () => {
			writeLock({ pid: process.pid, token: 'previous-engine' });

			await cueEngineStart({ dataDir: tmp, json: true });

			expect(process.exitCode).toBe(1);
			const json = refusalJson();
			expect(json.started).toBe(false);
			expect(String(json.error)).toContain("which is this process's own pid");
			expect(String(json.error)).toContain('frees when its heartbeat goes stale');
			expect(json.holder).toMatchObject({
				pid: process.pid,
				mode: 'standalone',
				relation: 'own-pid',
			});
			expect((json.holder as { staleInMs: number }).staleInMs).toBeGreaterThan(0);
		});

		it('says a lock from another PID namespace is judged by its heartbeat', async () => {
			writeLock({ pid: 1, token: 'other-container', pidNsInode: (currentPidNsInode() ?? 0) + 1 });

			await cueEngineStart({ dataDir: tmp, json: true });

			const json = refusalJson();
			expect(json.started).toBe(false);
			expect(String(json.error)).toContain('in another PID namespace');
			expect(json.holder).toMatchObject({ pid: 1, relation: 'foreign-pid-namespace' });
		});
	});
});
