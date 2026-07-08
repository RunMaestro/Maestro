import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnotatorToolbar } from '../../../../renderer/components/ImageAnnotator/AnnotatorToolbar';
import type {
	Shape,
	UseAnnotatorStateReturn,
} from '../../../../renderer/components/ImageAnnotator/useAnnotatorState';
import type { Theme } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

const flashMock = vi.hoisted(() => ({
	notifyCenterFlash: vi.fn(),
}));

vi.mock('../../../../renderer/stores/centerFlashStore', () => flashMock);

const theme = THEMES.dracula as Theme;

const selectedShape: Shape = {
	id: 'shape-1',
	kind: 'rect',
	x1: 1,
	y1: 2,
	x2: 30,
	y2: 40,
	style: {
		color: '#ef4444',
		size: 3,
		filled: false,
	},
};

function makeState(overrides: Partial<UseAnnotatorStateReturn> = {}): UseAnnotatorStateReturn {
	return {
		strokes: [
			{
				id: 'stroke-1',
				points: [[1, 1, 0.5]],
				style: {
					color: '#9146FF',
					size: 10,
					thinning: 0.5,
					smoothing: 0.5,
					streamline: 0.5,
					taperStart: 0,
					taperEnd: 0,
				},
			},
		],
		currentPoints: [],
		shapes: [selectedShape],
		currentShape: null,
		selectedShapeId: 'shape-1',
		texts: [],
		editingTextId: null,
		selectedTextId: null,
		tool: 'pen',
		setTool: vi.fn(),
		view: { x: 0, y: 0, scale: 1 },
		setView: vi.fn(),
		beginStroke: vi.fn(),
		extendStroke: vi.fn(),
		extendStrokeStraight: vi.fn(),
		endStroke: vi.fn(),
		eraseStrokeAt: vi.fn(),
		beginShape: vi.fn(),
		updateCurrentShape: vi.fn(),
		commitCurrentShape: vi.fn(),
		cancelCurrentShape: vi.fn(),
		updateShape: vi.fn(),
		deleteShape: vi.fn(),
		selectShape: vi.fn(),
		beginText: vi.fn(),
		updateTextValue: vi.fn(),
		updateText: vi.fn(),
		commitTextEditing: vi.fn(),
		deleteText: vi.fn(),
		selectText: vi.fn(),
		editText: vi.fn(),
		undo: vi.fn(),
		clear: vi.fn(),
		...overrides,
	} as UseAnnotatorStateReturn;
}

function renderToolbar(
	state = makeState(),
	overrides: Partial<ComponentProps<typeof AnnotatorToolbar>> = {}
) {
	const props = {
		state,
		theme,
		drawerOpen: false,
		onToggleDrawer: vi.fn(),
		onSave: vi.fn(),
		onCopy: vi.fn().mockResolvedValue(undefined),
		onCancel: vi.fn(),
		...overrides,
	};
	render(<AnnotatorToolbar {...props} />);
	return props;
}

describe('AnnotatorToolbar', () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it('selects tools, opens clear confirmation, and triggers toolbar actions', async () => {
		const state = makeState();
		const props = renderToolbar(state);

		expect(screen.getByRole('toolbar', { name: 'Image annotator toolbar' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Erase' }));
		expect(state.setTool).toHaveBeenCalledWith('eraser');

		fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
		expect(state.undo).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Clear all strokes' }));
		const confirm = screen.getByRole('dialog', { name: 'Clear all strokes?' });
		fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
		expect(state.clear).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Clear all strokes' }));
		fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
		expect(state.clear).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Drawing settings' }));
		expect(props.onToggleDrawer).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
		await waitFor(() => expect(props.onCopy).toHaveBeenCalledTimes(1));
		expect(flashMock.notifyCenterFlash).toHaveBeenCalledWith({
			message: 'Copied annotated image to clipboard',
			color: 'green',
		});

		fireEvent.click(screen.getByRole('button', { name: 'Save' }));
		expect(props.onSave).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(props.onCancel).toHaveBeenCalledTimes(1);
	});

	it('updates selected-shape color and handles annotator keyboard shortcuts', async () => {
		const state = makeState();
		const props = renderToolbar(state);

		fireEvent.click(screen.getByRole('button', { name: 'Current drawing color' }));
		const colorList = screen.getByRole('listbox', { name: 'Drawing color' });
		fireEvent.click(within(colorList).getByRole('option', { name: 'Set color to #10b981' }));

		expect(state.updateShape).toHaveBeenCalledWith('shape-1', {
			style: {
				...selectedShape.style,
				color: '#10b981',
			},
		});
		expect(screen.queryByRole('listbox', { name: 'Drawing color' })).not.toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'z', metaKey: true });
		expect(state.undo).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(window, { key: 's', metaKey: true });
		expect(props.onSave).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(window, { key: 'c', metaKey: true });
		await waitFor(() => expect(props.onCopy).toHaveBeenCalledTimes(1));
	});

	it('disables undo and clear when there is no annotator content', () => {
		renderToolbar(makeState({ strokes: [], shapes: [], texts: [] }));

		expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
		expect(screen.getByRole('button', { name: 'Clear all strokes' })).toBeDisabled();
	});
});
