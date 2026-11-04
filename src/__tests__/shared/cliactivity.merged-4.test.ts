// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/shared/cli-activity.test.ts
// Source: src/__tests__/shared/retryClassification.test.ts
// Source: src/__tests__/shared/modelPricing.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Now import after mocks are set up
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	registerCliActivity,
	unregisterCliActivity,
	getCliActivityForSession,
	isSessionBusyWithCli,
	getSessionIdsBusyWithCli,
} from '../../shared/cli-activity';
import { resolveUserDataDir } from '../../shared/userDataDir';
import {
	classifyRetryableError,
	availabilityDelayMs,
	tokenExhaustionResetAt,
	tokenExhaustionDelayMs,
	AVAILABILITY_BASE_DELAY_MS,
	AVAILABILITY_MAX_DELAY_MS,
	TOKEN_EXHAUSTION_POLL_BASE_MS,
	TOKEN_EXHAUSTION_POLL_MAX_MS,
	RESET_TIME_BUFFER_MS,
	type ClassifiableError,
} from '../../shared/retryClassification';
import type { AgentErrorType } from '../../shared/types';
import {
	resolveModelPricing,
	normalizeModelId,
	calculateModelCost,
	computeClaudeUsageCost,
	createClaudeUsageAccumulator,
	DEFAULT_MODEL_PRICING,
	MODEL_PRICING,
} from '../../shared/modelPricing';
// Mock the Node.js modules before importing the module under test
vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
	existsSync: vi.fn(),
	mkdirSync: vi.fn(),
}));
vi.mock('os', () => ({
	platform: vi.fn(),
	homedir: vi.fn(),
}));
// Source: src/__tests__/shared/cli-activity.test.ts
describe('', () => {
	// Local type alias mirroring the (now-internal) CliActivityStatus shape
	// expected by registerCliActivity. Kept in sync with shared/cli-activity.ts.
	type CliActivityStatus = Parameters<typeof registerCliActivity>[0];
	// Type assertions for mocked modules
	const mockFs = {
		readFileSync: fs.readFileSync as ReturnType<typeof vi.fn>,
		writeFileSync: fs.writeFileSync as ReturnType<typeof vi.fn>,
		existsSync: fs.existsSync as ReturnType<typeof vi.fn>,
		mkdirSync: fs.mkdirSync as ReturnType<typeof vi.fn>,
	};
	const mockOs = {
		platform: os.platform as ReturnType<typeof vi.fn>,
		homedir: os.homedir as ReturnType<typeof vi.fn>,
	};
	describe('cli-activity', () => {
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
		let savedUserDataEnv: string | undefined;
		beforeEach(() => {
			vi.clearAllMocks();
			// Platform-default tests must not see the runner's MAESTRO_USER_DATA;
			// the override tests set it themselves.
			savedUserDataEnv = process.env.MAESTRO_USER_DATA;
			delete process.env.MAESTRO_USER_DATA;
			// Default mock implementations
			mockOs.platform.mockReturnValue('darwin');
			mockOs.homedir.mockReturnValue('/Users/testuser');
			mockFs.existsSync.mockReturnValue(true);
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
			mockFs.writeFileSync.mockReturnValue(undefined);
			mockFs.mkdirSync.mockReturnValue(undefined);
			// Mock console.error for writeCliActivities error handling
			vi.spyOn(console, 'error').mockImplementation(() => {});
		});
		afterEach(() => {
			vi.restoreAllMocks();
			if (savedUserDataEnv === undefined) delete process.env.MAESTRO_USER_DATA;
			else process.env.MAESTRO_USER_DATA = savedUserDataEnv;
		});
		describe('MAESTRO_USER_DATA', () => {
			// The desktop sets it on its own env and every agent it spawns inherits
			// it, so a CLI run inside an agent must register where the desktop's
			// watcher (getUserDataPath()/cli-activity.json) is looking. The old
			// private resolver ignored it, so in dev the desktop never saw a CLI run.
			it('reads the activity file from MAESTRO_USER_DATA', () => {
				process.env.MAESTRO_USER_DATA = '/data/maestro-dev';
				getCliActivityForSession('any-session');
				expect(mockFs.readFileSync).toHaveBeenCalledWith(
					path.join(path.resolve('/data/maestro-dev'), 'cli-activity.json'),
					'utf-8'
				);
			});
			it('registers activity into MAESTRO_USER_DATA', () => {
				process.env.MAESTRO_USER_DATA = '/data/maestro-dev';
				registerCliActivity(sampleActivity);
				expect(mockFs.writeFileSync).toHaveBeenCalledWith(
					path.join(path.resolve('/data/maestro-dev'), 'cli-activity.json'),
					expect.any(String),
					'utf-8'
				);
			});
			it('agrees with resolveUserDataDir() on a case-sensitive Linux install', () => {
				mockOs.platform.mockReturnValue('linux');
				mockOs.homedir.mockReturnValue('/home/testuser');
				const originalXdg = process.env.XDG_CONFIG_HOME;
				delete process.env.XDG_CONFIG_HOME;
				try {
					getCliActivityForSession('any-session');
					expect(mockFs.readFileSync).toHaveBeenCalledWith(
						path.join(resolveUserDataDir(), 'cli-activity.json'),
						'utf-8'
					);
				} finally {
					if (originalXdg !== undefined) process.env.XDG_CONFIG_HOME = originalXdg;
				}
			});
		});
		describe('getConfigDir (internal via path construction)', () => {
			describe('on macOS', () => {
				it('should construct correct config path for macOS', () => {
					mockOs.platform.mockReturnValue('darwin');
					mockOs.homedir.mockReturnValue('/Users/testuser');
					// Call a function that uses getConfigDir internally
					getCliActivityForSession('any-session');
					// Verify the path was constructed correctly
					expect(mockFs.readFileSync).toHaveBeenCalledWith(
						path.join(
							'/Users/testuser',
							'Library',
							'Application Support',
							'Maestro',
							'cli-activity.json'
						),
						'utf-8'
					);
				});
			});
			describe('on Windows', () => {
				it('should construct correct config path for Windows with APPDATA', () => {
					mockOs.platform.mockReturnValue('win32');
					mockOs.homedir.mockReturnValue('C:\\Users\\testuser');
					const originalAppdata = process.env.APPDATA;
					process.env.APPDATA = 'C:\\Users\\testuser\\AppData\\Roaming';
					getCliActivityForSession('any-session');
					expect(mockFs.readFileSync).toHaveBeenCalledWith(
						path.join('C:\\Users\\testuser\\AppData\\Roaming', 'Maestro', 'cli-activity.json'),
						'utf-8'
					);
					process.env.APPDATA = originalAppdata;
				});
				it('should construct correct config path for Windows without APPDATA', () => {
					mockOs.platform.mockReturnValue('win32');
					mockOs.homedir.mockReturnValue('C:\\Users\\testuser');
					const originalAppdata = process.env.APPDATA;
					delete process.env.APPDATA;
					getCliActivityForSession('any-session');
					expect(mockFs.readFileSync).toHaveBeenCalledWith(
						path.join('C:\\Users\\testuser', 'AppData', 'Roaming', 'Maestro', 'cli-activity.json'),
						'utf-8'
					);
					process.env.APPDATA = originalAppdata;
				});
			});
			describe('on Linux', () => {
				it('should construct correct config path for Linux with XDG_CONFIG_HOME', () => {
					mockOs.platform.mockReturnValue('linux');
					mockOs.homedir.mockReturnValue('/home/testuser');
					const originalXdg = process.env.XDG_CONFIG_HOME;
					process.env.XDG_CONFIG_HOME = '/home/testuser/.custom-config';
					getCliActivityForSession('any-session');
					expect(mockFs.readFileSync).toHaveBeenCalledWith(
						path.join('/home/testuser/.custom-config', 'maestro', 'cli-activity.json'),
						'utf-8'
					);
					process.env.XDG_CONFIG_HOME = originalXdg;
				});
				it('should construct correct config path for Linux without XDG_CONFIG_HOME', () => {
					mockOs.platform.mockReturnValue('linux');
					mockOs.homedir.mockReturnValue('/home/testuser');
					const originalXdg = process.env.XDG_CONFIG_HOME;
					delete process.env.XDG_CONFIG_HOME;
					getCliActivityForSession('any-session');
					expect(mockFs.readFileSync).toHaveBeenCalledWith(
						path.join('/home/testuser', '.config', 'maestro', 'cli-activity.json'),
						'utf-8'
					);
					process.env.XDG_CONFIG_HOME = originalXdg;
				});
			});
			describe('on other platforms', () => {
				it('should construct correct config path for other platforms (freebsd)', () => {
					mockOs.platform.mockReturnValue('freebsd');
					mockOs.homedir.mockReturnValue('/home/testuser');
					const originalXdg = process.env.XDG_CONFIG_HOME;
					delete process.env.XDG_CONFIG_HOME;
					getCliActivityForSession('any-session');
					expect(mockFs.readFileSync).toHaveBeenCalledWith(
						path.join('/home/testuser', '.config', 'Maestro', 'cli-activity.json'),
						'utf-8'
					);
					process.env.XDG_CONFIG_HOME = originalXdg;
				});
			});
		});
		describe('registerCliActivity', () => {
			it('should register a new activity', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				registerCliActivity(sampleActivity);
				expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities).toHaveLength(1);
				expect(parsed.activities[0].sessionId).toBe('session-123');
			});
			it('should replace existing activity for same session', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				const updatedActivity: CliActivityStatus = {
					...sampleActivity,
					currentTask: 'New task',
				};
				registerCliActivity(updatedActivity);
				expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities).toHaveLength(1);
				expect(parsed.activities[0].currentTask).toBe('New task');
			});
			it('should preserve other session activities', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [anotherActivity] }));
				registerCliActivity(sampleActivity);
				expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities).toHaveLength(2);
			});
			it('should create directory if it does not exist', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				mockFs.existsSync.mockReturnValue(false);
				registerCliActivity(sampleActivity);
				expect(mockFs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
			});
			it('should handle write errors gracefully', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				mockFs.writeFileSync.mockImplementation(() => {
					throw new Error('Permission denied');
				});
				// Should not throw
				expect(() => registerCliActivity(sampleActivity)).not.toThrow();
				expect(console.error).toHaveBeenCalledWith(
					'[CLI Activity] Failed to write activity file:',
					expect.any(Error)
				);
			});
		});
		describe('unregisterCliActivity', () => {
			it('should remove an existing activity', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				unregisterCliActivity('session-123');
				expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities).toHaveLength(0);
			});
			it('should preserve other activities when removing one', () => {
				mockFs.readFileSync.mockReturnValue(
					JSON.stringify({ activities: [sampleActivity, anotherActivity] })
				);
				unregisterCliActivity('session-123');
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities).toHaveLength(1);
				expect(parsed.activities[0].sessionId).toBe('session-456');
			});
			it('should handle non-existent session gracefully', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				unregisterCliActivity('non-existent-session');
				// Still writes (same data)
				expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities).toHaveLength(1);
			});
		});
		describe('getCliActivityForSession', () => {
			it('should return activity for existing session', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				const activity = getCliActivityForSession('session-123');
				expect(activity).toBeDefined();
				expect(activity?.sessionId).toBe('session-123');
				expect(activity?.playbookName).toBe('Test Playbook');
			});
			it('should return undefined for non-existent session', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				const activity = getCliActivityForSession('non-existent');
				expect(activity).toBeUndefined();
			});
			it('should find correct session among multiple', () => {
				mockFs.readFileSync.mockReturnValue(
					JSON.stringify({ activities: [sampleActivity, anotherActivity] })
				);
				const activity = getCliActivityForSession('session-456');
				expect(activity).toBeDefined();
				expect(activity?.playbookId).toBe('playbook-789');
			});
			it('should return undefined when no activities exist', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				const activity = getCliActivityForSession('session-123');
				expect(activity).toBeUndefined();
			});
		});
		describe('isSessionBusyWithCli', () => {
			it('should return false when no activity exists', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				const busy = isSessionBusyWithCli('session-123');
				expect(busy).toBe(false);
			});
			it('should return true when process is running', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				// Mock process.kill to not throw (process exists)
				const originalKill = process.kill;
				process.kill = vi.fn().mockReturnValue(true) as unknown as typeof process.kill;
				const busy = isSessionBusyWithCli('session-123');
				expect(busy).toBe(true);
				expect(process.kill).toHaveBeenCalledWith(12345, 0);
				process.kill = originalKill;
			});
			it('should return false and cleanup when process is not running', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				// Mock process.kill to throw (process doesn't exist)
				const originalKill = process.kill;
				process.kill = vi.fn().mockImplementation(() => {
					throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
				}) as unknown as typeof process.kill;
				const busy = isSessionBusyWithCli('session-123');
				expect(busy).toBe(false);
				// Should have cleaned up stale entry (called writeFileSync)
				expect(mockFs.writeFileSync).toHaveBeenCalled();
				process.kill = originalKill;
			});
			it('should preserve busy activity when the process probe returns EPERM', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				const originalKill = process.kill;
				process.kill = vi.fn().mockImplementation(() => {
					throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
				}) as unknown as typeof process.kill;
				try {
					expect(isSessionBusyWithCli('session-123')).toBe(true);
					expect(mockFs.writeFileSync).not.toHaveBeenCalled();
				} finally {
					process.kill = originalKill;
				}
			});
			it('should not erase activity after an unknown process-probe error', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				const originalKill = process.kill;
				process.kill = vi.fn().mockImplementation(() => {
					throw Object.assign(new Error('Unexpected probe failure'), { code: 'EIO' });
				}) as unknown as typeof process.kill;
				try {
					expect(isSessionBusyWithCli('session-123')).toBe(false);
					expect(mockFs.writeFileSync).not.toHaveBeenCalled();
				} finally {
					process.kill = originalKill;
				}
			});
			it('should check correct PID', () => {
				mockFs.readFileSync.mockReturnValue(
					JSON.stringify({ activities: [{ ...sampleActivity, pid: 99999 }] })
				);
				const originalKill = process.kill;
				process.kill = vi.fn().mockReturnValue(true) as unknown as typeof process.kill;
				isSessionBusyWithCli('session-123');
				expect(process.kill).toHaveBeenCalledWith(99999, 0);
				process.kill = originalKill;
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
				mockFs.readFileSync.mockReturnValue(
					JSON.stringify({
						activities: [activityFor('a', 1), activityFor('b', 2), activityFor('c', 3)],
					})
				);
				const originalKill = process.kill;
				process.kill = vi.fn().mockReturnValue(true) as unknown as typeof process.kill;
				try {
					expect(getSessionIdsBusyWithCli()).toEqual(new Set(['a', 'b', 'c']));
					expect(mockFs.readFileSync).toHaveBeenCalledTimes(1);
				} finally {
					process.kill = originalKill;
				}
			});
			it('applies the same EPERM-is-alive / ESRCH-is-dead rule per entry', () => {
				mockFs.readFileSync.mockReturnValue(
					JSON.stringify({
						activities: [activityFor('alive', 1), activityFor('denied', 2), activityFor('gone', 3)],
					})
				);
				const originalKill = process.kill;
				process.kill = vi.fn().mockImplementation((pid: number) => {
					if (pid === 1) return true;
					if (pid === 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
					throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
				}) as unknown as typeof process.kill;
				try {
					// 'denied' counts as busy: EPERM proves the pid exists.
					expect(getSessionIdsBusyWithCli()).toEqual(new Set(['alive', 'denied']));
				} finally {
					process.kill = originalKill;
				}
			});
			it('returns an empty set when nothing is registered', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				expect(getSessionIdsBusyWithCli()).toEqual(new Set());
			});
		});
		describe('CliActivityStatus interface', () => {
			it('should accept minimal required fields', () => {
				const minimal: CliActivityStatus = {
					sessionId: 'session-1',
					playbookId: 'playbook-1',
					playbookName: 'Test',
					startedAt: Date.now(),
					pid: 1234,
				};
				expect(minimal.sessionId).toBe('session-1');
				expect(minimal.currentTask).toBeUndefined();
				expect(minimal.currentDocument).toBeUndefined();
			});
			it('should accept all fields', () => {
				const full: CliActivityStatus = {
					sessionId: 'session-1',
					playbookId: 'playbook-1',
					playbookName: 'Test',
					startedAt: Date.now(),
					pid: 1234,
					currentTask: 'Running',
					currentDocument: 'doc.md',
				};
				expect(full.currentTask).toBe('Running');
				expect(full.currentDocument).toBe('doc.md');
			});
		});
		describe('edge cases', () => {
			it('should handle special characters in session IDs', () => {
				const specialActivity: CliActivityStatus = {
					sessionId: 'session-with-special-chars_123!@#$',
					playbookId: 'playbook-456',
					playbookName: 'Test',
					startedAt: Date.now(),
					pid: 1234,
				};
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				registerCliActivity(specialActivity);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities[0].sessionId).toBe('session-with-special-chars_123!@#$');
			});
			it('should handle unicode characters in playbook names', () => {
				const unicodeActivity: CliActivityStatus = {
					sessionId: 'session-unicode',
					playbookId: 'playbook-unicode',
					playbookName: 'Test Playbook 🎵 日本語 العربية',
					startedAt: Date.now(),
					pid: 1234,
					currentTask: 'Running task 🚀',
				};
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				registerCliActivity(unicodeActivity);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities[0].playbookName).toBe('Test Playbook 🎵 日本語 العربية');
				expect(parsed.activities[0].currentTask).toBe('Running task 🚀');
			});
			it('should handle very long session IDs', () => {
				const longId = 'session-' + 'x'.repeat(1000);
				const longActivity: CliActivityStatus = {
					sessionId: longId,
					playbookId: 'playbook-456',
					playbookName: 'Test',
					startedAt: Date.now(),
					pid: 1234,
				};
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				registerCliActivity(longActivity);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities[0].sessionId).toBe(longId);
			});
			it('should handle negative PIDs (edge case)', () => {
				const negativeActivity: CliActivityStatus = {
					...sampleActivity,
					pid: -1,
				};
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				registerCliActivity(negativeActivity);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities[0].pid).toBe(-1);
			});
			it('should handle zero timestamp', () => {
				const zeroTimestamp: CliActivityStatus = {
					...sampleActivity,
					startedAt: 0,
				};
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				registerCliActivity(zeroTimestamp);
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities[0].startedAt).toBe(0);
			});
			it('should handle concurrent read/write scenarios', () => {
				// Simulate file being empty on first read, then having content on second read
				let readCount = 0;
				mockFs.readFileSync.mockImplementation(() => {
					readCount++;
					if (readCount === 1) {
						return JSON.stringify({ activities: [] });
					}
					return JSON.stringify({ activities: [sampleActivity] });
				});
				registerCliActivity(anotherActivity);
				// First write should have one activity
				expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
			});
		});
		describe('integration scenarios', () => {
			it('should support full lifecycle: register -> get -> unregister', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				// Register
				registerCliActivity(sampleActivity);
				expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
				// Simulate subsequent reads returning the registered activity
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				// Get
				const activity = getCliActivityForSession('session-123');
				expect(activity).toBeDefined();
				// Unregister
				unregisterCliActivity('session-123');
				expect(mockFs.writeFileSync).toHaveBeenCalledTimes(2);
			});
			it('should support multiple concurrent sessions', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				// Register first session
				registerCliActivity(sampleActivity);
				// Simulate file now contains first activity
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				// Register second session
				registerCliActivity(anotherActivity);
				// Verify both are preserved
				const [, writtenContent] = mockFs.writeFileSync.mock.calls[1];
				const parsed = JSON.parse(writtenContent as string);
				expect(parsed.activities).toHaveLength(2);
			});
		});
		describe('on another data directory (F9)', () => {
			const DIR = path.join('/data', 'dev');
			const FILE = path.join(DIR, 'cli-activity.json');
			it('registers and unregisters in that directory, never the default one', () => {
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));
				registerCliActivity(sampleActivity, DIR);
				const [writtenPath, writtenContent] = mockFs.writeFileSync.mock.calls[0];
				expect(writtenPath).toBe(FILE);
				expect(JSON.parse(writtenContent as string).activities).toEqual([sampleActivity]);
				mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));
				unregisterCliActivity(sampleActivity.sessionId, DIR);
				expect(mockFs.writeFileSync.mock.calls[1][0]).toBe(FILE);
				expect(mockFs.readFileSync).toHaveBeenCalledWith(FILE, 'utf-8');
				// Nothing was read from or written to the user's own file.
				expect(mockFs.writeFileSync.mock.calls.every(([target]) => target === FILE)).toBe(true);
			});
			it('reads that directory for a busy check', () => {
				mockFs.readFileSync.mockReturnValue(
					JSON.stringify({ activities: [{ ...sampleActivity, pid: process.pid }] })
				);
				expect(getCliActivityForSession(sampleActivity.sessionId, DIR)).toMatchObject({
					sessionId: sampleActivity.sessionId,
				});
				expect(isSessionBusyWithCli(sampleActivity.sessionId, DIR)).toBe(true);
				expect(mockFs.readFileSync.mock.calls.every(([target]) => target === FILE)).toBe(true);
			});
			it('creates that directory when it is missing', () => {
				mockFs.existsSync.mockReturnValue(false);
				mockFs.readFileSync.mockImplementation(() => {
					throw new Error('ENOENT');
				});
				registerCliActivity(sampleActivity, DIR);
				expect(mockFs.mkdirSync).toHaveBeenCalledWith(DIR, { recursive: true });
			});
		});
	});
});
// Source: src/__tests__/shared/retryClassification.test.ts
describe('', () => {
	function err(
		partial: Partial<ClassifiableError> & {
			message: string;
		}
	): ClassifiableError {
		return {
			type: 'rate_limited',
			recoverable: true,
			...partial,
		};
	}
	/**
	 * The 2026-09-16 report: Codex refused a model with a hard HTTP 400 and Maestro
	 * drew "Service overloaded - auto-retrying" over it, probing every 30 minutes
	 * with no attempt cap while the one actionable instruction - upgrade the CLI -
	 * sat behind a dismissible banner. Nothing in the payload was ambiguous; the
	 * only thing that matched was the phrase "try again" at the end of an apology.
	 */
	describe('a permanently fatal request is never retried', () => {
		const gpt6Astra = {
			type: 'error',
			status: 400,
			error: {
				type: 'invalid_request_error',
				message:
					"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
			},
		};
		it('does not retry the reported gpt-6-astra 400', () => {
			expect(
				classifyRetryableError(
					err({
						message:
							"The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
						parsedJson: gpt6Astra,
					})
				)
			).toBeNull();
		});
		it('reads the status structurally, whatever the prose says', () => {
			// The sentence names a quota, so without the structural gate this would
			// route to the wait-for-reset strategy and wait out a limit that is not
			// the reason the request failed.
			expect(
				classifyRetryableError(
					err({ message: 'usage limit reached', parsedJson: { type: 'error', status: 400 } })
				)
			).toBeNull();
		});
		it('reads a provider error type when no status is given', () => {
			expect(
				classifyRetryableError(
					err({
						message: 'something went wrong, please try again later',
						parsedJson: { error: { type: 'invalid_request_error' } },
					})
				)
			).toBeNull();
		});
		it('falls back to prose for providers that send no structure', () => {
			for (const message of [
				'This model requires a newer version of Codex. Please try again later.',
				'Unsupported model: gpt-6-astra',
				'model not found',
			]) {
				expect(classifyRetryableError(err({ message }))).toBeNull();
			}
		});
		// The two 4xx that DO clear on their own must be untouched, and 429 in
		// particular has to stay available to the token-exhaustion strategy.
		it('leaves 408 and 429 retryable', () => {
			expect(
				classifyRetryableError(
					err({
						message: 'Request timed out. Please try again later.',
						parsedJson: { type: 'error', status: 408 },
					})
				)
			).toBe('availability');
			expect(
				classifyRetryableError(
					err({ message: 'usage limit reached', parsedJson: { type: 'error', status: 429 } })
				)
			).toBe('token-exhaustion');
		});
		// The tightened pattern must not cost us the errors it was written for.
		it('still retries real transient failures', () => {
			expect(classifyRetryableError(err({ message: 'Overloaded, please try again later' }))).toBe(
				'availability'
			);
			expect(classifyRetryableError(err({ message: 'API Error: 529 Overloaded' }))).toBe(
				'availability'
			);
			expect(
				classifyRetryableError(err({ message: 'Service is busy. Try again in a few minutes.' }))
			).toBe('availability');
		});
		// A bare "try again" is the closing words of an apology, not a signal.
		it('does not read a bare "try again" as a retry signal', () => {
			expect(
				classifyRetryableError(err({ message: 'Something broke. Please fix it and try again.' }))
			).toBeNull();
		});
	});
	describe('classifyRetryableError', () => {
		it('classifies overload/529/5xx/throttle messages as availability', () => {
			for (const message of [
				'API Error: 529 Overloaded',
				'API Error: Overloaded',
				'The service is currently overloaded. Please try again later.',
				'503 Service Unavailable',
				'HTTP 502 Bad Gateway',
				'Too many requests',
				'Rate limit exceeded. Please wait a moment before trying again.',
				'429 error',
			]) {
				expect(classifyRetryableError(err({ message }))).toBe('availability');
			}
		});
		it('classifies plan/quota exhaustion messages as token-exhaustion', () => {
			for (const message of [
				'Usage limit reached. Check your plan for available quota.',
				'Your API quota has been exceeded. Resume when quota resets.',
				'You have hit your weekly limit',
				'5-hour limit reached',
				'Out of credits',
				'Limit reached, resets at 5pm',
			]) {
				expect(classifyRetryableError(err({ message }))).toBe('token-exhaustion');
			}
		});
		it('prefers token-exhaustion when a message mixes quota + rate-limit language', () => {
			// "usage limit reached, resets in 1 hour" contains both signals; the quota
			// meaning must win so we wait for the reset instead of fast-backing-off.
			expect(
				classifyRetryableError(
					err({ message: 'Usage limit reached, rate limit, resets in 1 hour' })
				)
			).toBe('token-exhaustion');
		});
		it('treats network errors as availability', () => {
			expect(
				classifyRetryableError(err({ type: 'network_error', message: 'Connection reset' }))
			).toBe('availability');
		});
		it('never auto-retries errors that need human action', () => {
			const humanTypes: AgentErrorType[] = [
				'auth_expired',
				'permission_denied',
				'session_not_found',
				'hitl_gate',
				'token_exhaustion', // context-window-full: resending can't help
				'agent_crashed',
			];
			for (const type of humanTypes) {
				expect(classifyRetryableError(err({ type, message: 'overloaded' }))).toBeNull();
			}
		});
		it('returns null for non-recoverable errors', () => {
			expect(classifyRetryableError(err({ recoverable: false, message: 'overloaded' }))).toBeNull();
		});
		it('returns null for unrecognized messages', () => {
			expect(
				classifyRetryableError(err({ type: 'unknown', message: 'something weird' }))
			).toBeNull();
		});
	});
	describe('availabilityDelayMs', () => {
		it('follows the 30s→30m doubling schedule', () => {
			const min = 60 * 1000;
			expect(availabilityDelayMs(0)).toBe(30 * 1000); // 30s
			expect(availabilityDelayMs(1)).toBe(1 * min); // 1m
			expect(availabilityDelayMs(2)).toBe(2 * min); // 2m
			expect(availabilityDelayMs(3)).toBe(4 * min); // 4m
			expect(availabilityDelayMs(4)).toBe(8 * min); // 8m
			expect(availabilityDelayMs(5)).toBe(16 * min); // 16m
		});
		it('caps at 30m and stays there for all later attempts', () => {
			expect(availabilityDelayMs(6)).toBe(AVAILABILITY_MAX_DELAY_MS); // would be 32m → 30m
			expect(availabilityDelayMs(7)).toBe(AVAILABILITY_MAX_DELAY_MS);
			expect(availabilityDelayMs(100)).toBe(AVAILABILITY_MAX_DELAY_MS);
			expect(availabilityDelayMs(1000)).toBe(AVAILABILITY_MAX_DELAY_MS);
		});
		it('clamps negative/fractional attempts to the base', () => {
			expect(availabilityDelayMs(-5)).toBe(AVAILABILITY_BASE_DELAY_MS);
			expect(availabilityDelayMs(0.9)).toBe(AVAILABILITY_BASE_DELAY_MS);
		});
	});
	describe('tokenExhaustionResetAt', () => {
		const now = 1700000000000; // fixed epoch ms
		// An unreadable reset is a real answer, not a failure: the caller polls
		// either way, so `undefined` costs nothing but the card's "Resets at" line.
		// This used to return `now + 1h`, which the caller then slept through whole.
		it('returns undefined when nothing parseable is present', () => {
			expect(tokenExhaustionResetAt(err({ message: 'Usage limit reached' }), now)).toBeUndefined();
		});
		it('reads relative seconds from parsedJson retryAfter', () => {
			const e = err({ message: 'quota exceeded', parsedJson: { retryAfter: 120 } });
			expect(tokenExhaustionResetAt(e, now)).toBe(now + 120 * 1000 + RESET_TIME_BUFFER_MS);
		});
		it('reads epoch-seconds reset timestamps from parsedJson', () => {
			const resetSeconds = Math.floor(now / 1000) + 3600;
			const e = err({ message: 'quota exceeded', parsedJson: { resetsAt: resetSeconds } });
			expect(tokenExhaustionResetAt(e, now)).toBe(resetSeconds * 1000 + RESET_TIME_BUFFER_MS);
		});
		it('reads epoch-ms reset timestamps from parsedJson', () => {
			const resetMs = now + 3600000;
			const e = err({ message: 'quota exceeded', parsedJson: { reset: resetMs } });
			expect(tokenExhaustionResetAt(e, now)).toBe(resetMs + RESET_TIME_BUFFER_MS);
		});
		it('parses "retry after N seconds/minutes/hours" from the message', () => {
			expect(tokenExhaustionResetAt(err({ message: 'retry after 45 seconds' }), now)).toBe(
				now + 45 * 1000 + RESET_TIME_BUFFER_MS
			);
			expect(tokenExhaustionResetAt(err({ message: 'try again in 10 minutes' }), now)).toBe(
				now + 10 * 60 * 1000 + RESET_TIME_BUFFER_MS
			);
			expect(tokenExhaustionResetAt(err({ message: 'wait 2 hours' }), now)).toBe(
				now + 2 * 60 * 60 * 1000 + RESET_TIME_BUFFER_MS
			);
		});
		// Claude Code's real plan-limit message puts the authoritative reset time in a
		// NESTED container. A top-level-only scan misses it and falls back to the
		// blind hourly poll, which is what made the retry land up to an hour late.
		it('reads quotaLimits.resetsAt from the real Claude limit payload', () => {
			const resetSeconds = 1787416800;
			const e = err({
				message: "You've hit your session limit · resets 11:40am (America/Chicago)",
				parsedJson: {
					error: 'rate_limit',
					isApiErrorMessage: true,
					quotaLimits: { status: 'rejected', resetsAt: resetSeconds, rateLimitType: 'five_hour' },
				},
			});
			expect(tokenExhaustionResetAt(e, now)).toBe(resetSeconds * 1000 + RESET_TIME_BUFFER_MS);
		});
		it('prefers a nested quota reset over a generic top-level retry hint', () => {
			// A top-level retryAfter is a hint for the REQUEST; the quota container is
			// the actual window. Taking the request hint would retry into the wall.
			const resetSeconds = Math.floor(now / 1000) + 7200;
			const e = err({
				message: 'usage limit reached',
				parsedJson: { retryAfter: 30, quotaLimits: { resetsAt: resetSeconds } },
			});
			expect(tokenExhaustionResetAt(e, now)).toBe(resetSeconds * 1000 + RESET_TIME_BUFFER_MS);
		});
		it('parses the legacy "usage limit reached|<epoch>" marker', () => {
			const resetSeconds = Math.floor(now / 1000) + 1800;
			const e = err({ message: `Claude AI usage limit reached|${resetSeconds}` });
			expect(tokenExhaustionResetAt(e, now)).toBe(resetSeconds * 1000 + RESET_TIME_BUFFER_MS);
		});
		describe('zoned wall-clock reset times', () => {
			// 2026-08-22T17:22:00Z = 12:22pm America/Chicago (CDT, UTC-5).
			const noon = Date.UTC(2026, 7, 22, 17, 22);
			it('resolves a same-day reset that is still ahead', () => {
				const e = err({
					message: "You've hit your session limit · resets 2:40pm (America/Chicago)",
				});
				expect(tokenExhaustionResetAt(e, noon)).toBe(
					Date.UTC(2026, 7, 22, 19, 40) + RESET_TIME_BUFFER_MS
				);
			});
			it('rolls a reset time that has already passed to the next day', () => {
				const e = err({
					message: "You've hit your session limit · resets 11:40am (America/Chicago)",
				});
				expect(tokenExhaustionResetAt(e, noon)).toBe(
					Date.UTC(2026, 7, 23, 16, 40) + RESET_TIME_BUFFER_MS
				);
			});
			it('handles a zone other than the local one', () => {
				// 9pm Europe/London (BST, UTC+1) on the same day.
				const e = err({ message: "You've hit your 5-hour limit · resets 9pm (Europe/London)" });
				expect(tokenExhaustionResetAt(e, noon)).toBe(
					Date.UTC(2026, 7, 22, 20, 0) + RESET_TIME_BUFFER_MS
				);
			});
			it('reads no reset from a wall clock with no zone', () => {
				const e = err({ message: 'usage limit reached, resets at 3pm' });
				expect(tokenExhaustionResetAt(e, noon)).toBeUndefined();
			});
			it('reads no reset from an unknown zone', () => {
				const e = err({ message: "You've hit your session limit · resets 3pm (Not/AZone)" });
				expect(tokenExhaustionResetAt(e, noon)).toBeUndefined();
			});
		});
		it('classifies the bare machine tag "rate_limit" as availability', () => {
			// Claude Code puts exactly this in the `error` field of a 429. A
			// whitespace-only pattern missed it, leaving a real rate limit unretryable.
			for (const message of ['rate_limit', 'rate-limit', 'rate_limited']) {
				expect(classifyRetryableError(err({ type: 'unknown', message }))).toBe('availability');
			}
		});
		it('classifies the Claude CLI limit notice as token-exhaustion', () => {
			expect(
				classifyRetryableError(
					err({ message: "You've hit your session limit · resets 11:40am (America/Chicago)" })
				)
			).toBe('token-exhaustion');
		});
	});
	// ============================================================================
	// tokenExhaustionDelayMs - the spin, not the sleep
	// ============================================================================
	describe('tokenExhaustionDelayMs', () => {
		const now = 1700000000000;
		const minute = 60 * 1000;
		/** The steady-state floor: every probe from the third on waits this long. */
		const floor = 15 * minute;
		it('probes twice quickly, then holds at the 15 minute floor', () => {
			// Two fast probes catch a stale notice or an account the user already
			// switched. Everything after that is a quota coming back on a clock
			// measured in hours, so it is polled at the floor and not faster.
			expect(tokenExhaustionDelayMs(0, undefined, now)).toBe(15 * 1000);
			expect(tokenExhaustionDelayMs(1, undefined, now)).toBe(minute);
			expect(tokenExhaustionDelayMs(2, undefined, now)).toBe(floor);
			expect(tokenExhaustionDelayMs(3, undefined, now)).toBe(floor);
			expect(tokenExhaustionDelayMs(500, undefined, now)).toBe(TOKEN_EXHAUSTION_POLL_MAX_MS);
		});
		// A doubling ramp to the same ceiling reaches the floor on the seventh probe,
		// roughly 31 minutes in, so the first half hour of a four-hour outage is
		// still spent probing. The floor has to arrive on probe 3, not eventually.
		it('reaches the floor by the third probe rather than ramping into it', () => {
			expect(tokenExhaustionDelayMs(2, undefined, now)).toBe(floor);
			const firstHour = [0, 1, 2, 3].map((a) => tokenExhaustionDelayMs(a, undefined, now));
			expect(firstHour.reduce((a, b) => a + b, 0)).toBeGreaterThan(30 * minute);
		});
		it('clamps negative and fractional attempts to the first probe', () => {
			expect(tokenExhaustionDelayMs(-5, undefined, now)).toBe(TOKEN_EXHAUSTION_POLL_BASE_MS);
			expect(tokenExhaustionDelayMs(0.9, undefined, now)).toBe(TOKEN_EXHAUSTION_POLL_BASE_MS);
		});
		// The whole point. A 5-hour window used to mean one attempt, five hours in;
		// an outage that cleared early - because the user swapped accounts, or the
		// notice named the wrong window - was invisible until the sleep expired.
		it('keeps polling through a reset that is hours away', () => {
			const resetAt = now + 5 * 60 * minute;
			expect(tokenExhaustionDelayMs(0, resetAt, now)).toBe(15 * 1000);
			expect(tokenExhaustionDelayMs(9, resetAt, now)).toBe(floor);
			expect(tokenExhaustionDelayMs(200, resetAt, now)).toBe(floor);
		});
		it('lands exactly on the reset when it arrives sooner than the next probe', () => {
			// 20s out at the floor: waiting the full 15 minutes would meet a known
			// reset roughly 14 minutes late, every time, for no reason.
			expect(tokenExhaustionDelayMs(5, now + 20 * 1000, now)).toBe(20 * 1000);
			expect(tokenExhaustionDelayMs(5, now + 90 * 1000, now)).toBe(90 * 1000);
		});
		// This is the guard on the clamp DIRECTION, and it is load-bearing. Clamping
		// the other way (waiting for a distant reset instead of the cadence) restores
		// the blind sleep this design replaced: the observed failure was a 2h26m
		// outage that cleared "after 0 retries" because Maestro looked exactly once,
		// at the end. A far-off reset must never stretch the wait past the floor.
		it('never waits LONGER than the floor just because a reset is far away', () => {
			expect(tokenExhaustionDelayMs(5, now + 30 * minute, now)).toBe(floor);
			expect(tokenExhaustionDelayMs(5, now + 4 * 60 * minute, now)).toBe(floor);
		});
		it('goes on polling once the reset has come and gone', () => {
			// The provider said the quota would be back and it was not. That is a
			// reason to keep asking, not to stop.
			expect(tokenExhaustionDelayMs(4, now - 60 * minute, now)).toBe(floor);
			expect(tokenExhaustionDelayMs(4, now, now)).toBe(floor);
		});
		it('never returns a delay that could stall the loop', () => {
			for (let attempt = 0; attempt < 40; attempt++) {
				for (const resetAt of [undefined, now - 1, now, now + 1, now + 10 * minute]) {
					const delay = tokenExhaustionDelayMs(attempt, resetAt, now);
					expect(delay).toBeGreaterThan(0);
					expect(delay).toBeLessThanOrEqual(TOKEN_EXHAUSTION_POLL_MAX_MS);
				}
			}
		});
	});
	/**
	 * The provider's own error text (`raw.errorLine`).
	 *
	 * Codex's parser replaces `message` with the pattern bank's curated wording, so
	 * before this the scheduler saw "Rate limited. Please wait and try again." for a
	 * multi-hour quota outage and ran the 30s availability backoff against it. These
	 * cover the decision being made off the real line while display keeps using
	 * `message`.
	 */
	describe('classifying off the provider raw line', () => {
		it('reads exhaustion out of the raw line when the curated message hides it', () => {
			const error = err({
				// What the Codex bank rewrote it to.
				message: 'Rate limited. Please wait and try again.',
				// What Codex actually printed.
				raw: { errorLine: "429 - you've hit your usage limit for this plan" },
			});
			expect(classifyRetryableError(error)).toBe('token-exhaustion');
		});
		it('prefers exhaustion when the raw line carries both signals', () => {
			// A throttle read as a quota outage only waits too long; a quota outage
			// read as a throttle hammers the provider for hours.
			const error = err({
				message: 'Rate limit exceeded. Please wait before trying again.',
				raw: { errorLine: 'rate limit: usage limit reached for your plan' },
			});
			expect(classifyRetryableError(error)).toBe('token-exhaustion');
		});
		it('still classifies from message alone when there is no raw line', () => {
			expect(classifyRetryableError(err({ message: '429 error' }))).toBe('availability');
			expect(classifyRetryableError(err({ message: 'usage limit reached' }))).toBe(
				'token-exhaustion'
			);
		});
		it('ignores a blank raw line rather than treating it as a text', () => {
			expect(classifyRetryableError(err({ message: 'usage limit reached', raw: {} }))).toBe(
				'token-exhaustion'
			);
			expect(
				classifyRetryableError(err({ message: 'usage limit reached', raw: { errorLine: '   ' } }))
			).toBe('token-exhaustion');
		});
		it('recovers a reset time that only the raw line carries', () => {
			const now = Date.UTC(2026, 8, 16, 12, 0, 0);
			const error = err({
				message: 'Usage limit reached. Please wait or check your plan quota.',
				raw: { errorLine: 'You have hit your usage limit. Try again in 4h 12m.' },
			});
			const resetAt = tokenExhaustionResetAt(error, now);
			// The point of this case is that a hint is recovered AT ALL: before the raw
			// line was carried, `message` was the curated bank wording and this was
			// `undefined`, so the scheduler had nothing but its fixed poll.
			//
			// The value is 4h, not 4h12m: `parseRetryAfterFromMessage` reads a single
			// leading unit and ignores the trailing minutes. That is a pre-existing
			// limit of the parser, unrelated to where the text came from, and it errs
			// EARLY (probing 12 minutes before the quota is back costs one refused
			// request), so it is pinned here rather than quietly fixed.
			expect(resetAt).toBe(now + 4 * 60 * 60 * 1000 + RESET_TIME_BUFFER_MS);
		});
		it('leaves the reset undefined when neither text names one', () => {
			const now = Date.UTC(2026, 8, 16, 12, 0, 0);
			const error = err({
				message: 'Usage limit reached. Please wait or check your plan quota.',
				raw: { errorLine: 'stream error: usage limit reached' },
			});
			expect(tokenExhaustionResetAt(error, now)).toBeUndefined();
		});
	});
});
// Source: src/__tests__/shared/modelPricing.test.ts
describe('', () => {
	describe('resolveModelPricing', () => {
		it('resolves exact current-gen models to their tier', () => {
			expect(resolveModelPricing('claude-fable-5').INPUT_PER_MILLION).toBe(10);
			expect(resolveModelPricing('claude-fable-5').OUTPUT_PER_MILLION).toBe(50);
			expect(resolveModelPricing('claude-opus-4-8').INPUT_PER_MILLION).toBe(5);
			expect(resolveModelPricing('claude-opus-4-8').OUTPUT_PER_MILLION).toBe(25);
			expect(resolveModelPricing('claude-sonnet-4-6').INPUT_PER_MILLION).toBe(3);
			expect(resolveModelPricing('claude-haiku-4-5').INPUT_PER_MILLION).toBe(1);
		});
		it('prices legacy Opus (4.1/4.0) at the old $15/$75 tier, not current Opus', () => {
			expect(resolveModelPricing('claude-opus-4-1').INPUT_PER_MILLION).toBe(15);
			expect(resolveModelPricing('claude-opus-4-0').OUTPUT_PER_MILLION).toBe(75);
		});
		it('derives cache prices from the input rate (read 0.1x, creation 1.25x)', () => {
			const fable = resolveModelPricing('claude-fable-5');
			expect(fable.CACHE_READ_PER_MILLION).toBeCloseTo(1, 10); // 10 * 0.1
			expect(fable.CACHE_CREATION_PER_MILLION).toBeCloseTo(12.5, 10); // 10 * 1.25
		});
		it('strips the [1m] extended-context marker', () => {
			expect(resolveModelPricing('claude-opus-4-8[1m]')).toBe(
				resolveModelPricing('claude-opus-4-8')
			);
		});
		it('strips a trailing date snapshot suffix', () => {
			expect(resolveModelPricing('claude-haiku-4-5-20251001')).toBe(
				resolveModelPricing('claude-haiku-4-5')
			);
		});
		it('is case-insensitive', () => {
			expect(resolveModelPricing('Claude-Opus-4-8')).toBe(resolveModelPricing('claude-opus-4-8'));
		});
		it('falls back to the family tier for unknown versioned IDs', () => {
			// A future opus version not in the table should still price at the opus tier.
			expect(resolveModelPricing('claude-opus-4-9').INPUT_PER_MILLION).toBe(5);
			expect(resolveModelPricing('claude-fable-6').INPUT_PER_MILLION).toBe(10);
			expect(resolveModelPricing('claude-haiku-9-0').INPUT_PER_MILLION).toBe(1);
		});
		it('falls back to the default tier for unknown, family-less, or empty input', () => {
			// gpt-4o is outside the GPT-5 family the OpenAI table covers, so it still
			// takes the default rather than being priced off a family it isn't in.
			expect(resolveModelPricing('gpt-4o')).toBe(DEFAULT_MODEL_PRICING);
			expect(resolveModelPricing(undefined)).toBe(DEFAULT_MODEL_PRICING);
			expect(resolveModelPricing(null)).toBe(DEFAULT_MODEL_PRICING);
			expect(resolveModelPricing('')).toBe(DEFAULT_MODEL_PRICING);
		});
		it('default tier matches the historical flat Sonnet rates', () => {
			expect(DEFAULT_MODEL_PRICING.INPUT_PER_MILLION).toBe(3);
			expect(DEFAULT_MODEL_PRICING.OUTPUT_PER_MILLION).toBe(15);
			expect(DEFAULT_MODEL_PRICING.CACHE_READ_PER_MILLION).toBe(0.3);
			expect(DEFAULT_MODEL_PRICING.CACHE_CREATION_PER_MILLION).toBe(3.75);
		});
	});
	describe('normalizeModelId', () => {
		it('lowercases and strips [1m] + date suffix', () => {
			expect(normalizeModelId('Claude-Opus-4-8[1m]')).toBe('claude-opus-4-8');
			expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
		});
	});
	describe('calculateModelCost', () => {
		it('prices the same tokens differently per model', () => {
			const tokens = { inputTokens: 1000000, outputTokens: 1000000 };
			expect(calculateModelCost(tokens, 'claude-fable-5')).toBeCloseTo(60, 10); // 10 + 50
			expect(calculateModelCost(tokens, 'claude-opus-4-8')).toBeCloseTo(30, 10); // 5 + 25
			expect(calculateModelCost(tokens, 'claude-sonnet-4-6')).toBeCloseTo(18, 10); // 3 + 15
			expect(calculateModelCost(tokens, 'claude-haiku-4-5')).toBeCloseTo(6, 10); // 1 + 5
		});
		it('Fable costs more than 3x the flat default for the same usage', () => {
			const tokens = { inputTokens: 1000000, outputTokens: 1000000 };
			const fable = calculateModelCost(tokens, 'claude-fable-5');
			const flat = calculateModelCost(tokens); // default Sonnet
			expect(fable / flat).toBeGreaterThan(3);
		});
		it('unknown model uses the default tier', () => {
			const tokens = { inputTokens: 1000000, outputTokens: 1000000 };
			expect(calculateModelCost(tokens, 'mystery-model')).toBeCloseTo(18, 10);
		});
	});
	describe('computeClaudeUsageCost', () => {
		function assistantLine(model: string | null, usage: Record<string, number>): string {
			const message: Record<string, unknown> = { usage };
			if (model !== null) message.model = model;
			return JSON.stringify({ type: 'assistant', message });
		}
		it('buckets tokens by model and prices each bucket separately', () => {
			const content = [
				assistantLine('claude-opus-4-8', { input_tokens: 1000000 }),
				assistantLine('claude-fable-5', { output_tokens: 1000000 }),
			].join('\n');
			const result = computeClaudeUsageCost(content);
			expect(result.inputTokens).toBe(1000000);
			expect(result.outputTokens).toBe(1000000);
			// Opus 1M input ($5) + Fable 1M output ($50) = $55 (NOT a single flat rate).
			expect(result.costUsd).toBeCloseTo(55, 10);
		});
		it('sums grand totals across all token types', () => {
			const content = [
				assistantLine('claude-sonnet-4-6', {
					input_tokens: 100,
					output_tokens: 200,
					cache_read_input_tokens: 300,
					cache_creation_input_tokens: 400,
				}),
			].join('\n');
			const result = computeClaudeUsageCost(content);
			expect(result.inputTokens).toBe(100);
			expect(result.outputTokens).toBe(200);
			expect(result.cacheReadTokens).toBe(300);
			expect(result.cacheCreationTokens).toBe(400);
		});
		it('ignores malformed lines, non-usage lines, and synthetic-model usage falls back to default', () => {
			const content = [
				'not valid json at all',
				JSON.stringify({ type: 'user', message: { content: 'hello' } }),
				assistantLine('<synthetic>', { input_tokens: 1000000 }), // unknown -> default $3
				'',
			].join('\n');
			const result = computeClaudeUsageCost(content);
			expect(result.inputTokens).toBe(1000000);
			expect(result.costUsd).toBeCloseTo(3, 10); // default Sonnet input rate
		});
		it('prices usage with a missing model field at the default tier', () => {
			const content = assistantLine(null, { input_tokens: 1000000 });
			const result = computeClaudeUsageCost(content);
			expect(result.costUsd).toBeCloseTo(3, 10);
		});
		it('returns zeros for content with no usage', () => {
			const content = JSON.stringify({ type: 'user', message: { content: 'hi' } });
			const result = computeClaudeUsageCost(content);
			expect(result).toEqual({
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0,
				byModel: [],
			});
		});
		it('exposes the per-model split the grand totals were summed from', () => {
			const content = [
				assistantLine('claude-opus-4-8', { input_tokens: 1000000 }),
				assistantLine('claude-fable-5', { output_tokens: 1000000 }),
			].join('\n');
			const result = computeClaudeUsageCost(content);
			expect(result.byModel).toHaveLength(2);
			const opus = result.byModel.find((m) => m.model === 'claude-opus-4-8');
			const fable = result.byModel.find((m) => m.model === 'claude-fable-5');
			expect(opus).toMatchObject({ inputTokens: 1000000, outputTokens: 0 });
			expect(opus?.costUsd).toBeCloseTo(5, 10); // 1M Opus input
			expect(fable).toMatchObject({ inputTokens: 0, outputTokens: 1000000 });
			expect(fable?.costUsd).toBeCloseTo(50, 10); // 1M Fable output
			// Per-model costs sum to the grand total.
			const summed = result.byModel.reduce((acc, m) => acc + m.costUsd, 0);
			expect(summed).toBeCloseTo(result.costUsd, 10);
		});
		it('tolerates usage/model at the entry top level (not nested under message)', () => {
			const content = [
				JSON.stringify({
					type: 'result',
					model: 'claude-fable-5',
					usage: { input_tokens: 1000000 },
				}),
			].join('\n');
			const result = computeClaudeUsageCost(content);
			expect(result.inputTokens).toBe(1000000);
			expect(result.costUsd).toBeCloseTo(10, 10); // Fable input rate, top-level shape
		});
		it('aggregates repeated turns of the same model', () => {
			const content = [
				assistantLine('claude-opus-4-8', { input_tokens: 500000 }),
				assistantLine('claude-opus-4-8', { input_tokens: 500000 }),
			].join('\n');
			const result = computeClaudeUsageCost(content);
			expect(result.inputTokens).toBe(1000000);
			expect(result.costUsd).toBeCloseTo(5, 10); // 1M Opus input
		});
		it('counts one API response once even though Claude Code writes a line per content block', () => {
			// Thinking, text, and tool_use blocks of ONE response each get their own
			// line, and every line repeats the response's usage.
			const block = (id: string, requestId: string) =>
				JSON.stringify({
					type: 'assistant',
					requestId,
					message: {
						id,
						model: 'claude-opus-4-8',
						usage: { input_tokens: 1000000, output_tokens: 1000000 },
					},
				});
			const content = [
				block('msg_a', 'req_a'),
				block('msg_a', 'req_a'),
				block('msg_a', 'req_a'),
				block('msg_b', 'req_b'),
			].join('\n');
			const result = computeClaudeUsageCost(content);
			expect(result.inputTokens).toBe(2000000);
			expect(result.outputTokens).toBe(2000000);
			// Two responses at Opus rates: 2 x ($5 input + $25 output).
			expect(result.costUsd).toBeCloseTo(60, 10);
			expect(result.byModel[0]).toMatchObject({ inputTokens: 2000000 });
		});
		it('keeps responses that share a message id but came from different requests', () => {
			const line = (requestId: string) =>
				JSON.stringify({
					type: 'assistant',
					requestId,
					message: { id: 'msg_a', model: 'claude-opus-4-8', usage: { input_tokens: 1000000 } },
				});
			const result = computeClaudeUsageCost([line('req_1'), line('req_2')].join('\n'));
			expect(result.inputTokens).toBe(2000000);
		});
	});
	describe('createClaudeUsageAccumulator', () => {
		const line = (id: string, model: string, inputTokens: number) =>
			JSON.stringify({
				type: 'assistant',
				requestId: `req_${id}`,
				message: { id, model, usage: { input_tokens: inputTokens, output_tokens: 1000 } },
			});
		it('prices several documents the same as their joined text', () => {
			const docs = [
				[line('msg_a', 'claude-opus-4-8', 1000000), line('msg_a', 'claude-opus-4-8', 1000000)].join(
					'\n'
				),
				line('msg_b', 'claude-haiku-4-5', 2000000),
				line('msg_c', 'claude-opus-4-8', 500000),
			];
			const usage = createClaudeUsageAccumulator();
			for (const doc of docs) usage.add(doc);
			expect(usage.finish()).toEqual(computeClaudeUsageCost(docs.join('\n')));
		});
		it('counts a response repeated in a later document once', () => {
			const usage = createClaudeUsageAccumulator();
			usage.add(line('msg_a', 'claude-opus-4-8', 1000000));
			usage.add(line('msg_a', 'claude-opus-4-8', 1000000));
			expect(usage.finish().inputTokens).toBe(1000000);
		});
		it('reports zeros when nothing was added', () => {
			expect(createClaudeUsageAccumulator().finish()).toEqual(computeClaudeUsageCost(''));
		});
	});
	describe('OpenAI (Codex) pricing', () => {
		it('resolves gpt slugs to the OpenAI tier instead of the Anthropic default', () => {
			expect(resolveModelPricing('gpt-5-codex').INPUT_PER_MILLION).toBe(1.25);
			expect(resolveModelPricing('gpt-5-codex').OUTPUT_PER_MILLION).toBe(10);
			// Point releases Codex discovers at runtime inherit the family rate.
			expect(resolveModelPricing('gpt-5.4').INPUT_PER_MILLION).toBe(1.25);
			expect(resolveModelPricing('gpt-5.6-sol').OUTPUT_PER_MILLION).toBe(10);
			expect(resolveModelPricing('gpt-5.4-mini').INPUT_PER_MILLION).toBe(0.25);
			expect(resolveModelPricing('gpt-5-nano').INPUT_PER_MILLION).toBe(0.05);
		});
		it('never prices a gpt model at the Sonnet default', () => {
			expect(resolveModelPricing('gpt-5.4')).not.toBe(DEFAULT_MODEL_PRICING);
		});
		it('bills cached tokens once, as the cheap half of input', () => {
			// OpenAI reports cached tokens INSIDE input_tokens, so a 1M-input turn that
			// was 80% cache costs 200k at the input rate + 800k at the cache rate.
			const cost = calculateModelCost(
				{ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 800000 },
				'gpt-5-codex'
			);
			expect(cost).toBeCloseTo(0.2 * 1.25 + 0.8 * 0.125, 10);
		});
		it('a cache hit is cheaper than a cache miss', () => {
			const miss = calculateModelCost({ inputTokens: 1000000, outputTokens: 0 }, 'gpt-5-codex');
			const hit = calculateModelCost(
				{ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 1000000 },
				'gpt-5-codex'
			);
			expect(hit).toBeLessThan(miss);
		});
		it('leaves Anthropic cache reads additive', () => {
			// Claude reports cache reads BESIDE input_tokens, so both are billed.
			const cost = calculateModelCost(
				{ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 1000000 },
				'claude-sonnet-4-6'
			);
			expect(cost).toBeCloseTo(3 + 0.3, 10);
		});
	});
	describe('MODEL_PRICING table', () => {
		it('covers the current generation of models', () => {
			for (const id of [
				'claude-fable-5',
				'claude-opus-4-8',
				'claude-opus-4-7',
				'claude-opus-4-6',
				'claude-sonnet-4-6',
				'claude-haiku-4-5',
			]) {
				expect(MODEL_PRICING[id]).toBeDefined();
			}
		});
	});
});
