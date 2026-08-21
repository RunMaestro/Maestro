/**
 * Tests for the tiled-layout resize divider.
 *
 * The bug these guard: a divider drag could stick. The old hand-rolled version
 * committed to the store BEFORE removing its document mouse listeners, so any
 * throw in that synchronous store update (which re-renders every pane) left the
 * move listener attached and the divider kept following the pointer with no
 * button held. It also had no pointer capture, no `pointercancel`, and no
 * unmount cleanup. Release must always release.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { act } from 'react';
import { TiledLayout } from '../../../renderer/components/MainPanel/TiledLayout';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { TabGroup, Theme } from '../../../renderer/types';
import { createMockSession } from '../../helpers/mockSession';

vi.mock('../../../renderer/components/FilePreview', () => ({
	FilePreview: () => <div />,
}));

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
});
