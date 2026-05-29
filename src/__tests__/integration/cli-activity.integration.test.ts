/**
 * Tests for src/shared/cli-activity.ts
 *
 * This module provides functions for tracking CLI activity status across sessions.
 * Tests mock Node.js fs, os, and process modules to isolate behavior.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Now import after mocks are set up
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	CliActivityStatus,
	readCliActivities,
	registerCliActivity,
	updateCliActivity,
	unregisterCliActivity,
	getCliActivityForSession,
	isSessionBusyWithCli,
	cleanupStaleActivities,
} from '../../shared/cli-activity';

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

	beforeEach(() => {
		vi.clearAllMocks();

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
	});

	describe('getConfigDir (internal via path construction)', () => {
		describe('on macOS', () => {
			it('should construct correct config path for macOS', () => {
				mockOs.platform.mockReturnValue('darwin');
				mockOs.homedir.mockReturnValue('/Users/testuser');

				// Call a function that uses getConfigDir internally
				readCliActivities();

				// Verify the path was constructed correctly
				expect(mockFs.readFileSync).toHaveBeenCalledWith(
					path.join(
						'/Users/testuser',
						'Library',
						'Application Support',
						'maestro',
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

				readCliActivities();

				expect(mockFs.readFileSync).toHaveBeenCalledWith(
					path.join('C:\\Users\\testuser\\AppData\\Roaming', 'maestro', 'cli-activity.json'),
					'utf-8'
				);

				process.env.APPDATA = originalAppdata;
			});

			it('should construct correct config path for Windows without APPDATA', () => {
				mockOs.platform.mockReturnValue('win32');
				mockOs.homedir.mockReturnValue('C:\\Users\\testuser');
				const originalAppdata = process.env.APPDATA;
				delete process.env.APPDATA;

				readCliActivities();

				expect(mockFs.readFileSync).toHaveBeenCalledWith(
					path.join('C:\\Users\\testuser', 'AppData', 'Roaming', 'maestro', 'cli-activity.json'),
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

				readCliActivities();

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

				readCliActivities();

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

				readCliActivities();

				expect(mockFs.readFileSync).toHaveBeenCalledWith(
					path.join('/home/testuser', '.config', 'maestro', 'cli-activity.json'),
					'utf-8'
				);

				process.env.XDG_CONFIG_HOME = originalXdg;
			});
		});
	});

	describe('readCliActivities', () => {
		it('should return empty array when file does not exist', () => {
			mockFs.readFileSync.mockImplementation(() => {
				throw new Error('ENOENT: no such file or directory');
			});

			const activities = readCliActivities();
			expect(activities).toEqual([]);
		});

		it('should return empty array when file contains invalid JSON', () => {
			mockFs.readFileSync.mockReturnValue('not valid json');

			const activities = readCliActivities();
			expect(activities).toEqual([]);
		});

		it('should return empty array when activities array is missing', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({}));

			const activities = readCliActivities();
			expect(activities).toEqual([]);
		});

		it('should return activities when file contains valid data', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));

			const activities = readCliActivities();
			expect(activities).toHaveLength(1);
			expect(activities[0].sessionId).toBe('session-123');
		});

		it('should return multiple activities', () => {
			mockFs.readFileSync.mockReturnValue(
				JSON.stringify({ activities: [sampleActivity, anotherActivity] })
			);

			const activities = readCliActivities();
			expect(activities).toHaveLength(2);
			expect(activities[0].sessionId).toBe('session-123');
			expect(activities[1].sessionId).toBe('session-456');
		});

		it('should return empty array when null activities', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: null }));

			const activities = readCliActivities();
			expect(activities).toEqual([]);
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

	describe('updateCliActivity', () => {
		it('should update an existing activity', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));

			updateCliActivity('session-123', { currentTask: 'Updated task' });

			expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
			const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
			const parsed = JSON.parse(writtenContent as string);
			expect(parsed.activities[0].currentTask).toBe('Updated task');
		});

		it('should update multiple fields', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));

			updateCliActivity('session-123', {
				currentTask: 'Updated task',
				currentDocument: 'new-doc.md',
			});

			const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
			const parsed = JSON.parse(writtenContent as string);
			expect(parsed.activities[0].currentTask).toBe('Updated task');
			expect(parsed.activities[0].currentDocument).toBe('new-doc.md');
		});

		it('should preserve unchanged fields', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));

			updateCliActivity('session-123', { currentTask: 'Updated task' });

			const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
			const parsed = JSON.parse(writtenContent as string);
			expect(parsed.activities[0].playbookId).toBe('playbook-456');
			expect(parsed.activities[0].pid).toBe(12345);
		});

		it('should do nothing if session not found', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));

			updateCliActivity('non-existent-session', { currentTask: 'Updated task' });

			expect(mockFs.writeFileSync).not.toHaveBeenCalled();
		});

		it('should update correct session when multiple exist', () => {
			mockFs.readFileSync.mockReturnValue(
				JSON.stringify({ activities: [sampleActivity, anotherActivity] })
			);

			updateCliActivity('session-456', { currentTask: 'Updated second' });

			const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
			const parsed = JSON.parse(writtenContent as string);
			expect(parsed.activities[0].currentTask).toBe('Running tests'); // Unchanged
			expect(parsed.activities[1].currentTask).toBe('Updated second');
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
				throw new Error('ESRCH: No such process');
			}) as unknown as typeof process.kill;

			const busy = isSessionBusyWithCli('session-123');

			expect(busy).toBe(false);
			// Should have cleaned up stale entry (called writeFileSync)
			expect(mockFs.writeFileSync).toHaveBeenCalled();

			process.kill = originalKill;
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

	describe('cleanupStaleActivities', () => {
		it('should remove activities with dead processes', () => {
			const deadActivity: CliActivityStatus = {
				...sampleActivity,
				pid: 11111, // Dead process
			};
			const aliveActivity: CliActivityStatus = {
				...anotherActivity,
				pid: 22222, // Alive process
			};

			mockFs.readFileSync.mockReturnValue(
				JSON.stringify({ activities: [deadActivity, aliveActivity] })
			);

			const originalKill = process.kill;
			process.kill = vi.fn().mockImplementation((pid: number) => {
				if (pid === 11111) {
					throw new Error('ESRCH: No such process');
				}
				return true; // Process exists
			}) as unknown as typeof process.kill;

			cleanupStaleActivities();

			expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
			const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
			const parsed = JSON.parse(writtenContent as string);
			expect(parsed.activities).toHaveLength(1);
			expect(parsed.activities[0].pid).toBe(22222);

			process.kill = originalKill;
		});

		it('should not write if no stale activities', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));

			const originalKill = process.kill;
			process.kill = vi.fn().mockReturnValue(true) as unknown as typeof process.kill;

			cleanupStaleActivities();

			expect(mockFs.writeFileSync).not.toHaveBeenCalled();

			process.kill = originalKill;
		});

		it('should remove all activities if all are stale', () => {
			mockFs.readFileSync.mockReturnValue(
				JSON.stringify({ activities: [sampleActivity, anotherActivity] })
			);

			const originalKill = process.kill;
			process.kill = vi.fn().mockImplementation(() => {
				throw new Error('ESRCH: No such process');
			}) as unknown as typeof process.kill;

			cleanupStaleActivities();

			expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);
			const [, writtenContent] = mockFs.writeFileSync.mock.calls[0];
			const parsed = JSON.parse(writtenContent as string);
			expect(parsed.activities).toHaveLength(0);

			process.kill = originalKill;
		});

		it('should handle empty activities list', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));

			cleanupStaleActivities();

			expect(mockFs.writeFileSync).not.toHaveBeenCalled();
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
		it('should support full lifecycle: register -> update -> get -> unregister', () => {
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [] }));

			// Register
			registerCliActivity(sampleActivity);
			expect(mockFs.writeFileSync).toHaveBeenCalledTimes(1);

			// Simulate subsequent reads returning the registered activity
			mockFs.readFileSync.mockReturnValue(JSON.stringify({ activities: [sampleActivity] }));

			// Update
			updateCliActivity('session-123', { currentTask: 'New task' });
			expect(mockFs.writeFileSync).toHaveBeenCalledTimes(2);

			// Get
			const activity = getCliActivityForSession('session-123');
			expect(activity).toBeDefined();

			// Unregister
			unregisterCliActivity('session-123');
			expect(mockFs.writeFileSync).toHaveBeenCalledTimes(3);
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
});
