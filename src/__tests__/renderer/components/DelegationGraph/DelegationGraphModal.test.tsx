/**
 * Tests for the window the Delegation Graph opens in.
 *
 * The canvas has its own tests. What is pinned here is the mount: the layer
 * (Escape closes through the layer stack, at the graph's own priority), the two
 * ways out, the size (most of the screen, remembered under one key), the
 * `select-none` root, the scope handed to the view, and that the modal is NOT
 * portaled, because the Edit Agent modal its Peers link opens must paint on top.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefObject } from 'react';
import type { DelegationGraphScope } from '../../../../shared/delegationGraph';
import { mockTheme } from '../../../helpers/mockTheme';

const view = vi.hoisted(() => ({ mounts: 0 }));

// reactflow cannot lay itself out in jsdom. The view is replaced by a marker
// that shows the scope it was handed and counts how often it mounted.
vi.mock('../../../../renderer/components/DelegationGraph/DelegationGraphView', async () => {
	const React = await import('react');
	return {
		DelegationGraphView: ({
			initialScope,
			focusRef,
			onClose,
		}: {
			initialScope?: DelegationGraphScope;
			focusRef?: RefObject<HTMLDivElement>;
			onClose?: () => void;
		}) => {
			React.useEffect(() => {
				view.mounts += 1;
			}, []);
			return (
				<div ref={focusRef} tabIndex={-1} data-testid="delegation-graph-view-stub">
					{initialScope ? JSON.stringify(initialScope) : 'every agent'}
					<button type="button" onClick={onClose} data-testid="delegation-graph-esc">
						Close Delegation Graph
					</button>
				</div>
			);
		},
	};
});

import {
	DELEGATION_GRAPH_RESIZE_KEY,
	DelegationGraphModal,
} from '../../../../renderer/components/DelegationGraph/DelegationGraphModal';
import { MODAL_PRIORITIES } from '../../../../renderer/constants/modalPriorities';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { viewportModalSize } from '../../../../renderer/utils/modalSizing';

function renderModal(scope?: DelegationGraphScope) {
	const onClose = vi.fn();
	const utils = render(
		<LayerStackProvider>
			<DelegationGraphModal theme={mockTheme} onClose={onClose} scope={scope} />
		</LayerStackProvider>
	);
	const rerenderWith = (next?: DelegationGraphScope) =>
		utils.rerender(
			<LayerStackProvider>
				<DelegationGraphModal theme={mockTheme} onClose={onClose} scope={next} />
			</LayerStackProvider>
		);
	return { onClose, rerenderWith, ...utils };
}

function card(): HTMLElement {
	const el = document.querySelector<HTMLElement>(
		`[data-modal-resize-key="${DELEGATION_GRAPH_RESIZE_KEY}"]`
	);
	if (!el) throw new Error('the modal card was not rendered');
	return el;
}

beforeEach(() => {
	view.mounts = 0;
	useSettingsStore.setState({ modalSizes: {} });
});

describe('DelegationGraphModal', () => {
	it('focuses the graph so its shortcuts work as soon as it opens', async () => {
		renderModal();
		await waitFor(() => expect(screen.getByTestId('delegation-graph-view-stub')).toHaveFocus());
	});

	it('renders the graph inside a dialog named Delegation Graph', () => {
		renderModal();

		const dialog = screen.getByRole('dialog', { name: 'Delegation Graph' });
		expect(dialog).toHaveAttribute('data-testid', 'delegation-graph-modal');
		expect(within(dialog).getByTestId('delegation-graph-view-stub')).toBeInTheDocument();
	});

	it('closes on Escape through the layer stack', async () => {
		const { onClose } = renderModal();

		fireEvent.keyDown(window, { key: 'Escape' });

		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it('has a visible close control as well as Escape', () => {
		const { onClose } = renderModal();

		fireEvent.click(screen.getByTestId('delegation-graph-esc'));

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('ranks below the Edit Agent modal its Peers link opens', () => {
		// Escape closes the highest-priority layer. Ranked above the form, Escape
		// would close the graph under it and leave the form open.
		expect(MODAL_PRIORITIES.DELEGATION_GRAPH).toBeLessThan(MODAL_PRIORITIES.NEW_INSTANCE);
		// A confirmation the view raises (Apply layout, Reset) sits on top of both.
		expect(MODAL_PRIORITIES.DELEGATION_GRAPH).toBeLessThan(MODAL_PRIORITIES.CONFIRM);
	});

	it('is rendered in place, not through a portal', () => {
		// The Edit Agent modal shares this modal's z-index, so DOM order decides
		// which paints on top. A portal would append the graph to the body, after
		// the form it had just opened.
		const { container } = renderModal();

		expect(container.contains(screen.getByTestId('delegation-graph-modal'))).toBe(true);
	});

	it('defaults to most of the screen', () => {
		renderModal();

		const expected = viewportModalSize({ width: 0.9, height: 0.88 });
		// The shared clamp may trim the default to the viewport's cap, never grow it.
		expect(parseInt(card().style.width, 10)).toBeGreaterThan(0);
		expect(parseInt(card().style.width, 10)).toBeLessThanOrEqual(expected.width);
		expect(parseInt(card().style.height, 10)).toBeLessThanOrEqual(expected.height);
	});

	it('reopens at the size the user dragged it to', () => {
		useSettingsStore.setState({
			modalSizes: { [DELEGATION_GRAPH_RESIZE_KEY]: { width: 700, height: 500 } },
		});

		renderModal();

		expect(card().style.width).toBe('700px');
		expect(card().style.height).toBe('500px');
	});

	it('is select-none on its content root, since the surface is clicked and dragged', () => {
		renderModal();

		const root = screen.getByTestId('delegation-graph-view-stub').parentElement!;
		expect(root.className).toContain('select-none');
	});

	it('opens on every agent when no scope is asked for', () => {
		renderModal();

		expect(screen.getByTestId('delegation-graph-view-stub')).toHaveTextContent('every agent');
	});

	it('opens on the scope it was handed', () => {
		renderModal({ kind: 'group', groupId: 'g1' });

		expect(screen.getByTestId('delegation-graph-view-stub')).toHaveTextContent(
			JSON.stringify({ kind: 'group', groupId: 'g1' })
		);
	});

	it('remounts the view when a second open asks for another scope', () => {
		// The view reads its scope once, on mount. Without the remount, opening a
		// group's graph while the all-agents graph is up would change nothing.
		const { rerenderWith } = renderModal({ kind: 'group', groupId: 'g1' });
		expect(view.mounts).toBe(1);

		rerenderWith({ kind: 'group', groupId: 'g2' });

		expect(view.mounts).toBe(2);
		expect(screen.getByTestId('delegation-graph-view-stub')).toHaveTextContent('g2');
	});

	it('keeps the view mounted across a re-render with the same scope', () => {
		const { rerenderWith } = renderModal({ kind: 'group', groupId: 'g1' });

		// A new object with the same content, as the modal store hands over.
		rerenderWith({ kind: 'group', groupId: 'g1' });

		expect(view.mounts).toBe(1);
	});
});
