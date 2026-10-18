/**
 * Tests for ModalResizeGrip: a mouse-driven surface gets mousedown, a
 * pointer-driven one (`usePointerDrag`) gets pointerdown instead and never both,
 * and double-click resets.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ModalResizeGrip } from '../../../../renderer/components/ui/ModalResizeGrip';
import { mockTheme } from '../../../helpers/mockTheme';

describe('ModalResizeGrip', () => {
	it('starts a mouse-driven resize on mousedown', () => {
		const onResizeStart = vi.fn();
		render(
			<ModalResizeGrip theme={mockTheme} onResizeStart={onResizeStart} onReset={vi.fn()} canReset />
		);

		fireEvent.mouseDown(screen.getByTestId('modal-resize-grip'));
		expect(onResizeStart).toHaveBeenCalledTimes(1);
	});

	it('starts a pointer-driven resize on pointerdown, and ignores mousedown then', () => {
		const onResizeStart = vi.fn();
		const onResizePointerDown = vi.fn();
		render(
			<ModalResizeGrip
				theme={mockTheme}
				onResizeStart={onResizeStart}
				onResizePointerDown={onResizePointerDown}
				onReset={vi.fn()}
				canReset={false}
				label="Resize gauge"
			/>
		);

		const grip = screen.getByRole('separator', { name: 'Resize gauge' });
		fireEvent.pointerDown(grip);
		fireEvent.mouseDown(grip);
		expect(onResizePointerDown).toHaveBeenCalledTimes(1);
		expect(onResizeStart).not.toHaveBeenCalled();
		expect(grip).toHaveAttribute('title', 'Drag to resize');
	});

	it('resets on double-click', () => {
		const onReset = vi.fn();
		render(<ModalResizeGrip onResizePointerDown={vi.fn()} onReset={onReset} canReset />);

		fireEvent.doubleClick(screen.getByTestId('modal-resize-grip'));
		expect(onReset).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId('modal-resize-grip')).toHaveAttribute(
			'title',
			'Drag to resize, double-click to reset'
		);
	});
});
