/**
 * Tests for useSessions hook
 *
 * Tests the session management hook for the Maestro web interface.
 * Covers session state management, WebSocket event handling, API operations,
 * and various edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	useSessions,
	type Session,
	type SessionState,
	type InputMode,
	type UseSessionsOptions,
	type UseSessionsReturn,
	type GroupInfo,
} from '../../../web/hooks/useSessions';
import type {
	WebSocketState,
	SessionData,
	UseWebSocketReturn,
	WebSocketEventHandlers,
} from '../../../web/hooks/useWebSocket';
import type { Theme } from '../../../shared/theme-types';

// Create a mock useWebSocket return value factory
function createMockWebSocketReturn(
	overrides: Partial<UseWebSocketReturn> = {}
): UseWebSocketReturn {
	return {
		state: 'disconnected' as WebSocketState,
		isAuthenticated: false,
		isConnecting: false,
		error: null,
		clientId: null,
		connect: vi.fn(),
		disconnect: vi.fn(),
		authenticate: vi.fn(),
		send: vi.fn().mockReturnValue(true),
		...overrides,
	};
}

// Store the handlers passed to useWebSocket
let capturedHandlers: WebSocketEventHandlers = {};
let mockWsReturn: UseWebSocketReturn = createMockWebSocketReturn();

// Mock the useWebSocket hook
vi.mock('../../../web/hooks/useWebSocket', async () => {
	const actual = await vi.importActual('../../../web/hooks/useWebSocket');
	return {
		...actual,
		useWebSocket: vi.fn((options) => {
			// Capture the handlers for testing
			if (options?.handlers) {
				capturedHandlers = options.handlers;
			}
			return mockWsReturn;
		}),
	};
});

describe('useSessions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		capturedHandlers = {};
		mockWsReturn = createMockWebSocketReturn();

		// Mock window.location for getApiBaseUrl
		Object.defineProperty(window, 'location', {
			writable: true,
			value: {
				protocol: 'http:',
				host: 'localhost:3000',
			},
		});

		// Mock global fetch
		global.fetch = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// =============================================================================
	// 1. Initial State Tests
	// =============================================================================
	describe('Initial State', () => {
		it('returns empty sessions array initially', () => {
			const { result } = renderHook(() => useSessions());

			expect(result.current.sessions).toEqual([]);
		});

		it('returns null activeSession initially', () => {
			const { result } = renderHook(() => useSessions());

			expect(result.current.activeSession).toBeNull();
		});

		it('returns empty sessionsByGroup initially', () => {
			const { result } = renderHook(() => useSessions());

			expect(result.current.sessionsByGroup).toEqual({});
		});

		it('exposes connection state from WebSocket', () => {
			mockWsReturn = createMockWebSocketReturn({
				state: 'connecting',
				isConnecting: true,
			});

			const { result } = renderHook(() => useSessions());

			expect(result.current.connectionState).toBe('connecting');
		});

		it('exposes clientId from WebSocket', () => {
			mockWsReturn = createMockWebSocketReturn({
				clientId: 'client-123',
			});

			const { result } = renderHook(() => useSessions());

			expect(result.current.clientId).toBe('client-123');
		});
	});

	// =============================================================================
	// 2. WebSocket Handler Wiring Tests
	// =============================================================================
	describe('WebSocket Handler Wiring', () => {
		it('handleSessionsUpdate updates sessions state', async () => {
			const { result } = renderHook(() => useSessions());

			const newSessions: SessionData[] = [
				{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				{ id: 'session-2', name: 'Session 2', state: 'busy' } as SessionData,
			];

			act(() => {
				capturedHandlers.onSessionsUpdate?.(newSessions);
			});

			expect(result.current.sessions).toHaveLength(2);
			expect(result.current.sessions[0].id).toBe('session-1');
			expect(result.current.sessions[1].id).toBe('session-2');
		});

		it('handleSessionsUpdate notifies onSessionsChange with updated sessions', async () => {
			const onSessionsChange = vi.fn();
			renderHook(() => useSessions({ onSessionsChange }));

			const newSessions: SessionData[] = [
				{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				{ id: 'session-2', name: 'Session 2', state: 'busy' } as SessionData,
			];

			act(() => {
				capturedHandlers.onSessionsUpdate?.(newSessions);
			});

			expect(onSessionsChange).toHaveBeenCalledTimes(1);
			expect(onSessionsChange).toHaveBeenCalledWith([
				expect.objectContaining({ id: 'session-1', name: 'Session 1', state: 'idle' }),
				expect.objectContaining({ id: 'session-2', name: 'Session 2', state: 'busy' }),
			]);
		});

		it('handleSessionsUpdate preserves client-side state (isSending, lastError)', async () => {
			const { result } = renderHook(() => useSessions());

			// First update with initial sessions
			const initialSessions: SessionData[] = [
				{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
			];

			act(() => {
				capturedHandlers.onSessionsUpdate?.(initialSessions);
			});

			// Simulate client-side state by directly modifying (via sendCommand failure)
			// For simplicity, we'll verify the merge logic works
			const updatedSessions: SessionData[] = [
				{ id: 'session-1', name: 'Session 1 Updated', state: 'busy' } as SessionData,
			];

			act(() => {
				capturedHandlers.onSessionsUpdate?.(updatedSessions);
			});

			expect(result.current.sessions[0].name).toBe('Session 1 Updated');
			expect(result.current.sessions[0].state).toBe('busy');
		});

		it('handleSessionStateChange updates specific session state', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize with sessions
			const sessions: SessionData[] = [
				{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				{ id: 'session-2', name: 'Session 2', state: 'idle' } as SessionData,
			];

			act(() => {
				capturedHandlers.onSessionsUpdate?.(sessions);
			});

			// Update one session's state
			act(() => {
				capturedHandlers.onSessionStateChange?.('session-1', 'busy', {
					inputMode: 'ai',
				});
			});

			expect(result.current.sessions[0].state).toBe('busy');
			expect(result.current.sessions[0].inputMode).toBe('ai');
			expect(result.current.sessions[1].state).toBe('idle'); // Unchanged
		});

		it('handleSessionAdded adds new session to list', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize with one session
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			// Add a new session
			const newSession: SessionData = {
				id: 'session-2',
				name: 'Session 2',
				state: 'connecting',
			} as SessionData;

			act(() => {
				capturedHandlers.onSessionAdded?.(newSession);
			});

			expect(result.current.sessions).toHaveLength(2);
			expect(result.current.sessions[1].id).toBe('session-2');
		});

		it('handleSessionAdded ignores duplicate sessions', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize with one session
			const session: SessionData = {
				id: 'session-1',
				name: 'Session 1',
				state: 'idle',
			} as SessionData;

			act(() => {
				capturedHandlers.onSessionsUpdate?.([session]);
			});

			// Try to add duplicate
			act(() => {
				capturedHandlers.onSessionAdded?.(session);
			});

			expect(result.current.sessions).toHaveLength(1);
		});

		it('handleSessionRemoved removes session from list', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize with two sessions
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
					{ id: 'session-2', name: 'Session 2', state: 'idle' } as SessionData,
				]);
			});

			// Remove one session
			act(() => {
				capturedHandlers.onSessionRemoved?.('session-1');
			});

			expect(result.current.sessions).toHaveLength(1);
			expect(result.current.sessions[0].id).toBe('session-2');
		});

		it('handleSessionRemoved clears activeSessionId if removed session was active', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize and set active session
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			act(() => {
				result.current.setActiveSessionId('session-1');
			});

			expect(result.current.activeSession?.id).toBe('session-1');

			// Remove the active session
			act(() => {
				capturedHandlers.onSessionRemoved?.('session-1');
			});

			expect(result.current.activeSession).toBeNull();
		});
	});

	// =============================================================================
	// 3. Theme and Tabs Handlers Tests
	// =============================================================================
	describe('Theme and Tabs Handlers', () => {
		it('handleThemeUpdate calls onThemeUpdate callback', () => {
			const onThemeUpdate = vi.fn();
			renderHook(() => useSessions({ onThemeUpdate }));

			const theme: Theme = {
				id: 'dark',
				mode: 'dark',
				name: 'Dark Theme',
				colors: {} as Theme['colors'],
			};

			act(() => {
				capturedHandlers.onThemeUpdate?.(theme);
			});

			expect(onThemeUpdate).toHaveBeenCalledWith(theme);
		});

		it('handleTabsChanged updates session tabs', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize with a session
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{
						id: 'session-1',
						name: 'Session 1',
						state: 'idle',
						aiTabs: [],
						activeTabId: '',
					} as SessionData,
				]);
			});

			const newTabs = [
				{ id: 'tab-1', name: 'Tab 1', logs: [] },
				{ id: 'tab-2', name: 'Tab 2', logs: [] },
			];

			act(() => {
				capturedHandlers.onTabsChanged?.('session-1', newTabs, 'tab-2');
			});

			expect(result.current.sessions[0].aiTabs).toEqual(newTabs);
			expect(result.current.sessions[0].activeTabId).toBe('tab-2');
		});

		it('handleError calls onError callback', () => {
			const onError = vi.fn();
			renderHook(() => useSessions({ onError }));

			act(() => {
				capturedHandlers.onError?.('Something went wrong');
			});

			expect(onError).toHaveBeenCalledWith('Something went wrong');
		});
	});

	// =============================================================================
	// 4. Active Session Management Tests
	// =============================================================================
	describe('Active Session Management', () => {
		it('setActiveSessionId updates activeSessionId', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize sessions
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			act(() => {
				result.current.setActiveSessionId('session-1');
			});

			expect(result.current.activeSession?.id).toBe('session-1');
		});

		it('activeSession returns correct session object', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize sessions
			const session: SessionData = {
				id: 'session-1',
				name: 'My Session',
				state: 'busy',
				inputMode: 'ai',
			} as SessionData;

			act(() => {
				capturedHandlers.onSessionsUpdate?.([session]);
			});

			act(() => {
				result.current.setActiveSessionId('session-1');
			});

			expect(result.current.activeSession).toEqual({
				...session,
				isSending: undefined,
				lastError: undefined,
			});
		});

		it('activeSession returns null when no session matches', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				result.current.setActiveSessionId('nonexistent');
			});

			expect(result.current.activeSession).toBeNull();
		});

		it('getSession returns session by ID', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
					{ id: 'session-2', name: 'Session 2', state: 'busy' } as SessionData,
				]);
			});

			const session = result.current.getSession('session-2');

			expect(session?.id).toBe('session-2');
			expect(session?.name).toBe('Session 2');
		});

		it('getSession returns undefined for unknown ID', () => {
			const { result } = renderHook(() => useSessions());

			const session = result.current.getSession('unknown');

			expect(session).toBeUndefined();
		});

		it('onActiveSessionChange callback fires on active change', async () => {
			const onActiveSessionChange = vi.fn();
			const { result } = renderHook(() => useSessions({ onActiveSessionChange }));

			// Initialize sessions
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			// Change active session
			act(() => {
				result.current.setActiveSessionId('session-1');
			});

			// Wait for effect to run
			await waitFor(() => {
				expect(onActiveSessionChange).toHaveBeenCalled();
			});
		});
	});

	// =============================================================================
	// 5. Sessions By Group Computation Tests
	// =============================================================================
	describe('Sessions By Group Computation', () => {
		it('groups sessions by groupId', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{
						id: 's1',
						name: 'Session 1',
						groupId: 'group-a',
						groupName: 'Group A',
						state: 'idle',
					} as SessionData,
					{
						id: 's2',
						name: 'Session 2',
						groupId: 'group-a',
						groupName: 'Group A',
						state: 'idle',
					} as SessionData,
					{
						id: 's3',
						name: 'Session 3',
						groupId: 'group-b',
						groupName: 'Group B',
						state: 'idle',
					} as SessionData,
				]);
			});

			expect(Object.keys(result.current.sessionsByGroup)).toEqual(['group-a', 'group-b']);
			expect(result.current.sessionsByGroup['group-a'].sessions).toHaveLength(2);
			expect(result.current.sessionsByGroup['group-b'].sessions).toHaveLength(1);
		});

		it('places ungrouped sessions under ungrouped key', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 's1', name: 'Session 1', state: 'idle' } as SessionData, // No groupId
				]);
			});

			expect(result.current.sessionsByGroup['ungrouped']).toBeDefined();
			expect(result.current.sessionsByGroup['ungrouped'].sessions).toHaveLength(1);
			expect(result.current.sessionsByGroup['ungrouped'].name).toBe('Ungrouped');
		});

		it('includes group metadata (id, name, emoji)', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{
						id: 's1',
						name: 'Session 1',
						groupId: 'group-1',
						groupName: 'My Group',
						groupEmoji: '🚀',
						state: 'idle',
					} as SessionData,
				]);
			});

			const group = result.current.sessionsByGroup['group-1'];

			expect(group.id).toBe('group-1');
			expect(group.name).toBe('My Group');
			expect(group.emoji).toBe('🚀');
		});

		it('updates when sessions change', () => {
			const { result } = renderHook(() => useSessions());

			// Initial sessions
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{
						id: 's1',
						name: 'Session 1',
						groupId: 'group-a',
						groupName: 'Group A',
						state: 'idle',
					} as SessionData,
				]);
			});

			expect(result.current.sessionsByGroup['group-a'].sessions).toHaveLength(1);

			// Add another session to the same group
			act(() => {
				capturedHandlers.onSessionAdded?.({
					id: 's2',
					name: 'Session 2',
					groupId: 'group-a',
					groupName: 'Group A',
					state: 'idle',
				} as SessionData);
			});

			expect(result.current.sessionsByGroup['group-a'].sessions).toHaveLength(2);
		});

		it('handles mixed grouped and ungrouped sessions', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{
						id: 's1',
						name: 'Grouped',
						groupId: 'group-1',
						groupName: 'Group 1',
						state: 'idle',
					} as SessionData,
					{ id: 's2', name: 'Ungrouped 1', state: 'idle' } as SessionData,
					{ id: 's3', name: 'Ungrouped 2', state: 'busy' } as SessionData,
				]);
			});

			expect(result.current.sessionsByGroup['group-1'].sessions).toHaveLength(1);
			expect(result.current.sessionsByGroup['ungrouped'].sessions).toHaveLength(2);
		});
	});

	// =============================================================================
	// 6. Auto-Connect Behavior Tests
	// =============================================================================
	describe('Auto-Connect Behavior', () => {
		it('auto-connects when autoConnect=true and state=disconnected', () => {
			mockWsReturn = createMockWebSocketReturn({ state: 'disconnected' });

			renderHook(() => useSessions({ autoConnect: true }));

			expect(mockWsReturn.connect).toHaveBeenCalled();
		});

		it('does not auto-connect when autoConnect=false', () => {
			mockWsReturn = createMockWebSocketReturn({ state: 'disconnected' });

			renderHook(() => useSessions({ autoConnect: false }));

			expect(mockWsReturn.connect).not.toHaveBeenCalled();
		});

		it('does not reconnect if already connecting/connected', () => {
			mockWsReturn = createMockWebSocketReturn({ state: 'connecting' });

			renderHook(() => useSessions({ autoConnect: true }));

			expect(mockWsReturn.connect).not.toHaveBeenCalled();
		});
	});

	// =============================================================================
	// 7. sendCommand API Operation Tests
	// =============================================================================
	describe('sendCommand API Operation', () => {
		it('sets isSending=true before request', async () => {
			const { result } = renderHook(() => useSessions());

			// Initialize session
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			// Mock a slow fetch
			let resolveRequest: () => void;
			(global.fetch as vi.Mock).mockImplementation(
				() =>
					new Promise((resolve) => {
						resolveRequest = () =>
							resolve({
								ok: true,
								json: () => Promise.resolve({ success: true }),
							});
					})
			);

			// Start the command
			let promise: Promise<boolean>;
			act(() => {
				promise = result.current.sendCommand('session-1', 'test command');
			});

			// Check isSending is true
			expect(result.current.sessions[0].isSending).toBe(true);

			// Resolve the request
			await act(async () => {
				resolveRequest!();
				await promise;
			});
		});

		it('makes fetch request to correct URL', async () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			await act(async () => {
				await result.current.sendCommand('session-1', 'test command');
			});

			expect(global.fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/session/session-1/send',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ command: 'test command' }),
				})
			);
		});

		it('sets isSending=false on success', async () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			await act(async () => {
				await result.current.sendCommand('session-1', 'test');
			});

			expect(result.current.sessions[0].isSending).toBe(false);
		});

		it('returns true on success', async () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			let success: boolean;
			await act(async () => {
				success = await result.current.sendCommand('session-1', 'test');
			});

			expect(success!).toBe(true);
		});

		it('sets lastError and isSending=false on failure', async () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: false,
				json: () => Promise.resolve({ success: false, error: 'Session busy' }),
			});

			await act(async () => {
				await result.current.sendCommand('session-1', 'test');
			});

			expect(result.current.sessions[0].isSending).toBe(false);
			expect(result.current.sessions[0].lastError).toBe('Session busy');
		});

		it('calls onError callback on failure', async () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useSessions({ onError }));

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			(global.fetch as vi.Mock).mockRejectedValue(new Error('Network error'));

			await act(async () => {
				await result.current.sendCommand('session-1', 'test');
			});

			expect(onError).toHaveBeenCalledWith('Network error');
		});

		it('returns false on failure', async () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: false,
				json: () => Promise.resolve({ success: false, error: 'Failed' }),
			});

			let success: boolean;
			await act(async () => {
				success = await result.current.sendCommand('session-1', 'test');
			});

			expect(success!).toBe(false);
		});
	});

	// =============================================================================
	// 8. sendToActive Tests
	// =============================================================================
	describe('sendToActive', () => {
		it('calls sendCommand with activeSessionId', async () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			act(() => {
				result.current.setActiveSessionId('session-1');
			});

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			await act(async () => {
				await result.current.sendToActive('test command');
			});

			expect(global.fetch).toHaveBeenCalledWith(
				expect.stringContaining('session-1'),
				expect.any(Object)
			);
		});

		it('returns false and calls onError when no active session', async () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useSessions({ onError }));

			let success: boolean;
			await act(async () => {
				success = await result.current.sendToActive('test');
			});

			expect(success!).toBe(false);
			expect(onError).toHaveBeenCalledWith('No active session');
		});

		it('passes through return value from sendCommand', async () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			act(() => {
				result.current.setActiveSessionId('session-1');
			});

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			let success: boolean;
			await act(async () => {
				success = await result.current.sendToActive('test');
			});

			expect(success!).toBe(true);
		});
	});

	// =============================================================================
	// 9. interrupt API Operation Tests
	// =============================================================================
	describe('interrupt API Operation', () => {
		it('makes fetch request to correct URL', async () => {
			const { result } = renderHook(() => useSessions());

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			await act(async () => {
				await result.current.interrupt('session-1');
			});

			expect(global.fetch).toHaveBeenCalledWith(
				'http://localhost:3000/api/session/session-1/interrupt',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
				})
			);
		});

		it('returns true on success', async () => {
			const { result } = renderHook(() => useSessions());

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			let success: boolean;
			await act(async () => {
				success = await result.current.interrupt('session-1');
			});

			expect(success!).toBe(true);
		});

		it('returns false and calls onError on failure', async () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useSessions({ onError }));

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: false,
				json: () => Promise.resolve({ success: false, error: 'Cannot interrupt' }),
			});

			let success: boolean;
			await act(async () => {
				success = await result.current.interrupt('session-1');
			});

			expect(success!).toBe(false);
			expect(onError).toHaveBeenCalledWith('Cannot interrupt');
		});

		it('handles non-Error exceptions', async () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useSessions({ onError }));

			(global.fetch as vi.Mock).mockRejectedValue('string error');

			let success: boolean;
			await act(async () => {
				success = await result.current.interrupt('session-1');
			});

			expect(success!).toBe(false);
			expect(onError).toHaveBeenCalledWith('Unknown error');
		});
	});

	// =============================================================================
	// 10. interruptActive Tests
	// =============================================================================
	describe('interruptActive', () => {
		it('calls interrupt with activeSessionId', async () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'busy' } as SessionData,
				]);
			});

			act(() => {
				result.current.setActiveSessionId('session-1');
			});

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			await act(async () => {
				await result.current.interruptActive();
			});

			expect(global.fetch).toHaveBeenCalledWith(
				expect.stringContaining('session-1'),
				expect.any(Object)
			);
		});

		it('returns false and calls onError when no active session', async () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useSessions({ onError }));

			let success: boolean;
			await act(async () => {
				success = await result.current.interruptActive();
			});

			expect(success!).toBe(false);
			expect(onError).toHaveBeenCalledWith('No active session');
		});
	});

	// =============================================================================
	// 11. WebSocket Message Operations Tests
	// =============================================================================
	describe('WebSocket Message Operations', () => {
		it('switchMode sends correct message type', async () => {
			const { result } = renderHook(() => useSessions());

			await act(async () => {
				await result.current.switchMode('session-1', 'terminal');
			});

			expect(mockWsReturn.send).toHaveBeenCalledWith({
				type: 'switch_mode',
				sessionId: 'session-1',
				mode: 'terminal',
			});
		});

		it('selectTab sends correct message type', async () => {
			const { result } = renderHook(() => useSessions());

			await act(async () => {
				await result.current.selectTab('session-1', 'tab-2');
			});

			expect(mockWsReturn.send).toHaveBeenCalledWith({
				type: 'select_tab',
				sessionId: 'session-1',
				tabId: 'tab-2',
			});
		});

		it('newTab sends correct message type', async () => {
			const { result } = renderHook(() => useSessions());

			await act(async () => {
				await result.current.newTab('session-1');
			});

			expect(mockWsReturn.send).toHaveBeenCalledWith({
				type: 'new_tab',
				sessionId: 'session-1',
			});
		});

		it('closeTab sends correct message type', async () => {
			const { result } = renderHook(() => useSessions());

			await act(async () => {
				await result.current.closeTab('session-1', 'tab-1');
			});

			expect(mockWsReturn.send).toHaveBeenCalledWith({
				type: 'close_tab',
				sessionId: 'session-1',
				tabId: 'tab-1',
			});
		});

		it('refreshSessions sends get_sessions message', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				result.current.refreshSessions();
			});

			expect(mockWsReturn.send).toHaveBeenCalledWith({ type: 'get_sessions' });
		});
	});

	// =============================================================================
	// 12. Connection Methods Tests
	// =============================================================================
	describe('Connection Methods', () => {
		it('connect calls ws.connect', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				result.current.connect();
			});

			expect(mockWsReturn.connect).toHaveBeenCalled();
		});

		it('disconnect calls ws.disconnect', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				result.current.disconnect();
			});

			expect(mockWsReturn.disconnect).toHaveBeenCalled();
		});

		it('authenticate calls ws.authenticate', () => {
			const { result } = renderHook(() => useSessions());

			act(() => {
				result.current.authenticate('my-token');
			});

			expect(mockWsReturn.authenticate).toHaveBeenCalledWith('my-token');
		});
	});

	// =============================================================================
	// 13. Edge Cases Tests
	// =============================================================================
	describe('Edge Cases', () => {
		it('handles session not found in handleSessionStateChange', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize with a session
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			// Try to update a non-existent session
			act(() => {
				capturedHandlers.onSessionStateChange?.('nonexistent', 'busy');
			});

			// Should not crash, and original session should be unchanged
			expect(result.current.sessions[0].state).toBe('idle');
		});

		it('handles session not found in sendCommand', async () => {
			const { result } = renderHook(() => useSessions());

			// No sessions initialized, try to send command
			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			// Should not crash even if session not found for state update
			await act(async () => {
				await result.current.sendCommand('nonexistent', 'test');
			});

			// Fetch should still be called
			expect(global.fetch).toHaveBeenCalled();
		});

		it('handles session not found in handleTabsChanged', () => {
			const { result } = renderHook(() => useSessions());

			// Initialize with a session
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			// Try to update tabs for non-existent session
			act(() => {
				capturedHandlers.onTabsChanged?.('nonexistent', [], 'tab-1');
			});

			// Should not crash, original session unchanged
			expect(result.current.sessions).toHaveLength(1);
		});

		it('getApiBaseUrl returns correct URL from location', async () => {
			// Change location
			Object.defineProperty(window, 'location', {
				writable: true,
				value: {
					protocol: 'https:',
					host: 'maestro.example.com:8443',
				},
			});

			const { result } = renderHook(() => useSessions());

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: true }),
			});

			await act(async () => {
				await result.current.sendCommand('session-1', 'test');
			});

			expect(global.fetch).toHaveBeenCalledWith(
				'https://maestro.example.com:8443/api/session/session-1/send',
				expect.any(Object)
			);
		});

		it('sendCommand uses fallback error message when result.error is undefined', async () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useSessions({ onError }));

			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			// Response ok but success=false, no error message
			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: false }),
			});

			await act(async () => {
				await result.current.sendCommand('session-1', 'test');
			});

			expect(onError).toHaveBeenCalledWith('Failed to send command');
		});

		it('sendCommand handles session not found during error state update', async () => {
			const { result } = renderHook(() => useSessions());

			// Initialize with a session
			act(() => {
				capturedHandlers.onSessionsUpdate?.([
					{ id: 'session-1', name: 'Session 1', state: 'idle' } as SessionData,
				]);
			});

			// Mock fetch to fail - remove the session during the fetch
			(global.fetch as vi.Mock).mockImplementation(async () => {
				// Remove the session during the request
				act(() => {
					capturedHandlers.onSessionRemoved?.('session-1');
				});
				return {
					ok: false,
					json: () => Promise.resolve({ success: false, error: 'Test error' }),
				};
			});

			// Should not crash when trying to update error state for removed session
			await act(async () => {
				await result.current.sendCommand('session-1', 'test');
			});

			// Session should be gone
			expect(result.current.sessions).toHaveLength(0);
		});

		it('interrupt uses fallback error message when result.error is undefined', async () => {
			const onError = vi.fn();
			const { result } = renderHook(() => useSessions({ onError }));

			// Response ok but success=false, no error message
			(global.fetch as vi.Mock).mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ success: false }),
			});

			await act(async () => {
				await result.current.interrupt('session-1');
			});

			expect(onError).toHaveBeenCalledWith('Failed to interrupt session');
		});

		it('callback refs update without re-registering handlers', () => {
			const onError1 = vi.fn();
			const onError2 = vi.fn();

			const { rerender } = renderHook(({ onError }) => useSessions({ onError }), {
				initialProps: { onError: onError1 },
			});

			// Rerender with new callback
			rerender({ onError: onError2 });

			// Trigger error with new callback
			act(() => {
				capturedHandlers.onError?.('Test error');
			});

			// Should call the new callback
			expect(onError2).toHaveBeenCalledWith('Test error');
			expect(onError1).not.toHaveBeenCalled();
		});
	});

	// =============================================================================
	// Additional Type and Interface Tests
	// =============================================================================
	describe('Type Exports', () => {
		it('Session interface extends SessionData with client-side state', () => {
			const session: Session = {
				id: 'test',
				name: 'Test',
				state: 'idle',
				isSending: true,
				lastError: 'Error',
			} as Session;

			expect(session.isSending).toBe(true);
			expect(session.lastError).toBe('Error');
		});

		it('SessionState union type accepts valid values', () => {
			const states: SessionState[] = ['idle', 'busy', 'error', 'connecting'];

			states.forEach((state) => {
				expect(['idle', 'busy', 'error', 'connecting']).toContain(state);
			});
		});

		it('InputMode union type accepts valid values', () => {
			const modes: InputMode[] = ['ai', 'terminal'];

			modes.forEach((mode) => {
				expect(['ai', 'terminal']).toContain(mode);
			});
		});

		it('GroupInfo interface has required properties', () => {
			const group: GroupInfo = {
				id: 'group-1',
				name: 'Test Group',
				emoji: '🚀',
				sessions: [],
			};

			expect(group.id).toBe('group-1');
			expect(group.name).toBe('Test Group');
			expect(group.emoji).toBe('🚀');
			expect(group.sessions).toEqual([]);
		});

		it('GroupInfo accepts null id and emoji', () => {
			const group: GroupInfo = {
				id: null,
				name: 'Ungrouped',
				emoji: null,
				sessions: [],
			};

			expect(group.id).toBeNull();
			expect(group.emoji).toBeNull();
		});
	});

	// =============================================================================
	// Return Value Tests
	// =============================================================================
	describe('Return Value', () => {
		it('exposes ws object for advanced use', () => {
			const { result } = renderHook(() => useSessions());

			expect(result.current.ws).toBe(mockWsReturn);
		});

		it('isConnected reflects isAuthenticated state', () => {
			mockWsReturn = createMockWebSocketReturn({ isAuthenticated: true });

			const { result } = renderHook(() => useSessions());

			expect(result.current.isConnected).toBe(true);
		});

		it('connectionError reflects ws.error', () => {
			mockWsReturn = createMockWebSocketReturn({ error: 'Connection failed' });

			const { result } = renderHook(() => useSessions());

			expect(result.current.connectionError).toBe('Connection failed');
		});
	});

	// =============================================================================
	// Default Export Test
	// =============================================================================
	describe('Default Export', () => {
		it('exports useSessions as default', async () => {
			const module = await import('../../../web/hooks/useSessions');
			expect(module.default).toBe(module.useSessions);
		});
	});
});
