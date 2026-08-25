import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useChatFileDropZone } from '../../../../renderer/hooks/ui/useChatFileDropZone';
import type { Theme } from '../../../../renderer/types';

const theme = {
	colors: {
		accent: '#7aa2f7',
		bgMain: '#1a1b26',
		bgSidebar: '#16161e',
		border: '#292e42',
		textMain: '#c0caf5',
		textDim: '#565f89',
	},
} as unknown as Theme;

function Host({ onDrop }: { onDrop: (e: React.DragEvent<HTMLElement>) => void }) {
	const zone = useChatFileDropZone(theme, onDrop);
	return (
		<div data-testid="zone" className="relative" {...zone.dragHandlers}>
			<span data-testid="dragging">{String(zone.isDragging)}</span>
			{zone.overlay}
		</div>
	);
}

/** DataTransfer stub: only `types` and `getData` are read by the zone. */
function dataTransferOf(...types: string[]) {
	return { types, getData: (t: string) => (types.includes(t) ? '0' : '') };
}

describe('useChatFileDropZone', () => {
	it('lights up the overlay for an OS file drag', () => {
		render(<Host onDrop={vi.fn()} />);

		fireEvent.dragEnter(screen.getByTestId('zone'), { dataTransfer: dataTransferOf('Files') });

		expect(screen.getByTestId('dragging').textContent).toBe('true');
	});

	it('forwards a staged-image drop to the caller', () => {
		const onDrop = vi.fn();
		render(<Host onDrop={onDrop} />);

		fireEvent.drop(screen.getByTestId('zone'), {
			dataTransfer: dataTransferOf('application/x-maestro-staged-image'),
		});

		expect(onDrop).toHaveBeenCalledTimes(1);
	});

	it('does not light up the overlay for a staged-image drag', () => {
		// The strip lives inside this region, so an ordinary in-strip reorder
		// bubbles its dragenter up here. A full-panel banner on every reorder
		// would be worse than no affordance.
		render(<Host onDrop={vi.fn()} />);

		fireEvent.dragEnter(screen.getByTestId('zone'), {
			dataTransfer: dataTransferOf('application/x-maestro-staged-image'),
		});

		expect(screen.getByTestId('dragging').textContent).toBe('false');
	});

	it('ignores a drag carrying neither payload', () => {
		const onDrop = vi.fn();
		render(<Host onDrop={onDrop} />);

		fireEvent.drop(screen.getByTestId('zone'), { dataTransfer: dataTransferOf('text/plain') });

		expect(onDrop).not.toHaveBeenCalled();
		expect(screen.getByTestId('dragging').textContent).toBe('false');
	});
});
