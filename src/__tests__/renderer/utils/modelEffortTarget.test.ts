import { describe, expect, it } from 'vitest';

import {
	createGroupFromTabRefs,
	resolveFocusedAiTabId,
	resolveModelEffortTabId,
} from '../../../renderer/utils/panelLayout';
import { createMockFileTab } from '../../helpers/mockTab';
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

describe('resolveFocusedAiTabId', () => {
	it('resolves the active AI tab', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1' }), createMockAITab({ id: 'tab-2' })],
			activeTabId: 'tab-2',
		});

		expect(resolveFocusedAiTabId(session)).toBe('tab-2');
	});

	// The one place it differs from the model/effort target: looking at a file
	// does not stop the conversation behind it from being the one you talk to.
	it('keeps the conversation behind a file tab in a single view', () => {
		const session = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1' })],
			activeTabId: 'tab-1',
			filePreviewTabs: [createMockFileTab({ id: 'file-1' })],
			activeFileTabId: 'file-1',
		});

		expect(resolveModelEffortTabId(session)).toBeNull();
		expect(resolveFocusedAiTabId(session)).toBe('tab-1');
	});

	it('takes the focused AI pane of a tiled group over the tab behind it', () => {
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

		expect(resolveFocusedAiTabId(session)).toBe('tab-2');
	});

	// Inside a group there is no "behind": the pane in front is what is on screen.
	it('addresses no conversation when a tiled group is focused on a file pane', () => {
		const base = createMockSession({
			aiTabs: [createMockAITab({ id: 'tab-1' })],
			activeTabId: 'tab-1',
			filePreviewTabs: [createMockFileTab({ id: 'file-1' })],
		});
		const group = createGroupFromTabRefs(
			[
				{ type: 'file', id: 'file-1' },
				{ type: 'ai', id: 'tab-1' },
			],
			'Group'
		);
		const session = createMockSession({ ...base, tabGroups: [group], activeGroupId: group.id });

		expect(resolveFocusedAiTabId(session)).toBeNull();
	});

	it('is null without an agent, or for an agent with no AI tab', () => {
		expect(resolveFocusedAiTabId(null)).toBeNull();
		expect(resolveFocusedAiTabId(createMockSession({ aiTabs: [], activeTabId: '' }))).toBeNull();
	});
});
