import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../renderer/stores/notificationStore', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: vi.fn(() => 'toast-id'),
}));
import {
	insertIntoAgentComposer,
	quoteIntoAgentComposer,
	stageDesignPickOnAgent,
} from '../../../renderer/services/quoteIntoComposer';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../renderer/stores/composerInputStore';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { notifyToast } from '../../../renderer/stores/notificationStore';
import type { Session } from '../../../renderer/types';
import { createMockDesignPick } from '../../helpers';

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
	useSessionStore.setState({ sessions: [session], activeSessionId: 'agent-1' } as never);
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

	it('focuses the AI pane when a file pane in the split had focus', () => {
		seed({
			activeGroupId: 'g1',
			tabGroups: [
				{
					id: 'g1',
					focusedPaneId: 'l1',
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
		expect(session.tabGroups?.[0].focusedPaneId).toBe('l2');
		expect(session.activeTabId).toBe('tab-b');
		expect(useComposerInputStore.getState().aiValueTabId).toBe('tab-b');
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: 'tab-b' } });
	});
});

describe('insertIntoAgentComposer', () => {
	beforeEach(() => {
		useComposerInputStore.setState({ aiValue: '', aiValueTabId: null, aiCommandMode: 'off' });
		useUIStore.setState({ focusRequest: null } as never);
	});

	it('appends a block unquoted and lands in the composer', () => {
		seed();
		useComposerInputStore.setState({ aiValue: 'note', aiValueTabId: 'tab-a' });
		expect(insertIntoAgentComposer('agent-1', '## Review\n\nFix it.', { format: 'block' })).toBe(
			'tab-a'
		);
		expect(useComposerInputStore.getState().aiValue).toBe('note\n\n## Review\n\nFix it.\n\n');
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: 'tab-a' } });
	});

	it('in the background, writes the saved draft and moves nothing', () => {
		seed();
		// The live slot belongs to whatever the user is looking at.
		useComposerInputStore.setState({ aiValue: 'typing elsewhere', aiValueTabId: 'other-tab' });

		expect(
			insertIntoAgentComposer('agent-1', '## Review', { format: 'block', reveal: false })
		).toBe('tab-a');

		const session = useSessionStore.getState().sessions[0];
		expect(session.aiTabs.find((t) => t.id === 'tab-a')?.inputValue).toBe(
			'saved draft\n\n## Review\n\n'
		);
		expect(session.activeFileTabId).toBe('file-1');
		expect(useComposerInputStore.getState()).toMatchObject({
			aiValue: 'typing elsewhere',
			aiValueTabId: 'other-tab',
		});
		expect(useUIStore.getState().focusRequest).toBeNull();
	});
});

describe('stageDesignPickOnAgent', () => {
	const chip = (id: string) => createMockDesignPick({ id });

	function tab(id: string) {
		return useSessionStore.getState().sessions[0].aiTabs.find((t) => t.id === id);
	}

	beforeEach(() => {
		useComposerInputStore.setState({ aiValue: '', aiValueTabId: null, aiCommandMode: 'off' });
		useUIStore.setState({ focusRequest: null } as never);
		vi.mocked(notifyToast).mockClear();
	});

	it('stages the chip on the active AI tab, leaves the draft alone, and lands there', () => {
		seed();
		useComposerInputStore.setState({ aiValue: 'my question', aiValueTabId: 'tab-a' });

		expect(stageDesignPickOnAgent('agent-1', chip('p1'))).toBe('tab-a');

		expect(tab('tab-a')?.stagedDesignPicks).toEqual([chip('p1')]);
		expect(tab('tab-a')?.inputValue).toBe('saved draft');
		expect(useComposerInputStore.getState()).toMatchObject({
			aiValue: 'my question',
			aiValueTabId: 'tab-a',
		});
		const session = useSessionStore.getState().sessions[0];
		// The file tab no longer hides the chat.
		expect(session.activeFileTabId).toBeNull();
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: 'tab-a' } });
	});

	it('adds after the chips already staged, in order', () => {
		seed({
			aiTabs: [
				{ id: 'tab-a', inputValue: '', commandMode: 'off', stagedDesignPicks: [chip('p1')] },
			],
		} as unknown as Partial<Session>);

		stageDesignPickOnAgent('agent-1', chip('p2'), { reveal: false });

		expect(tab('tab-a')?.stagedDesignPicks?.map((c) => c.id)).toEqual(['p1', 'p2']);
	});

	it('leaves command mode on the target tab, never on the tab the live slot holds', () => {
		seed({
			aiTabs: [
				{ id: 'tab-a', inputValue: 'ls', commandMode: 'shell' },
				{ id: 'tab-b', inputValue: '', commandMode: 'off' },
			],
		} as unknown as Partial<Session>);
		// The user is typing a shell line on another tab.
		useComposerInputStore.setState({
			aiValue: 'git status',
			aiValueTabId: 'tab-b',
			aiCommandMode: 'shell',
		});

		stageDesignPickOnAgent('agent-1', chip('p1'), { reveal: false });

		expect(tab('tab-a')?.commandMode).toBe('off');
		expect(tab('tab-a')?.inputValue).toBe('ls');
		expect(useComposerInputStore.getState()).toMatchObject({
			aiValue: 'git status',
			aiValueTabId: 'tab-b',
			aiCommandMode: 'shell',
		});

		// When the live slot holds the target tab's draft, the live mode is the one to drop.
		useComposerInputStore.setState({
			aiValue: 'ls',
			aiValueTabId: 'tab-a',
			aiCommandMode: 'shell',
		});
		stageDesignPickOnAgent('agent-1', chip('p2'), { reveal: false });
		expect(useComposerInputStore.getState()).toMatchObject({ aiValue: 'ls', aiCommandMode: 'off' });
	});

	it('stages on the AI pane of the tiled group on screen and keeps the split', () => {
		seed({
			activeGroupId: 'g1',
			tabGroups: [
				{
					id: 'g1',
					focusedPaneId: 'l1',
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

		expect(stageDesignPickOnAgent('agent-1', chip('p1'))).toBe('tab-b');

		const session = useSessionStore.getState().sessions[0];
		expect(tab('tab-b')?.stagedDesignPicks).toEqual([chip('p1')]);
		expect(tab('tab-a')?.stagedDesignPicks).toBeUndefined();
		expect(session.activeGroupId).toBe('g1');
		expect(session.tabGroups?.[0].focusedPaneId).toBe('l2');
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: 'tab-b' } });
	});

	it('in the background, stages the chip and moves nothing', () => {
		seed();
		useComposerInputStore.setState({ aiValue: 'typing elsewhere', aiValueTabId: 'other-tab' });

		expect(stageDesignPickOnAgent('agent-1', chip('p1'), { reveal: false })).toBe('tab-a');

		const session = useSessionStore.getState().sessions[0];
		expect(tab('tab-a')?.stagedDesignPicks).toEqual([chip('p1')]);
		expect(session.activeFileTabId).toBe('file-1');
		expect(useComposerInputStore.getState()).toMatchObject({
			aiValue: 'typing elsewhere',
			aiValueTabId: 'other-tab',
		});
		expect(useUIStore.getState().focusRequest).toBeNull();
	});

	it('brings a background agent on screen when revealing', () => {
		seed();
		useSessionStore.setState({ activeSessionId: 'someone-else' } as never);

		expect(stageDesignPickOnAgent('agent-1', chip('p1'))).toBe('tab-a');

		expect(useSessionStore.getState().activeSessionId).toBe('agent-1');
		expect(tab('tab-a')?.stagedDesignPicks).toEqual([chip('p1')]);
		expect(useUIStore.getState().focusRequest).toEqual({ tab: { type: 'ai', id: 'tab-a' } });
	});

	it('says so, and stages nothing, when the agent has no AI tab', () => {
		seed({ aiTabs: [], activeTabId: undefined } as Partial<Session>);

		expect(stageDesignPickOnAgent('agent-1', chip('p1'))).toBeNull();
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('then pick again') })
		);

		expect(
			stageDesignPickOnAgent('gone', chip('p1'), { missingTabMessage: 'Pick the region again.' })
		).toBeNull();
		expect(notifyToast).toHaveBeenLastCalledWith(
			expect.objectContaining({ message: 'Pick the region again.' })
		);
		expect(useUIStore.getState().focusRequest).toBeNull();
	});
});
