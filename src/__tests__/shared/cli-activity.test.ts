// @vitest-environment node
/**
 * Tests for src/shared/cli-activity.ts
 *
 * This module tracks which agents a `maestro-cli` run is driving, in a JSON
 * file shared by every CLI process and the desktop app. Tests run against a
 * real temp directory (only `os.platform` / `os.homedir` are stubbed to steer
 * the config path), because the behaviors that matter - atomic replacement,
 * serialized read-modify-write, pid-reuse detection - are properties of real
 * files and real processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Pass-through spy so a test can count reads of the activity file.
vi.mock('fs', async () => {
	const actual = await vi.importActual<typeof import('fs')>('fs');
	return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

vi.mock('os', async () => {
	const actual = await vi.importActual<typeof import('os')>('os');
	return { ...actual, platform: vi.fn(), homedir: vi.fn() };
});

import * as os from 'os';

import {
	registerCliActivity,
	unregisterCliActivity,
	getCliActivityForSession,
	isSessionBusyWithCli,
	getSessionIdsBusyWithCli,
} from '../../shared/cli-activity';
import { readProcessStartToken } from '../../shared/processIdentity';
import { bundleForChildProcess, runChildren } from '../helpers/childProcessBundle';

// Local type alias mirroring the (now-internal) CliActivityStatus shape
// expected by registerCliActivity. Kept in sync with shared/cli-activity.ts.
type CliActivityStatus = Parameters<typeof registerCliActivity>[0];

const mockOs = {
	platform: os.platform as unknown as ReturnType<typeof vi.fn>,
	homedir: os.homedir as unknown as ReturnType<typeof vi.fn>,
};

const tokensSupported = process.platform === 'linux' || process.platform === 'darwin';

describe('cli-activity', () => {
	const realTmp = fs.realpathSync(os.tmpdir());
	let root: string;
	let activityFile: string;
	const savedEnv = {
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		APPDATA: process.env.APPDATA,
	};

	// Sample activity data for tests
	const sampleActivity: CliActivityStatus = {
		sessionId: 'session-123',
		playbookId: 'playbook-456',
		playbookName: 'Test Playbook',
		startedAt: Date.now(),
		pid: 12345,
		currentTask: 'Running tests',
		currentDocument: 'test-doc.md',
	};

	const anotherActivity: CliActivityStatus = {
		sessionId: 'session-456',
		playbookId: 'playbook-789',
		playbookName: 'Another Playbook',
		startedAt: Date.now() - 10000,
		pid: 67890,
	};

	function writeActivities(activities: CliActivityStatus[]): void {
		fs.mkdirSync(path.dirname(activityFile), { recursive: true });
		fs.writeFileSync(activityFile, JSON.stringify({ activities }));
	}

	function readActivities(): CliActivityStatus[] {
		return JSON.parse(fs.readFileSync(activityFile, 'utf-8')).activities;
	}

	function mockKill(impl: (pid: number) => boolean) {
		return vi
			.spyOn(process, 'kill')
			.mockImplementation(((pid: number) => impl(pid)) as unknown as typeof process.kill);
	}

	const esrch = () => {
		throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
	};

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(realTmp, 'maestro-activity-'));
		mockOs.platform.mockReturnValue('linux');
		mockOs.homedir.mockReturnValue(root);
		process.env.XDG_CONFIG_HOME = path.join(root, 'config');
		activityFile = path.join(root, 'config', 'maestro', 'cli-activity.json');
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
	});

	// Assigning `undefined` to a `process.env` key stores the STRING "undefined",
	// which leaks into every later suite sharing this worker. Same shape as
	// `cli-server-discovery.test.ts`.
	function restoreEnv(key: keyof typeof savedEnv): void {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}

	afterEach(() => {
		vi.restoreAllMocks();
		restoreEnv('XDG_CONFIG_HOME');
		restoreEnv('APPDATA');
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe('getConfigDir (internal via path construction)', () => {
		it('uses Library/Application Support on macOS', () => {
			mockOs.platform.mockReturnValue('darwin');
			registerCliActivity(sampleActivity);
			expect(
				fs.existsSync(
					path.join(root, 'Library', 'Application Support', 'maestro', 'cli-activity.json')
				)
			).toBe(true);
		});

		it('uses APPDATA on Windows when set', () => {
			mockOs.platform.mockReturnValue('win32');
			process.env.APPDATA = path.join(root, 'Roaming');
			registerCliActivity(sampleActivity);
			expect(fs.existsSync(path.join(root, 'Roaming', 'maestro', 'cli-activity.json'))).toBe(true);
		});

		it('falls back to AppData/Roaming under home on Windows without APPDATA', () => {
			mockOs.platform.mockReturnValue('win32');
			delete process.env.APPDATA;
			registerCliActivity(sampleActivity);
			expect(
				fs.existsSync(path.join(root, 'AppData', 'Roaming', 'maestro', 'cli-activity.json'))
			).toBe(true);
		});

		it('uses XDG_CONFIG_HOME on Linux when set', () => {
			registerCliActivity(sampleActivity);
			expect(fs.existsSync(activityFile)).toBe(true);
		});

		it.each(['linux', 'freebsd'])('falls back to ~/.config on %s without XDG_CONFIG_HOME', (p) => {
			mockOs.platform.mockReturnValue(p);
			delete process.env.XDG_CONFIG_HOME;
			registerCliActivity(sampleActivity);
			expect(fs.existsSync(path.join(root, '.config', 'maestro', 'cli-activity.json'))).toBe(true);
		});
	});

	describe('registerCliActivity', () => {
		it('should register a new activity, creating the directory', () => {
			registerCliActivity(sampleActivity);
			const activities = readActivities();
			expect(activities).toHaveLength(1);
			expect(activities[0].sessionId).toBe('session-123');
		});

		it('should replace existing activity for same session', () => {
			writeActivities([sampleActivity]);
			registerCliActivity({ ...sampleActivity, currentTask: 'New task' });
			const activities = readActivities();
			expect(activities).toHaveLength(1);
			expect(activities[0].currentTask).toBe('New task');
		});

		it('should preserve other session activities', () => {
			writeActivities([anotherActivity]);
			registerCliActivity(sampleActivity);
			expect(readActivities()).toHaveLength(2);
		});

		it('stamps the start token when a process registers itself', () => {
			registerCliActivity({ ...sampleActivity, pid: process.pid });
			const [entry] = readActivities();
			expect(entry.startToken).toBe(readProcessStartToken(process.pid) ?? undefined);
		});

		it('does not invent a token for another process', () => {
			registerCliActivity(sampleActivity);
			expect(readActivities()[0].startToken).toBeUndefined();
		});

		it('leaves no temp or lock files behind', () => {
			registerCliActivity(sampleActivity);
			expect(fs.readdirSync(path.dirname(activityFile))).toEqual(['cli-activity.json']);
		});

		it('should handle write errors gracefully', () => {
			// A directory where the file should be makes every write fail for real.
			fs.mkdirSync(activityFile, { recursive: true });
			expect(() => registerCliActivity(sampleActivity)).not.toThrow();
			expect(console.error).toHaveBeenCalledWith(
				'[CLI Activity] Failed to write activity file:',
				expect.any(Error)
			);
		});

		it('writes unlocked rather than dropping the registration when the lock is stuck', () => {
			// A live holder (this process) that never releases.
			fs.mkdirSync(path.dirname(activityFile), { recursive: true });
			fs.writeFileSync(
				`${activityFile}.lock`,
				JSON.stringify({ pid: process.pid, instanceId: 'stuck', acquiredAt: Date.now() })
			);
			registerCliActivity(sampleActivity);
			expect(readActivities()).toHaveLength(1);
			expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('without the lock'));
		});

		it('recovers from a corrupt file instead of throwing', () => {
			fs.mkdirSync(path.dirname(activityFile), { recursive: true });
			fs.writeFileSync(activityFile, '{"activities": [');
			registerCliActivity(sampleActivity);
			expect(readActivities()).toHaveLength(1);
		});

		it('drops malformed entries on the next write', () => {
			fs.mkdirSync(path.dirname(activityFile), { recursive: true });
			fs.writeFileSync(activityFile, JSON.stringify({ activities: [null, { sessionId: 1 }] }));
			registerCliActivity(sampleActivity);
			expect(readActivities().map((a) => a.sessionId)).toEqual(['session-123']);
		});
	});

	describe('unregisterCliActivity', () => {
		it('should remove an existing activity', () => {
			writeActivities([sampleActivity]);
			unregisterCliActivity('session-123');
			expect(readActivities()).toHaveLength(0);
		});

		it('should preserve other activities when removing one', () => {
			writeActivities([sampleActivity, anotherActivity]);
			unregisterCliActivity('session-123');
			expect(readActivities().map((a) => a.sessionId)).toEqual(['session-456']);
		});

		it('should not rewrite the file for a non-existent session', () => {
			writeActivities([sampleActivity]);
			const before = fs.statSync(activityFile).ino;
			unregisterCliActivity('non-existent-session');
			expect(fs.statSync(activityFile).ino).toBe(before);
			expect(readActivities()).toHaveLength(1);
		});
	});

	describe('getCliActivityForSession', () => {
		it('should return activity for existing session', () => {
			writeActivities([sampleActivity]);
			const activity = getCliActivityForSession('session-123');
			expect(activity?.playbookName).toBe('Test Playbook');
		});

		it('should return undefined for non-existent session', () => {
			writeActivities([sampleActivity]);
			expect(getCliActivityForSession('non-existent')).toBeUndefined();
		});

		it('should find correct session among multiple', () => {
			writeActivities([sampleActivity, anotherActivity]);
			expect(getCliActivityForSession('session-456')?.playbookId).toBe('playbook-789');
		});

		it('should return undefined when the file does not exist', () => {
			expect(getCliActivityForSession('session-123')).toBeUndefined();
		});
	});

	describe('isSessionBusyWithCli', () => {
		it('should return false when no activity exists', () => {
			expect(isSessionBusyWithCli('session-123')).toBe(false);
		});

		it('should return true when process is running', () => {
			writeActivities([sampleActivity]);
			const kill = mockKill(() => true);
			expect(isSessionBusyWithCli('session-123')).toBe(true);
			expect(kill).toHaveBeenCalledWith(12345, 0);
		});

		it('should return false and cleanup when process is not running', () => {
			writeActivities([sampleActivity, anotherActivity]);
			mockKill(esrch);
			expect(isSessionBusyWithCli('session-123')).toBe(false);
			expect(readActivities().map((a) => a.sessionId)).toEqual(['session-456']);
		});

		it('should preserve busy activity when the process probe returns EPERM', () => {
			writeActivities([sampleActivity]);
			mockKill(() => {
				throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
			});
			expect(isSessionBusyWithCli('session-123')).toBe(true);
			expect(readActivities()).toHaveLength(1);
		});

		it('should not erase activity after an unknown process-probe error', () => {
			writeActivities([sampleActivity]);
			mockKill(() => {
				throw Object.assign(new Error('Unexpected probe failure'), { code: 'EIO' });
			});
			expect(isSessionBusyWithCli('session-123')).toBe(false);
			expect(readActivities()).toHaveLength(1);
		});

		it('treats zero or negative pids as dead instead of probing process groups', () => {
			writeActivities([{ ...sampleActivity, pid: 0 }]);
			const kill = mockKill(() => true);
			expect(isSessionBusyWithCli('session-123')).toBe(false);
			expect(kill).not.toHaveBeenCalled();
			expect(readActivities()).toHaveLength(0);
		});

		it('is true for a real running CLI process', () => {
			// The file names this very process, as a registering CLI would.
			registerCliActivity({ ...sampleActivity, pid: process.pid });
			expect(isSessionBusyWithCli('session-123')).toBe(true);
		});

		it.runIf(tokensSupported)(
			'is false, and cleans up, when the pid now belongs to an unrelated process',
			() => {
				const unrelated = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
					stdio: 'ignore',
				});
				try {
					// The CLI that wrote this entry crashed; its pid was then reused.
					writeActivities([{ ...sampleActivity, pid: unrelated.pid!, startToken: '1' }]);
					expect(isSessionBusyWithCli('session-123')).toBe(false);
					expect(readActivities()).toHaveLength(0);
				} finally {
					unrelated.kill('SIGKILL');
				}
			}
		);

		it('only removes the dead entry, not a new run registered for the same agent', () => {
			const dead = { ...sampleActivity, pid: 11111 };
			const fresh = { ...sampleActivity, pid: 22222 };
			writeActivities([dead]);
			mockKill((pid) => {
				if (pid === 11111) {
					// A new CLI run registers the same agent between our probe and
					// our cleanup write.
					writeActivities([fresh]);
					return esrch();
				}
				return true;
			});

			expect(isSessionBusyWithCli('session-123')).toBe(false);
			expect(readActivities()).toEqual([fresh]);
		});
	});

	// Batch form used by the desktop session listing, which asks about every
	// agent at once. Same liveness rule as isSessionBusyWithCli, but resolved
	// from a single read of the activity file instead of one read per agent.
	describe('getSessionIdsBusyWithCli', () => {
		const activityFor = (sessionId: string, pid: number) => ({
			...sampleActivity,
			sessionId,
			pid,
		});

		it('reads the activity file once no matter how many sessions it holds', () => {
			writeActivities([activityFor('a', 1), activityFor('b', 2), activityFor('c', 3)]);
			mockKill(() => true);
			const readSpy = fs.readFileSync as unknown as ReturnType<typeof vi.fn>;
			readSpy.mockClear();

			expect(getSessionIdsBusyWithCli()).toEqual(new Set(['a', 'b', 'c']));
			expect(readSpy.mock.calls.filter(([p]) => p === activityFile)).toHaveLength(1);
		});

		it('applies the same EPERM-is-alive / ESRCH-is-dead rule per entry', () => {
			writeActivities([activityFor('alive', 1), activityFor('denied', 2), activityFor('gone', 3)]);
			mockKill((pid) => {
				if (pid === 1) return true;
				if (pid === 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
				return esrch();
			});

			// 'denied' counts as busy: EPERM proves the pid exists.
			expect(getSessionIdsBusyWithCli()).toEqual(new Set(['alive', 'denied']));
			expect(readActivities().map((a) => a.sessionId)).toEqual(['alive', 'denied']);
		});

		it('returns an empty set when nothing is registered', () => {
			expect(getSessionIdsBusyWithCli()).toEqual(new Set());
		});
	});

	describe('edge cases', () => {
		it('should round-trip special characters, unicode, and long ids', () => {
			const longId = 'session-' + 'x'.repeat(1000);
			registerCliActivity({ ...sampleActivity, sessionId: 'special_123!@#$' });
			registerCliActivity({
				...sampleActivity,
				sessionId: 'session-unicode',
				playbookName: 'Test Playbook 🎵 日本語 العربية',
			});
			registerCliActivity({ ...sampleActivity, sessionId: longId, startedAt: 0 });

			expect(getCliActivityForSession('special_123!@#$')).toBeDefined();
			expect(getCliActivityForSession('session-unicode')?.playbookName).toBe(
				'Test Playbook 🎵 日本語 العربية'
			);
			expect(getCliActivityForSession(longId)?.startedAt).toBe(0);
		});
	});

	describe('integration scenarios', () => {
		it('should support full lifecycle: register -> get -> unregister', () => {
			registerCliActivity(sampleActivity);
			expect(getCliActivityForSession('session-123')).toBeDefined();
			unregisterCliActivity('session-123');
			expect(getCliActivityForSession('session-123')).toBeUndefined();
		});

		it('keeps every registration when many CLI processes start at once', async () => {
			const bundle = bundleForChildProcess('shared/cli-activity.ts', root, 'cli-activity');
			const perChild = 15;
			const children = 6;
			const results = await runChildren(
				`
// Steer the bundle to the same config dir as the parent, on any host OS.
const os = require('os');
os.platform = () => 'linux';
const { registerCliActivity } = require(${JSON.stringify(bundle)});
for (let i = 0; i < ${perChild}; i++) {
	registerCliActivity({
		sessionId: 'child-' + process.env.CHILD_INDEX + '-' + i,
		playbookId: 'p', playbookName: 'P', startedAt: Date.now(), pid: process.pid,
	});
}
`,
				children,
				{ dir: root, env: { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } }
			);

			for (const result of results) {
				expect(result.stderr).toBe('');
				expect(result.code).toBe(0);
			}
			expect(readActivities()).toHaveLength(children * perChild);
		}, 30_000);
	});
});
