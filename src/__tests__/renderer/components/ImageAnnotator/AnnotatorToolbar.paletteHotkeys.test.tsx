/**
 * The color popover draws a number inside each swatch, and the same bare digit
 * picks that color. These tests pin the two together and check the hotkey goes
 * to the same target a click would (a selected shape before the pen default).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AnnotatorToolbar } from '../../../../renderer/components/ImageAnnotator/AnnotatorToolbar';
import { ANNOTATOR_PALETTE } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
import type { UseAnnotatorStateReturn } from '../../../../renderer/components/ImageAnnotator/useAnnotatorState';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';

function makeState(overrides: Partial<UseAnnotatorStateReturn> = {}): UseAnnotatorStateReturn {
	return {
		tool: 'pen',
		setTool: vi.fn(),
		strokes: [],
		shapes: [],
		texts: [],
		cropCount: 0,
		undo: vi.fn(),
		clear: vi.fn(),
		selectedShapeId: null,
		selectedTextId: null,
		updateShape: vi.fn(),
		updateText: vi.fn(),
		...overrides,
	} as unknown as UseAnnotatorStateReturn;
}

function renderToolbar(state: UseAnnotatorStateReturn) {
	return render(
		<AnnotatorToolbar
			state={state}
			theme={mockTheme}
			drawerOpen={false}
			onToggleDrawer={vi.fn()}
			onSave={vi.fn()}
			onCopy={vi.fn().mockResolvedValue(undefined)}
			onApplyCrop={vi.fn()}
			onCancel={vi.fn()}
		/>
	);
}

describe('AnnotatorToolbar palette hotkeys', () => {
	const setPen = vi.fn();
	beforeEach(() => {
		setPen.mockReset();
		useSettingsStore.setState({ setAnnotatorPenColor: setPen } as never);
	});

	it('picks the swatch matching a bare digit', () => {
		renderToolbar(makeState());
		fireEvent.keyDown(document, { key: '3' });
		expect(setPen).toHaveBeenCalledWith(ANNOTATOR_PALETTE[2]);
	});

	it('ignores the digit when a modifier is held', () => {
		renderToolbar(makeState());
		fireEvent.keyDown(document, { key: '3', metaKey: true });
		expect(setPen).not.toHaveBeenCalled();
	});

	it('recolors the selected shape instead of the pen default', () => {
		const updateShape = vi.fn();
		const shape = { id: 's1', style: { color: '#ef4444', size: 4 } };
		renderToolbar(makeState({ shapes: [shape] as never, selectedShapeId: 's1', updateShape }));
		fireEvent.keyDown(document, { key: '1' });
		expect(updateShape).toHaveBeenCalledWith('s1', {
			style: { ...shape.style, color: ANNOTATOR_PALETTE[0] },
		});
		expect(setPen).not.toHaveBeenCalled();
	});

	it('draws the hotkey number inside each swatch', () => {
		renderToolbar(makeState());
		fireEvent.click(screen.getByRole('button', { name: /color/i }));
		ANNOTATOR_PALETTE.forEach((color, index) => {
			const swatch = screen.getByRole('option', { name: `Set color to ${color} (${index + 1})` });
			expect(swatch.textContent).toBe(String(index + 1));
		});
	});
});
