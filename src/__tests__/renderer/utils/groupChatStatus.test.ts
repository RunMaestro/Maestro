/**
 * Tests for the shared group chat "is this room running?" predicate.
 *
 * The interesting case is the split source of truth: the ACTIVE room reports
 * through `groupChatState`/`participantStates` while every other room reports
 * through the all-chats maps. Reading the wrong pair is the bug this module
 * exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import {
	describeGroupChatRunState,
	getBusyGroupChatIds,
	getGroupChatRunState,
	isGroupChatBusy,
	type GroupChatBusySnapshot,
} from '../../../renderer/utils/groupChatStatus';

const CHATS = [{ id: 'gc-1' }, { id: 'gc-2' }, { id: 'gc-3' }];

describe('groupChatStatus', () => {
	it('treats an idle snapshot as not busy', () => {
		expect(isGroupChatBusy('gc-1', {})).toBe(false);
		expect(getBusyGroupChatIds(CHATS, {})).toEqual([]);
	});

	it('reads the active room from the active-chat fields, not the maps', () => {
		const snapshot: GroupChatBusySnapshot = {
			activeGroupChatId: 'gc-1',
			groupChatState: 'moderator-thinking',
			// Stale map entry for the active room - the live fields must win.
			groupChatStates: new Map([['gc-1', 'idle']]),
		};
		expect(isGroupChatBusy('gc-1', snapshot)).toBe(true);
	});

	it('reads non-active rooms from the all-chats maps', () => {
		const snapshot: GroupChatBusySnapshot = {
			activeGroupChatId: 'gc-1',
			groupChatState: 'idle',
			groupChatStates: new Map([['gc-2', 'agent-working']]),
		};
		expect(isGroupChatBusy('gc-2', snapshot)).toBe(true);
		expect(isGroupChatBusy('gc-3', snapshot)).toBe(false);
	});

	it('counts a working participant even when the moderator is idle', () => {
		const snapshot: GroupChatBusySnapshot = {
			activeGroupChatId: 'gc-1',
			groupChatState: 'idle',
			participantStates: new Map([
				['Atlas', 'idle'],
				['Nova', 'working'],
			]),
			allGroupChatParticipantStates: new Map([['gc-2', new Map([['Orion', 'working'] as const])]]),
		};
		expect(getGroupChatRunState('gc-1', snapshot).workingParticipants).toEqual(['Nova']);
		expect(getBusyGroupChatIds(CHATS, snapshot)).toEqual(['gc-1', 'gc-2']);
	});

	it('ignores busy map entries for rooms the caller no longer knows about', () => {
		const snapshot: GroupChatBusySnapshot = {
			groupChatStates: new Map([['deleted-chat', 'agent-working']]),
		};
		expect(getBusyGroupChatIds(CHATS, snapshot)).toEqual([]);
	});

	it('describes what is running', () => {
		expect(
			describeGroupChatRunState({
				moderatorState: 'moderator-thinking',
				workingParticipants: [],
				isBusy: true,
			})
		).toBe('Moderator thinking');
		expect(
			describeGroupChatRunState({
				moderatorState: 'agent-working',
				workingParticipants: ['Atlas', 'Nova'],
				isBusy: true,
			})
		).toBe('Atlas, Nova working');
		expect(
			describeGroupChatRunState({
				moderatorState: 'agent-working',
				workingParticipants: ['Atlas', 'Nova', 'Orion'],
				isBusy: true,
			})
		).toBe('3 agents working');
		// Dispatched but the per-agent state has not landed yet.
		expect(
			describeGroupChatRunState({
				moderatorState: 'agent-working',
				workingParticipants: [],
				isBusy: true,
			})
		).toBe('Working');
	});
});
