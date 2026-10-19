/**
 * TabWindowRoot fed by a real patch stream (Tab Windows, D2). The owner's
 * snapshot and deltas are built by the real patch functions and cloned the way
 * IPC clones them, and the tab window renders them with the main panel's own
 * AI tab views: the transcript (`TerminalOutput`), the queued items inside it,
 * and the composer's thinking pill. Only the markdown stack is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('react-markdown', () => ({
	default: ({ children }: { children: string }) => (
		<div data-testid="react-markdown">{children}</div>
	),
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));
vi.mock('react-syntax-highlighter', () => ({
	Prism: ({ children }: { children: string }) => <pre>{children}</pre>,
}));
vi.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({ oneDark: {}, vscDarkPlus: {} }));
vi.mock('dompurify', () => ({ default: { sanitize: (html: string) => html } }));

import { TabWindowRoot } from '../../../../renderer/components/TabWindow/TabWindowRoot';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { AITab, LogEntry, QueuedItem, Session } from '../../../../renderer/types';
import type { TabWindowInfo, TabWindowTabRef } from '../../../../shared/tabWindowTypes';
import { createMockAITab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';
import {
	createOwnerPatchStream,
	installTabWindowsApi,
	type OwnerPatchStream,
} from '../../../helpers/tabWindows';

const AGENT = 'agent-1';
const POPPED: TabWindowTabRef = { type: 'ai', id: 'popped' };
const HOME: TabWindowTabRef = { type: 'ai', id: 'home' };

/** This window holds the popped tab and shows it; the owner keeps `home`. */
const INFO: TabWindowInfo = {
	windowId: 'tw-7',
	agentId: AGENT,
	tabRefs: [POPPED],
	activeTabRef: POPPED,
};

let nextLogId = 0;
function entry(text: string, overrides: Partial<LogEntry> = {}): LogEntry {
	nextLogId += 1;
	return { id: `log-${nextLogId}`, timestamp: nextLogId, source: 'stdout', text, ...overrides };
}

function ownerAgent(): Session {
	return createMockSession({
		id: AGENT,
		name: 'Maestro Marketing',
		aiTabs: [
			createMockAITab({
				id: 'popped',
				name: 'Popped Chat',
				logs: [entry('What is the answer?', { source: 'user' }), entry('Let me think.')],
			}),
			createMockAITab({
				id: 'home',
				name: 'Home Chat',
				logs: [entry('An owner-only conversation', { source: 'user' })],
			}),
		],
		activeTabId: 'home',
		unifiedTabOrder: [POPPED, HOME],
	});
}

function withTab(session: Session, tabId: string, fn: (tab: AITab) => AITab): Session {
	return { ...session, aiTabs: session.aiTabs.map((tab) => (tab.id === tabId ? fn(tab) : tab)) };
}

/** The agent working on one tab, as the owner's process listeners leave it. */
function busyOn(session: Session, tabId: string, at: number): Session {
	return {
		...withTab(session, tabId, (tab) => ({ ...tab, state: 'busy', thinkingStartTime: at })),
		state: 'busy',
		busySource: 'ai',
		thinkingStartTime: at,
	};
}

/** The turn over: the agent and every tab idle again. */
function idle(session: Session): Session {
	return {
		...session,
		state: 'idle',
		busySource: undefined,
		thinkingStartTime: undefined,
		aiTabs: session.aiTabs.map((tab) => ({ ...tab, state: 'idle', thinkingStartTime: undefined })),
	};
}

function queued(id: string, tabId: string, text: string): QueuedItem {
	return { id, timestamp: 1, tabId, type: 'message', text };
}

let api: ReturnType<typeof installTabWindowsApi>;
let owner: OwnerPatchStream;

/** Mount the tab window and let it read its record (it then asks for a snapshot). */
async function renderTabWindow() {
	render(<TabWindowRoot windowId="tw-7" />);
	await act(async () => {});
}

/** Deliver patches the way the relay does: outside React, then let it render. */
function deliver(send: () => void): void {
	act(() => send());
}

const root = () => screen.getByTestId('tab-window-root');
/**
 * The composer, while its thinking pill shows (the pill always carries its
 * elapsed timer; "Thinking..." gives way to the token count), else null.
 */
const pill = () => {
	const composer = screen.queryByTestId('tab-window-composer');
	const timer = composer ? within(composer).queryByText('Elapsed:') : null;
	return timer ? composer : null;
};

beforeEach(() => {
	nextLogId = 0;
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	api = installTabWindowsApi();
	api.getState.mockResolvedValue(INFO);
	owner = createOwnerPatchStream(api.emitPatch, AGENT, [POPPED]);
});

afterEach(() => {
	api.restore();
});

describe('TabWindowRoot fed by the owner patch stream (D2, TW-7)', () => {
	it('renders the snapshot transcript, then every delta after it', async () => {
		await renderTabWindow();
		let session = ownerAgent();
		deliver(() => owner.snapshot(session));

		expect(root()).toHaveTextContent('What is the answer?');
		expect(root()).toHaveTextContent('Let me think.');
		// The owner's own tab arrives without its transcript.
		expect(root()).not.toHaveTextContent('An owner-only conversation');

		session = withTab(session, 'popped', (tab) => ({
			...tab,
			logs: [...tab.logs, entry('And the follow-up?', { source: 'user' }), entry('The answer')],
		}));
		deliver(() => owner.delta(session));
		// A streamed chunk rewrites the last entry.
		session = withTab(session, 'popped', (tab) => {
			const last = tab.logs[tab.logs.length - 1];
			return { ...tab, logs: [...tab.logs.slice(0, -1), { ...last, text: `${last.text} is 42` }] };
		});
		deliver(() => owner.delta(session));

		expect(root()).toHaveTextContent('And the follow-up?');
		expect(root()).toHaveTextContent('The answer is 42');
		expect(root()).toHaveTextContent('What is the answer?');
	});

	it('shows the thinking pill while a popped tab works, and drops it when the turn ends', async () => {
		await renderTabWindow();
		let session = ownerAgent();
		deliver(() => owner.snapshot(session));
		expect(pill()).toBeNull();

		session = busyOn(session, 'popped', Date.now());
		deliver(() => owner.delta(session));

		const shown = within(pill()!);
		expect(shown.getByText('Maestro Marketing')).toBeInTheDocument();
		expect(shown.getByText('Popped Chat')).toBeInTheDocument();
		expect(shown.getByText('Thinking...')).toBeInTheDocument();

		session = { ...session, currentCycleTokens: 1500 };
		deliver(() => owner.delta(session));
		expect(within(pill()!).getByText('Tokens:')).toBeInTheDocument();

		session = idle(session);
		deliver(() => owner.delta(session));
		expect(pill()).toBeNull();
	});

	it('never shows a tab this window does not hold as thinking: its copy is frozen', async () => {
		await renderTabWindow();
		// The owner's own tab is busy at snapshot time, and finishes later.
		let session = busyOn(ownerAgent(), 'home', Date.now());
		deliver(() => owner.snapshot(session));
		expect(pill()).toBeNull();

		session = idle(session);
		deliver(() => owner.delta(session));
		expect(pill()).toBeNull();
	});

	it("renders the shown tab's queued items as the owner queues and drains them", async () => {
		await renderTabWindow();
		let session = ownerAgent();
		deliver(() => owner.snapshot(session));

		session = {
			...busyOn(session, 'popped', Date.now()),
			executionQueue: [
				queued('q1', 'popped', 'Queued for the popped tab'),
				queued('q2', 'home', 'Queued for the home tab'),
			],
		};
		deliver(() => owner.delta(session));

		expect(root()).toHaveTextContent('Queued for the popped tab');
		// Filtered to the shown tab, exactly as in the owner.
		expect(root()).not.toHaveTextContent('Queued for the home tab');

		// The owner dispatches it: it leaves the queue and becomes the next turn.
		session = withTab(
			{ ...session, executionQueue: [session.executionQueue[1]] },
			'popped',
			(tab) => ({
				...tab,
				logs: [...tab.logs, entry('Queued for the popped tab', { source: 'user' })],
			})
		);
		deliver(() => owner.delta(session));
		expect(screen.getAllByText('Queued for the popped tab')).toHaveLength(1);
		expect(root()).not.toHaveTextContent('Queued for the home tab');
	});

	it("removes a queued item through the owner's intent, after the queue's own confirm (phase 5)", async () => {
		await renderTabWindow();
		let session = ownerAgent();
		deliver(() => owner.snapshot(session));
		session = {
			...busyOn(session, 'popped', Date.now()),
			executionQueue: [queued('q1', 'popped', 'Queued for the popped tab')],
		};
		deliver(() => owner.delta(session));
		api.sendIntent.mockClear();

		fireEvent.click(screen.getByTitle('Remove from queue'));
		expect(api.sendIntent).not.toHaveBeenCalled();
		fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));

		expect(api.sendIntent).toHaveBeenCalledWith({
			kind: 'removeQueuedItem',
			agentId: AGENT,
			tabRef: POPPED,
			itemId: 'q1',
		});
	});

	it('recovers when it missed the attach snapshot: deltas wait for the one it asks for', async () => {
		let session = ownerAgent();
		// Sent while the page was still loading: nothing listened.
		owner.snapshot(session);
		await renderTabWindow();
		expect(api.sendIntent).toHaveBeenCalledWith({
			kind: 'requestSnapshot',
			agentId: AGENT,
			tabRef: POPPED,
		});

		session = withTab(session, 'popped', (tab) => ({
			...tab,
			logs: [...tab.logs, entry('Streamed before the answer')],
		}));
		deliver(() => owner.delta(session));
		expect(screen.queryByText('What is the answer?')).not.toBeInTheDocument();

		// The publisher answers the request.
		deliver(() => owner.snapshot(session));
		expect(root()).toHaveTextContent('What is the answer?');
		expect(root()).toHaveTextContent('Streamed before the answer');
		expect(screen.getByTestId('tab-window-agent-name')).toHaveTextContent('Maestro Marketing');
	});
});
