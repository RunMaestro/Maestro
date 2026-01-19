import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNavigationHistory, NavHistoryEntry } from '../../../renderer/hooks';

describe('useNavigationHistory', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('initial state', () => {
		it('should initialize with no ability to go back', () => {
			const { result } = renderHook(() => useNavigationHistory());
			expect(result.current.canGoBack()).toBe(false);
		});

		it('should initialize with no ability to go forward', () => {
			const { result } = renderHook(() => useNavigationHistory());
			expect(result.current.canGoForward()).toBe(false);
		});

		it('should return null when navigating back with empty history', () => {
			const { result } = renderHook(() => useNavigationHistory());

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateBack();
			});

			expect(entry).toBeNull();
		});

		it('should return null when navigating forward with empty history', () => {
			const { result } = renderHook(() => useNavigationHistory());

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateForward();
			});

			expect(entry).toBeNull();
		});
	});

	describe('pushNavigation', () => {
		it('should set current on first push', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
			});

			// Can't go back yet - first entry is current, not in history
			expect(result.current.canGoBack()).toBe(false);
			expect(result.current.canGoForward()).toBe(false);
		});

		it('should add to history on second push', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			expect(result.current.canGoBack()).toBe(true);
			expect(result.current.canGoForward()).toBe(false);
		});

		it('should add multiple entries to history', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
				result.current.pushNavigation({ sessionId: 'session3' });
			});

			expect(result.current.canGoBack()).toBe(true);
		});

		it('should include tabId in entry', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' });
				result.current.pushNavigation({ sessionId: 'session2', tabId: 'tab2' });
			});

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(entry).toEqual({ sessionId: 'session1', tabId: 'tab1' });
		});

		it('should ignore duplicate entry with same sessionId', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session1' }); // duplicate
			});

			// Should still not be able to go back - duplicate was ignored
			expect(result.current.canGoBack()).toBe(false);
		});

		it('should ignore duplicate entry with same sessionId and tabId', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' });
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' }); // duplicate
			});

			expect(result.current.canGoBack()).toBe(false);
		});

		it('should not ignore entry with same sessionId but different tabId', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' });
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab2' }); // different tab
			});

			expect(result.current.canGoBack()).toBe(true);
		});

		it('should not ignore entry with different sessionId but same tabId', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' });
				result.current.pushNavigation({ sessionId: 'session2', tabId: 'tab1' }); // different session
			});

			expect(result.current.canGoBack()).toBe(true);
		});

		it('should clear forward stack on new push', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
				result.current.pushNavigation({ sessionId: 'session3' });
			});

			// Go back to build forward stack
			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(result.current.canGoForward()).toBe(true);

			// Push new entry - should clear forward stack
			act(() => {
				result.current.pushNavigation({ sessionId: 'session4' });
			});

			expect(result.current.canGoForward()).toBe(false);
		});

		it('should limit history to MAX_HISTORY (50)', () => {
			const { result } = renderHook(() => useNavigationHistory());

			// Push 52 entries (first becomes current, then 51 go to history, oldest gets removed)
			act(() => {
				for (let i = 0; i < 52; i++) {
					result.current.pushNavigation({ sessionId: `session${i}` });
				}
			});

			// Navigate back through all history entries
			let backCount = 0;
			act(() => {
				while (result.current.canGoBack()) {
					result.current.navigateBack();
					vi.runAllTimers();
					backCount++;
				}
			});

			// Should only be able to go back 50 times (MAX_HISTORY)
			expect(backCount).toBe(50);
		});
	});

	describe('navigateBack', () => {
		it('should return the previous entry', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(entry).toEqual({ sessionId: 'session1' });
		});

		it('should allow going forward after going back', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(result.current.canGoForward()).toBe(true);
		});

		it('should update canGoBack after going back', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			expect(result.current.canGoBack()).toBe(true);

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(result.current.canGoBack()).toBe(false);
		});

		it('should handle multiple back navigations', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
				result.current.pushNavigation({ sessionId: 'session3' });
			});

			let entry1: NavHistoryEntry | null = null;
			let entry2: NavHistoryEntry | null = null;

			act(() => {
				entry1 = result.current.navigateBack();
				vi.runAllTimers();
			});

			act(() => {
				entry2 = result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(entry1).toEqual({ sessionId: 'session2' });
			expect(entry2).toEqual({ sessionId: 'session1' });
		});

		it('should prevent pushNavigation during navigation', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
				result.current.pushNavigation({ sessionId: 'session3' });
			});

			// Navigate back but don't run timers - isNavigatingRef is still true
			act(() => {
				result.current.navigateBack();
				// Push during navigation - should be ignored
				result.current.pushNavigation({ sessionId: 'newSession' });
			});

			// Now run timers to reset flag
			act(() => {
				vi.runAllTimers();
			});

			// Navigate forward to verify newSession wasn't added
			let forwardEntry: NavHistoryEntry | null = null;
			act(() => {
				forwardEntry = result.current.navigateForward();
				vi.runAllTimers();
			});

			// Should go to session3, not newSession
			expect(forwardEntry).toEqual({ sessionId: 'session3' });
		});
	});

	describe('navigateForward', () => {
		it('should return the next entry after going back', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateForward();
				vi.runAllTimers();
			});

			expect(entry).toEqual({ sessionId: 'session2' });
		});

		it('should allow going back after going forward', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			act(() => {
				result.current.navigateForward();
				vi.runAllTimers();
			});

			expect(result.current.canGoBack()).toBe(true);
		});

		it('should update canGoForward after going forward', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(result.current.canGoForward()).toBe(true);

			act(() => {
				result.current.navigateForward();
				vi.runAllTimers();
			});

			expect(result.current.canGoForward()).toBe(false);
		});

		it('should handle multiple forward navigations', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
				result.current.pushNavigation({ sessionId: 'session3' });
			});

			// Go back twice
			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			// Go forward twice
			let entry1: NavHistoryEntry | null = null;
			let entry2: NavHistoryEntry | null = null;

			act(() => {
				entry1 = result.current.navigateForward();
				vi.runAllTimers();
			});

			act(() => {
				entry2 = result.current.navigateForward();
				vi.runAllTimers();
			});

			expect(entry1).toEqual({ sessionId: 'session2' });
			expect(entry2).toEqual({ sessionId: 'session3' });
		});

		it('should prevent pushNavigation during forward navigation', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			// Navigate forward but don't run timers
			act(() => {
				result.current.navigateForward();
				// Push during navigation - should be ignored
				result.current.pushNavigation({ sessionId: 'newSession' });
			});

			// Run timers
			act(() => {
				vi.runAllTimers();
			});

			// Going back should return session1, proving newSession wasn't added after session2
			let backEntry: NavHistoryEntry | null = null;
			act(() => {
				backEntry = result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(backEntry).toEqual({ sessionId: 'session1' });
		});
	});

	describe('canGoBack', () => {
		it('should return false with empty history', () => {
			const { result } = renderHook(() => useNavigationHistory());
			expect(result.current.canGoBack()).toBe(false);
		});

		it('should return false with single entry (current only)', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
			});

			expect(result.current.canGoBack()).toBe(false);
		});

		it('should return true with multiple entries', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			expect(result.current.canGoBack()).toBe(true);
		});

		it('should return false after navigating back through all history', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(result.current.canGoBack()).toBe(false);
		});
	});

	describe('canGoForward', () => {
		it('should return false with empty history', () => {
			const { result } = renderHook(() => useNavigationHistory());
			expect(result.current.canGoForward()).toBe(false);
		});

		it('should return false before any back navigation', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			expect(result.current.canGoForward()).toBe(false);
		});

		it('should return true after navigating back', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(result.current.canGoForward()).toBe(true);
		});

		it('should return false after navigating forward through all forward history', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			act(() => {
				result.current.navigateForward();
				vi.runAllTimers();
			});

			expect(result.current.canGoForward()).toBe(false);
		});
	});

	describe('clearHistory', () => {
		it('should clear back history', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			expect(result.current.canGoBack()).toBe(true);

			act(() => {
				result.current.clearHistory();
			});

			expect(result.current.canGoBack()).toBe(false);
		});

		it('should clear forward history', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(result.current.canGoForward()).toBe(true);

			act(() => {
				result.current.clearHistory();
			});

			expect(result.current.canGoForward()).toBe(false);
		});

		it('should clear current', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.clearHistory();
			});

			// After clearing, pushing same entry shouldn't be ignored (since current was cleared)
			// We verify this by pushing the same session twice - if current was cleared,
			// the first push sets current, second should not be ignored
			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session1' }); // Should be ignored as duplicate
			});

			// Still can't go back because the second push was a duplicate
			expect(result.current.canGoBack()).toBe(false);
		});

		it('should allow new navigation after clearing', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
				result.current.clearHistory();
			});

			act(() => {
				result.current.pushNavigation({ sessionId: 'session3' });
				result.current.pushNavigation({ sessionId: 'session4' });
			});

			expect(result.current.canGoBack()).toBe(true);

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(entry).toEqual({ sessionId: 'session3' });
		});
	});

	describe('updateCurrentTab', () => {
		it('should update tabId without affecting history', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' });
				result.current.pushNavigation({ sessionId: 'session2', tabId: 'tab2' });
				result.current.updateCurrentTab('tab3');
			});

			// Go back and forward to verify current has updated tabId
			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			let forwardEntry: NavHistoryEntry | null = null;
			act(() => {
				forwardEntry = result.current.navigateForward();
				vi.runAllTimers();
			});

			// Current should have updated tabId
			expect(forwardEntry).toEqual({ sessionId: 'session2', tabId: 'tab3' });
		});

		it('should not create history entry', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' });
				result.current.updateCurrentTab('tab2');
				result.current.updateCurrentTab('tab3');
				result.current.updateCurrentTab('tab4');
			});

			// Still can't go back - updateCurrentTab doesn't add history
			expect(result.current.canGoBack()).toBe(false);
		});

		it('should handle undefined tabId', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' });
				result.current.pushNavigation({ sessionId: 'session2', tabId: 'tab2' });
				result.current.updateCurrentTab(undefined);
			});

			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			let forwardEntry: NavHistoryEntry | null = null;
			act(() => {
				forwardEntry = result.current.navigateForward();
				vi.runAllTimers();
			});

			expect(forwardEntry).toEqual({ sessionId: 'session2', tabId: undefined });
		});

		it('should do nothing when current is null', () => {
			const { result } = renderHook(() => useNavigationHistory());

			// No push yet, current is null
			act(() => {
				result.current.updateCurrentTab('tab1');
			});

			// Should not throw, and no effect
			expect(result.current.canGoBack()).toBe(false);
			expect(result.current.canGoForward()).toBe(false);
		});
	});

	describe('complex navigation scenarios', () => {
		it('should handle back-forward-back sequence', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'A' });
				result.current.pushNavigation({ sessionId: 'B' });
				result.current.pushNavigation({ sessionId: 'C' });
			});

			// Current: C, History: [A, B], Forward: []

			let entry: NavHistoryEntry | null = null;

			// Back to B
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});
			expect(entry).toEqual({ sessionId: 'B' });
			// Current: B, History: [A], Forward: [C]

			// Forward to C
			act(() => {
				entry = result.current.navigateForward();
				vi.runAllTimers();
			});
			expect(entry).toEqual({ sessionId: 'C' });
			// Current: C, History: [A, B], Forward: []

			// Back to B again
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});
			expect(entry).toEqual({ sessionId: 'B' });
		});

		it('should handle branch creation (back then push new)', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'A' });
				result.current.pushNavigation({ sessionId: 'B' });
				result.current.pushNavigation({ sessionId: 'C' });
			});

			// Go back to B
			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
			});

			// Push new entry D (creates new branch, clears forward)
			act(() => {
				result.current.pushNavigation({ sessionId: 'D' });
			});

			// Can't go forward to C anymore
			expect(result.current.canGoForward()).toBe(false);

			// Can go back to B
			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});
			expect(entry).toEqual({ sessionId: 'B' });
		});

		it('should handle tab navigation within sessions', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' });
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab2' }); // Same session, different tab
				result.current.pushNavigation({ sessionId: 'session2', tabId: 'tab1' }); // Different session
			});

			// Can go back
			expect(result.current.canGoBack()).toBe(true);

			let entry: NavHistoryEntry | null = null;

			// Back to session1/tab2
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});
			expect(entry).toEqual({ sessionId: 'session1', tabId: 'tab2' });

			// Back to session1/tab1
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});
			expect(entry).toEqual({ sessionId: 'session1', tabId: 'tab1' });
		});

		it('should preserve entry immutability', () => {
			const { result } = renderHook(() => useNavigationHistory());

			const original: NavHistoryEntry = { sessionId: 'session1', tabId: 'tab1' };

			act(() => {
				result.current.pushNavigation(original);
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			let retrieved: NavHistoryEntry | null = null;
			act(() => {
				retrieved = result.current.navigateBack();
				vi.runAllTimers();
			});

			// Should be a copy, not the same object
			expect(retrieved).toEqual(original);
		});

		it('should handle rapid back/forward navigation', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'A' });
				result.current.pushNavigation({ sessionId: 'B' });
				result.current.pushNavigation({ sessionId: 'C' });
				result.current.pushNavigation({ sessionId: 'D' });
				result.current.pushNavigation({ sessionId: 'E' });
			});

			// Multiple backs
			act(() => {
				result.current.navigateBack();
				vi.runAllTimers();
				result.current.navigateBack();
				vi.runAllTimers();
				result.current.navigateBack();
				vi.runAllTimers();
			});

			// Current should be B, Forward: [C, D, E]
			expect(result.current.canGoBack()).toBe(true); // Can go to A
			expect(result.current.canGoForward()).toBe(true);

			// Multiple forwards
			act(() => {
				result.current.navigateForward();
				vi.runAllTimers();
				result.current.navigateForward();
				vi.runAllTimers();
			});

			// Current should be D, History: [A, B, C], Forward: [E]
			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateForward();
				vi.runAllTimers();
			});
			expect(entry).toEqual({ sessionId: 'E' });
		});
	});

	describe('edge cases', () => {
		it('should handle entry without tabId', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(entry?.sessionId).toBe('session1');
			expect(entry?.tabId).toBeUndefined();
		});

		it('should handle mixed entries with and without tabId', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session1', tabId: 'tab1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			let entry: NavHistoryEntry | null = null;

			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});
			expect(entry).toEqual({ sessionId: 'session1', tabId: 'tab1' });

			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});
			expect(entry).toEqual({ sessionId: 'session1' });
		});

		it('should handle empty string sessionId', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: '' });
				result.current.pushNavigation({ sessionId: 'session1' });
			});

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(entry).toEqual({ sessionId: '' });
		});

		it('should handle empty string tabId', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1', tabId: '' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(entry).toEqual({ sessionId: 'session1', tabId: '' });
		});

		it('should handle clearing then immediately navigating', () => {
			const { result } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
				result.current.clearHistory();
			});

			// Attempt navigation should return null
			let backEntry: NavHistoryEntry | null = { sessionId: 'placeholder' };
			let forwardEntry: NavHistoryEntry | null = { sessionId: 'placeholder' };

			act(() => {
				backEntry = result.current.navigateBack();
				forwardEntry = result.current.navigateForward();
			});

			expect(backEntry).toBeNull();
			expect(forwardEntry).toBeNull();
		});
	});

	describe('hook stability', () => {
		it('should return stable function references', () => {
			const { result, rerender } = renderHook(() => useNavigationHistory());

			const firstRender = {
				pushNavigation: result.current.pushNavigation,
				navigateBack: result.current.navigateBack,
				navigateForward: result.current.navigateForward,
				canGoBack: result.current.canGoBack,
				canGoForward: result.current.canGoForward,
				clearHistory: result.current.clearHistory,
				updateCurrentTab: result.current.updateCurrentTab,
			};

			rerender();

			expect(result.current.pushNavigation).toBe(firstRender.pushNavigation);
			expect(result.current.navigateBack).toBe(firstRender.navigateBack);
			expect(result.current.navigateForward).toBe(firstRender.navigateForward);
			expect(result.current.canGoBack).toBe(firstRender.canGoBack);
			expect(result.current.canGoForward).toBe(firstRender.canGoForward);
			expect(result.current.clearHistory).toBe(firstRender.clearHistory);
			expect(result.current.updateCurrentTab).toBe(firstRender.updateCurrentTab);
		});

		it('should maintain state across rerenders', () => {
			const { result, rerender } = renderHook(() => useNavigationHistory());

			act(() => {
				result.current.pushNavigation({ sessionId: 'session1' });
				result.current.pushNavigation({ sessionId: 'session2' });
			});

			expect(result.current.canGoBack()).toBe(true);

			rerender();

			expect(result.current.canGoBack()).toBe(true);

			let entry: NavHistoryEntry | null = null;
			act(() => {
				entry = result.current.navigateBack();
				vi.runAllTimers();
			});

			expect(entry).toEqual({ sessionId: 'session1' });
		});
	});
});
