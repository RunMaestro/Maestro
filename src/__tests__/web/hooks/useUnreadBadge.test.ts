/**
 * Tests for useUnreadBadge hook
 *
 * This hook manages unread response counts and updates the app badge
 * using the Navigator Badge API (PWA feature).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useUnreadBadge,
	isBadgeApiSupported,
	UseUnreadBadgeOptions,
	UseUnreadBadgeReturn,
} from '../../../web/hooks/useUnreadBadge';

// Storage key used by the hook
const UNREAD_RESPONSES_KEY = 'maestro_unread_responses';

// Mock webLogger
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

describe('useUnreadBadge', () => {
	let mockSetAppBadge: ReturnType<typeof vi.fn>;
	let mockClearAppBadge: ReturnType<typeof vi.fn>;
	let originalNavigator: Navigator;
	let mockLocalStorage: Record<string, string>;

	beforeEach(() => {
		// Setup Badge API mocks
		mockSetAppBadge = vi.fn().mockResolvedValue(undefined);
		mockClearAppBadge = vi.fn().mockResolvedValue(undefined);

		// Store original navigator
		originalNavigator = window.navigator;

		// Mock navigator with Badge API
		Object.defineProperty(window, 'navigator', {
			writable: true,
			configurable: true,
			value: {
				...originalNavigator,
				setAppBadge: mockSetAppBadge,
				clearAppBadge: mockClearAppBadge,
			},
		});

		// Mock localStorage
		mockLocalStorage = {};
		const localStorageMock = {
			getItem: vi.fn((key: string) => mockLocalStorage[key] ?? null),
			setItem: vi.fn((key: string, value: string) => {
				mockLocalStorage[key] = value;
			}),
			removeItem: vi.fn((key: string) => {
				delete mockLocalStorage[key];
			}),
			clear: vi.fn(() => {
				mockLocalStorage = {};
			}),
			length: 0,
			key: vi.fn(),
		};
		Object.defineProperty(window, 'localStorage', {
			writable: true,
			configurable: true,
			value: localStorageMock,
		});

		// Mock document.visibilityState
		Object.defineProperty(document, 'visibilityState', {
			writable: true,
			configurable: true,
			value: 'visible',
		});

		vi.clearAllMocks();
	});

	afterEach(() => {
		// Restore original navigator
		Object.defineProperty(window, 'navigator', {
			writable: true,
			configurable: true,
			value: originalNavigator,
		});
		vi.clearAllMocks();
	});

	describe('isBadgeApiSupported() Pure Function', () => {
		it('returns true when navigator.setAppBadge exists', () => {
			expect(isBadgeApiSupported()).toBe(true);
		});

		it('returns false when navigator.setAppBadge is missing', () => {
			Object.defineProperty(window, 'navigator', {
				writable: true,
				configurable: true,
				value: { ...originalNavigator },
			});
			expect(isBadgeApiSupported()).toBe(false);
		});

		it('handles navigator object without setAppBadge property', () => {
			const navWithoutBadge = Object.create(originalNavigator);
			delete (navWithoutBadge as any).setAppBadge;
			Object.defineProperty(window, 'navigator', {
				writable: true,
				configurable: true,
				value: navWithoutBadge,
			});
			expect(isBadgeApiSupported()).toBe(false);
		});
	});

	describe('Hook Initial State', () => {
		it('loads unread IDs from localStorage on mount', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2', 'id3']);

			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadIds.size).toBe(3);
			expect(result.current.unreadIds.has('id1')).toBe(true);
			expect(result.current.unreadIds.has('id2')).toBe(true);
			expect(result.current.unreadIds.has('id3')).toBe(true);
			expect(result.current.unreadCount).toBe(3);
		});

		it('returns empty Set if localStorage is empty', () => {
			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadIds.size).toBe(0);
			expect(result.current.unreadCount).toBe(0);
		});

		it('returns empty Set if localStorage has invalid JSON', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = 'not valid json {';

			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadIds.size).toBe(0);
			expect(result.current.unreadCount).toBe(0);
		});

		it('returns empty Set if localStorage value is not an array', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify({ obj: 'value' });

			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadIds.size).toBe(0);
		});

		it('sets isSupported based on Badge API availability', () => {
			const { result } = renderHook(() => useUnreadBadge());
			expect(result.current.isSupported).toBe(true);

			// Remove Badge API
			Object.defineProperty(window, 'navigator', {
				writable: true,
				configurable: true,
				value: { ...originalNavigator },
			});

			const { result: result2 } = renderHook(() => useUnreadBadge());
			expect(result2.current.isSupported).toBe(false);
		});

		it('calls updateBadge with initial count on mount', async () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2']);

			renderHook(() => useUnreadBadge());

			await waitFor(() => {
				expect(mockSetAppBadge).toHaveBeenCalledWith(2);
			});
		});
	});

	describe('addUnread Function', () => {
		it('adds new response ID to unreadIds', () => {
			const { result } = renderHook(() => useUnreadBadge());

			act(() => {
				result.current.addUnread('response-1');
			});

			expect(result.current.unreadIds.has('response-1')).toBe(true);
		});

		it('increments unreadCount', () => {
			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadCount).toBe(0);

			act(() => {
				result.current.addUnread('response-1');
			});

			expect(result.current.unreadCount).toBe(1);

			act(() => {
				result.current.addUnread('response-2');
			});

			expect(result.current.unreadCount).toBe(2);
		});

		it('persists to localStorage', () => {
			const { result } = renderHook(() => useUnreadBadge());

			act(() => {
				result.current.addUnread('response-1');
			});

			expect(localStorage.setItem).toHaveBeenCalled();
			const savedValue = JSON.parse(mockLocalStorage[UNREAD_RESPONSES_KEY]);
			expect(savedValue).toContain('response-1');
		});

		it('does not add duplicate IDs', () => {
			const { result } = renderHook(() => useUnreadBadge());

			act(() => {
				result.current.addUnread('response-1');
			});

			expect(result.current.unreadCount).toBe(1);

			act(() => {
				result.current.addUnread('response-1');
			});

			expect(result.current.unreadCount).toBe(1);
			expect(result.current.unreadIds.size).toBe(1);
		});

		it('handles rapid successive calls', () => {
			const { result } = renderHook(() => useUnreadBadge());

			act(() => {
				result.current.addUnread('id1');
				result.current.addUnread('id2');
				result.current.addUnread('id3');
				result.current.addUnread('id4');
				result.current.addUnread('id5');
			});

			expect(result.current.unreadCount).toBe(5);
		});

		it('handles special characters in IDs', () => {
			const { result } = renderHook(() => useUnreadBadge());

			const specialId = 'id-with-special-chars-!@#$%^&*()';
			act(() => {
				result.current.addUnread(specialId);
			});

			expect(result.current.unreadIds.has(specialId)).toBe(true);
		});

		it('handles empty string ID', () => {
			const { result } = renderHook(() => useUnreadBadge());

			act(() => {
				result.current.addUnread('');
			});

			// Empty string is a valid Set entry
			expect(result.current.unreadIds.has('')).toBe(true);
			expect(result.current.unreadCount).toBe(1);
		});

		it('handles unicode in response IDs', () => {
			const { result } = renderHook(() => useUnreadBadge());

			const unicodeId = 'response-日本語-🎼-émoji';
			act(() => {
				result.current.addUnread(unicodeId);
			});

			expect(result.current.unreadIds.has(unicodeId)).toBe(true);
		});
	});

	describe('markRead Function', () => {
		it('removes response ID from unreadIds', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['response-1', 'response-2']);
			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadIds.has('response-1')).toBe(true);

			act(() => {
				result.current.markRead('response-1');
			});

			expect(result.current.unreadIds.has('response-1')).toBe(false);
		});

		it('decrements unreadCount', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2', 'id3']);
			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadCount).toBe(3);

			act(() => {
				result.current.markRead('id1');
			});

			expect(result.current.unreadCount).toBe(2);
		});

		it('persists to localStorage', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2']);
			const { result } = renderHook(() => useUnreadBadge());

			vi.clearAllMocks();

			act(() => {
				result.current.markRead('id1');
			});

			expect(localStorage.setItem).toHaveBeenCalled();
			const savedValue = JSON.parse(mockLocalStorage[UNREAD_RESPONSES_KEY]);
			expect(savedValue).not.toContain('id1');
			expect(savedValue).toContain('id2');
		});

		it('is no-op if ID not in set', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1']);
			const { result } = renderHook(() => useUnreadBadge());

			const initialCount = result.current.unreadCount;

			act(() => {
				result.current.markRead('nonexistent-id');
			});

			expect(result.current.unreadCount).toBe(initialCount);
		});

		it('handles marking already read ID', () => {
			const { result } = renderHook(() => useUnreadBadge());

			// Add and then remove
			act(() => {
				result.current.addUnread('id1');
			});
			act(() => {
				result.current.markRead('id1');
			});

			// Try to mark read again - should be no-op
			const countAfterFirstRemove = result.current.unreadCount;
			act(() => {
				result.current.markRead('id1');
			});

			expect(result.current.unreadCount).toBe(countAfterFirstRemove);
		});
	});

	describe('markAllRead Function', () => {
		it('clears all unread IDs', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2', 'id3']);
			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadCount).toBe(3);

			act(() => {
				result.current.markAllRead();
			});

			expect(result.current.unreadCount).toBe(0);
			expect(result.current.unreadIds.size).toBe(0);
		});

		it('sets unreadCount to 0', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2']);
			const { result } = renderHook(() => useUnreadBadge());

			act(() => {
				result.current.markAllRead();
			});

			expect(result.current.unreadCount).toBe(0);
		});

		it('persists empty set to localStorage', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2']);
			const { result } = renderHook(() => useUnreadBadge());

			vi.clearAllMocks();

			act(() => {
				result.current.markAllRead();
			});

			expect(localStorage.setItem).toHaveBeenCalled();
			const savedValue = JSON.parse(mockLocalStorage[UNREAD_RESPONSES_KEY]);
			expect(savedValue).toEqual([]);
		});

		it('updates badge to 0', async () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2']);
			const { result } = renderHook(() => useUnreadBadge());

			vi.clearAllMocks();

			act(() => {
				result.current.markAllRead();
			});

			await waitFor(() => {
				expect(mockClearAppBadge).toHaveBeenCalled();
			});
		});
	});

	describe('setBadgeCount Function', () => {
		it('calls navigator.setAppBadge with count', async () => {
			const { result } = renderHook(() => useUnreadBadge());

			await act(async () => {
				await result.current.setBadgeCount(5);
			});

			expect(mockSetAppBadge).toHaveBeenCalledWith(5);
		});

		it('handles count > 0', async () => {
			const { result } = renderHook(() => useUnreadBadge());

			await act(async () => {
				await result.current.setBadgeCount(42);
			});

			expect(mockSetAppBadge).toHaveBeenCalledWith(42);
		});

		it('handles count = 0 (clears badge)', async () => {
			const { result } = renderHook(() => useUnreadBadge());

			await act(async () => {
				await result.current.setBadgeCount(0);
			});

			expect(mockClearAppBadge).toHaveBeenCalled();
		});

		it('handles Badge API not supported (no-op)', async () => {
			// Remove Badge API
			Object.defineProperty(window, 'navigator', {
				writable: true,
				configurable: true,
				value: { ...originalNavigator },
			});

			const { result } = renderHook(() => useUnreadBadge());

			await act(async () => {
				await result.current.setBadgeCount(10);
			});

			// Should not throw, just no-op
			expect(result.current.isSupported).toBe(false);
		});
	});

	describe('clearBadge Function', () => {
		it('calls navigator.clearAppBadge', async () => {
			const { result } = renderHook(() => useUnreadBadge());

			await act(async () => {
				await result.current.clearBadge();
			});

			expect(mockClearAppBadge).toHaveBeenCalled();
		});

		it('handles Badge API not supported (no-op)', async () => {
			Object.defineProperty(window, 'navigator', {
				writable: true,
				configurable: true,
				value: { ...originalNavigator },
			});

			const { result } = renderHook(() => useUnreadBadge());

			await act(async () => {
				await result.current.clearBadge();
			});

			// Should not throw
			expect(result.current.isSupported).toBe(false);
		});

		it('handles Badge API errors gracefully', async () => {
			mockClearAppBadge.mockRejectedValueOnce(new Error('Badge API error'));

			const { result } = renderHook(() => useUnreadBadge());

			// Should not throw
			await act(async () => {
				await result.current.clearBadge();
			});

			expect(mockClearAppBadge).toHaveBeenCalled();
		});
	});

	describe('Badge Update Effect', () => {
		it('updates badge when unreadCount changes', async () => {
			const { result } = renderHook(() => useUnreadBadge());

			vi.clearAllMocks();

			act(() => {
				result.current.addUnread('id1');
			});

			await waitFor(() => {
				expect(mockSetAppBadge).toHaveBeenCalledWith(1);
			});

			act(() => {
				result.current.addUnread('id2');
			});

			await waitFor(() => {
				expect(mockSetAppBadge).toHaveBeenCalledWith(2);
			});
		});

		it('calls onCountChange callback with new count', async () => {
			const onCountChange = vi.fn();
			const { result } = renderHook(() => useUnreadBadge({ onCountChange }));

			// Initial call with 0
			await waitFor(() => {
				expect(onCountChange).toHaveBeenCalledWith(0);
			});

			vi.clearAllMocks();

			act(() => {
				result.current.addUnread('id1');
			});

			await waitFor(() => {
				expect(onCountChange).toHaveBeenCalledWith(1);
			});
		});

		it('handles onCountChange being undefined', async () => {
			const { result } = renderHook(() => useUnreadBadge());

			// Should not throw
			act(() => {
				result.current.addUnread('id1');
			});

			expect(result.current.unreadCount).toBe(1);
		});

		it('clears badge when count reaches 0', async () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1']);
			const { result } = renderHook(() => useUnreadBadge());

			vi.clearAllMocks();

			act(() => {
				result.current.markRead('id1');
			});

			await waitFor(() => {
				expect(mockClearAppBadge).toHaveBeenCalled();
			});
		});

		it('handles Badge API setAppBadge error gracefully', async () => {
			mockSetAppBadge.mockRejectedValueOnce(new Error('Not running as PWA'));

			const { result } = renderHook(() => useUnreadBadge());

			// Should not throw
			act(() => {
				result.current.addUnread('id1');
			});

			expect(result.current.unreadCount).toBe(1);
		});
	});

	describe('Auto-clear on Visibility Change', () => {
		it('clears badge when document becomes visible (default behavior)', async () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2']);
			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadCount).toBe(2);

			// Simulate visibility change
			Object.defineProperty(document, 'visibilityState', {
				writable: true,
				configurable: true,
				value: 'hidden',
			});

			act(() => {
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Should not clear when hidden
			expect(result.current.unreadCount).toBe(2);

			Object.defineProperty(document, 'visibilityState', {
				writable: true,
				configurable: true,
				value: 'visible',
			});

			act(() => {
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Should clear when visible
			expect(result.current.unreadCount).toBe(0);
		});

		it('does not clear when autoClearOnVisible is false', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2']);
			const { result } = renderHook(() => useUnreadBadge({ autoClearOnVisible: false }));

			expect(result.current.unreadCount).toBe(2);

			Object.defineProperty(document, 'visibilityState', {
				writable: true,
				configurable: true,
				value: 'visible',
			});

			act(() => {
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Should NOT clear
			expect(result.current.unreadCount).toBe(2);
		});

		it('adds visibilitychange listener on mount', () => {
			const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

			renderHook(() => useUnreadBadge());

			expect(addEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

			addEventListenerSpy.mockRestore();
		});

		it('removes visibilitychange listener on unmount', () => {
			const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

			const { unmount } = renderHook(() => useUnreadBadge());

			unmount();

			expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

			removeEventListenerSpy.mockRestore();
		});

		it('only clears when visibility is visible', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1']);
			const { result } = renderHook(() => useUnreadBadge());

			// Set to hidden first
			Object.defineProperty(document, 'visibilityState', {
				writable: true,
				configurable: true,
				value: 'hidden',
			});

			act(() => {
				document.dispatchEvent(new Event('visibilitychange'));
			});

			expect(result.current.unreadCount).toBe(1);
		});

		it('handles rapid visibility changes', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['id1', 'id2', 'id3']);
			const { result } = renderHook(() => useUnreadBadge());

			// Rapid changes
			act(() => {
				Object.defineProperty(document, 'visibilityState', {
					value: 'hidden',
					writable: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
				Object.defineProperty(document, 'visibilityState', {
					value: 'visible',
					writable: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
				Object.defineProperty(document, 'visibilityState', {
					value: 'hidden',
					writable: true,
					configurable: true,
				});
				document.dispatchEvent(new Event('visibilitychange'));
			});

			// Should have cleared on the visible event
			expect(result.current.unreadCount).toBe(0);
		});

		it('does not add listener when autoClearOnVisible is false', () => {
			const addEventListenerSpy = vi.spyOn(document, 'addEventListener');

			renderHook(() => useUnreadBadge({ autoClearOnVisible: false }));

			const visibilityChangeCalls = addEventListenerSpy.mock.calls.filter(
				(call) => call[0] === 'visibilitychange'
			);
			expect(visibilityChangeCalls.length).toBe(0);

			addEventListenerSpy.mockRestore();
		});
	});

	describe('localStorage Persistence', () => {
		it('saves unread IDs as JSON array', () => {
			const { result } = renderHook(() => useUnreadBadge());

			act(() => {
				result.current.addUnread('id1');
				result.current.addUnread('id2');
			});

			expect(localStorage.setItem).toHaveBeenCalled();
			const saved = JSON.parse(mockLocalStorage[UNREAD_RESPONSES_KEY]);
			expect(Array.isArray(saved)).toBe(true);
			expect(saved).toContain('id1');
			expect(saved).toContain('id2');
		});

		it('loads and parses JSON array on init', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = JSON.stringify(['saved1', 'saved2']);

			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadIds.has('saved1')).toBe(true);
			expect(result.current.unreadIds.has('saved2')).toBe(true);
		});

		it('handles localStorage.setItem errors', () => {
			const setItemMock = vi.fn().mockImplementation(() => {
				throw new Error('Storage quota exceeded');
			});
			Object.defineProperty(window, 'localStorage', {
				writable: true,
				configurable: true,
				value: {
					getItem: vi.fn(() => null),
					setItem: setItemMock,
					removeItem: vi.fn(),
					clear: vi.fn(),
					length: 0,
					key: vi.fn(),
				},
			});

			const { result } = renderHook(() => useUnreadBadge());

			// Should not throw
			act(() => {
				result.current.addUnread('id1');
			});

			// State should still update
			expect(result.current.unreadIds.has('id1')).toBe(true);
		});

		it('handles localStorage.getItem errors', () => {
			const getItemMock = vi.fn().mockImplementation(() => {
				throw new Error('Storage access denied');
			});
			Object.defineProperty(window, 'localStorage', {
				writable: true,
				configurable: true,
				value: {
					getItem: getItemMock,
					setItem: vi.fn(),
					removeItem: vi.fn(),
					clear: vi.fn(),
					length: 0,
					key: vi.fn(),
				},
			});

			// Should not throw
			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadIds.size).toBe(0);
		});

		it('handles stored value being a string', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = '"just a string"';

			const { result } = renderHook(() => useUnreadBadge());

			// Should return empty set since it's not an array
			expect(result.current.unreadIds.size).toBe(0);
		});

		it('handles stored value being null JSON', () => {
			mockLocalStorage[UNREAD_RESPONSES_KEY] = 'null';

			const { result } = renderHook(() => useUnreadBadge());

			expect(result.current.unreadIds.size).toBe(0);
		});
	});

	describe('Hook Return Value Stability', () => {
		it('addUnread is stable across renders', () => {
			const { result, rerender } = renderHook(() => useUnreadBadge());

			const firstAddUnread = result.current.addUnread;
			rerender();
			const secondAddUnread = result.current.addUnread;

			expect(firstAddUnread).toBe(secondAddUnread);
		});

		it('markRead is stable across renders', () => {
			const { result, rerender } = renderHook(() => useUnreadBadge());

			const first = result.current.markRead;
			rerender();
			const second = result.current.markRead;

			expect(first).toBe(second);
		});

		it('markAllRead is stable across renders', () => {
			const { result, rerender } = renderHook(() => useUnreadBadge());

			const first = result.current.markAllRead;
			rerender();
			const second = result.current.markAllRead;

			expect(first).toBe(second);
		});

		it('setBadgeCount is stable across renders', () => {
			const { result, rerender } = renderHook(() => useUnreadBadge());

			const first = result.current.setBadgeCount;
			rerender();
			const second = result.current.setBadgeCount;

			expect(first).toBe(second);
		});

		it('clearBadge is stable across renders', () => {
			const { result, rerender } = renderHook(() => useUnreadBadge());

			const first = result.current.clearBadge;
			rerender();
			const second = result.current.clearBadge;

			expect(first).toBe(second);
		});
	});

	describe('Edge Cases', () => {
		it('handles very long response IDs', () => {
			const { result } = renderHook(() => useUnreadBadge());

			const longId = 'x'.repeat(10000);
			act(() => {
				result.current.addUnread(longId);
			});

			expect(result.current.unreadIds.has(longId)).toBe(true);
		});

		it('handles many (100+) unread IDs', () => {
			const { result } = renderHook(() => useUnreadBadge());

			act(() => {
				for (let i = 0; i < 100; i++) {
					result.current.addUnread(`id-${i}`);
				}
			});

			expect(result.current.unreadCount).toBe(100);
		});

		it('handles rapid add/remove sequences', () => {
			const { result } = renderHook(() => useUnreadBadge());

			act(() => {
				result.current.addUnread('id1');
				result.current.markRead('id1');
				result.current.addUnread('id1');
				result.current.markRead('id1');
				result.current.addUnread('id2');
			});

			expect(result.current.unreadCount).toBe(1);
			expect(result.current.unreadIds.has('id2')).toBe(true);
		});

		it('default export matches named export', async () => {
			const { default: defaultExport } = await import('../../../web/hooks/useUnreadBadge');
			expect(defaultExport).toBe(useUnreadBadge);
		});

		it('handles options being updated via rerender', () => {
			const onCountChange1 = vi.fn();
			const onCountChange2 = vi.fn();

			const { result, rerender } = renderHook(
				({ onCountChange }) => useUnreadBadge({ onCountChange }),
				{ initialProps: { onCountChange: onCountChange1 } }
			);

			vi.clearAllMocks();

			// Change callback
			rerender({ onCountChange: onCountChange2 });

			act(() => {
				result.current.addUnread('id1');
			});

			// The new callback should be called (due to ref update)
			expect(onCountChange2).toHaveBeenCalledWith(1);
		});
	});

	describe('Interface Types', () => {
		it('UseUnreadBadgeOptions interface allows all optional properties', () => {
			const options1: UseUnreadBadgeOptions = {};
			const options2: UseUnreadBadgeOptions = { onCountChange: () => {} };
			const options3: UseUnreadBadgeOptions = { autoClearOnVisible: false };
			const options4: UseUnreadBadgeOptions = {
				onCountChange: (count) => console.log(count),
				autoClearOnVisible: true,
			};

			// Type checks - if this compiles, the interface is correct
			expect(options1).toBeDefined();
			expect(options2).toBeDefined();
			expect(options3).toBeDefined();
			expect(options4).toBeDefined();
		});

		it('UseUnreadBadgeReturn interface has all expected properties', () => {
			const { result } = renderHook(() => useUnreadBadge());

			const returnValue: UseUnreadBadgeReturn = result.current;

			expect(typeof returnValue.unreadCount).toBe('number');
			expect(returnValue.unreadIds instanceof Set).toBe(true);
			expect(typeof returnValue.isSupported).toBe('boolean');
			expect(typeof returnValue.addUnread).toBe('function');
			expect(typeof returnValue.markRead).toBe('function');
			expect(typeof returnValue.markAllRead).toBe('function');
			expect(typeof returnValue.setBadgeCount).toBe('function');
			expect(typeof returnValue.clearBadge).toBe('function');
		});
	});
});
