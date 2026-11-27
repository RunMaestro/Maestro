/**
 * Tests for DelegationEdgeEditor - the popover that states one relationship.
 *
 * The writes are `writeDelegationEdge`, `deleteDelegationEdge` and
 * `excludeDelegationPeer`, which have their own test. What is pinned here is
 * what the editor offers, what it hands `onConfirm` and `onDelete`, and what it
 * says about an edge that already exists in either direction, before the click
 * that takes one away.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	DelegationEdgeEditor,
	DelegationEdgeRefusal,
	type DelegationEdgeEditorProps,
} from '../../../../renderer/components/DelegationGraph/DelegationEdgeEditor';
import { LayerStackProvider } from '../../../../renderer/contexts/LayerStackContext';
import { DELEGATION_EDGE_NEEDS_ACCESS } from '../../../../renderer/services/delegationGraphEdits';
import { delegationEdgeId, type DelegationGraphEdge } from '../../../../shared/delegationGraph';
import {
	PEER_ACCESS_CONTROLS,
	PEER_GRANT_LABELS,
	PEER_NOTE_PLACEHOLDER,
} from '../../../../shared/peerAgents';
import { mockTheme } from '../../../helpers/mockTheme';

const ANCHOR = { x: 320, y: 240 };

function edge(
	sourceId: string,
	targetId: string,
	fields: Partial<DelegationGraphEdge> = {}
): DelegationGraphEdge {
	return {
		id: delegationEdgeId(sourceId, targetId),
		sourceId,
		targetId,
		read: true,
		write: false,
		source: 'explicit',
		...fields,
	};
}

function renderEditor(props: Partial<DelegationEdgeEditorProps> = {}) {
	const handlers = {
		onConfirm: vi.fn<DelegationEdgeEditorProps['onConfirm']>(() => null),
		onDelete: vi.fn<NonNullable<DelegationEdgeEditorProps['onDelete']>>(() => null),
		onClose: vi.fn(),
	};
	render(
		<LayerStackProvider>
			<DelegationEdgeEditor
				theme={mockTheme}
				anchor={ANCHOR}
				sourceName="Alpha"
				targetName="Beta"
				{...handlers}
				{...props}
			/>
		</LayerStackProvider>
	);
	return handlers;
}

function square(bit: 'read' | 'write'): HTMLElement {
	return screen.getByRole('switch', { name: PEER_ACCESS_CONTROLS[bit].title });
}

function note(): HTMLInputElement {
	return screen.getByPlaceholderText(PEER_NOTE_PLACEHOLDER) as HTMLInputElement;
}

function confirmButton(): HTMLElement {
	return screen.getByTestId('delegation-edge-editor-confirm');
}

function deleteButton(): HTMLElement | null {
	return screen.queryByTestId('delegation-edge-editor-delete');
}

/** Switch off every bit that is lit. */
function clearBothBits(): void {
	for (const bit of ['read', 'write'] as const) {
		if (square(bit).getAttribute('aria-checked') === 'true') fireEvent.click(square(bit));
	}
}

describe('DelegationEdgeEditor', () => {
	describe('a new edge', () => {
		it('names the direction: the source, then the target', () => {
			renderEditor();

			expect(screen.getByRole('dialog', { name: 'Edge from Alpha to Beta' })).toBeInTheDocument();
		});

		it('opens where the edge was dropped', () => {
			renderEditor();

			const dialog = screen.getByTestId('delegation-edge-editor');
			expect(dialog.style.left).toBe(`${ANCHOR.x}px`);
			expect(dialog.style.top).toBe(`${ANCHOR.y}px`);
		});

		it('offers Consult and Delegate with the wording of the Peers tab', () => {
			renderEditor();

			const dialog = screen.getByTestId('delegation-edge-editor');
			for (const bit of ['read', 'write'] as const) {
				expect(square(bit)).toHaveTextContent(PEER_ACCESS_CONTROLS[bit].square);
				expect(dialog).toHaveTextContent(PEER_ACCESS_CONTROLS[bit].word);
				expect(dialog).toHaveTextContent(PEER_ACCESS_CONTROLS[bit].effect);
			}
			expect(note()).toBeInTheDocument();
		});

		it('starts as consult only, the access that never touches the peer', () => {
			renderEditor();

			expect(square('read')).toHaveAttribute('aria-checked', 'true');
			expect(square('write')).toHaveAttribute('aria-checked', 'false');
			expect(note().value).toBe('');
			expect(confirmButton()).toHaveTextContent('Add edge');
		});

		it('hands over both bits and the note on confirm', () => {
			const { onConfirm } = renderEditor();

			fireEvent.click(square('write'));
			fireEvent.change(note(), { target: { value: 'Owns the build' } });
			fireEvent.click(confirmButton());

			expect(onConfirm).toHaveBeenCalledTimes(1);
			expect(onConfirm).toHaveBeenCalledWith({
				read: true,
				write: true,
				description: 'Owns the build',
			});
		});

		it('hands over delegate only when consult is switched off', () => {
			const { onConfirm } = renderEditor();

			fireEvent.click(square('write'));
			fireEvent.click(square('read'));
			fireEvent.click(confirmButton());

			expect(onConfirm).toHaveBeenCalledWith({ read: false, write: true, description: '' });
		});

		it('confirms on Enter in the note', () => {
			const { onConfirm } = renderEditor();

			fireEvent.keyDown(note(), { key: 'Enter' });

			expect(onConfirm).toHaveBeenCalledWith({ read: true, write: false, description: '' });
		});

		it('says nothing about another edge when there is none', () => {
			renderEditor();

			expect(screen.queryByTestId('delegation-edge-editor-existing')).not.toBeInTheDocument();
			expect(screen.queryByTestId('delegation-edge-editor-reverse')).not.toBeInTheDocument();
		});

		// There is nothing to take away yet, even when the caller hands a handler.
		it('offers no delete action', () => {
			renderEditor();

			expect(deleteButton()).not.toBeInTheDocument();
		});
	});

	describe('a new edge with neither bit', () => {
		it('cannot be confirmed, by the button or by Enter, and says why', () => {
			const { onConfirm } = renderEditor();

			fireEvent.click(square('read'));

			expect(confirmButton()).toBeDisabled();
			expect(screen.getByTestId('delegation-edge-editor-needs-access')).toHaveTextContent(
				DELEGATION_EDGE_NEEDS_ACCESS
			);
			fireEvent.click(confirmButton());
			fireEvent.keyDown(note(), { key: 'Enter' });
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it('can be confirmed again once a bit is lit', () => {
			const { onConfirm } = renderEditor();

			fireEvent.click(square('read'));
			fireEvent.click(square('write'));

			expect(confirmButton()).not.toBeDisabled();
			expect(screen.queryByTestId('delegation-edge-editor-needs-access')).not.toBeInTheDocument();
			fireEvent.click(confirmButton());
			expect(onConfirm).toHaveBeenCalledWith({ read: false, write: true, description: '' });
		});
	});

	describe('an edge that exists in this direction', () => {
		it('opens with the bits and the note of the row, and saves in place of adding', () => {
			renderEditor({
				existing: edge('a', 'b', { read: true, write: true, description: 'Owns the build' }),
			});

			expect(square('read')).toHaveAttribute('aria-checked', 'true');
			expect(square('write')).toHaveAttribute('aria-checked', 'true');
			expect(note().value).toBe('Owns the build');
			expect(confirmButton()).toHaveTextContent('Save edge');
			expect(screen.getByTestId('delegation-edge-editor-existing')).toHaveTextContent(
				'This edge exists: Alpha may consult and delegate to Beta. Saving changes it.'
			);
		});

		it('says which grant derived it, and that saving writes a row that overrides the grant', () => {
			renderEditor({ existing: edge('a', 'b', { source: 'group' }) });

			const existing = screen.getByTestId('delegation-edge-editor-existing');
			expect(existing).toHaveTextContent('Alpha may consult Beta');
			expect(existing).toHaveTextContent(PEER_GRANT_LABELS.group);
			expect(existing).toHaveTextContent('overrides the grant');
		});
	});

	describe('taking an edge away', () => {
		it('offers to delete an edge the user wrote, and says what that removes', () => {
			const { onDelete, onConfirm } = renderEditor({ existing: edge('a', 'b') });

			const button = deleteButton()!;
			expect(button).toHaveTextContent('Delete edge');
			expect(button).toHaveAttribute(
				'title',
				expect.stringContaining('Removes the row for Beta from the Peers of Alpha')
			);

			fireEvent.click(button);

			expect(onDelete).toHaveBeenCalledTimes(1);
			expect(onConfirm).not.toHaveBeenCalled();
		});

		// A derived edge has no row. The action is named for what it writes.
		it.each(['group', 'worktree'] as const)(
			'names the action Exclude peer for an edge the %s grant derived, and says why',
			(grant) => {
				const { onDelete } = renderEditor({ existing: edge('a', 'b', { source: grant }) });

				const button = deleteButton()!;
				expect(button).toHaveTextContent('Exclude peer');
				expect(button).not.toHaveTextContent('Delete');
				expect(button).toHaveAttribute('title', expect.stringContaining(PEER_GRANT_LABELS[grant]));
				expect(button).toHaveAttribute('title', expect.stringContaining('no row to delete'));

				fireEvent.click(button);

				expect(onDelete).toHaveBeenCalledTimes(1);
			}
		);

		it('offers no delete action when the caller hands none', () => {
			renderEditor({ existing: edge('a', 'b'), onDelete: undefined });

			expect(deleteButton()).not.toBeInTheDocument();
		});

		it('shows why a delete was refused and stays open', () => {
			const { onClose } = renderEditor({
				existing: edge('a', 'b'),
				onDelete: () => 'This edge is no longer on the graph.',
			});

			fireEvent.click(deleteButton()!);

			expect(screen.getByTestId('delegation-edge-editor-error')).toHaveTextContent(
				'This edge is no longer on the graph.'
			);
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	// Clearing both bits is the exclusion, not a delete, and the editor says so
	// before the click.
	describe('an existing edge saved with neither bit', () => {
		it('can be confirmed, says it excludes and is not a delete, and hands over neither bit', () => {
			const { onConfirm, onDelete } = renderEditor({
				existing: edge('a', 'b', { read: true, write: true, description: 'Owns the build' }),
			});

			clearBothBits();

			expect(confirmButton()).not.toBeDisabled();
			expect(confirmButton()).toHaveTextContent('Save as excluded');
			const excludes = screen.getByTestId('delegation-edge-editor-excludes');
			expect(excludes).toHaveTextContent('Beta is excluded');
			expect(excludes).toHaveTextContent('It is not a delete.');
			expect(excludes).toHaveTextContent('To remove the row, use Delete edge.');
			expect(screen.queryByTestId('delegation-edge-editor-needs-access')).not.toBeInTheDocument();

			fireEvent.click(confirmButton());

			expect(onConfirm).toHaveBeenCalledWith({
				read: false,
				write: false,
				description: 'Owns the build',
			});
			expect(onDelete).not.toHaveBeenCalled();
		});

		// There is no row to remove under a derived edge, so the line does not
		// point at a delete that does not exist.
		it('does not point a derived edge at Delete edge', () => {
			renderEditor({ existing: edge('a', 'b', { source: 'group' }) });

			clearBothBits();

			const excludes = screen.getByTestId('delegation-edge-editor-excludes');
			expect(excludes).toHaveTextContent('It is not a delete.');
			expect(excludes).not.toHaveTextContent('Delete edge');
		});

		it('reads Save edge again once a bit is lit', () => {
			renderEditor({ existing: edge('a', 'b') });

			clearBothBits();
			fireEvent.click(square('write'));

			expect(confirmButton()).toHaveTextContent('Save edge');
			expect(screen.queryByTestId('delegation-edge-editor-excludes')).not.toBeInTheDocument();
		});
	});

	describe('an edge that exists the other way', () => {
		it('says so, in the direction it runs, and offers nothing automatic', () => {
			const { onConfirm } = renderEditor({ reverse: edge('b', 'a') });

			const reverse = screen.getByTestId('delegation-edge-editor-reverse');
			expect(reverse).toHaveTextContent('Beta may already consult Alpha');
			expect(reverse).toHaveTextContent('nothing is changed for Beta');
			// The new edge still starts as consult only: the reverse edge is not copied.
			expect(square('write')).toHaveAttribute('aria-checked', 'false');
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it('names both bits of a reverse edge that carries both', () => {
			renderEditor({ reverse: edge('b', 'a', { write: true }) });

			expect(screen.getByTestId('delegation-edge-editor-reverse')).toHaveTextContent(
				'Beta may already consult and delegate to Alpha'
			);
		});
	});

	describe('closing', () => {
		it('shows why a write was refused and stays open', () => {
			const { onClose } = renderEditor({ onConfirm: () => 'Peer "b" is not an agent.' });

			fireEvent.click(confirmButton());

			expect(screen.getByTestId('delegation-edge-editor-error')).toHaveTextContent(
				'Peer "b" is not an agent.'
			);
			expect(onClose).not.toHaveBeenCalled();
		});

		it('closes on Cancel and on its X, with nothing confirmed', () => {
			const { onConfirm, onClose } = renderEditor();

			fireEvent.click(screen.getByTestId('delegation-edge-editor-cancel'));
			fireEvent.click(screen.getByRole('button', { name: 'Close' }));

			expect(onClose).toHaveBeenCalledTimes(2);
			expect(onConfirm).not.toHaveBeenCalled();
		});

		it('closes on Escape, with nothing confirmed', () => {
			const { onConfirm, onClose } = renderEditor();

			fireEvent.keyDown(window, { key: 'Escape' });

			expect(onClose).toHaveBeenCalledTimes(1);
			expect(onConfirm).not.toHaveBeenCalled();
		});
	});
});

describe('DelegationEdgeRefusal', () => {
	it('says why no edge was drawn, where it was dropped', () => {
		const onClose = vi.fn();
		render(
			<LayerStackProvider>
				<DelegationEdgeRefusal
					theme={mockTheme}
					anchor={ANCHOR}
					message="An agent cannot be its own peer."
					onClose={onClose}
				/>
			</LayerStackProvider>
		);

		const dialog = screen.getByTestId('delegation-edge-refusal');
		expect(dialog).toHaveTextContent('An agent cannot be its own peer.');
		expect(dialog.style.left).toBe(`${ANCHOR.x}px`);

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
