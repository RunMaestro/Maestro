/**
 * Tests for groupChatStore — Group chat state management
 *
 * Tests entity data (chats, active chat), active chat state (messages, state,
 * participants, usage), all-chats tracking (Maps), execution queue, UI state,
 * error handling, convenience methods, and non-React access helpers.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	useGroupChatStore,
	getGroupChatState,
	getGroupChatActions,
} from '../../../renderer/stores/groupChatStore';
import type {
	GroupChatRightTab,
	GroupChatErrorState,
} from '../../../renderer/stores/groupChatStore';
import type { GroupChat, GroupChatMessage, GroupChatState } from '../../../renderer/types';
import type { QueuedItem } from '../../../renderer/types';

// ============================================================================
// Helpers
// ============================================================================

function createMockGroupChat(overrides: Partial<GroupChat> = {}): GroupChat {
	return {
		id: overrides.id ?? 'gc-1',
		name: overrides.name ?? 'Test Chat',
		createdAt: overrides.createdAt ?? Date.now(),
		moderatorAgentId: overrides.moderatorAgentId ?? 'claude-code',
		moderatorSessionId: overrides.moderatorSessionId ?? 'group-chat-gc-1-moderator',
		participants: overrides.participants ?? [],
		logPath: overrides.logPath ?? '/tmp/gc-1.log',
		imagesDir: overrides.imagesDir ?? '/tmp/gc-1-images',
		...overrides,
	} as GroupChat;
}

function createMockMessage(overrides: Partial<GroupChatMessage> = {}): GroupChatMessage {
	return {
		timestamp: overrides.timestamp ?? new Date().toISOString(),
		from: overrides.from ?? 'user',
		content: overrides.content ?? 'Hello',
		...overrides,
	} as GroupChatMessage;
}

function createMockQueuedItem(overrides: Partial<QueuedItem> = {}): QueuedItem {
	return {
		type: overrides.type ?? 'message',
		content: overrides.content ?? 'queued message',
		...overrides,
	} as QueuedItem;
}

function createMockError(overrides: Partial<GroupChatErrorState> = {}): GroupChatErrorState {
	return {
		groupChatId: overrides.groupChatId ?? 'gc-1',
		error: overrides.error ?? { type: 'process_error', message: 'Something went wrong' },
		participantName: overrides.participantName,
		...overrides,
	} as GroupChatErrorState;
}

function resetStore() {
	useGroupChatStore.setState({
		groupChats: [],
		activeGroupChatId: null,
		groupChatMessages: [],
		groupChatState: 'idle',
		participantStates: new Map(),
		moderatorUsage: null,
		groupChatStates: new Map(),
		allGroupChatParticipantStates: new Map(),
		groupChatExecutionQueue: [],
		groupChatReadOnlyMode: false,
		groupChatRightTab: 'participants',
		groupChatParticipantColors: {},
		groupChatStagedImages: [],
		groupChatError: null,
	});
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
	resetStore();
});

// ============================================================================
// Tests
// ============================================================================

describe('groupChatStore', () => {
	describe('initial state', () => {
		it('has correct default values', () => {
			const state = useGroupChatStore.getState();
			expect(state.groupChats).toEqual([]);
			expect(state.activeGroupChatId).toBeNull();
			expect(state.groupChatMessages).toEqual([]);
			expect(state.groupChatState).toBe('idle');
			expect(state.participantStates).toEqual(new Map());
			expect(state.moderatorUsage).toBeNull();
			expect(state.groupChatStates).toEqual(new Map());
			expect(state.allGroupChatParticipantStates).toEqual(new Map());
			expect(state.groupChatExecutionQueue).toEqual([]);
			expect(state.groupChatReadOnlyMode).toBe(false);
			expect(state.groupChatRightTab).toBe('participants');
			expect(state.groupChatParticipantColors).toEqual({});
			expect(state.groupChatStagedImages).toEqual([]);
			expect(state.groupChatError).toBeNull();
		});
	});

	// ==========================================================================
	// Entity data
	// ==========================================================================

	describe('entity data', () => {
		it('sets group chats with direct value', () => {
			const chats = [createMockGroupChat({ id: 'gc-1' }), createMockGroupChat({ id: 'gc-2' })];
			useGroupChatStore.getState().setGroupChats(chats);
			expect(useGroupChatStore.getState().groupChats).toHaveLength(2);
			expect(useGroupChatStore.getState().groupChats[0].id).toBe('gc-1');
		});

		it('sets group chats with functional updater', () => {
			const chat1 = createMockGroupChat({ id: 'gc-1' });
			useGroupChatStore.getState().setGroupChats([chat1]);
			const chat2 = createMockGroupChat({ id: 'gc-2' });
			useGroupChatStore.getState().setGroupChats((prev) => [...prev, chat2]);
			expect(useGroupChatStore.getState().groupChats).toHaveLength(2);
		});

		it('sets active group chat ID', () => {
			useGroupChatStore.getState().setActiveGroupChatId('gc-123');
			expect(useGroupChatStore.getState().activeGroupChatId).toBe('gc-123');
		});

		it('sets active group chat ID with functional updater', () => {
			useGroupChatStore.getState().setActiveGroupChatId('gc-1');
			useGroupChatStore
				.getState()
				.setActiveGroupChatId((prev) => (prev === 'gc-1' ? 'gc-2' : prev));
			expect(useGroupChatStore.getState().activeGroupChatId).toBe('gc-2');
		});

		it('sets active group chat ID to null', () => {
			useGroupChatStore.getState().setActiveGroupChatId('gc-1');
			useGroupChatStore.getState().setActiveGroupChatId(null);
			expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
		});
	});

	// ==========================================================================
	// Active chat state
	// ==========================================================================

	describe('active chat state', () => {
		it('sets messages with direct value', () => {
			const msgs = [
				createMockMessage({ content: 'Hello' }),
				createMockMessage({ content: 'World' }),
			];
			useGroupChatStore.getState().setGroupChatMessages(msgs);
			expect(useGroupChatStore.getState().groupChatMessages).toHaveLength(2);
		});

		it('appends messages with functional updater', () => {
			const msg1 = createMockMessage({ content: 'First' });
			useGroupChatStore.getState().setGroupChatMessages([msg1]);
			const msg2 = createMockMessage({ content: 'Second' });
			useGroupChatStore.getState().setGroupChatMessages((prev) => [...prev, msg2]);
			expect(useGroupChatStore.getState().groupChatMessages).toHaveLength(2);
			expect(useGroupChatStore.getState().groupChatMessages[1].content).toBe('Second');
		});

		it('sets group chat state', () => {
			useGroupChatStore.getState().setGroupChatState('moderator-thinking');
			expect(useGroupChatStore.getState().groupChatState).toBe('moderator-thinking');
		});

		it('sets group chat state with functional updater', () => {
			useGroupChatStore.getState().setGroupChatState('moderator-thinking');
			useGroupChatStore
				.getState()
				.setGroupChatState((prev) => (prev === 'moderator-thinking' ? 'agent-working' : prev));
			expect(useGroupChatStore.getState().groupChatState).toBe('agent-working');
		});

		it('sets participant states', () => {
			const states = new Map<string, 'idle' | 'working'>([
				['Alice', 'working'],
				['Bob', 'idle'],
			]);
			useGroupChatStore.getState().setParticipantStates(states);
			expect(useGroupChatStore.getState().participantStates.get('Alice')).toBe('working');
			expect(useGroupChatStore.getState().participantStates.get('Bob')).toBe('idle');
		});

		it('updates participant states with functional updater', () => {
			const initial = new Map<string, 'idle' | 'working'>([['Alice', 'idle']]);
			useGroupChatStore.getState().setParticipantStates(initial);
			useGroupChatStore.getState().setParticipantStates((prev) => {
				const next = new Map(prev);
				next.set('Alice', 'working');
				return next;
			});
			expect(useGroupChatStore.getState().participantStates.get('Alice')).toBe('working');
		});

		it('sets moderator usage', () => {
			const usage = { contextUsage: 50, totalCost: 0.12, tokenCount: 1000 };
			useGroupChatStore.getState().setModeratorUsage(usage);
			expect(useGroupChatStore.getState().moderatorUsage).toEqual(usage);
		});

		it('clears moderator usage', () => {
			useGroupChatStore
				.getState()
				.setModeratorUsage({ contextUsage: 50, totalCost: 0.12, tokenCount: 1000 });
			useGroupChatStore.getState().setModeratorUsage(null);
			expect(useGroupChatStore.getState().moderatorUsage).toBeNull();
		});
	});

	// ==========================================================================
	// All-chats tracking (Maps)
	// ==========================================================================

	describe('all-chats tracking', () => {
		it('sets per-chat group chat states', () => {
			const states = new Map<string, GroupChatState>([
				['gc-1', 'moderator-thinking'],
				['gc-2', 'idle'],
			]);
			useGroupChatStore.getState().setGroupChatStates(states);
			expect(useGroupChatStore.getState().groupChatStates.get('gc-1')).toBe('moderator-thinking');
			expect(useGroupChatStore.getState().groupChatStates.size).toBe(2);
		});

		it('updates per-chat group chat states with functional updater', () => {
			const initial = new Map<string, GroupChatState>([['gc-1', 'idle']]);
			useGroupChatStore.getState().setGroupChatStates(initial);
			useGroupChatStore.getState().setGroupChatStates((prev) => {
				const next = new Map(prev);
				next.set('gc-1', 'agent-working');
				return next;
			});
			expect(useGroupChatStore.getState().groupChatStates.get('gc-1')).toBe('agent-working');
		});

		it('sets all-chats participant states', () => {
			const innerMap = new Map<string, 'idle' | 'working'>([['Alice', 'working']]);
			const outerMap = new Map<string, Map<string, 'idle' | 'working'>>([['gc-1', innerMap]]);
			useGroupChatStore.getState().setAllGroupChatParticipantStates(outerMap);
			expect(
				useGroupChatStore.getState().allGroupChatParticipantStates.get('gc-1')?.get('Alice')
			).toBe('working');
		});

		it('updates all-chats participant states with functional updater', () => {
			const innerMap = new Map<string, 'idle' | 'working'>([['Alice', 'idle']]);
			const outerMap = new Map<string, Map<string, 'idle' | 'working'>>([['gc-1', innerMap]]);
			useGroupChatStore.getState().setAllGroupChatParticipantStates(outerMap);
			useGroupChatStore.getState().setAllGroupChatParticipantStates((prev) => {
				const next = new Map(prev);
				const gcStates = new Map(next.get('gc-1')!);
				gcStates.set('Alice', 'working');
				next.set('gc-1', gcStates);
				return next;
			});
			expect(
				useGroupChatStore.getState().allGroupChatParticipantStates.get('gc-1')?.get('Alice')
			).toBe('working');
		});

		it('creates new Map reference on functional update (triggers Zustand subscription)', () => {
			const initial = new Map<string, GroupChatState>([['gc-1', 'idle']]);
			useGroupChatStore.getState().setGroupChatStates(initial);
			const before = useGroupChatStore.getState().groupChatStates;
			useGroupChatStore.getState().setGroupChatStates((prev) => {
				const next = new Map(prev);
				next.set('gc-2', 'idle');
				return next;
			});
			const after = useGroupChatStore.getState().groupChatStates;
			expect(before).not.toBe(after); // Different reference
			expect(after.size).toBe(2);
		});
	});

	// ==========================================================================
	// Execution queue
	// ==========================================================================

	describe('execution queue', () => {
		it('sets execution queue', () => {
			const items = [
				createMockQueuedItem({ content: 'msg1' }),
				createMockQueuedItem({ content: 'msg2' }),
			];
			useGroupChatStore.getState().setGroupChatExecutionQueue(items);
			expect(useGroupChatStore.getState().groupChatExecutionQueue).toHaveLength(2);
		});

		it('dequeues with functional updater', () => {
			const items = [
				createMockQueuedItem({ content: 'first' }),
				createMockQueuedItem({ content: 'second' }),
			];
			useGroupChatStore.getState().setGroupChatExecutionQueue(items);
			useGroupChatStore.getState().setGroupChatExecutionQueue((prev) => prev.slice(1));
			expect(useGroupChatStore.getState().groupChatExecutionQueue).toHaveLength(1);
			expect(useGroupChatStore.getState().groupChatExecutionQueue[0].content).toBe('second');
		});

		it('sets read-only mode', () => {
			useGroupChatStore.getState().setGroupChatReadOnlyMode(true);
			expect(useGroupChatStore.getState().groupChatReadOnlyMode).toBe(true);
		});

		it('toggles read-only mode with functional updater', () => {
			useGroupChatStore.getState().setGroupChatReadOnlyMode(true);
			useGroupChatStore.getState().setGroupChatReadOnlyMode((prev) => !prev);
			expect(useGroupChatStore.getState().groupChatReadOnlyMode).toBe(false);
		});
	});

	// ==========================================================================
	// UI state
	// ==========================================================================

	describe('UI state', () => {
		it('sets right tab', () => {
			useGroupChatStore.getState().setGroupChatRightTab('history');
			expect(useGroupChatStore.getState().groupChatRightTab).toBe('history');
		});

		it('sets right tab with functional updater', () => {
			useGroupChatStore.getState().setGroupChatRightTab('history');
			useGroupChatStore
				.getState()
				.setGroupChatRightTab((prev) => (prev === 'history' ? 'participants' : 'history'));
			expect(useGroupChatStore.getState().groupChatRightTab).toBe('participants');
		});

		it('sets participant colors', () => {
			const colors = { Alice: '#ff0000', Bob: '#00ff00' };
			useGroupChatStore.getState().setGroupChatParticipantColors(colors);
			expect(useGroupChatStore.getState().groupChatParticipantColors).toEqual(colors);
		});

		it('merges participant colors with functional updater', () => {
			useGroupChatStore.getState().setGroupChatParticipantColors({ Alice: '#ff0000' });
			useGroupChatStore.getState().setGroupChatParticipantColors((prev) => ({
				...prev,
				Bob: '#00ff00',
			}));
			expect(useGroupChatStore.getState().groupChatParticipantColors).toEqual({
				Alice: '#ff0000',
				Bob: '#00ff00',
			});
		});

		it('sets staged images', () => {
			const images = ['base64img1', 'base64img2'];
			useGroupChatStore.getState().setGroupChatStagedImages(images);
			expect(useGroupChatStore.getState().groupChatStagedImages).toEqual(images);
		});

		it('appends staged images with functional updater', () => {
			useGroupChatStore.getState().setGroupChatStagedImages(['img1']);
			useGroupChatStore.getState().setGroupChatStagedImages((prev) => [...prev, 'img2']);
			expect(useGroupChatStore.getState().groupChatStagedImages).toEqual(['img1', 'img2']);
		});
	});

	// ==========================================================================
	// Error state
	// ==========================================================================

	describe('error state', () => {
		it('sets group chat error', () => {
			const error = createMockError({ participantName: 'Moderator' });
			useGroupChatStore.getState().setGroupChatError(error);
			expect(useGroupChatStore.getState().groupChatError).toEqual(error);
			expect(useGroupChatStore.getState().groupChatError?.participantName).toBe('Moderator');
		});

		it('sets group chat error with functional updater', () => {
			const error = createMockError();
			useGroupChatStore.getState().setGroupChatError(error);
			useGroupChatStore
				.getState()
				.setGroupChatError((prev) => (prev ? { ...prev, participantName: 'Alice' } : null));
			expect(useGroupChatStore.getState().groupChatError?.participantName).toBe('Alice');
		});

		it('clears error with clearGroupChatError', () => {
			useGroupChatStore.getState().setGroupChatError(createMockError());
			expect(useGroupChatStore.getState().groupChatError).not.toBeNull();
			useGroupChatStore.getState().clearGroupChatError();
			expect(useGroupChatStore.getState().groupChatError).toBeNull();
		});
	});

	// ==========================================================================
	// Convenience methods
	// ==========================================================================

	describe('convenience methods', () => {
		it('resetGroupChatState clears active chat fields', () => {
			// Set up some active state
			useGroupChatStore.getState().setActiveGroupChatId('gc-1');
			useGroupChatStore.getState().setGroupChatMessages([createMockMessage()]);
			useGroupChatStore.getState().setGroupChatState('moderator-thinking');
			useGroupChatStore.getState().setParticipantStates(new Map([['Alice', 'working']]));
			useGroupChatStore.getState().setGroupChatError(createMockError());

			// Also set some state that should NOT be cleared
			useGroupChatStore.getState().setGroupChats([createMockGroupChat()]);
			useGroupChatStore.getState().setGroupChatStagedImages(['img1']);
			useGroupChatStore.getState().setGroupChatRightTab('history');

			// Reset
			useGroupChatStore.getState().resetGroupChatState();

			// Active chat fields should be reset
			expect(useGroupChatStore.getState().activeGroupChatId).toBeNull();
			expect(useGroupChatStore.getState().groupChatMessages).toEqual([]);
			expect(useGroupChatStore.getState().groupChatState).toBe('idle');
			expect(useGroupChatStore.getState().participantStates).toEqual(new Map());
			expect(useGroupChatStore.getState().groupChatError).toBeNull();

			// Non-active fields should be preserved
			expect(useGroupChatStore.getState().groupChats).toHaveLength(1);
			expect(useGroupChatStore.getState().groupChatStagedImages).toEqual(['img1']);
			expect(useGroupChatStore.getState().groupChatRightTab).toBe('history');
		});

		it('clearGroupChatError only clears the error field', () => {
			useGroupChatStore.getState().setGroupChatState('moderator-thinking');
			useGroupChatStore.getState().setGroupChatError(createMockError());
			useGroupChatStore.getState().clearGroupChatError();

			expect(useGroupChatStore.getState().groupChatError).toBeNull();
			// Other state should be untouched
			expect(useGroupChatStore.getState().groupChatState).toBe('moderator-thinking');
		});
	});

	// ==========================================================================
	// Action stability
	// ==========================================================================

	describe('action stability', () => {
		it('returns stable action references across state changes', () => {
			const before = useGroupChatStore.getState();
			useGroupChatStore.getState().setGroupChats([createMockGroupChat()]);
			useGroupChatStore.getState().setGroupChatState('agent-working');
			const after = useGroupChatStore.getState();

			expect(after.setGroupChats).toBe(before.setGroupChats);
			expect(after.setActiveGroupChatId).toBe(before.setActiveGroupChatId);
			expect(after.setGroupChatMessages).toBe(before.setGroupChatMessages);
			expect(after.setGroupChatState).toBe(before.setGroupChatState);
			expect(after.setParticipantStates).toBe(before.setParticipantStates);
			expect(after.setGroupChatStates).toBe(before.setGroupChatStates);
			expect(after.clearGroupChatError).toBe(before.clearGroupChatError);
			expect(after.resetGroupChatState).toBe(before.resetGroupChatState);
		});
	});

	// ==========================================================================
	// Non-React access
	// ==========================================================================

	describe('non-React access', () => {
		it('getGroupChatState returns current state', () => {
			useGroupChatStore.getState().setActiveGroupChatId('gc-99');
			const state = getGroupChatState();
			expect(state.activeGroupChatId).toBe('gc-99');
		});

		it('getGroupChatActions returns all actions', () => {
			const actions = getGroupChatActions();
			expect(typeof actions.setGroupChats).toBe('function');
			expect(typeof actions.setActiveGroupChatId).toBe('function');
			expect(typeof actions.setGroupChatMessages).toBe('function');
			expect(typeof actions.setGroupChatState).toBe('function');
			expect(typeof actions.setParticipantStates).toBe('function');
			expect(typeof actions.setModeratorUsage).toBe('function');
			expect(typeof actions.setGroupChatStates).toBe('function');
			expect(typeof actions.setAllGroupChatParticipantStates).toBe('function');
			expect(typeof actions.setGroupChatExecutionQueue).toBe('function');
			expect(typeof actions.setGroupChatReadOnlyMode).toBe('function');
			expect(typeof actions.setGroupChatRightTab).toBe('function');
			expect(typeof actions.setGroupChatParticipantColors).toBe('function');
			expect(typeof actions.setGroupChatStagedImages).toBe('function');
			expect(typeof actions.setGroupChatError).toBe('function');
			expect(typeof actions.clearGroupChatError).toBe('function');
			expect(typeof actions.resetGroupChatState).toBe('function');
		});

		it('getGroupChatActions returns stable references', () => {
			const actions1 = getGroupChatActions();
			useGroupChatStore.getState().setGroupChatState('agent-working');
			const actions2 = getGroupChatActions();
			expect(actions1.setGroupChats).toBe(actions2.setGroupChats);
			expect(actions1.clearGroupChatError).toBe(actions2.clearGroupChatError);
		});

		it('actions from getGroupChatActions mutate state correctly', () => {
			const actions = getGroupChatActions();
			actions.setActiveGroupChatId('gc-from-actions');
			expect(useGroupChatStore.getState().activeGroupChatId).toBe('gc-from-actions');
		});
	});

	// ==========================================================================
	// Store reset
	// ==========================================================================

	describe('store reset', () => {
		it('resets all state via setState', () => {
			// Populate various state
			useGroupChatStore.getState().setGroupChats([createMockGroupChat()]);
			useGroupChatStore.getState().setActiveGroupChatId('gc-1');
			useGroupChatStore.getState().setGroupChatMessages([createMockMessage()]);
			useGroupChatStore.getState().setGroupChatState('agent-working');
			useGroupChatStore.getState().setGroupChatError(createMockError());
			useGroupChatStore.getState().setGroupChatRightTab('history');

			// Reset
			resetStore();

			// Verify all fields are at defaults
			const state = useGroupChatStore.getState();
			expect(state.groupChats).toEqual([]);
			expect(state.activeGroupChatId).toBeNull();
			expect(state.groupChatMessages).toEqual([]);
			expect(state.groupChatState).toBe('idle');
			expect(state.participantStates).toEqual(new Map());
			expect(state.moderatorUsage).toBeNull();
			expect(state.groupChatStates).toEqual(new Map());
			expect(state.allGroupChatParticipantStates).toEqual(new Map());
			expect(state.groupChatExecutionQueue).toEqual([]);
			expect(state.groupChatReadOnlyMode).toBe(false);
			expect(state.groupChatRightTab).toBe('participants');
			expect(state.groupChatParticipantColors).toEqual({});
			expect(state.groupChatStagedImages).toEqual([]);
			expect(state.groupChatError).toBeNull();
		});
	});
});
