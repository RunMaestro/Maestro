/**
 * The composer draft of a popped-out AI tab (Tab Windows, D2). It lives in the
 * tab window while the tab is popped out, starts from the draft the owner had
 * for the tab, and goes back to the owner through the `setDraft` intent: after
 * a typing pause, and at every point where the tab window could stop holding
 * it (another tab shows, the window blurs, hides, or unloads, a send, a Dock).
 *
 * The end-to-end cases run both windows' real code in turn on one page: the
 * owner's publisher builds the snapshot the tab window seeds from, and the
 * owner's intent dispatcher applies what the tab window sent before a dock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { TabWindowRoot } from '../../../../renderer/components/TabWindow/TabWindowRoot';
import { DRAFT_FLUSH_DELAY_MS } from '../../../../renderer/hooks/input/useInputSync';
import { startTabWindowPublisher } from '../../../../renderer/services/tabWindowPublisher';
import { dispatchTabWindowIntent } from '../../../../renderer/services/tabWindowIntents';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../../renderer/stores/composerInputStore';
import { useTabWindowStore } from '../../../../renderer/stores/tabWindowStore';
import { clearLiveDraft } from '../../../../renderer/utils/liveDraftStore';
import type { AITab, Session } from '../../../../renderer/types';
import type {
	TabWindowInfo,
	TabWindowIntent,
	TabWindowSessionPatch,
	TabWindowTabRef,
} from '../../../../shared/tabWindowTypes';
import { createMockAITab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';
import {
	createOwnerPatchStream,
	createTabWindowOwnerHandlers,
	installTabWindowsApi,
	type OwnerPatchStream,
} from '../../../helpers/tabWindows';

// The transcript is the main panel's own view (TabWindowRoot.mirror.test.tsx
// renders it); only the composer matters here.
vi.mock('../../../../renderer/components/MainPanel/TiledLayout', () => ({
	TiledAiPane: ({ aiTabId }: { aiTabId: string }) => <div data-testid="ai-pane">{aiTabId}</div>,
	TiledFilePane: ({ fileTabId }: { fileTabId: string }) => (
		<div data-testid="file-pane">{fileTabId}</div>
	),
	PaneMissingTab: () => <div data-testid="pane-notice" />,
}));

const AGENT = 'agent-1';
const POPPED: TabWindowTabRef = { type: 'ai', id: 'popped' };
const SECOND: TabWindowTabRef = { type: 'ai', id: 'second' };
const HOME: TabWindowTabRef = { type: 'ai', id: 'home' };
const IMAGE_A = 'data:image/png;base64,AA';
const IMAGE_B = 'data:image/png;base64,BB';

/** This window holds two of the agent's tabs and shows the first; the owner keeps `home`. */
const INFO: TabWindowInfo = {
	windowId: 'tw-7',
	agentId: AGENT,
	tabRefs: [POPPED, SECOND],
	activeTabRef: POPPED,
};

/** The agent as its owner holds it, with `popped` overridden. */
function ownerAgent(popped: Partial<AITab> = {}): Session {
	return createMockSession({
		id: AGENT,
		name: 'Maestro Marketing',
		aiTabs: [
			createMockAITab({ id: 'popped', name: 'Popped Chat', ...popped }),
			createMockAITab({
				id: 'second',
				name: 'Second Chat',
				inputValue: 'A draft of the second tab',
			}),
			createMockAITab({ id: 'home', name: 'Home Chat' }),
		],
		activeTabId: 'home',
		unifiedTabOrder: [POPPED, SECOND, HOME],
	});
}

let api: ReturnType<typeof installTabWindowsApi>;

const composer = () => screen.getByTestId('tab-window-composer');
const draftBox = () => within(composer()).getByRole('textbox');
const typeDraft = (text: string) => fireEvent.change(draftBox(), { target: { value: text } });
const sentIntents = (): TabWindowIntent[] =>
	api.sendIntent.mock.calls.map(([intent]) => intent as TabWindowIntent);
const draftsSent = () => sentIntents().filter((intent) => intent.kind === 'setDraft');
const lastDraftSent = () => draftsSent()[draftsSent().length - 1];
const waitMs = (ms: number) =>
	act(() => {
		vi.advanceTimersByTime(ms);
	});

/** What a fresh page holds: no agent, an empty composer, no tab windows. */
function resetStores(): void {
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	useComposerInputStore.setState(useComposerInputStore.getInitialState(), true);
	useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
}

/** Mount the tab window and let it read its record. */
async function renderTabWindow() {
	const view = render(<TabWindowRoot windowId="tw-7" />);
	await act(async () => {});
	return view;
}

/** Mount the tab window and play the owner's snapshot of `session` into it. */
async function openTabWindow(
	session: Session
): Promise<{ view: ReturnType<typeof render>; owner: OwnerPatchStream }> {
	const view = await renderTabWindow();
	const owner = createOwnerPatchStream(api.emitPatch, AGENT, INFO.tabRefs);
	act(() => owner.snapshot(session));
	return { view, owner };
}

function setDocumentHidden(hidden: boolean): void {
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => (hidden ? 'hidden' : 'visible'),
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	resetStores();
	clearLiveDraft('popped');
	clearLiveDraft('second');
	api = installTabWindowsApi();
	api.getState.mockResolvedValue(INFO);
});

afterEach(() => {
	api.restore();
	Reflect.deleteProperty(document, 'visibilityState');
	vi.useRealTimers();
});

describe('TabWindowRoot composer draft (D2)', () => {
	it('starts from the draft the owner had for the tab: text, command mode, staged images', async () => {
		await openTabWindow(
			ownerAgent({ inputValue: 'git status', commandMode: 'shell', stagedImages: [IMAGE_A] })
		);
		expect(draftBox()).toHaveValue('git status');
		expect(within(composer()).getByTestId('command-mode-bar')).toBeInTheDocument();
		expect(within(composer()).getByLabelText('Staged image 1')).toBeInTheDocument();

		// The owner holds this draft already, so nothing goes back.
		waitMs(DRAFT_FLUSH_DELAY_MS * 2);
		expect(draftsSent()).toEqual([]);
	});

	it('writes what is typed here back to the owner after a typing pause, once', async () => {
		await openTabWindow(ownerAgent());
		typeDraft('Half');
		typeDraft('Half-written');
		waitMs(DRAFT_FLUSH_DELAY_MS - 1);
		typeDraft('Half-written reply');
		waitMs(DRAFT_FLUSH_DELAY_MS - 1);
		expect(draftsSent()).toEqual([]);

		waitMs(1);
		expect(draftsSent()).toEqual([
			{
				kind: 'setDraft',
				agentId: AGENT,
				tabRef: POPPED,
				inputValue: 'Half-written reply',
				commandMode: 'off',
				stagedImages: [],
			},
		]);
	});

	it('carries the command mode and the staged images with the text', async () => {
		await openTabWindow(ownerAgent({ stagedImages: [IMAGE_A, IMAGE_B] }));
		// A bang typed into the empty composer enters command mode and is consumed.
		typeDraft('!npm test');
		fireEvent.click(within(composer()).getByLabelText('Remove image 1'));
		waitMs(DRAFT_FLUSH_DELAY_MS);

		expect(draftsSent()).toHaveLength(1);
		expect(lastDraftSent()).toMatchObject({
			tabRef: POPPED,
			inputValue: 'npm test',
			commandMode: 'shell',
			stagedImages: [IMAGE_B],
		});
	});

	it('sends the draft of a tab at once when another tab shows, and keeps each tab its own', async () => {
		await openTabWindow(ownerAgent());
		typeDraft('Draft for the popped tab');
		await act(async () => {
			fireEvent.click(screen.getByText('Second Chat'));
		});
		expect(draftsSent()).toEqual([
			expect.objectContaining({ tabRef: POPPED, inputValue: 'Draft for the popped tab' }),
		]);
		expect(draftBox()).toHaveValue('A draft of the second tab');

		await act(async () => {
			fireEvent.click(screen.getByText('Popped Chat'));
		});
		expect(draftBox()).toHaveValue('Draft for the popped tab');
		// The second tab's draft did not change, so nothing went for it.
		expect(draftsSent()).toHaveLength(1);
	});

	it('sends what is still waiting when the window loses focus, hides, or unloads', async () => {
		await openTabWindow(ownerAgent());
		typeDraft('One');
		act(() => {
			window.dispatchEvent(new Event('blur'));
		});
		expect(lastDraftSent()).toMatchObject({ inputValue: 'One' });

		typeDraft('One, two');
		setDocumentHidden(true);
		act(() => {
			document.dispatchEvent(new Event('visibilitychange'));
		});
		expect(lastDraftSent()).toMatchObject({ inputValue: 'One, two' });

		typeDraft('One, two, three');
		act(() => {
			window.dispatchEvent(new Event('pagehide'));
		});
		expect(lastDraftSent()).toMatchObject({ inputValue: 'One, two, three' });
		expect(draftsSent()).toHaveLength(3);
	});

	it('hands the owner the cleared draft right after a send, so the tab never docks with sent text', async () => {
		await openTabWindow(ownerAgent());
		typeDraft('Ship it');
		waitMs(DRAFT_FLUSH_DELAY_MS);
		// Cmd+Enter sends under either Enter-to-send setting.
		fireEvent.keyDown(draftBox(), { key: 'Enter', metaKey: true });

		expect(
			sentIntents()
				.filter((intent) => intent.kind === 'send' || intent.kind === 'setDraft')
				.map((intent) => intent.kind)
		).toEqual(['setDraft', 'send', 'setDraft']);
		expect(lastDraftSent()).toMatchObject({ inputValue: '', stagedImages: [] });
	});

	it('keeps the draft typed here when the owner sends a new snapshot', async () => {
		const { owner } = await openTabWindow(ownerAgent({ inputValue: 'The seed' }));
		typeDraft('The seed, and what came after');
		// Another tab pops out: the owner sends the agent whole again, with its
		// own copy of this tab's draft.
		act(() => owner.snapshot(ownerAgent({ inputValue: 'The seed' }), [POPPED, SECOND, HOME]));

		expect(draftBox()).toHaveValue('The seed, and what came after');
		waitMs(DRAFT_FLUSH_DELAY_MS);
		expect(lastDraftSent()).toMatchObject({ inputValue: 'The seed, and what came after' });
	});
});

describe('the draft round trip between the owner and its tab window (D2)', () => {
	it('a draft typed in the owner before pop-out appears in the tab window, unsaved text included', async () => {
		// The owner window. The user typed in the tab's composer, and the typing
		// pause has not written the last of it back to the tab yet.
		useSessionStore.setState({
			sessions: [ownerAgent({ inputValue: 'Started in the main window', stagedImages: [IMAGE_A] })],
			activeSessionId: AGENT,
		});
		useComposerInputStore
			.getState()
			.loadAiDraft('popped', 'Started in the main window, finished just now', 'off');
		const publisher = startTabWindowPublisher();
		act(() => useTabWindowStore.getState().setWindows([{ ...INFO, tabRefs: [POPPED] }]));
		publisher.stop();
		const [seed] = api.sendSessionPatch.mock.calls.map(([patch]) => patch as TabWindowSessionPatch);
		expect(seed).toMatchObject({ form: 'snapshot', agentId: AGENT });

		// The tab window: a new page that receives the snapshot.
		resetStores();
		api.getState.mockResolvedValue({ ...INFO, tabRefs: [POPPED] });
		await renderTabWindow();
		act(() => api.emitPatch(seed));

		expect(draftBox()).toHaveValue('Started in the main window, finished just now');
		expect(within(composer()).getByLabelText('Staged image 1')).toBeInTheDocument();
	});

	it('a draft typed in the tab window survives a dock: it reaches the owner first', async () => {
		const { view } = await openTabWindow(ownerAgent({ stagedImages: [IMAGE_A, IMAGE_B] }));
		typeDraft('!npm test');
		fireEvent.click(within(composer()).getByLabelText('Remove image 1'));
		// Docked at once: the typing pause has not passed.
		await act(async () => {
			fireEvent.click(screen.getByTestId('tab-window-dock'));
		});

		expect(api.dock).toHaveBeenCalledWith(AGENT, POPPED);
		const draft = lastDraftSent();
		expect(draft).toMatchObject({
			tabRef: POPPED,
			inputValue: 'npm test',
			commandMode: 'shell',
			stagedImages: [IMAGE_B],
		});
		// Main relays this window's messages in order, so the owner has the draft
		// before it hears of the dock.
		const draftCall = api.sendIntent.mock.calls.findIndex(([intent]) => intent === draft);
		expect(api.sendIntent.mock.invocationCallOrder[draftCall]).toBeLessThan(
			api.dock.mock.invocationCallOrder[0]
		);

		// The owner window: the page now holds the real agent and runs what was sent.
		view.unmount();
		resetStores();
		useSessionStore.setState({
			sessions: [ownerAgent({ stagedImages: [IMAGE_A, IMAGE_B] })],
			activeSessionId: AGENT,
		});
		for (const intent of draftsSent()) {
			dispatchTabWindowIntent(intent, createTabWindowOwnerHandlers());
		}
		// What the owner's composer loads when the docked tab shows there.
		expect(useSessionStore.getState().sessions[0].aiTabs[0]).toMatchObject({
			id: 'popped',
			inputValue: 'npm test',
			commandMode: 'shell',
			stagedImages: [IMAGE_B],
		});
	});

	it('a closed tab window docks before its page can write: the late draft still reaches the owner composer', async () => {
		const { view } = await openTabWindow(ownerAgent({ inputValue: 'Last' }));
		typeDraft('Last words');
		// Main docked every tab on close; the page unloads after it.
		act(() => {
			window.dispatchEvent(new Event('pagehide'));
		});
		expect(lastDraftSent()).toMatchObject({ inputValue: 'Last words' });

		// The owner window has shown the docked tab already, with the copy it held.
		view.unmount();
		resetStores();
		useSessionStore.setState({
			sessions: [ownerAgent({ inputValue: 'Last' })],
			activeSessionId: AGENT,
		});
		useComposerInputStore.getState().loadAiDraft('popped', 'Last', 'off');
		for (const intent of draftsSent()) {
			dispatchTabWindowIntent(intent, createTabWindowOwnerHandlers());
		}
		expect(useComposerInputStore.getState()).toMatchObject({
			aiValueTabId: 'popped',
			aiValue: 'Last words',
		});
	});
});
