import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnnotatorSettingsDrawer } from '../../../../renderer/components/ImageAnnotator/AnnotatorSettingsDrawer';
import type {
	Shape,
	TextBox,
	UseAnnotatorStateReturn,
} from '../../../../renderer/components/ImageAnnotator/useAnnotatorState';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import type { Theme } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

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

const selectedText: TextBox = {
	id: 'text-1',
	x: 20,
	y: 30,
	value: 'Label',
	style: {
		color: '#3b82f6',
		size: 18,
		font: 'serif',
		bgColor: null,
	},
};

function resetAnnotatorSettings() {
	useSettingsStore.setState({
		annotatorPenColor: '#9146FF',
		annotatorPenSize: 10,
		annotatorThinning: 0.5,
		annotatorSmoothing: 0.5,
		annotatorStreamline: 0.5,
		annotatorTaperStart: 0,
		annotatorTaperEnd: 0,
		annotatorTextColor: '#9146FF',
		annotatorTextSize: 24,
		annotatorTextFont: 'sans-serif',
		annotatorTextBgColor: '',
	});
}

function makeState(overrides: Partial<UseAnnotatorStateReturn> = {}): UseAnnotatorStateReturn {
	return {
		strokes: [],
		currentPoints: [],
		shapes: [],
		currentShape: null,
		selectedShapeId: null,
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

function renderDrawer(state = makeState(), open = true, onClose = vi.fn()) {
	render(<AnnotatorSettingsDrawer open={open} onClose={onClose} theme={theme} state={state} />);
	return { onClose };
}

describe('AnnotatorSettingsDrawer', () => {
	beforeEach(() => {
		resetAnnotatorSettings();
		vi.mocked((window as any).maestro.settings.set).mockClear();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		resetAnnotatorSettings();
	});

	it('updates global annotator defaults and resets them', () => {
		const { onClose } = renderDrawer();

		expect(screen.getByRole('complementary', { name: 'Drawing settings' })).toHaveAttribute(
			'aria-hidden',
			'false'
		);

		fireEvent.click(screen.getByRole('button', { name: 'Use color #10b981' }));
		expect(useSettingsStore.getState().annotatorPenColor).toBe('#10b981');

		fireEvent.change(screen.getByLabelText('Pen size'), { target: { value: '24' } });
		expect(useSettingsStore.getState().annotatorPenSize).toBe(24);

		fireEvent.change(screen.getByLabelText('Thinning'), { target: { value: '0.25' } });
		fireEvent.change(screen.getByLabelText('Smoothing'), { target: { value: '0.75' } });
		fireEvent.change(screen.getByLabelText('Streamline'), { target: { value: '0.9' } });
		fireEvent.change(screen.getByLabelText('Taper Start'), { target: { value: '0.2' } });
		fireEvent.change(screen.getByLabelText('Taper End'), { target: { value: '0.4' } });

		expect(useSettingsStore.getState()).toMatchObject({
			annotatorThinning: 0.25,
			annotatorSmoothing: 0.75,
			annotatorStreamline: 0.9,
			annotatorTaperStart: 0.2,
			annotatorTaperEnd: 0.4,
		});

		fireEvent.click(screen.getByRole('button', { name: 'Use foreground color #ec4899' }));
		fireEvent.click(screen.getByRole('button', { name: 'Use background color #000000' }));
		fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '44' } });
		fireEvent.change(screen.getByLabelText('Text font'), { target: { value: 'monospace' } });

		expect(useSettingsStore.getState()).toMatchObject({
			annotatorTextColor: '#ec4899',
			annotatorTextBgColor: '#000000',
			annotatorTextSize: 44,
			annotatorTextFont: 'monospace',
		});

		fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
		expect(useSettingsStore.getState()).toMatchObject({
			annotatorPenColor: '#9146FF',
			annotatorPenSize: 10,
			annotatorThinning: 0.5,
			annotatorSmoothing: 0.5,
			annotatorStreamline: 0.5,
			annotatorTaperStart: 0,
			annotatorTaperEnd: 0,
			annotatorTextColor: '#9146FF',
			annotatorTextSize: 24,
			annotatorTextFont: 'sans-serif',
			annotatorTextBgColor: '',
		});

		fireEvent.click(screen.getByRole('button', { name: 'Close' }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('routes pen controls to the selected shape instead of global defaults', () => {
		const state = makeState({
			shapes: [selectedShape],
			selectedShapeId: 'shape-1',
		});
		renderDrawer(state);

		expect(screen.getByText('Editing selection')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Use color #3b82f6' }));
		expect(state.updateShape).toHaveBeenCalledWith('shape-1', {
			style: {
				...selectedShape.style,
				color: '#3b82f6',
			},
		});

		fireEvent.change(screen.getByLabelText('Pen size'), { target: { value: '18' } });
		expect(state.updateShape).toHaveBeenCalledWith('shape-1', {
			style: {
				...selectedShape.style,
				size: 18,
			},
		});
		expect(useSettingsStore.getState().annotatorPenSize).toBe(10);
	});

	it('routes text controls to the selected text and supports no-color backgrounds', () => {
		const state = makeState({
			texts: [selectedText],
			selectedTextId: 'text-1',
		});
		renderDrawer(state);

		fireEvent.click(screen.getByRole('button', { name: 'Use foreground color #ef4444' }));
		expect(state.updateText).toHaveBeenCalledWith('text-1', {
			style: {
				...selectedText.style,
				color: '#ef4444',
			},
		});

		fireEvent.click(screen.getByRole('button', { name: 'Use background color #10b981' }));
		expect(state.updateText).toHaveBeenCalledWith('text-1', {
			style: {
				...selectedText.style,
				bgColor: '#10b981',
			},
		});

		fireEvent.click(screen.getByRole('button', { name: 'No color' }));
		expect(state.updateText).toHaveBeenCalledWith('text-1', {
			style: {
				...selectedText.style,
				bgColor: null,
			},
		});

		fireEvent.click(screen.getByRole('button', { name: 'Swap foreground and background' }));
		expect(state.updateText).toHaveBeenCalledWith('text-1', {
			style: {
				...selectedText.style,
				color: '#ffffff',
				bgColor: '#3b82f6',
			},
		});

		fireEvent.change(screen.getByLabelText('Text size'), { target: { value: '36' } });
		fireEvent.change(screen.getByLabelText('Text font'), {
			target: { value: 'Georgia, "Times New Roman", serif' },
		});

		expect(state.updateText).toHaveBeenCalledWith('text-1', {
			style: {
				...selectedText.style,
				size: 36,
			},
		});
		expect(state.updateText).toHaveBeenCalledWith('text-1', {
			style: {
				...selectedText.style,
				font: 'Georgia, "Times New Roman", serif',
			},
		});
	});

	it('marks the closed drawer hidden and inert', () => {
		renderDrawer(makeState(), false);

		const drawer = screen.getByRole('complementary', { hidden: true });
		expect(drawer).toHaveAttribute('aria-hidden', 'true');
		expect(drawer).toHaveAttribute('inert');
	});
});
