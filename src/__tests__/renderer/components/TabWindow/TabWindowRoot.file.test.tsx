/**
 * File preview tabs in a tab window (Tab Windows, D5). The tab window renders
 * the file itself, from its own copy of the tab, and owns the tab's edits,
 * mode, scroll, and disk state while the tab is popped out. It writes them
 * back to the owner with the `setFileTabState` intent: after a pause, at once
 * after a save, and before a Dock.
 *
 * The real `TiledFilePane` and `useFilePreviewHandlers` run (the save is the
 * owner's own function); only the lazy `FilePreview` is a stand-in that
 * records its props, so a test drives it the way the preview does. The
 * end-to-end cases run both windows' real code in turn on one page: the
 * owner's patch stream seeds the tab window, and the owner's intent dispatcher
 * applies what the tab window sent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { TabWindowRoot } from '../../../../renderer/components/TabWindow/TabWindowRoot';
import { DRAFT_FLUSH_DELAY_MS } from '../../../../renderer/hooks/input/useInputSync';
import { dispatchTabWindowIntent } from '../../../../renderer/services/tabWindowIntents';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useComposerInputStore } from '../../../../renderer/stores/composerInputStore';
import { useTabWindowStore } from '../../../../renderer/stores/tabWindowStore';
import { FILE_TREE_REFRESH_EVENT } from '../../../../renderer/utils/fileTreeRefresh';
import type { FilePreviewTab, Session } from '../../../../renderer/types';
import type {
	TabWindowInfo,
	TabWindowIntent,
	TabWindowIntentOf,
	TabWindowTabRef,
} from '../../../../shared/tabWindowTypes';
import { createMockAITab, createMockFileTab } from '../../../helpers/mockTab';
import { createMockSession } from '../../../helpers/mockSession';
import {
	createOwnerPatchStream,
	createTabWindowOwnerHandlers,
	installTabWindowsApi,
	type OwnerPatchStream,
} from '../../../helpers/tabWindows';

interface PreviewProps {
	file: { name: string; content: string; path: string };
	markdownEditMode: boolean;
	setMarkdownEditMode: (editMode: boolean) => void;
	onSave: (path: string, content: string) => Promise<boolean>;
	externalEditContent?: string;
	onEditContentChange: (content: string) => void;
	initialScrollTop?: number;
	onScrollPositionChange: (scrollTop: number) => void;
	onSearchQueryChange: (query: string) => void;
}

// The real preview pulls the markdown and CodeMirror stack; this one records
// what the pane hands it.
const previews: PreviewProps[] = [];
vi.mock('../../../../renderer/components/FilePreview', () => ({
	FilePreview: (props: PreviewProps) => {
		previews.push(props);
		return <div data-testid="file-preview">{props.externalEditContent ?? props.file.content}</div>;
	},
}));

const AGENT = 'agent-1';
const NOTES: TabWindowTabRef = { type: 'file', id: 'notes' };
const HOME: TabWindowTabRef = { type: 'ai', id: 'home' };
const MTIME = Date.parse('2026-10-18T12:00:00.000Z');

const INFO: TabWindowInfo = {
	windowId: 'tw-7',
	agentId: AGENT,
	tabRefs: [NOTES],
	activeTabRef: NOTES,
};

/** The agent as its owner holds it: a home AI tab and the popped `notes` file tab. */
function ownerAgent(notes: Partial<FilePreviewTab> = {}): Session {
	return createMockSession({
		id: AGENT,
		name: 'Maestro Marketing',
		fullPath: '/repo',
		aiTabs: [createMockAITab({ id: 'home', name: 'Home Chat' })],
		activeTabId: 'home',
		filePreviewTabs: [
			createMockFileTab({
				id: 'notes',
				path: '/repo/notes.md',
				name: 'notes',
				extension: '.md',
				content: 'on disk',
				lastModified: 1,
				...notes,
			}),
		],
		unifiedTabOrder: [HOME, NOTES],
	});
}

let api: ReturnType<typeof installTabWindowsApi>;

const preview = () => previews[previews.length - 1];
const sentIntents = (): TabWindowIntent[] =>
	api.sendIntent.mock.calls.map(([intent]) => intent as TabWindowIntent);
const fileWrites = () =>
	sentIntents().filter(
		(intent): intent is TabWindowIntentOf<'setFileTabState'> => intent.kind === 'setFileTabState'
	);
const waitMs = (ms: number) =>
	act(() => {
		vi.advanceTimersByTime(ms);
	});

function resetStores(): void {
	useSessionStore.setState({ sessions: [], activeSessionId: '' });
	useComposerInputStore.setState(useComposerInputStore.getInitialState(), true);
	useTabWindowStore.setState({ windows: [], poppedByAgent: {} });
}

/** Mount the tab window and play the owner's snapshot of `session` into it. */
async function openTabWindow(
	session: Session
): Promise<{ view: ReturnType<typeof render>; owner: OwnerPatchStream }> {
	const view = render(<TabWindowRoot windowId="tw-7" />);
	await act(async () => {});
	const owner = createOwnerPatchStream(api.emitPatch, AGENT, INFO.tabRefs);
	act(() => owner.snapshot(session));
	// The pane's preview is lazy: let it resolve.
	await act(async () => {});
	return { view, owner };
}

/** The owner window: the page now holds the real agent and runs what the tab window sent. */
function runInOwner(view: ReturnType<typeof render>, session: Session): FilePreviewTab {
	view.unmount();
	resetStores();
	useSessionStore.setState({ sessions: [session], activeSessionId: AGENT });
	for (const intent of fileWrites()) {
		expect(dispatchTabWindowIntent(intent, createTabWindowOwnerHandlers())).toEqual({
			handled: true,
		});
	}
	return useSessionStore.getState().sessions[0].filePreviewTabs[0];
}

beforeEach(() => {
	vi.useFakeTimers();
	previews.length = 0;
	resetStores();
	api = installTabWindowsApi();
	api.getState.mockResolvedValue(INFO);
	vi.mocked(window.maestro.fs.stat).mockResolvedValue({
		size: 10,
		createdAt: '2026-10-18T00:00:00.000Z',
		modifiedAt: new Date(MTIME).toISOString(),
	} as never);
	vi.mocked(window.maestro.fs.writeFile).mockClear();
	vi.mocked(window.maestro.fs.readFile).mockClear();
});

afterEach(() => {
	api.restore();
	vi.useRealTimers();
});

describe('TabWindowRoot file preview tabs (D5)', () => {
	it('renders the file from the owner copy, unsaved edits, mode, and scroll included', async () => {
		await openTabWindow(ownerAgent({ editContent: 'unsaved', editMode: true, scrollTop: 300 }));

		expect(screen.getByTestId('file-preview')).toHaveTextContent('unsaved');
		expect(preview()).toMatchObject({
			file: { name: 'notes.md', content: 'on disk', path: '/repo/notes.md' },
			markdownEditMode: true,
			externalEditContent: 'unsaved',
			initialScrollTop: 300,
		});
		// The owner holds all of that already, so nothing goes back.
		waitMs(DRAFT_FLUSH_DELAY_MS * 2);
		expect(fileWrites()).toEqual([]);
	});

	it('writes what changed back to the owner after a pause, once, and only what changed', async () => {
		await openTabWindow(ownerAgent());
		act(() => preview().setMarkdownEditMode(true));
		act(() => preview().onEditContentChange('first'));
		act(() => preview().onEditContentChange('first, then more'));
		act(() => preview().onSearchQueryChange('needle'));
		waitMs(DRAFT_FLUSH_DELAY_MS - 1);
		expect(fileWrites()).toEqual([]);

		waitMs(1);
		expect(fileWrites()).toEqual([
			{
				kind: 'setFileTabState',
				agentId: AGENT,
				tabRef: NOTES,
				fields: { editContent: 'first, then more', editMode: true, searchQuery: 'needle' },
			},
		]);
	});

	it('keeps an edit made here when the owner patches the tab', async () => {
		const { owner } = await openTabWindow(ownerAgent());
		act(() => preview().onEditContentChange('typed here'));
		// The owner renames the tab, and its copy still holds the old edits.
		act(() => {
			owner.delta(ownerAgent({ customName: 'Release notes' }));
		});

		const tab = useSessionStore.getState().sessions[0].filePreviewTabs[0];
		expect(tab).toMatchObject({ customName: 'Release notes', editContent: 'typed here' });
		expect(screen.getByTestId('file-preview')).toHaveTextContent('typed here');
	});

	it('edit then dock: the edits reach the owner before the dock, and the owner shows them', async () => {
		const { view } = await openTabWindow(ownerAgent());
		act(() => preview().setMarkdownEditMode(true));
		act(() => preview().onEditContentChange('edited in the tab window'));
		act(() => preview().onScrollPositionChange(120));
		// Docked at once: the pause has not passed.
		await act(async () => {
			fireEvent.click(screen.getByTestId('tab-window-dock'));
		});

		expect(api.dock).toHaveBeenCalledWith(AGENT, NOTES);
		expect(fileWrites()).toHaveLength(1);
		const write = fileWrites()[0];
		expect(write.fields).toEqual({
			editContent: 'edited in the tab window',
			editMode: true,
			scrollTop: 120,
		});
		// Main relays this window's messages in order, so the owner has the
		// edits before it hears of the dock.
		const writeCall = api.sendIntent.mock.calls.findIndex(([intent]) => intent === write);
		expect(api.sendIntent.mock.invocationCallOrder[writeCall]).toBeLessThan(
			api.dock.mock.invocationCallOrder[0]
		);

		expect(runInOwner(view, ownerAgent())).toMatchObject({
			content: 'on disk',
			editContent: 'edited in the tab window',
			editMode: true,
			scrollTop: 120,
		});
	});

	it('a closed tab window docks first: its last edit still reaches the owner', async () => {
		const { view } = await openTabWindow(ownerAgent());
		act(() => preview().onEditContentChange('last words'));
		act(() => {
			window.dispatchEvent(new Event('pagehide'));
		});

		expect(runInOwner(view, ownerAgent())).toMatchObject({ editContent: 'last words' });
	});

	it('saves with the owner save function and writes the result back at once', async () => {
		const { view } = await openTabWindow(ownerAgent());
		act(() => preview().onEditContentChange('saved text'));
		// The owner has heard of the edit: the save must clear it there too.
		waitMs(DRAFT_FLUSH_DELAY_MS);
		let saved = false;
		await act(async () => {
			saved = await preview().onSave('/repo/notes.md', 'saved text');
		});

		expect(saved).toBe(true);
		expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
			'/repo/notes.md',
			'saved text',
			undefined
		);
		// No pause: a save is written back as it lands.
		expect(fileWrites()).toHaveLength(2);
		const write = fileWrites()[1];
		expect(write).toEqual({
			kind: 'setFileTabState',
			agentId: AGENT,
			tabRef: NOTES,
			fields: { content: 'saved text', editContent: undefined, lastModified: MTIME },
		});
		// A clean tab is a cleared field, not a missing one.
		expect(Object.keys(write.fields)).toContain('editContent');

		const refreshes: unknown[] = [];
		const onRefresh = (event: Event) => refreshes.push((event as CustomEvent).detail);
		window.addEventListener(FILE_TREE_REFRESH_EVENT, onRefresh);
		const tab = runInOwner(view, ownerAgent({ editContent: 'saved text' }));
		window.removeEventListener(FILE_TREE_REFRESH_EVENT, onRefresh);
		expect(tab).toMatchObject({ content: 'saved text', lastModified: MTIME });
		expect(tab.editContent).toBeUndefined();
		// Saved in place, as it would be in the owner: the Files panel already lists it.
		expect(refreshes).toEqual([]);
	});

	it('a save that moved the file refreshes the owner Files panel', async () => {
		const { view } = await openTabWindow(ownerAgent());
		// The file vanished on disk since it was opened: the save asks where to put it.
		vi.mocked(window.maestro.fs.stat).mockResolvedValueOnce(null as never);
		vi.mocked(window.maestro.dialog.saveFile).mockResolvedValueOnce('/repo/docs/moved.md');
		await act(async () => {
			await preview().onSave('/repo/notes.md', 'rescued');
		});

		expect(window.maestro.fs.writeFile).toHaveBeenCalledWith(
			'/repo/docs/moved.md',
			'rescued',
			undefined
		);
		expect(fileWrites()).toEqual([
			expect.objectContaining({
				fields: expect.objectContaining({
					path: '/repo/docs/moved.md',
					name: 'moved',
					content: 'rescued',
				}),
				refreshFileTree: true,
			}),
		]);

		const refreshes: unknown[] = [];
		const onRefresh = (event: Event) => refreshes.push((event as CustomEvent).detail);
		window.addEventListener(FILE_TREE_REFRESH_EVENT, onRefresh);
		const tab = runInOwner(view, ownerAgent());
		window.removeEventListener(FILE_TREE_REFRESH_EVENT, onRefresh);
		expect(tab).toMatchObject({ path: '/repo/docs/moved.md', name: 'moved' });
		expect(refreshes).toEqual([{ sessionId: AGENT }]);
	});

	it('reads a tab that popped out mid-load from disk itself', async () => {
		vi.mocked(window.maestro.fs.readFile).mockResolvedValueOnce('read in the tab window');
		await openTabWindow(ownerAgent({ content: '', isLoading: true, sshRemoteId: 'remote-1' }));
		await act(async () => {});

		expect(window.maestro.fs.readFile).toHaveBeenCalledWith('/repo/notes.md', 'remote-1');
		expect(useSessionStore.getState().sessions[0].filePreviewTabs[0]).toMatchObject({
			content: 'read in the tab window',
			isLoading: false,
		});
		waitMs(DRAFT_FLUSH_DELAY_MS);
		expect(fileWrites()).toEqual([
			expect.objectContaining({
				fields: { content: 'read in the tab window', lastModified: MTIME },
			}),
		]);
	});

	it('refuses a write for a tab the owner no longer holds', () => {
		useSessionStore.setState({ sessions: [ownerAgent()], activeSessionId: AGENT });
		expect(
			dispatchTabWindowIntent(
				{
					kind: 'setFileTabState',
					agentId: AGENT,
					tabRef: { type: 'file', id: 'gone' },
					fields: { editContent: 'x' },
				},
				createTabWindowOwnerHandlers()
			)
		).toEqual({ handled: false, reason: 'the tab is gone' });
	});

	it('takes only the file tab fields a tab window owns', () => {
		useSessionStore.setState({ sessions: [ownerAgent()], activeSessionId: AGENT });
		dispatchTabWindowIntent(
			{
				kind: 'setFileTabState',
				agentId: AGENT,
				tabRef: NOTES,
				fields: { editContent: 'ok', id: 'hijacked', customName: 'nope' } as never,
			},
			createTabWindowOwnerHandlers()
		);
		const tab = useSessionStore.getState().sessions[0].filePreviewTabs[0];
		expect(tab).toMatchObject({ id: 'notes', editContent: 'ok' });
		expect(tab.customName).toBeUndefined();
	});
});
