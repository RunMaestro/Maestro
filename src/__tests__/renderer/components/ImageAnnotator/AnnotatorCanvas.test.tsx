import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { AnnotatorCanvas } from '../../../../renderer/components/ImageAnnotator/AnnotatorCanvas';
import type { AnnotatorState } from '../../../../renderer/components/ImageAnnotator/useAnnotatorState';

describe('AnnotatorCanvas', () => {
	it('leaves Cmd+Enter to the input method while editing text during IME composition', () => {
		const commitTextEditing = vi.fn();
		const mockText = {
			id: 'text-1',
			x: 50,
			y: 50,
			value: 'Annotation text',
			style: {
				color: '#ffffff',
				size: 16,
				font: 'sans-serif',
				bgColor: null,
			},
		};

		const mockState: Partial<AnnotatorState> = {
			strokes: [],
			currentPoints: [],
			shapes: [],
			currentShape: null,
			selectedShapeId: null,
			texts: [mockText],
			editingTextId: 'text-1',
			selectedTextId: null,
			tool: 'text',
			view: { scale: 1, x: 0, y: 0 },
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
			commitTextEditing,
			deleteText: vi.fn(),
			selectText: vi.fn(),
			cropRect: null,
			setCropRect: vi.fn(),
		};

		const { container } = render(
			<AnnotatorCanvas
				imageDataUrl="data:image/png;base64,fake"
				state={mockState as AnnotatorState}
			/>
		);

		const img = container.querySelector('img');
		expect(img).not.toBeNull();
		Object.defineProperty(img!, 'naturalWidth', { value: 800 });
		Object.defineProperty(img!, 'naturalHeight', { value: 600 });
		act(() => {
			fireEvent.load(img!);
		});

		const textarea = screen.getByRole('textbox');
		expect(textarea).toBeInTheDocument();

		for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
			fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true, ...ime });
			expect(commitTextEditing).not.toHaveBeenCalled();
		}

		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		expect(commitTextEditing).toHaveBeenCalledTimes(1);
	});
});
