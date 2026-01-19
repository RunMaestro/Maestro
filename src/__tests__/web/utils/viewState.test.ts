import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	saveViewState,
	loadViewState,
	clearViewState,
	saveScrollPosition,
	loadScrollState,
	debouncedSaveViewState,
	debouncedSaveScrollPosition,
	ViewState,
	ScrollState,
} from '../../../web/utils/viewState';

// Mock the webLogger
vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		error: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
	},
}));

describe('viewState', () => {
	let localStorageMock: Record<string, string>;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();

		// Mock localStorage
		localStorageMock = {};
		vi.stubGlobal('localStorage', {
			getItem: vi.fn((key: string) => localStorageMock[key] ?? null),
			setItem: vi.fn((key: string, value: string) => {
				localStorageMock[key] = value;
			}),
			removeItem: vi.fn((key: string) => {
				delete localStorageMock[key];
			}),
			clear: vi.fn(() => {
				localStorageMock = {};
			}),
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	describe('loadViewState', () => {
		it('should return default state when localStorage is empty', () => {
			const state = loadViewState();

			expect(state).toEqual({
				showAllSessions: false,
				showHistoryPanel: false,
				showTabSearch: false,
				activeSessionId: null,
				activeTabId: null,
				inputMode: 'ai',
				historyFilter: 'all',
				historySearchOpen: false,
				historySearchQuery: '',
				savedAt: 0,
			});
		});

		it('should return saved state from localStorage', () => {
			const savedState: ViewState = {
				showAllSessions: true,
				showHistoryPanel: true,
				showTabSearch: false,
				activeSessionId: 'session-1',
				activeTabId: 'tab-1',
				inputMode: 'terminal',
				historyFilter: 'AUTO',
				historySearchOpen: true,
				historySearchQuery: 'test query',
				savedAt: Date.now(),
			};
			localStorageMock['maestro-web-view-state'] = JSON.stringify(savedState);

			const state = loadViewState();

			expect(state.showAllSessions).toBe(true);
			expect(state.showHistoryPanel).toBe(true);
			expect(state.activeSessionId).toBe('session-1');
			expect(state.activeTabId).toBe('tab-1');
			expect(state.inputMode).toBe('terminal');
			expect(state.historyFilter).toBe('AUTO');
			expect(state.historySearchOpen).toBe(true);
			expect(state.historySearchQuery).toBe('test query');
		});

		it('should return default state when saved state is stale (> 5 minutes)', () => {
			const fiveMinutesAgo = Date.now() - (5 * 60 * 1000 + 1); // 5 minutes + 1ms ago
			const staleState: ViewState = {
				showAllSessions: true,
				showHistoryPanel: true,
				showTabSearch: true,
				activeSessionId: 'old-session',
				activeTabId: 'old-tab',
				inputMode: 'terminal',
				historyFilter: 'USER',
				historySearchOpen: true,
				historySearchQuery: 'old query',
				savedAt: fiveMinutesAgo,
			};
			localStorageMock['maestro-web-view-state'] = JSON.stringify(staleState);

			const state = loadViewState();

			// Should return defaults because state is stale
			expect(state.showAllSessions).toBe(false);
			expect(state.activeSessionId).toBe(null);
		});

		it('should return saved state when within 5 minutes', () => {
			const fourMinutesAgo = Date.now() - 4 * 60 * 1000; // 4 minutes ago
			const freshState: ViewState = {
				showAllSessions: true,
				showHistoryPanel: false,
				showTabSearch: false,
				activeSessionId: 'fresh-session',
				activeTabId: 'fresh-tab',
				inputMode: 'ai',
				historyFilter: 'all',
				historySearchOpen: false,
				historySearchQuery: '',
				savedAt: fourMinutesAgo,
			};
			localStorageMock['maestro-web-view-state'] = JSON.stringify(freshState);

			const state = loadViewState();

			expect(state.showAllSessions).toBe(true);
			expect(state.activeSessionId).toBe('fresh-session');
		});

		it('should handle invalid JSON gracefully', () => {
			localStorageMock['maestro-web-view-state'] = 'not valid json';

			const state = loadViewState();

			// Should return defaults on error
			expect(state).toEqual({
				showAllSessions: false,
				showHistoryPanel: false,
				showTabSearch: false,
				activeSessionId: null,
				activeTabId: null,
				inputMode: 'ai',
				historyFilter: 'all',
				historySearchOpen: false,
				historySearchQuery: '',
				savedAt: 0,
			});
		});

		it('should merge partial saved state with defaults', () => {
			const partialState = {
				showAllSessions: true,
				savedAt: Date.now(),
			};
			localStorageMock['maestro-web-view-state'] = JSON.stringify(partialState);

			const state = loadViewState();

			expect(state.showAllSessions).toBe(true);
			// Other fields should be defaults
			expect(state.showHistoryPanel).toBe(false);
			expect(state.activeSessionId).toBe(null);
			expect(state.inputMode).toBe('ai');
		});

		it('should handle state with missing savedAt (treats as stale)', () => {
			const stateWithoutSavedAt = {
				showAllSessions: true,
				// savedAt is undefined
			};
			localStorageMock['maestro-web-view-state'] = JSON.stringify(stateWithoutSavedAt);

			const state = loadViewState();

			// savedAt is undefined/0, age calculation should result in large age
			expect(state.showAllSessions).toBe(false); // Defaults because stale
		});
	});

	describe('saveViewState', () => {
		it('should save partial state to localStorage', () => {
			saveViewState({ showAllSessions: true });

			expect(localStorage.setItem).toHaveBeenCalled();
			const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.showAllSessions).toBe(true);
			expect(savedData.savedAt).toBeGreaterThan(0);
		});

		it('should merge with existing state', () => {
			// First save
			const existingState: ViewState = {
				showAllSessions: false,
				showHistoryPanel: true,
				showTabSearch: false,
				activeSessionId: 'session-1',
				activeTabId: null,
				inputMode: 'ai',
				historyFilter: 'all',
				historySearchOpen: false,
				historySearchQuery: '',
				savedAt: Date.now(),
			};
			localStorageMock['maestro-web-view-state'] = JSON.stringify(existingState);

			// Update only showAllSessions
			saveViewState({ showAllSessions: true });

			const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.showAllSessions).toBe(true);
			expect(savedData.showHistoryPanel).toBe(true); // Preserved from existing
			expect(savedData.activeSessionId).toBe('session-1'); // Preserved
		});

		it('should update savedAt timestamp', () => {
			const beforeSave = Date.now();

			saveViewState({ activeSessionId: 'new-session' });

			const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.savedAt).toBeGreaterThanOrEqual(beforeSave);
		});

		it('should save all view state properties', () => {
			saveViewState({
				showAllSessions: true,
				showHistoryPanel: true,
				showTabSearch: true,
				activeSessionId: 'test-session',
				activeTabId: 'test-tab',
				inputMode: 'terminal',
				historyFilter: 'USER',
				historySearchOpen: true,
				historySearchQuery: 'search text',
			});

			const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.showAllSessions).toBe(true);
			expect(savedData.showHistoryPanel).toBe(true);
			expect(savedData.showTabSearch).toBe(true);
			expect(savedData.activeSessionId).toBe('test-session');
			expect(savedData.activeTabId).toBe('test-tab');
			expect(savedData.inputMode).toBe('terminal');
			expect(savedData.historyFilter).toBe('USER');
			expect(savedData.historySearchOpen).toBe(true);
			expect(savedData.historySearchQuery).toBe('search text');
		});

		it('should handle localStorage errors gracefully', () => {
			vi.mocked(localStorage.setItem).mockImplementation(() => {
				throw new Error('QuotaExceededError');
			});

			// Should not throw
			expect(() => saveViewState({ showAllSessions: true })).not.toThrow();
		});
	});

	describe('clearViewState', () => {
		it('should remove both view state and scroll state from localStorage', () => {
			localStorageMock['maestro-web-view-state'] = JSON.stringify({ showAllSessions: true });
			localStorageMock['maestro-web-scroll-state'] = JSON.stringify({ messageHistory: 100 });

			clearViewState();

			expect(localStorage.removeItem).toHaveBeenCalledWith('maestro-web-view-state');
			expect(localStorage.removeItem).toHaveBeenCalledWith('maestro-web-scroll-state');
		});

		it('should handle localStorage errors gracefully', () => {
			vi.mocked(localStorage.removeItem).mockImplementation(() => {
				throw new Error('Storage error');
			});

			// Should not throw
			expect(() => clearViewState()).not.toThrow();
		});
	});

	describe('loadScrollState', () => {
		it('should return default scroll state when localStorage is empty', () => {
			const state = loadScrollState();

			expect(state).toEqual({
				messageHistory: 0,
				allSessions: 0,
				historyPanel: 0,
			});
		});

		it('should return saved scroll positions', () => {
			const savedScroll: ScrollState = {
				messageHistory: 500,
				allSessions: 200,
				historyPanel: 300,
			};
			localStorageMock['maestro-web-scroll-state'] = JSON.stringify(savedScroll);

			const state = loadScrollState();

			expect(state.messageHistory).toBe(500);
			expect(state.allSessions).toBe(200);
			expect(state.historyPanel).toBe(300);
		});

		it('should handle invalid JSON gracefully', () => {
			localStorageMock['maestro-web-scroll-state'] = 'invalid json';

			const state = loadScrollState();

			expect(state).toEqual({
				messageHistory: 0,
				allSessions: 0,
				historyPanel: 0,
			});
		});

		it('should merge partial saved scroll state with defaults', () => {
			const partialScroll = {
				messageHistory: 100,
			};
			localStorageMock['maestro-web-scroll-state'] = JSON.stringify(partialScroll);

			const state = loadScrollState();

			expect(state.messageHistory).toBe(100);
			expect(state.allSessions).toBe(0); // Default
			expect(state.historyPanel).toBe(0); // Default
		});
	});

	describe('saveScrollPosition', () => {
		it('should save scroll position for messageHistory', () => {
			saveScrollPosition('messageHistory', 250);

			const savedData = JSON.parse(localStorageMock['maestro-web-scroll-state']);
			expect(savedData.messageHistory).toBe(250);
		});

		it('should save scroll position for allSessions', () => {
			saveScrollPosition('allSessions', 150);

			const savedData = JSON.parse(localStorageMock['maestro-web-scroll-state']);
			expect(savedData.allSessions).toBe(150);
		});

		it('should save scroll position for historyPanel', () => {
			saveScrollPosition('historyPanel', 350);

			const savedData = JSON.parse(localStorageMock['maestro-web-scroll-state']);
			expect(savedData.historyPanel).toBe(350);
		});

		it('should merge with existing scroll positions', () => {
			const existingScroll: ScrollState = {
				messageHistory: 100,
				allSessions: 200,
				historyPanel: 300,
			};
			localStorageMock['maestro-web-scroll-state'] = JSON.stringify(existingScroll);

			saveScrollPosition('messageHistory', 500);

			const savedData = JSON.parse(localStorageMock['maestro-web-scroll-state']);
			expect(savedData.messageHistory).toBe(500); // Updated
			expect(savedData.allSessions).toBe(200); // Preserved
			expect(savedData.historyPanel).toBe(300); // Preserved
		});

		it('should handle localStorage errors gracefully', () => {
			vi.mocked(localStorage.setItem).mockImplementation(() => {
				throw new Error('Storage error');
			});

			// Should not throw
			expect(() => saveScrollPosition('messageHistory', 100)).not.toThrow();
		});
	});

	describe('debouncedSaveViewState', () => {
		it('should delay saving view state', () => {
			debouncedSaveViewState({ showAllSessions: true });

			// Should not save immediately
			expect(localStorage.setItem).not.toHaveBeenCalled();

			// Advance time by default delay (300ms)
			vi.advanceTimersByTime(300);

			expect(localStorage.setItem).toHaveBeenCalled();
		});

		it('should use custom delay', () => {
			debouncedSaveViewState({ showAllSessions: true }, 500);

			vi.advanceTimersByTime(300);
			expect(localStorage.setItem).not.toHaveBeenCalled();

			vi.advanceTimersByTime(200);
			expect(localStorage.setItem).toHaveBeenCalled();
		});

		it('should cancel previous save when called again', () => {
			debouncedSaveViewState({ showAllSessions: true });
			vi.advanceTimersByTime(200);

			// Call again before first save completes
			debouncedSaveViewState({ showAllSessions: false });
			vi.advanceTimersByTime(100);

			// First call should have been cancelled
			expect(localStorage.setItem).not.toHaveBeenCalled();

			// Wait for second call to complete
			vi.advanceTimersByTime(200);
			expect(localStorage.setItem).toHaveBeenCalledTimes(1);

			const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.showAllSessions).toBe(false); // Second call's value
		});

		it('should save latest state when called multiple times rapidly', () => {
			debouncedSaveViewState({ showAllSessions: true });
			vi.advanceTimersByTime(100);
			debouncedSaveViewState({ showHistoryPanel: true });
			vi.advanceTimersByTime(100);
			debouncedSaveViewState({ activeSessionId: 'final-session' });

			// Wait for debounce to complete
			vi.advanceTimersByTime(300);

			expect(localStorage.setItem).toHaveBeenCalledTimes(1);
			const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.activeSessionId).toBe('final-session');
		});
	});

	describe('debouncedSaveScrollPosition', () => {
		it('should delay saving scroll position', () => {
			debouncedSaveScrollPosition('messageHistory', 100);

			// Should not save immediately
			expect(localStorage.setItem).not.toHaveBeenCalled();

			// Advance time by default delay (500ms)
			vi.advanceTimersByTime(500);

			expect(localStorage.setItem).toHaveBeenCalled();
		});

		it('should use custom delay', () => {
			debouncedSaveScrollPosition('messageHistory', 100, 1000);

			vi.advanceTimersByTime(500);
			expect(localStorage.setItem).not.toHaveBeenCalled();

			vi.advanceTimersByTime(500);
			expect(localStorage.setItem).toHaveBeenCalled();
		});

		it('should cancel previous save when called again', () => {
			debouncedSaveScrollPosition('messageHistory', 100);
			vi.advanceTimersByTime(300);

			debouncedSaveScrollPosition('messageHistory', 200);
			vi.advanceTimersByTime(200);

			// First call should have been cancelled
			expect(localStorage.setItem).not.toHaveBeenCalled();

			// Wait for second call to complete
			vi.advanceTimersByTime(300);
			expect(localStorage.setItem).toHaveBeenCalledTimes(1);

			const savedData = JSON.parse(localStorageMock['maestro-web-scroll-state']);
			expect(savedData.messageHistory).toBe(200); // Second call's value
		});

		it('should save latest scroll position when scrolling rapidly', () => {
			debouncedSaveScrollPosition('messageHistory', 100);
			vi.advanceTimersByTime(100);
			debouncedSaveScrollPosition('messageHistory', 200);
			vi.advanceTimersByTime(100);
			debouncedSaveScrollPosition('messageHistory', 300);
			vi.advanceTimersByTime(100);
			debouncedSaveScrollPosition('messageHistory', 400);

			// Wait for debounce to complete
			vi.advanceTimersByTime(500);

			expect(localStorage.setItem).toHaveBeenCalledTimes(1);
			const savedData = JSON.parse(localStorageMock['maestro-web-scroll-state']);
			expect(savedData.messageHistory).toBe(400);
		});
	});

	describe('edge cases', () => {
		it('should handle zero scroll positions', () => {
			saveScrollPosition('messageHistory', 0);

			const savedData = JSON.parse(localStorageMock['maestro-web-scroll-state']);
			expect(savedData.messageHistory).toBe(0);
		});

		it('should handle large scroll positions', () => {
			saveScrollPosition('messageHistory', 999999);

			const savedData = JSON.parse(localStorageMock['maestro-web-scroll-state']);
			expect(savedData.messageHistory).toBe(999999);
		});

		it('should handle null activeSessionId', () => {
			saveViewState({ activeSessionId: null });

			const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.activeSessionId).toBe(null);
		});

		it('should handle empty string historySearchQuery', () => {
			saveViewState({ historySearchQuery: '' });

			const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.historySearchQuery).toBe('');
		});

		it('should handle special characters in historySearchQuery', () => {
			saveViewState({ historySearchQuery: 'test<script>alert("xss")</script>' });

			const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.historySearchQuery).toBe('test<script>alert("xss")</script>');
		});

		it('should handle all history filter values', () => {
			const filters: Array<'all' | 'AUTO' | 'USER'> = ['all', 'AUTO', 'USER'];

			for (const filter of filters) {
				saveViewState({ historyFilter: filter });
				const savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
				expect(savedData.historyFilter).toBe(filter);
			}
		});

		it('should handle both input modes', () => {
			saveViewState({ inputMode: 'ai' });
			let savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.inputMode).toBe('ai');

			saveViewState({ inputMode: 'terminal' });
			savedData = JSON.parse(localStorageMock['maestro-web-view-state']);
			expect(savedData.inputMode).toBe('terminal');
		});
	});
});
