import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { PaneDropZones } from '../../../renderer/components/MainPanel/PaneDropZones';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { TAB_TILE_MIME } from '../../../renderer/utils/tabDragPayload';
import type { TabTilePayload } from '../../../renderer/utils/tabDragPayload';
import { tileTabIntoGroup } from '../../../renderer/utils/panelLayout';
import { notifyCenterFlash } from '../../../renderer/stores/centerFlashStore';
import type { PanelLayoutNode, TabGroup, Theme, UnifiedTabRef } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

vi.mock('../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

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
});
