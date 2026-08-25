/**
 * Tests for outputSearch key helpers - AI tab keys and group-chat keys.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
	outputSearchKeyFor,
	groupChatOutputSearchKey,
	getActiveOutputSearchKey,
} from '../../../renderer/utils/outputSearch';
import { useGroupChatStore } from '../../../renderer/stores/groupChatStore';
import { useSessionStore } from '../../../renderer/stores/sessionStore';

describe('outputSearch keys', () => {
	beforeEach(() => {
		useGroupChatStore.setState({ activeGroupChatId: null });
		useSessionStore.setState({ sessions: [], activeSessionId: null });
	});

	it('builds a stable agent+tab key', () => {
		expect(outputSearchKeyFor('sess-1', 'tab-a')).toBe('sess-1::tab-a');
		expect(outputSearchKeyFor('sess-1', null)).toBe('sess-1::');
	});

	it('builds a group-chat key that cannot collide with agent+tab keys', () => {
		expect(groupChatOutputSearchKey('gc-1')).toBe('group-chat::gc-1');
		expect(groupChatOutputSearchKey('gc-1')).not.toBe(outputSearchKeyFor('gc-1', null));
	});

	it('prefers the active group chat over the active agent for getActiveOutputSearchKey', () => {
		useSessionStore.setState({
			sessions: [
				{
					id: 'sess-1',
					activeTabId: 'tab-a',
				} as any,
			],
			activeSessionId: 'sess-1',
		});
		useGroupChatStore.setState({ activeGroupChatId: 'gc-99' });

		expect(getActiveOutputSearchKey()).toBe('group-chat::gc-99');
	});

	it('falls back to the active agent+tab when no group chat is open', () => {
		useSessionStore.setState({
			sessions: [
				{
					id: 'sess-1',
					activeTabId: 'tab-a',
				} as any,
			],
			activeSessionId: 'sess-1',
		});

		expect(getActiveOutputSearchKey()).toBe('sess-1::tab-a');
	});
});
