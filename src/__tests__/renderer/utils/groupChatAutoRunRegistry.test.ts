import { describe, expect, it } from 'vitest';
import {
	consumeGroupChatAutoRun,
	getAutoRunSessionsForGroupChat,
	registerGroupChatAutoRun,
} from '../../../renderer/utils/groupChatAutoRunRegistry';

describe('groupChatAutoRunRegistry', () => {
	it('returns undefined for sessions that were not registered', () => {
		expect(consumeGroupChatAutoRun('missing-session')).toBeUndefined();
		expect(getAutoRunSessionsForGroupChat('missing-group')).toEqual([]);
	});

	it('registers and consumes group chat autorun context once', () => {
		registerGroupChatAutoRun('session-1', 'group-1', 'Planner');

		expect(consumeGroupChatAutoRun('session-1')).toEqual({
			groupChatId: 'group-1',
			participantName: 'Planner',
		});
		expect(consumeGroupChatAutoRun('session-1')).toBeUndefined();
	});

	it('overwrites context when the same session is registered again', () => {
		registerGroupChatAutoRun('session-overwrite', 'group-old', 'OldAgent');
		registerGroupChatAutoRun('session-overwrite', 'group-new', 'NewAgent');

		expect(consumeGroupChatAutoRun('session-overwrite')).toEqual({
			groupChatId: 'group-new',
			participantName: 'NewAgent',
		});
	});

	it('lists only in-flight sessions for the requested group chat', () => {
		registerGroupChatAutoRun('group-a-session-1', 'group-a', 'Planner');
		registerGroupChatAutoRun('group-b-session-1', 'group-b', 'Builder');
		registerGroupChatAutoRun('group-a-session-2', 'group-a', 'Reviewer');

		expect(getAutoRunSessionsForGroupChat('group-a')).toEqual([
			'group-a-session-1',
			'group-a-session-2',
		]);
		expect(getAutoRunSessionsForGroupChat('group-b')).toEqual(['group-b-session-1']);

		consumeGroupChatAutoRun('group-a-session-1');
		consumeGroupChatAutoRun('group-a-session-2');
		consumeGroupChatAutoRun('group-b-session-1');
	});

	it('removes consumed sessions from the in-flight group chat list', () => {
		registerGroupChatAutoRun('session-remove-1', 'group-remove', 'Planner');
		registerGroupChatAutoRun('session-remove-2', 'group-remove', 'Builder');

		expect(consumeGroupChatAutoRun('session-remove-1')).toEqual({
			groupChatId: 'group-remove',
			participantName: 'Planner',
		});

		expect(getAutoRunSessionsForGroupChat('group-remove')).toEqual(['session-remove-2']);

		consumeGroupChatAutoRun('session-remove-2');
	});
});
