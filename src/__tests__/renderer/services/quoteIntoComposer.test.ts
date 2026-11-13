import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(() => 'toast-id'),
}));
import { quoteIntoAgentComposer } from '../../../renderer/services/quoteIntoComposer';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import type { Session } from '../../../renderer/types';

function seed(overrides: Partial<Session> = {}): void {
	const session = {
		id: 'agent-1',
		activeTabId: 'tab-a',
		activeFileTabId: 'file-1',
		inputMode: 'ai',
		aiTabs: [
			{ id: 'tab-a', inputValue: 'saved draft', commandMode: 'off' },
			{ id: 'tab-b', inputValue: '', commandMode: 'off' },
		],
		...overrides,
	} as unknown as Session;
	useSessionStore.setState({ sessions: [session] } as never);
}

describe('quoteIntoAgentComposer', () => {
	beforeEach(() => {
		useComposerInputStore.setState({ aiValue: '', aiValueTabId: null, aiCommandMode: 'off' });
		useUIStore.setState({ focusRequest: null } as never);
		vi.mocked(notifyToast).mockClear();
	});

	it("appends to the live draft of the agent's active AI tab and lands there", () => {
		seed();
		useComposerInputStore.setState({ aiValue: 'my question', aiValueTabId: 'tab-a' });

		expect(quoteIntoAgentComposer('agent-1', 'some code')).toBe(true);

		const composer = useComposerInputStore.getState();
		expect(composer.aiValue).toBe('my question\n\n> some code\n\n');
		expect(composer.aiValueTabId).toBe('tab-a');
		const session = useSessionStore.getState().sessions[0];
		// The file tab no longer hides the chat.
		expect(session.activeFileTabId).toBeNull();
		expect(session.inputMode).toBe('ai');
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: 'tab-a' } });
	});

	it('drops shell command mode: a quote is prose for the agent', () => {
		seed();
		useComposerInputStore.setState({
			aiValue: 'ls',
			aiValueTabId: 'tab-a',
			aiCommandMode: 'shell',
		});

		quoteIntoAgentComposer('agent-1', 'x');

		expect(useComposerInputStore.getState().aiCommandMode).toBe('off');
	});

	it("never files the quote on another tab's live draft", () => {
		seed();
		useComposerInputStore.setState({ aiValue: 'tab b text', aiValueTabId: 'tab-b' });

		quoteIntoAgentComposer('agent-1', 'q');

		const composer = useComposerInputStore.getState();
		expect(composer.aiValueTabId).toBe('tab-a');
		expect(composer.aiValue).toBe('saved draft\n\n> q\n\n');
		const tabA = useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === 'tab-a');
		expect(tabA?.inputValue).toBe('saved draft\n\n> q\n\n');
	});

	it('says so, and changes nothing, when the agent has no AI tab', () => {
		seed({ aiTabs: [], activeTabId: undefined } as Partial<Session>);

		expect(quoteIntoAgentComposer('agent-1', 'q')).toBe(false);
		expect(notifyToast).toHaveBeenCalledTimes(1);
		expect(useComposerInputStore.getState().aiValue).toBe('');
	});
});

describe('quoteIntoAgentComposer - tiled groups', () => {
	beforeEach(() => {
		useComposerInputStore.setState({ aiValue: '', aiValueTabId: null, aiCommandMode: 'off' });
	});

	it('quotes into the AI pane beside the file and keeps the split', () => {
		seed({
			activeGroupId: 'g1',
			tabGroups: [
				{
					id: 'g1',
					layout: {
						kind: 'split',
						id: 'root',
						children: [
							{ kind: 'leaf', id: 'l1', tab: { type: 'file', id: 'file-1' } },
							{ kind: 'leaf', id: 'l2', tab: { type: 'ai', id: 'tab-b' } },
						],
					},
				},
			],
		} as unknown as Partial<Session>);

		expect(quoteIntoAgentComposer('agent-1', 'q')).toBe(true);

		const session = useSessionStore.getState().sessions[0];
		expect(session.activeGroupId).toBe('g1');
		expect(session.activeTabId).toBe('tab-b');
		expect(useComposerInputStore.getState().aiValueTabId).toBe('tab-b');
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: 'tab-b' } });
	});
});
