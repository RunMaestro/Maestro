/**
 * Tests for DesignPickChips - the Design Mode picks staged on the composer.
 */

import type { ComponentProps } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DesignPickChips } from '../../../../../renderer/components/InputArea/components/DesignPickChips';
import { MODAL_PRIORITIES } from '../../../../../renderer/constants/modalPriorities';
import type { StagedDesignPick } from '../../../../../renderer/types';
import { createMockDesignPick } from '../../../../helpers';
import { inputAreaTheme } from '../_fixtures';

// Escape reaches the popover through the layer stack. Keep the layer the
// popover registers so a test can press Escape on it.
const { registerLayer } = vi.hoisted(() => ({
	registerLayer: vi.fn((_layer: { priority: number; onEscape: () => void }) => 'layer-1'),
}));
vi.mock('../../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer,
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

const BLOCK = [
	'Design Mode element from https://example.com/pricing',
	'',
	'Selector: `button.cta`',
	'```html',
	'<button class="cta">Sign up</button>',
	'```',
].join('\n');

function makePick(overrides: Partial<StagedDesignPick> = {}): StagedDesignPick {
	return createMockDesignPick({
		url: 'https://example.com/pricing',
		note: 'Make it blue',
		text: BLOCK,
		screenshot: 'data:image/png;base64,AAA',
		...overrides,
	});
}

function renderChips(overrides: Partial<ComponentProps<typeof DesignPickChips>> = {}) {
	const props: ComponentProps<typeof DesignPickChips> = {
		isVisible: true,
		picks: [makePick()],
		theme: inputAreaTheme,
		onNoteChange: vi.fn(),
		onRemove: vi.fn(),
		...overrides,
	};
	const view = render(<DesignPickChips {...props} />);
	return { ...view, props };
}

function chipButton(label = 'button.cta "Sign up"') {
	return screen.getByRole('button', { name: `Design Mode pick ${label}` });
}

function popover() {
	return screen.queryByTestId('design-pick-popover');
}

function noteField() {
	return screen.getByTestId('design-pick-popover-note') as HTMLTextAreaElement;
}

function lastLayer() {
	const { calls } = registerLayer.mock;
	if (calls.length === 0) throw new Error('no layer registered');
	return calls[calls.length - 1][0];
}

beforeEach(() => {
	registerLayer.mockClear();
});

describe('DesignPickChips', () => {
	it('renders nothing when hidden or when no pick is staged', () => {
		const { rerender, props } = renderChips({ isVisible: false });
		expect(screen.queryByTestId('design-pick-chips')).not.toBeInTheDocument();

		rerender(<DesignPickChips {...props} isVisible picks={[]} />);
		expect(screen.queryByTestId('design-pick-chips')).not.toBeInTheDocument();
	});

	it('shows one chip per pick, in order: thumbnail, label in mono, and the note', () => {
		renderChips({
			picks: [
				makePick(),
				makePick({ id: 'pick-2', label: 'h1#title "Pricing"', note: '', screenshot: null }),
			],
		});

		const chips = screen.getAllByTestId('design-pick-chip');
		expect(chips).toHaveLength(2);

		const first = within(chips[0]);
		expect(first.getByText('button.cta "Sign up"')).toHaveClass('font-mono', 'truncate');
		expect(first.getByText('Make it blue')).toHaveClass('truncate');
		expect(chips[0].querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AAA');

		// Off screen when picked: a placeholder instead of a thumbnail, and no
		// empty line where a note would go.
		const second = within(chips[1]);
		expect(second.getByTestId('design-pick-no-screenshot')).toBeInTheDocument();
		expect(chips[1].querySelector('img')).toBeNull();
		expect(second.getByText('h1#title "Pricing"').parentElement?.children).toHaveLength(1);
	});

	it('removes a chip by id from its X, without opening it', () => {
		const onRemove = vi.fn();
		renderChips({
			onRemove,
			picks: [makePick(), makePick({ id: 'pick-2', label: 'h1' })],
		});

		fireEvent.click(screen.getByRole('button', { name: 'Remove pick h1' }));

		expect(onRemove).toHaveBeenCalledTimes(1);
		expect(onRemove).toHaveBeenCalledWith('pick-2');
		expect(popover()).not.toBeInTheDocument();
	});

	it('opens a popover above the composer with the full block, read-only, and the note', () => {
		renderChips();
		fireEvent.click(chipButton());

		const open = popover();
		expect(open).toBeInTheDocument();
		// Portaled: the strip scrolls, and would clip it.
		expect(open?.parentElement).toBe(document.body);
		expect(chipButton()).toHaveAttribute('aria-expanded', 'true');

		const block = within(open!).getByTestId('design-pick-popover-block');
		expect(block.tagName).toBe('PRE');
		expect(block.textContent).toBe(BLOCK);
		expect(block).toHaveClass('select-text', 'overflow-auto');
		expect(within(open!).getByText('https://example.com/pricing')).toBeInTheDocument();
		expect(noteField()).toHaveValue('Make it blue');

		expect(lastLayer().priority).toBe(MODAL_PRIORITIES.DESIGN_PICK_POPOVER);
	});

	it('clicking the chip again closes its popover', () => {
		renderChips();
		fireEvent.click(chipButton());
		expect(popover()).toBeInTheDocument();

		fireEvent.click(chipButton());
		expect(popover()).not.toBeInTheDocument();
		expect(chipButton()).toHaveAttribute('aria-expanded', 'false');
	});

	it('lands in the note with the caret after it', async () => {
		renderChips();
		fireEvent.click(chipButton());

		const note = noteField();
		await waitFor(() => expect(note).toHaveFocus());
		expect(note.selectionStart).toBe('Make it blue'.length);
		expect(note.selectionEnd).toBe('Make it blue'.length);
	});

	it('Enter saves the note once and closes; Shift+Enter is a newline', () => {
		const onNoteChange = vi.fn();
		renderChips({ onNoteChange });
		fireEvent.click(chipButton());

		fireEvent.change(noteField(), { target: { value: 'Make it red' } });
		fireEvent.keyDown(noteField(), { key: 'Enter', shiftKey: true });
		expect(onNoteChange).not.toHaveBeenCalled();
		expect(popover()).toBeInTheDocument();

		fireEvent.keyDown(noteField(), { key: 'Enter' });
		expect(popover()).not.toBeInTheDocument();
		expect(onNoteChange).toHaveBeenCalledTimes(1);
		expect(onNoteChange).toHaveBeenCalledWith('pick-1', 'Make it red');
	});

	it.each(['Escape', 'Done', 'a click outside'] as const)(
		'closing with %s saves a changed note',
		(how) => {
			const onNoteChange = vi.fn();
			renderChips({ onNoteChange });
			fireEvent.click(chipButton());
			fireEvent.change(noteField(), { target: { value: 'Pad it' } });

			if (how === 'Escape') act(() => lastLayer().onEscape());
			if (how === 'Done') fireEvent.click(screen.getByTestId('design-pick-popover-done'));
			if (how === 'a click outside') fireEvent.mouseDown(document.body);

			expect(popover()).not.toBeInTheDocument();
			expect(onNoteChange).toHaveBeenCalledTimes(1);
			expect(onNoteChange).toHaveBeenCalledWith('pick-1', 'Pad it');
		}
	);

	it('does not save a note that is unchanged once trimmed', () => {
		const onNoteChange = vi.fn();
		renderChips({ onNoteChange });
		fireEvent.click(chipButton());

		fireEvent.change(noteField(), { target: { value: ' Make it blue \n' } });
		fireEvent.click(screen.getByTestId('design-pick-popover-done'));

		expect(popover()).not.toBeInTheDocument();
		expect(onNoteChange).not.toHaveBeenCalled();
	});

	it('a press inside the popover or on its chip is not a click outside', () => {
		renderChips();
		fireEvent.click(chipButton());

		fireEvent.mouseDown(screen.getByTestId('design-pick-popover-block'));
		fireEvent.mouseDown(screen.getAllByTestId('design-pick-chip')[0]);
		expect(popover()).toBeInTheDocument();
	});

	it('saves the note when the chip leaves while open, and does not reopen later', () => {
		const onNoteChange = vi.fn();
		const { rerender, props } = renderChips({ onNoteChange });
		fireEvent.click(chipButton());
		fireEvent.change(noteField(), { target: { value: 'Pad it' } });

		// The strip hides (terminal mode) with the popover open.
		rerender(<DesignPickChips {...props} isVisible={false} />);
		expect(popover()).not.toBeInTheDocument();
		expect(onNoteChange).toHaveBeenCalledWith('pick-1', 'Pad it');

		rerender(<DesignPickChips {...props} isVisible />);
		expect(chipButton()).toBeInTheDocument();
		expect(popover()).not.toBeInTheDocument();
	});
});
