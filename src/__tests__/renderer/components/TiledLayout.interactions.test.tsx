// Source: src/__tests__/renderer/components/TiledFilePane.test.tsx
// Source: src/__tests__/renderer/components/TiledSplitDivider.test.tsx
// Source: src/__tests__/renderer/components/PaneDropZones.test.tsx
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { beforeEach } from 'vitest';
import { vi } from 'vitest';
import { afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { TiledLayout } from '../../../renderer/components/MainPanel/TiledLayout';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { TabGroup } from '../../../renderer/types';
import type { Theme } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';
import { act } from 'react';
import { fireEvent } from '@testing-library/react';
import { act as source0_act } from '@testing-library/react';
import { PaneDropZones } from '../../../renderer/components/MainPanel/PaneDropZones';
import { TAB_TILE_MIME } from '../../../renderer/utils/tabDragPayload';
import type { TabTilePayload } from '../../../renderer/utils/tabDragPayload';
import { tileTabIntoGroup } from '../../../renderer/utils/panelLayout';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import type { PanelLayoutNode } from '../../../renderer/types';
import type { UnifiedTabRef } from '../../../renderer/types';
vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

const previewProps: Record<string, unknown>[] = [];
vi.mock('../../../renderer/components/FilePreview', () => ({
	FilePreview: (props: { file: { name: string } } & Record<string, unknown>) => {
		previewProps.push(props);
		return <div data-testid="preview-file-name">{props.file.name}</div>;
	},
}));
describe('TiledFilePane', () => {
	const theme = {
		colors: { accent: '#89b4fa', bgMain: '#1e1e2e', border: '#313244', textDim: '#6c7086' },
	} as unknown as Theme;

	function makeGroup(): TabGroup {
		return {
			id: 'g1',
			name: 'Group',
			layout: { kind: 'leaf', id: 'leaf-1', tab: { type: 'file', id: 'f1' } },
			focusedPaneId: 'leaf-1',
			createdAt: 0,
		};
	}

	/** One tiled file tab, `f1`, with scroll/search state and a two-entry visit history. */
	function makeSession(tabOverrides: Record<string, unknown> = {}) {
		return createMockSession({
			id: 's1',
			fullPath: '/repo',
			filePreviewTabs: [
				{
					id: 'f1',
					name: 'README',
					extension: '.md',
					path: '/repo/README.md',
					content: '# Title',
					...tabOverrides,
				},
			] as never,
			activeFileTabId: 'f1',
		});
	}

	describe('tiled file pane', () => {
		beforeEach(() => {
			previewProps.length = 0;
			useSessionStore.getState().setSessions([]);
		});

		it('previews the file under its full name so markdown renders formatted, not as source', async () => {
			const session = makeSession();
			useSessionStore.getState().setSessions([session]);

			render(<TiledLayout group={makeGroup()} session={session} theme={theme} />);

			// Without the extension the pane would preview a file called "README", which
			// getLanguageFromFilename cannot recognize as markdown - the bug that left
			// tiled markdown stuck in the unformatted source view.
			await waitFor(() => {
				expect(screen.getByTestId('preview-file-name').textContent).toBe('README.md');
			});
		});

		it('wires file links, scroll memory, and find memory the single view has', async () => {
			const fileTree = [{ name: 'README.md', path: '/repo/README.md', type: 'file' }] as never;
			const onFileClick = vi.fn();
			const onFileTabScrollPositionChange = vi.fn();
			const onFileTabSearchQueryChange = vi.fn();
			const session = makeSession({ scrollTop: 240, searchQuery: 'needle' });
			useSessionStore.getState().setSessions([session]);

			render(
				<TiledLayout
					group={makeGroup()}
					session={session}
					theme={theme}
					paneFileActions={{
						fileTree,
						onFileClick,
						onFileTabScrollPositionChange,
						onFileTabSearchQueryChange,
					}}
				/>
			);

			await waitFor(() => expect(previewProps.length).toBeGreaterThan(0));
			const props = previewProps[previewProps.length - 1];
			// Without a tree + cwd a wiki link inside a tiled preview resolved to nothing.
			expect(props.fileTree).toBe(fileTree);
			expect(props.onFileClick).toBe(onFileClick);
			expect(props.initialScrollTop).toBe(240);
			expect(props.initialSearchQuery).toBe('needle');

			// Both persist against THIS pane's tab id, not the active file tab.
			(props.onScrollPositionChange as (v: number) => void)(99);
			(props.onSearchQueryChange as (v: string) => void)('other');
			expect(onFileTabScrollPositionChange).toHaveBeenCalledWith('f1', 99);
			expect(onFileTabSearchQueryChange).toHaveBeenCalledWith('f1', 'other');
		});

		it('drives breadcrumb navigation against its own tab id', async () => {
			const onFileTabNavigateToIndex = vi.fn();
			const session = makeSession({
				navigationHistory: [
					{ name: 'A', path: '/repo/a.md' },
					{ name: 'B', path: '/repo/b.md' },
					{ name: 'C', path: '/repo/c.md' },
				],
				navigationIndex: 1,
			});
			useSessionStore.getState().setSessions([session]);

			render(
				<TiledLayout
					group={makeGroup()}
					session={session}
					theme={theme}
					paneFileActions={{ onFileTabNavigateToIndex }}
				/>
			);

			await waitFor(() => expect(previewProps.length).toBeGreaterThan(0));
			const props = previewProps[previewProps.length - 1];
			expect(props.canGoBack).toBe(true);
			expect(props.canGoForward).toBe(true);
			expect(props.currentHistoryIndex).toBe(1);

			// Focusing a file pane does NOT set activeFileTabId, so an unaddressed
			// navigate would move whichever other file tab happened to be active.
			(props.onNavigateBack as () => void)();
			expect(onFileTabNavigateToIndex).toHaveBeenCalledWith(0, 'f1');
			(props.onNavigateForward as () => void)();
			expect(onFileTabNavigateToIndex).toHaveBeenCalledWith(2, 'f1');
		});

		it('shows floating controls only on the focused file pane', async () => {
			const session = makeSession();
			useSessionStore.getState().setSessions([session]);

			const { rerender } = render(
				<TiledLayout group={makeGroup()} session={session} theme={theme} />
			);
			await waitFor(() => expect(previewProps.length).toBeGreaterThan(0));
			expect(previewProps[previewProps.length - 1].showFloatingControls).toBe(true);

			// Focus moves to another pane: this document's font zoom and ToC buttons hide.
			rerender(
				<TiledLayout
					group={{ ...makeGroup(), focusedPaneId: 'leaf-other' }}
					session={session}
					theme={theme}
				/>
			);
			await waitFor(() =>
				expect(previewProps[previewProps.length - 1].showFloatingControls).toBe(false)
			);
		});
	});
});
describe('TiledSplitDivider', () => {
	const theme = {
		colors: { accent: '#89b4fa', bgMain: '#1e1e2e', border: '#313244', textDim: '#6c7086' },
	} as unknown as Theme;

	/** Two AI panes side by side, split down the middle. */
	function makeGroup(): TabGroup {
		return {
			id: 'g1',
			name: 'Group',
			focusedPaneId: 'leaf-1',
			createdAt: 0,
			layout: {
				kind: 'split',
				id: 'split-1',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [
					{ kind: 'leaf', id: 'leaf-1', tab: { type: 'file', id: 'f1' } },
					{ kind: 'leaf', id: 'leaf-2', tab: { type: 'file', id: 'f2' } },
				],
			},
		};
	}

	function makeSession() {
		return createMockSession({
			id: 's1',
			activeGroupId: 'g1',
			// File panes rather than AI panes: the divider is what's under test, and a
			// tiled AI pane drags in TerminalOutput's provider requirements.
			filePreviewTabs: [
				{ id: 'f1', name: 'Alpha', extension: '.md', path: '/repo/Alpha.md', content: '' },
				{ id: 'f2', name: 'Beta', extension: '.md', path: '/repo/Beta.md', content: '' },
			] as never,
			tabGroups: [makeGroup()] as never,
		});
	}

	/** The 4px resize band between the two panes. */
	function getDivider(container: HTMLElement): HTMLElement {
		const el = container.querySelector<HTMLElement>('.cursor-col-resize');
		if (!el) throw new Error('divider not rendered');
		return el;
	}

	function pointerEvent(type: string, clientX: number, pointerId = 1): Event {
		const event = new MouseEvent(type, { clientX, clientY: 0, bubbles: true, button: 0 });
		Object.defineProperty(event, 'pointerId', { value: pointerId });
		return event;
	}

	describe('tiled layout resize divider', () => {
		const capture = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'setPointerCapture');
		const release = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'releasePointerCapture');
		afterEach(() => {
			if (capture) Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', capture);
			else Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture');
			if (release) Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', release);
			else Reflect.deleteProperty(HTMLElement.prototype, 'releasePointerCapture');
			previewProps.length = 0;
		});
		beforeEach(() => {
			useSessionStore.getState().setSessions([]);
			// jsdom implements neither pointer-capture method; the divider captures the
			// pointer so the drag survives crossing a pane overlay.
			HTMLElement.prototype.setPointerCapture = vi.fn();
			HTMLElement.prototype.releasePointerCapture = vi.fn();
		});

		it('stops tracking the pointer once the button is released', () => {
			const session = makeSession();
			useSessionStore.getState().setSessions([session]);
			const { container } = render(
				<TiledLayout group={makeGroup()} session={session} theme={theme} />
			);

			const divider = getDivider(container);
			// jsdom has no layout engine, so capture the flex-grow the drag writes
			// directly onto the neighbouring pane wrappers.
			const paneWrapper = divider.nextElementSibling as HTMLElement;

			act(() => {
				divider.dispatchEvent(pointerEvent('pointerdown', 100));
			});
			act(() => {
				window.dispatchEvent(pointerEvent('pointermove', 150));
			});
			const grownDuringDrag = paneWrapper.style.flexGrow;

			act(() => {
				window.dispatchEvent(pointerEvent('pointerup', 150));
			});
			// The gesture is over. Moving the mouse must no longer resize anything -
			// this is the "it sticks" regression.
			act(() => {
				window.dispatchEvent(pointerEvent('pointermove', 400));
			});

			expect(paneWrapper.style.flexGrow).toBe(grownDuringDrag);
		});

		it('releases the drag when the system cancels the gesture', () => {
			const session = makeSession();
			useSessionStore.getState().setSessions([session]);
			const { container } = render(
				<TiledLayout group={makeGroup()} session={session} theme={theme} />
			);

			const divider = getDivider(container);
			const paneWrapper = divider.nextElementSibling as HTMLElement;

			act(() => {
				divider.dispatchEvent(pointerEvent('pointerdown', 100));
			});
			act(() => {
				window.dispatchEvent(pointerEvent('pointermove', 150));
			});
			const grownDuringDrag = paneWrapper.style.flexGrow;

			// pointercancel fires instead of pointerup when the OS takes the gesture
			// (window drag, Mission Control). The old mouse-only divider never saw it.
			act(() => {
				window.dispatchEvent(pointerEvent('pointercancel', 150));
			});
			act(() => {
				window.dispatchEvent(pointerEvent('pointermove', 400));
			});

			expect(paneWrapper.style.flexGrow).toBe(grownDuringDrag);
		});

		it('ignores a non-left button press so it cannot arm a phantom drag', () => {
			const session = makeSession();
			useSessionStore.getState().setSessions([session]);
			const { container } = render(
				<TiledLayout group={makeGroup()} session={session} theme={theme} />
			);

			const divider = getDivider(container);
			const paneWrapper = divider.nextElementSibling as HTMLElement;
			const before = paneWrapper.style.flexGrow;

			const rightClick = new MouseEvent('pointerdown', {
				clientX: 100,
				clientY: 0,
				bubbles: true,
				button: 2,
			});
			Object.defineProperty(rightClick, 'pointerId', { value: 1 });
			act(() => {
				divider.dispatchEvent(rightClick);
			});
			act(() => {
				window.dispatchEvent(pointerEvent('pointermove', 400));
			});

			expect(paneWrapper.style.flexGrow).toBe(before);
		});

		it('Escape cancels a resize and puts the panes back at their pre-drag sizes', () => {
			const session = makeSession();
			useSessionStore.getState().setSessions([session]);
			const { container } = render(
				<TiledLayout group={makeGroup()} session={session} theme={theme} />
			);

			const divider = getDivider(container);
			const paneWrapper = divider.nextElementSibling as HTMLElement;

			act(() => {
				divider.dispatchEvent(pointerEvent('pointerdown', 100));
			});
			// jsdom has no layout, so stand in for the flex-grow a live drag writes.
			paneWrapper.style.flexGrow = '0.9';

			const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
			act(() => {
				window.dispatchEvent(escape);
			});

			expect(escape.defaultPrevented).toBe(true);
			expect(paneWrapper.style.flexGrow).toBe('0.5');

			// The gesture is over: a later release commits nothing.
			act(() => {
				window.dispatchEvent(pointerEvent('pointerup', 150));
			});
			const stored = useSessionStore.getState().sessions[0].tabGroups?.[0].layout;
			expect(stored).toMatchObject({ sizes: [0.5, 0.5] });
		});
	});
});
describe('PaneDropZones', () => {
	const theme = { colors: { accent: '#89b4fa' } } as unknown as Theme;

	/** Minimal DataTransfer stand-in carrying a tiling payload (jsdom lacks DataTransfer). */
	function mockDataTransfer(payload: TabTilePayload) {
		const store: Record<string, string> = {
			[TAB_TILE_MIME]: JSON.stringify(payload),
			'text/plain': payload.ref.id,
		};
		return {
			types: Object.keys(store),
			getData: (t: string) => store[t] ?? '',
			setData: (t: string, v: string) => {
				store[t] = v;
			},
			dropEffect: 'none',
			effectAllowed: 'all',
		} as unknown as DataTransfer;
	}

	/**
	 * Arm the overlay the way a real drag does. The payload MUST ride the dragstart:
	 * `dragover` can only see the MIME list, so the overlay captures which tab is being
	 * dragged here, and that is what lets it withhold the hint on a self-drop.
	 */
	function startDrag(dataTransfer: DataTransfer) {
		fireEvent(window, Object.assign(new Event('dragstart'), { dataTransfer }));
	}

	describe('PaneDropZones drop', () => {
		beforeEach(() => {
			useSessionStore.getState().setSessions([]);
			vi.mocked(notifyCenterFlash).mockClear();
		});

		it('creates a tiled group when a tab-bar tab is dropped onto the single view', () => {
			const session = createMockSession({
				id: 's1',
				aiTabs: [
					{ id: 'a', name: 'Alpha', logs: [] },
					{ id: 'b', name: 'Beta', logs: [] },
				] as never,
				activeTabId: 'a',
				unifiedTabOrder: [
					{ type: 'ai', id: 'a' },
					{ type: 'ai', id: 'b' },
				],
			});
			useSessionStore.getState().setSessions([session]);

			const activeStandaloneRef: UnifiedTabRef = { type: 'ai', id: 'a' };
			const onGroupActivated = vi.fn();

			const { container } = render(
				<PaneDropZones
					session={session}
					activeGroup={null}
					activeStandaloneRef={activeStandaloneRef}
					activeStandaloneTitle="Alpha"
					theme={theme}
					onGroupActivated={onGroupActivated}
				/>
			);

			const overlay = container.firstChild as HTMLElement;
			const dt = mockDataTransfer({ ref: { type: 'ai', id: 'b' }, source: 'tab-bar' });

			startDrag(dt);
			fireEvent.dragOver(overlay, { dataTransfer: dt, clientX: 10, clientY: 100 });
			fireEvent.drop(overlay, { dataTransfer: dt, clientX: 10, clientY: 100 });

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 's1')!;
			expect(updated.tabGroups).toHaveLength(1);
			expect(updated.activeGroupId).toBe(updated.tabGroups[0]?.id);
			expect(onGroupActivated).toHaveBeenCalledWith(updated.tabGroups[0]?.id);
			// A successful tile flashes a green ack so the gesture is confirmed.
			expect(notifyCenterFlash).toHaveBeenCalledWith(expect.objectContaining({ color: 'green' }));
		});

		it('offers no drop target when the currently-displayed tab is dragged over its own view', () => {
			// A tab tiles beside ANOTHER tab, never itself, so dragging the tab that is
			// already on screen must stay a plain tab-bar reorder: no highlight, no accepted
			// drop, and therefore no "you can't do that" flash to dismiss.
			const session = createMockSession({
				id: 's1',
				aiTabs: [{ id: 'a', name: 'Alpha', logs: [] }] as never,
				activeTabId: 'a',
				unifiedTabOrder: [{ type: 'ai', id: 'a' }],
			});
			useSessionStore.getState().setSessions([session]);

			const activeStandaloneRef: UnifiedTabRef = { type: 'ai', id: 'a' };
			const onGroupActivated = vi.fn();
			const { container } = render(
				<PaneDropZones
					session={session}
					activeGroup={null}
					activeStandaloneRef={activeStandaloneRef}
					activeStandaloneTitle="Alpha"
					theme={theme}
					onGroupActivated={onGroupActivated}
				/>
			);

			const overlay = container.firstChild as HTMLElement;
			// Drag the SAME tab that is on screen (id 'a').
			const dt = mockDataTransfer({ ref: { type: 'ai', id: 'a' }, source: 'tab-bar' });
			startDrag(dt);
			const dragOver = fireEvent.dragOver(overlay, { dataTransfer: dt, clientX: 10, clientY: 100 });
			fireEvent.drop(overlay, { dataTransfer: dt, clientX: 10, clientY: 100 });

			// The drag is refused rather than accepted-and-ignored: a prevented dragover is
			// what makes the cursor promise a drop, so it must NOT be prevented here.
			expect(dragOver).toBe(true);
			expect(dt.dropEffect).toBe('none');
			// No highlight rectangle is painted over the view.
			expect(overlay.querySelector('div')).toBeNull();

			const updated = useSessionStore.getState().sessions.find((s) => s.id === 's1')!;
			expect(updated.tabGroups).toHaveLength(0);
			expect(updated.activeGroupId).toBeNull();
			expect(onGroupActivated).not.toHaveBeenCalled();
			expect(notifyCenterFlash).not.toHaveBeenCalled();
		});

		// The group path (dropping onto an existing tiled group) can't be driven through
		// the overlay in jsdom: fireEvent does not propagate clientX/clientY onto a
		// synthetic `drop` event, so the pane hit-test (clientX >= rect.left) can't run.
		// Exercise the underlying edit directly instead - this is the exact call
		// applyDrop makes once resolveHover picks a pane + zone in the real browser.
		it('tileTabIntoGroup adds the dragged tab as a sibling on a right-edge drop', () => {
			const layout: PanelLayoutNode = {
				kind: 'split',
				id: 'split-1',
				direction: 'row',
				sizes: [0.5, 0.5],
				children: [
					{ kind: 'leaf', id: 'leaf-a', tab: { type: 'ai', id: 'a' } },
					{ kind: 'leaf', id: 'leaf-b', tab: { type: 'ai', id: 'b' } },
				],
			};
			const group: TabGroup = {
				id: 'g1',
				name: 'Group: Alpha',
				createdAt: 0,
				focusedPaneId: 'leaf-a',
				layout,
			};
			const session = createMockSession({
				id: 's1',
				aiTabs: [
					{ id: 'a', name: 'Alpha', logs: [] },
					{ id: 'b', name: 'Beta', logs: [] },
					{ id: 'c', name: 'Gamma', logs: [] },
				] as never,
				activeTabId: 'a',
				unifiedTabOrder: [{ type: 'ai', id: 'c' }],
				tabGroups: [group],
				activeGroupId: 'g1',
			});

			const out = tileTabIntoGroup(session, 'g1', 'leaf-a', 'right', { type: 'ai', id: 'c' });

			const leafCount = JSON.stringify(out.tabGroups[0]?.layout).match(/"kind":"leaf"/g)?.length;
			expect(leafCount).toBe(3);
			// The dragged tab moved out of the standalone strip into the group.
			expect(out.unifiedTabOrder.some((r) => r.id === 'c')).toBe(false);
		});
		it('does not arm the overlay synchronously inside dragstart', async () => {
			// Regression guard. Arming re-renders this component, and doing that
			// synchronously inside `dragstart` cancels the drag Chromium is still
			// setting up: the browser fires `dragstart`, then `dragend`, with no drag
			// session at all. Because the listener is on `window`, that killed EVERY
			// native drag in the app - a staged-image thumbnail could not be dragged
			// out of the composer while tab tiling was on screen.
			//
			// So the overlay must still be click-through when `dragstart` returns, and
			// only become a live drop target on a later task.
			const session = createMockSession({
				id: 's1',
				aiTabs: [{ id: 'a', name: 'Alpha', logs: [] }] as never,
				activeTabId: 'a',
				unifiedTabOrder: [{ type: 'ai', id: 'a' }],
			});
			useSessionStore.getState().setSessions([session]);

			const { container } = render(
				<PaneDropZones
					session={session}
					activeGroup={null}
					activeStandaloneRef={{ type: 'ai', id: 'a' }}
					activeStandaloneTitle="Alpha"
					theme={theme}
					onGroupActivated={vi.fn()}
				/>
			);
			const overlay = container.firstChild as HTMLElement;
			expect(overlay.className).toContain('pointer-events-none');

			startDrag(mockDataTransfer({ ref: { type: 'ai', id: 'a' }, source: 'tab-bar' }));

			// Synchronously after dragstart the overlay is still inert.
			expect(overlay.className).toContain('pointer-events-none');

			// ...and it arms on the next macrotask, long before a pointer could reach it.
			await waitFor(() => expect(overlay.className).not.toContain('pointer-events-none'));
		});
		it('never arms for a drag that is not a tab-tiling drag', async () => {
			// Regression guard. This listener is on `window`, so it sees EVERY native
			// drag in the app, and an armed overlay spans the whole panel at z-30 -
			// above the composer. Arming for an unrelated drag makes the overlay
			// swallow its `dragover`/`drop`: staged-image thumbnails could not be
			// reordered because every event meant for a tile landed on the overlay
			// instead. The zones only exist for tiling, so a drag with no tiling
			// payload must leave them click-through.
			const session = createMockSession({
				id: 's1',
				aiTabs: [{ id: 'a', name: 'Alpha', logs: [] }] as never,
				activeTabId: 'a',
				unifiedTabOrder: [{ type: 'ai', id: 'a' }],
			});
			useSessionStore.getState().setSessions([session]);

			const { container } = render(
				<PaneDropZones
					session={session}
					activeGroup={null}
					activeStandaloneRef={{ type: 'ai', id: 'a' }}
					activeStandaloneTitle="Alpha"
					theme={theme}
					onGroupActivated={vi.fn()}
				/>
			);
			const overlay = container.firstChild as HTMLElement;

			// A staged-image thumbnail leaving the composer: no tiling payload.
			const foreign = {
				types: ['application/x-maestro-staged-image', 'text/plain'],
				getData: (t: string) => (t === 'application/x-maestro-staged-image' ? '0' : 'Screenshot 1'),
				setData: () => {},
				dropEffect: 'none',
				effectAllowed: 'copyMove',
			} as unknown as DataTransfer;

			startDrag(foreign);

			// Still inert immediately, and it must STAY inert past the deferred arm the
			// tiling path uses, so the drop reaches the thumbnail behind it.
			expect(overlay.className).toContain('pointer-events-none');
			await source0_act(async () => {
				await new Promise((r) => setTimeout(r, 50));
			});
			expect(overlay.className).toContain('pointer-events-none');
		});
	});
});
