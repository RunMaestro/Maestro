import { describe, expect, it } from 'vitest';

import {
	createGroupFromTabRefs,
	resolveModelEffortTabId,
} from '../../../renderer/utils/panelLayout';
import { createMockSession } from '../../helpers/mockSession';
import { createMockAITab } from '../../helpers/mockTab';

describe('resolveModelEffortTabId', () => {
	it('resolves the active AI tab', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1' }), createMockAITab({ id: 'tab-2' })],
			activeTabId: 'tab-2',
		});

		expect(resolveModelEffortTabId(session)).toBe('tab-2');
	});

	// A tiled group owns the panel, so the pane the user is looking at is the one
	// being retuned - not the standalone tab hidden behind the group.
	it('prefers the focused pane of a tiled group', () => {
		const base = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1' }), createMockAITab({ id: 'tab-2' })],
			activeTabId: 'tab-1',
		});
		const group = createGroupFromTabRefs(
			[
				{ type: 'ai', id: 'tab-2' },
				{ type: 'ai', id: 'tab-1' },
			],
			'Group'
		);
		const session = createMockSession({ ...base, tabGroups: [group], activeGroupId: group.id });

		expect(resolveModelEffortTabId(session)).toBe('tab-2');
	});

	// This is the whole point of the helper. A group chat does not clear
	// `activeSession` on the way in: it still points at whichever agent was
	// selected before the room opened, and that agent still has a perfectly valid
	// active AI tab. Resolving through the session alone therefore does not fail
	// safely - it succeeds against a background tab and silently retunes an agent
	// the user is not looking at.
	it('resolves nothing while a group chat owns the view', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1' })],
			activeTabId: 'tab-1',
		});

		expect(resolveModelEffortTabId(session)).toBe('tab-1');
		expect(resolveModelEffortTabId(session, 'chat-1')).toBeNull();
	});

	it('resolves nothing for a non-AI tab or a missing session', () => {
		const aiTabs = [createMockAITab({ id: 'tab-1' })];
		const fileSession = createMockSession({
			aiTabs,
			activeTabId: 'tab-1',
			activeFileTabId: 'file-1',
		});
		const terminalSession = createMockSession({
			aiTabs,
			activeTabId: 'tab-1',
			inputMode: 'terminal',
			activeTerminalTabId: 'term-1',
		});

		expect(resolveModelEffortTabId(fileSession)).toBeNull();
		expect(resolveModelEffortTabId(terminalSession)).toBeNull();
		expect(resolveModelEffortTabId(null)).toBeNull();
		expect(resolveModelEffortTabId(undefined)).toBeNull();
	});
});
