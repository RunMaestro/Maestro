// Source: src/__tests__/renderer/components/ImageAnnotator/AnnotatorCanvas.test.tsx
// Source: src/__tests__/renderer/components/ImageAnnotator/AnnotatorToolbar.paletteHotkeys.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { render } from '@testing-library/react';
import { screen } from '@testing-library/react';
import { fireEvent } from '@testing-library/react';
import { act } from '@testing-library/react';
import { AnnotatorCanvas } from '../../../../renderer/components/ImageAnnotator/AnnotatorCanvas';
import type { UseAnnotatorStateReturn } from '../../../../renderer/components/ImageAnnotator/useAnnotatorState';
import { beforeEach } from 'vitest';
import { AnnotatorToolbar } from '../../../../renderer/components/ImageAnnotator/AnnotatorToolbar';
import { ANNOTATOR_PALETTE } from '../../../../renderer/components/ImageAnnotator/annotatorConstants';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';
describeSourceSuite('AnnotatorCanvas', () => {
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

			const mockState: Partial<UseAnnotatorStateReturn> = {
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
					state={mockState as UseAnnotatorStateReturn}
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
});
describeSourceSuite('AnnotatorToolbar.paletteHotkeys', () => {
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
});
