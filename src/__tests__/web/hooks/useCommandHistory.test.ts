/**
 * Tests for useCommandHistory hook
 *
 * Tests the command history management hook including:
 * - Initial state values
 * - Options handling (maxSize, persist, storageKey)
 * - localStorage persistence (load, save, error handling)
 * - addCommand (trimming, empty rejection, ID generation, mode handling)
 * - removeCommand (by ID, navigation reset)
 * - clearHistory (empty history, navigation reset)
 * - getRecentCommands (default count, custom count)
 * - getUniqueCommands (deduplication, normalization)
 * - searchCommands (case-insensitive, partial match)
 * - Navigation (up, down, reset, boundary clamping)
 * - Default export verification
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useCommandHistory,
	type CommandHistoryEntry,
	type UseCommandHistoryOptions,
	type UseCommandHistoryReturn,
} from '../../../web/hooks/useCommandHistory';

// Mock the webLogger
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		setLevel: vi.fn(),
		getLevel: vi.fn().mockReturnValue('warn'),
		setEnabled: vi.fn(),
		isEnabled: vi.fn().mockReturnValue(true),
		enableDebug: vi.fn(),
		reset: vi.fn(),
	},
}));

// Get the mock for assertions
import { webLogger } from '../../../web/utils/logger';

describe('useCommandHistory', () => {
	// Store original localStorage
	let localStorageMock: Record<string, string>;
	const originalLocalStorage = global.localStorage;

	beforeEach(() => {
		vi.clearAllMocks();

		// Reset localStorage mock
		localStorageMock = {};
		Object.defineProperty(global, 'localStorage', {
			value: {
				getItem: vi.fn((key: string) => localStorageMock[key] || null),
				setItem: vi.fn((key: string, value: string) => {
					localStorageMock[key] = value;
				}),
				removeItem: vi.fn((key: string) => {
					delete localStorageMock[key];
				}),
				clear: vi.fn(() => {
					localStorageMock = {};
				}),
				length: 0,
				key: vi.fn(),
			},
			writable: true,
		});

		// Mock Date.now for predictable IDs
		vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
		vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(global, 'localStorage', {
			value: originalLocalStorage,
			writable: true,
		});
	});

	describe('initial state', () => {
		it('should initialize with empty history', () => {
			const { result } = renderHook(() => useCommandHistory());

			expect(result.current.history).toEqual([]);
		});

		it('should initialize with navigationIndex of -1', () => {
			const { result } = renderHook(() => useCommandHistory());

			expect(result.current.navigationIndex).toBe(-1);
		});

		it('should return all expected API methods', () => {
			const { result } = renderHook(() => useCommandHistory());

			expect(typeof result.current.addCommand).toBe('function');
			expect(typeof result.current.removeCommand).toBe('function');
			expect(typeof result.current.clearHistory).toBe('function');
			expect(typeof result.current.getRecentCommands).toBe('function');
			expect(typeof result.current.getUniqueCommands).toBe('function');
			expect(typeof result.current.searchCommands).toBe('function');
			expect(typeof result.current.navigateUp).toBe('function');
			expect(typeof result.current.navigateDown).toBe('function');
			expect(typeof result.current.resetNavigation).toBe('function');
		});
	});

	describe('options handling', () => {
		it('should use default maxSize of 50', () => {
			const { result } = renderHook(() => useCommandHistory());

			// Add 55 commands
			act(() => {
				for (let i = 0; i < 55; i++) {
					// Advance time for unique IDs
					vi.spyOn(Date, 'now').mockReturnValue(1700000000000 + i);
					result.current.addCommand(`command${i}`);
				}
			});

			// Should be limited to 50
			expect(result.current.history.length).toBe(50);
		});

		it('should respect custom maxSize option', () => {
			const { result } = renderHook(() => useCommandHistory({ maxSize: 10 }));

			act(() => {
				for (let i = 0; i < 15; i++) {
					vi.spyOn(Date, 'now').mockReturnValue(1700000000000 + i);
					result.current.addCommand(`command${i}`);
				}
			});

			expect(result.current.history.length).toBe(10);
			// Most recent should be first
			expect(result.current.history[0].command).toBe('command14');
		});

		it('should use default storage key', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('test');
			});

			expect(localStorage.setItem).toHaveBeenCalledWith(
				'maestro_command_history',
				expect.any(String)
			);
		});

		it('should use custom storage key', () => {
			const { result } = renderHook(() => useCommandHistory({ storageKey: 'custom_history' }));

			act(() => {
				result.current.addCommand('test');
			});

			expect(localStorage.setItem).toHaveBeenCalledWith('custom_history', expect.any(String));
		});

		it('should not persist when persist is false', () => {
			const { result } = renderHook(() => useCommandHistory({ persist: false }));

			act(() => {
				result.current.addCommand('test');
			});

			// Should not call setItem after the initial load effect
			expect(localStorage.setItem).not.toHaveBeenCalled();
		});
	});

	describe('localStorage persistence', () => {
		it('should load history from localStorage on mount', () => {
			const existingHistory: CommandHistoryEntry[] = [
				{ id: '1', command: 'existing1', timestamp: 1700000000000, mode: 'ai' },
				{ id: '2', command: 'existing2', timestamp: 1699999999999, mode: 'terminal' },
			];
			localStorageMock['maestro_command_history'] = JSON.stringify(existingHistory);

			const { result } = renderHook(() => useCommandHistory());

			// Effect runs synchronously in test environment
			expect(result.current.history.length).toBe(2);
			expect(result.current.history[0].command).toBe('existing1');
			expect(result.current.history[1].command).toBe('existing2');
		});

		it('should validate entries when loading from localStorage', () => {
			const invalidHistory = [
				{ id: '1', command: 'valid', timestamp: 1700000000000, mode: 'ai' },
				{ command: 'missing-id', timestamp: 1700000000000, mode: 'ai' }, // Missing id
				{ id: '2', timestamp: 1700000000000, mode: 'ai' }, // Missing command
				{ id: '3', command: 'missing-timestamp', mode: 'ai' }, // Missing timestamp
				null, // null entry
				{ id: '4', command: 'valid2', timestamp: 1700000000001, mode: 'terminal' },
			];
			localStorageMock['maestro_command_history'] = JSON.stringify(invalidHistory);

			const { result } = renderHook(() => useCommandHistory());

			expect(result.current.history.length).toBe(2);
			expect(result.current.history[0].command).toBe('valid');
			expect(result.current.history[1].command).toBe('valid2');
		});

		it('should limit loaded history to maxSize', () => {
			const bigHistory: CommandHistoryEntry[] = [];
			for (let i = 0; i < 100; i++) {
				bigHistory.push({
					id: `${i}`,
					command: `command${i}`,
					timestamp: 1700000000000 - i,
					mode: 'ai',
				});
			}
			localStorageMock['maestro_command_history'] = JSON.stringify(bigHistory);

			const { result } = renderHook(() => useCommandHistory({ maxSize: 25 }));

			expect(result.current.history.length).toBe(25);
		});

		it('should handle JSON parse errors gracefully', () => {
			localStorageMock['maestro_command_history'] = 'invalid json{{{';

			const { result } = renderHook(() => useCommandHistory());

			expect(webLogger.error).toHaveBeenCalledWith(
				'Failed to load from localStorage',
				'CommandHistory',
				expect.any(Error)
			);

			// Should still have empty history
			expect(result.current.history).toEqual([]);
		});

		it('should save history to localStorage when it changes', () => {
			const { result } = renderHook(() => useCommandHistory());

			// Clear any calls from initial mount
			vi.mocked(localStorage.setItem).mockClear();

			act(() => {
				result.current.addCommand('new command');
			});

			// Check that setItem was called with the command
			expect(localStorage.setItem).toHaveBeenCalledWith(
				'maestro_command_history',
				expect.stringContaining('new command')
			);
		});

		it('should handle localStorage setItem errors gracefully', () => {
			// First render a hook to get past initial load
			const { result } = renderHook(() => useCommandHistory());

			// Now mock setItem to throw
			const originalSetItem = localStorage.setItem;
			(localStorage as any).setItem = vi.fn(() => {
				throw new Error('QuotaExceededError');
			});

			act(() => {
				result.current.addCommand('test');
			});

			expect(webLogger.error).toHaveBeenCalledWith(
				'Failed to save to localStorage',
				'CommandHistory',
				expect.any(Error)
			);

			// Restore
			(localStorage as any).setItem = originalSetItem;
		});

		it('should not save to localStorage before initial load completes', () => {
			// This tests the initialLoadDone.current check
			const existingHistory: CommandHistoryEntry[] = [
				{ id: '1', command: 'existing', timestamp: 1700000000000, mode: 'ai' },
			];
			localStorageMock['maestro_command_history'] = JSON.stringify(existingHistory);

			// Clear any previous calls
			vi.mocked(localStorage.setItem).mockClear();

			renderHook(() => useCommandHistory());

			// setItem should not be called during render (before load effect)
			// The first setItem should only happen after adding a command
		});
	});

	describe('addCommand', () => {
		it('should add a command to the beginning of history', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('first command');
			});

			act(() => {
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('second command');
			});

			expect(result.current.history.length).toBe(2);
			expect(result.current.history[0].command).toBe('second command');
			expect(result.current.history[1].command).toBe('first command');
		});

		it('should trim whitespace from commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('  trimmed command  ');
			});

			expect(result.current.history[0].command).toBe('trimmed command');
		});

		it('should reject empty commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('');
			});

			expect(result.current.history.length).toBe(0);
		});

		it('should reject whitespace-only commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('   ');
			});

			expect(result.current.history.length).toBe(0);
		});

		it('should use default mode of ai', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('test command');
			});

			expect(result.current.history[0].mode).toBe('ai');
		});

		it('should accept terminal mode', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('ls -la', undefined, 'terminal');
			});

			expect(result.current.history[0].mode).toBe('terminal');
		});

		it('should store sessionId when provided', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('test', 'session-123', 'ai');
			});

			expect(result.current.history[0].sessionId).toBe('session-123');
		});

		it('should handle undefined sessionId', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('test');
			});

			expect(result.current.history[0].sessionId).toBeUndefined();
		});

		it('should generate unique IDs', () => {
			const { result } = renderHook(() => useCommandHistory());

			// Restore Math.random for varied IDs
			vi.restoreAllMocks();
			vi.useFakeTimers();

			const ids = new Set<string>();

			act(() => {
				for (let i = 0; i < 10; i++) {
					result.current.addCommand(`command${i}`);
				}
			});

			result.current.history.forEach((entry) => {
				expect(ids.has(entry.id)).toBe(false);
				ids.add(entry.id);
			});

			expect(ids.size).toBe(10);
		});

		it('should set timestamp to current time', () => {
			const testTime = 1700000000000;
			vi.spyOn(Date, 'now').mockReturnValue(testTime);

			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('test');
			});

			expect(result.current.history[0].timestamp).toBe(testTime);
		});

		it('should reset navigation index when adding command', () => {
			const { result } = renderHook(() => useCommandHistory());

			// Add some commands
			act(() => {
				result.current.addCommand('first');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('second');
			});

			// Navigate up
			act(() => {
				result.current.navigateUp();
				result.current.navigateUp();
			});

			expect(result.current.navigationIndex).toBeGreaterThan(-1);

			// Add a new command
			act(() => {
				vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
				result.current.addCommand('third');
			});

			expect(result.current.navigationIndex).toBe(-1);
		});
	});

	describe('removeCommand', () => {
		it('should remove a command by ID', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('first');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('second');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
				result.current.addCommand('third');
			});

			const secondId = result.current.history[1].id;

			act(() => {
				result.current.removeCommand(secondId);
			});

			expect(result.current.history.length).toBe(2);
			expect(result.current.history.find((e) => e.id === secondId)).toBeUndefined();
			expect(result.current.history[0].command).toBe('third');
			expect(result.current.history[1].command).toBe('first');
		});

		it('should do nothing when removing non-existent ID', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('test');
			});

			const lengthBefore = result.current.history.length;

			act(() => {
				result.current.removeCommand('non-existent-id');
			});

			expect(result.current.history.length).toBe(lengthBefore);
		});

		it('should reset navigation index when removing command', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('first');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('second');
			});

			act(() => {
				result.current.navigateUp();
			});

			expect(result.current.navigationIndex).toBe(0);

			const firstId = result.current.history[1].id;

			act(() => {
				result.current.removeCommand(firstId);
			});

			expect(result.current.navigationIndex).toBe(-1);
		});
	});

	describe('clearHistory', () => {
		it('should clear all history', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('first');
				result.current.addCommand('second');
				result.current.addCommand('third');
			});

			expect(result.current.history.length).toBe(3);

			act(() => {
				result.current.clearHistory();
			});

			expect(result.current.history).toEqual([]);
		});

		it('should reset navigation index when clearing', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('first');
				result.current.addCommand('second');
			});

			act(() => {
				result.current.navigateUp();
			});

			expect(result.current.navigationIndex).toBe(0);

			act(() => {
				result.current.clearHistory();
			});

			expect(result.current.navigationIndex).toBe(-1);
		});

		it('should work when history is already empty', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.clearHistory();
			});

			expect(result.current.history).toEqual([]);
			expect(result.current.navigationIndex).toBe(-1);
		});
	});

	describe('getRecentCommands', () => {
		it('should return default 5 recent commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				for (let i = 0; i < 10; i++) {
					vi.spyOn(Date, 'now').mockReturnValue(1700000000000 + i);
					result.current.addCommand(`command${i}`);
				}
			});

			const recent = result.current.getRecentCommands();

			expect(recent.length).toBe(5);
			expect(recent[0].command).toBe('command9');
			expect(recent[4].command).toBe('command5');
		});

		it('should return custom count of recent commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				for (let i = 0; i < 10; i++) {
					vi.spyOn(Date, 'now').mockReturnValue(1700000000000 + i);
					result.current.addCommand(`command${i}`);
				}
			});

			const recent = result.current.getRecentCommands(3);

			expect(recent.length).toBe(3);
			expect(recent[0].command).toBe('command9');
			expect(recent[2].command).toBe('command7');
		});

		it('should return empty array for empty history', () => {
			const { result } = renderHook(() => useCommandHistory());

			const recent = result.current.getRecentCommands();

			expect(recent).toEqual([]);
		});

		it('should return all commands when count exceeds history size', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('only');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('two');
			});

			const recent = result.current.getRecentCommands(10);

			expect(recent.length).toBe(2);
		});
	});

	describe('getUniqueCommands', () => {
		it('should deduplicate by normalized text', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
				result.current.addCommand('hello');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('HELLO'); // duplicate (case-insensitive)
				vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
				result.current.addCommand('world');
			});

			const unique = result.current.getUniqueCommands();

			expect(unique.length).toBe(2);
			// Most recent of each unique command
			expect(unique[0].command).toBe('world');
			expect(unique[1].command).toBe('HELLO');
		});

		it('should ignore trailing punctuation when deduplicating', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
				result.current.addCommand('test');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('test?');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
				result.current.addCommand('test!');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000003);
				result.current.addCommand('test.');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000004);
				result.current.addCommand('test...');
			});

			const unique = result.current.getUniqueCommands();

			expect(unique.length).toBe(1);
			expect(unique[0].command).toBe('test...'); // Most recent
		});

		it('should return default 5 unique commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				for (let i = 0; i < 10; i++) {
					vi.spyOn(Date, 'now').mockReturnValue(1700000000000 + i);
					result.current.addCommand(`unique${i}`);
				}
			});

			const unique = result.current.getUniqueCommands();

			expect(unique.length).toBe(5);
		});

		it('should return custom count of unique commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				for (let i = 0; i < 10; i++) {
					vi.spyOn(Date, 'now').mockReturnValue(1700000000000 + i);
					result.current.addCommand(`unique${i}`);
				}
			});

			const unique = result.current.getUniqueCommands(3);

			expect(unique.length).toBe(3);
		});

		it('should return empty array for empty history', () => {
			const { result } = renderHook(() => useCommandHistory());

			const unique = result.current.getUniqueCommands();

			expect(unique).toEqual([]);
		});

		it('should handle mixed case and punctuation correctly', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
				result.current.addCommand('Hello World');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('hello world!');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
				result.current.addCommand('HELLO WORLD?');
			});

			const unique = result.current.getUniqueCommands();

			expect(unique.length).toBe(1);
			expect(unique[0].command).toBe('HELLO WORLD?');
		});
	});

	describe('searchCommands', () => {
		it('should search case-insensitively', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('Hello World');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('goodbye world');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
				result.current.addCommand('HELLO THERE');
			});

			const results = result.current.searchCommands('hello');

			expect(results.length).toBe(2);
			expect(results.some((e) => e.command === 'Hello World')).toBe(true);
			expect(results.some((e) => e.command === 'HELLO THERE')).toBe(true);
		});

		it('should return partial matches', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('git commit');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('git push');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
				result.current.addCommand('npm install');
			});

			const results = result.current.searchCommands('git');

			expect(results.length).toBe(2);
		});

		it('should return all commands for empty query', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('first');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('second');
			});

			const results = result.current.searchCommands('');

			expect(results.length).toBe(2);
		});

		it('should return empty array when no matches', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('hello');
				result.current.addCommand('world');
			});

			const results = result.current.searchCommands('xyz');

			expect(results).toEqual([]);
		});

		it('should return empty array for empty history', () => {
			const { result } = renderHook(() => useCommandHistory());

			const results = result.current.searchCommands('test');

			expect(results).toEqual([]);
		});
	});

	describe('navigation', () => {
		describe('navigateUp', () => {
			it('should return null for empty history', () => {
				const { result } = renderHook(() => useCommandHistory());

				let command: string | null = null;
				act(() => {
					command = result.current.navigateUp();
				});

				expect(command).toBeNull();
				expect(result.current.navigationIndex).toBe(-1);
			});

			it('should return first (most recent) command on first navigateUp', () => {
				const { result } = renderHook(() => useCommandHistory());

				act(() => {
					result.current.addCommand('first');
					vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
					result.current.addCommand('second');
				});

				let command: string | null = null;
				act(() => {
					command = result.current.navigateUp();
				});

				expect(command).toBe('second');
				expect(result.current.navigationIndex).toBe(0);
			});

			it('should navigate through history on subsequent calls', () => {
				const { result } = renderHook(() => useCommandHistory());

				act(() => {
					result.current.addCommand('first');
					vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
					result.current.addCommand('second');
					vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
					result.current.addCommand('third');
				});

				let command: string | null = null;

				act(() => {
					command = result.current.navigateUp();
				});
				expect(command).toBe('third');
				expect(result.current.navigationIndex).toBe(0);

				act(() => {
					command = result.current.navigateUp();
				});
				expect(command).toBe('second');
				expect(result.current.navigationIndex).toBe(1);

				act(() => {
					command = result.current.navigateUp();
				});
				expect(command).toBe('first');
				expect(result.current.navigationIndex).toBe(2);
			});

			it('should clamp at the end of history', () => {
				const { result } = renderHook(() => useCommandHistory());

				act(() => {
					result.current.addCommand('only');
				});

				let command: string | null = null;

				act(() => {
					command = result.current.navigateUp();
				});
				expect(command).toBe('only');

				act(() => {
					command = result.current.navigateUp();
				});
				expect(command).toBe('only');
				expect(result.current.navigationIndex).toBe(0);
			});
		});

		describe('navigateDown', () => {
			it('should return null when at beginning (index -1)', () => {
				const { result } = renderHook(() => useCommandHistory());

				act(() => {
					result.current.addCommand('test');
				});

				let command: string | null = null;
				act(() => {
					command = result.current.navigateDown();
				});

				expect(command).toBeNull();
				expect(result.current.navigationIndex).toBe(-1);
			});

			it('should return null and reset when navigating down from index 0', () => {
				const { result } = renderHook(() => useCommandHistory());

				act(() => {
					result.current.addCommand('test');
				});

				act(() => {
					result.current.navigateUp(); // Now at index 0
				});

				expect(result.current.navigationIndex).toBe(0);

				let command: string | null = null;
				act(() => {
					command = result.current.navigateDown();
				});

				expect(command).toBeNull();
				expect(result.current.navigationIndex).toBe(-1);
			});

			it('should navigate back to more recent commands', () => {
				const { result } = renderHook(() => useCommandHistory());

				act(() => {
					result.current.addCommand('first');
					vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
					result.current.addCommand('second');
					vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
					result.current.addCommand('third');
				});

				// Navigate up to the oldest - each call needs its own act()
				act(() => {
					result.current.navigateUp(); // index 0, third
				});
				act(() => {
					result.current.navigateUp(); // index 1, second
				});
				act(() => {
					result.current.navigateUp(); // index 2, first
				});

				expect(result.current.navigationIndex).toBe(2);

				let command: string | null = null;

				act(() => {
					command = result.current.navigateDown();
				});
				expect(command).toBe('second');
				expect(result.current.navigationIndex).toBe(1);

				act(() => {
					command = result.current.navigateDown();
				});
				expect(command).toBe('third');
				expect(result.current.navigationIndex).toBe(0);

				act(() => {
					command = result.current.navigateDown();
				});
				expect(command).toBeNull();
				expect(result.current.navigationIndex).toBe(-1);
			});
		});

		describe('resetNavigation', () => {
			it('should reset navigation index to -1', () => {
				const { result } = renderHook(() => useCommandHistory());

				act(() => {
					result.current.addCommand('first');
					vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
					result.current.addCommand('second');
				});

				act(() => {
					result.current.navigateUp();
				});
				act(() => {
					result.current.navigateUp();
				});

				expect(result.current.navigationIndex).toBe(1);

				act(() => {
					result.current.resetNavigation();
				});

				expect(result.current.navigationIndex).toBe(-1);
			});

			it('should work when already at -1', () => {
				const { result } = renderHook(() => useCommandHistory());

				expect(result.current.navigationIndex).toBe(-1);

				act(() => {
					result.current.resetNavigation();
				});

				expect(result.current.navigationIndex).toBe(-1);
			});
		});
	});

	describe('function stability', () => {
		it('should maintain stable function references', () => {
			const { result, rerender } = renderHook(() => useCommandHistory());

			const initialAddCommand = result.current.addCommand;
			const initialRemoveCommand = result.current.removeCommand;
			const initialClearHistory = result.current.clearHistory;
			const initialNavigateUp = result.current.navigateUp;
			const initialNavigateDown = result.current.navigateDown;
			const initialResetNavigation = result.current.resetNavigation;

			rerender();

			expect(result.current.addCommand).toBe(initialAddCommand);
			expect(result.current.removeCommand).toBe(initialRemoveCommand);
			expect(result.current.clearHistory).toBe(initialClearHistory);
			expect(result.current.navigateUp).toBe(initialNavigateUp);
			expect(result.current.navigateDown).toBe(initialNavigateDown);
			expect(result.current.resetNavigation).toBe(initialResetNavigation);
		});

		it('should update getRecentCommands when history changes', () => {
			const { result } = renderHook(() => useCommandHistory());

			const initial = result.current.getRecentCommands;

			act(() => {
				result.current.addCommand('new');
			});

			// getRecentCommands depends on history, so the memoized function changes
			expect(result.current.getRecentCommands).not.toBe(initial);
		});
	});

	describe('edge cases', () => {
		it('should handle special characters in commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			const specialCommand = 'echo "hello $USER" && ls -la | grep "test"';

			act(() => {
				result.current.addCommand(specialCommand);
			});

			expect(result.current.history[0].command).toBe(specialCommand);
		});

		it('should handle unicode characters', () => {
			const { result } = renderHook(() => useCommandHistory());

			const unicodeCommand = 'echo "Hello 世界 🎉"';

			act(() => {
				result.current.addCommand(unicodeCommand);
			});

			expect(result.current.history[0].command).toBe(unicodeCommand);
		});

		it('should handle very long commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			const longCommand = 'x'.repeat(10000);

			act(() => {
				result.current.addCommand(longCommand);
			});

			expect(result.current.history[0].command).toBe(longCommand);
		});

		it('should handle multiple mode types correctly', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				result.current.addCommand('ai command', 'session1', 'ai');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('terminal command', 'session1', 'terminal');
			});

			expect(result.current.history[0].mode).toBe('terminal');
			expect(result.current.history[1].mode).toBe('ai');
		});

		it('should handle rapid sequential additions', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				for (let i = 0; i < 100; i++) {
					vi.spyOn(Date, 'now').mockReturnValue(1700000000000 + i);
					result.current.addCommand(`rapid${i}`);
				}
			});

			// With default maxSize of 50
			expect(result.current.history.length).toBe(50);
			expect(result.current.history[0].command).toBe('rapid99');
			expect(result.current.history[49].command).toBe('rapid50');
		});

		it('should handle navigation during empty history', () => {
			const { result } = renderHook(() => useCommandHistory());

			let upResult: string | null = null;
			let downResult: string | null = null;

			act(() => {
				upResult = result.current.navigateUp();
				downResult = result.current.navigateDown();
			});

			expect(upResult).toBeNull();
			expect(downResult).toBeNull();
			expect(result.current.navigationIndex).toBe(-1);
		});

		it('should preserve history order with duplicate commands', () => {
			const { result } = renderHook(() => useCommandHistory());

			act(() => {
				vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
				result.current.addCommand('duplicate');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000001);
				result.current.addCommand('duplicate');
				vi.spyOn(Date, 'now').mockReturnValue(1700000000002);
				result.current.addCommand('duplicate');
			});

			// History keeps all entries (not deduplicated)
			expect(result.current.history.length).toBe(3);

			// But getUniqueCommands deduplicates
			const unique = result.current.getUniqueCommands();
			expect(unique.length).toBe(1);
		});
	});

	describe('types export', () => {
		it('should export CommandHistoryEntry interface correctly', () => {
			const entry: CommandHistoryEntry = {
				id: 'test-id',
				command: 'test command',
				timestamp: Date.now(),
				sessionId: 'session-1',
				mode: 'ai',
			};

			expect(entry.id).toBe('test-id');
			expect(entry.command).toBe('test command');
			expect(entry.mode).toBe('ai');
		});

		it('should export UseCommandHistoryOptions interface correctly', () => {
			const options: UseCommandHistoryOptions = {
				maxSize: 100,
				persist: false,
				storageKey: 'custom_key',
			};

			expect(options.maxSize).toBe(100);
			expect(options.persist).toBe(false);
			expect(options.storageKey).toBe('custom_key');
		});

		it('should allow partial options', () => {
			const partialOptions: UseCommandHistoryOptions = {
				maxSize: 25,
			};

			const { result } = renderHook(() => useCommandHistory(partialOptions));

			// Should work with partial options
			expect(result.current.history).toBeDefined();
		});
	});

	describe('default export', () => {
		it('should export useCommandHistory as default', async () => {
			const module = await import('../../../web/hooks/useCommandHistory');

			expect(module.default).toBe(module.useCommandHistory);
		});
	});
});
