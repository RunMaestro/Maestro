import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StagedImagesStrip } from '../../../../../renderer/components/InputArea/components/StagedImagesStrip';
import { inputAreaTheme } from '../_fixtures';

describe('StagedImagesStrip', () => {
	function renderStrip(overrides = {}) {
		return render(
			<StagedImagesStrip
				isVisible
				stagedImages={['data:image/png;base64,a', 'data:image/png;base64,b']}
				theme={inputAreaTheme}
				setLightboxImage={vi.fn()}
				setStagedImages={vi.fn()}
				openAnnotator={vi.fn()}
				onReorder={vi.fn()}
				{...overrides}
			/>
		);
	}

	it('renders nothing when hidden or empty', () => {
		const { rerender } = renderStrip({ isVisible: false });
		expect(screen.queryByRole('img')).not.toBeInTheDocument();

		rerender(
			<StagedImagesStrip
				isVisible
				stagedImages={[]}
				theme={inputAreaTheme}
				setLightboxImage={vi.fn()}
				setStagedImages={vi.fn()}
				openAnnotator={vi.fn()}
				onReorder={vi.fn()}
			/>
		);
		expect(screen.queryByRole('img')).not.toBeInTheDocument();
	});

	it('opens lightbox when clicking a staged image', () => {
		const setLightboxImage = vi.fn();
		renderStrip({ setLightboxImage });

		fireEvent.click(screen.getAllByRole('img')[0]);

		expect(setLightboxImage).toHaveBeenCalledWith(
			'data:image/png;base64,a',
			['data:image/png;base64,a', 'data:image/png;base64,b'],
			'staged'
		);
	});

	it('opens annotator and replaces by image content', () => {
		const setStagedImages = vi.fn();
		const openAnnotator = vi.fn((_img, onSave) => onSave('data:image/png;base64,new'));
		renderStrip({ setStagedImages, openAnnotator });

		fireEvent.click(screen.getAllByLabelText('Annotate image')[0]);
		const updater = setStagedImages.mock.calls[0][0];

		expect(openAnnotator).toHaveBeenCalledWith('data:image/png;base64,a', expect.any(Function));
		expect(updater(['data:image/png;base64/a', 'data:image/png;base64,a'])).toEqual([
			'data:image/png;base64/a',
			'data:image/png;base64,new',
		]);
	});

	it('removes image by content', () => {
		const setStagedImages = vi.fn();
		renderStrip({ setStagedImages });

		fireEvent.click(screen.getAllByTestId('x-icon')[0].closest('button')!);
		const updater = setStagedImages.mock.calls[0][0];

		expect(updater(['data:image/png;base64,a', 'data:image/png;base64,b'])).toEqual([
			'data:image/png;base64,b',
		]);
	});

	// Drag-to-reorder. jsdom has no layout engine and no DragEvent, so the tests
	// have to supply both halves of the geometry the drop math reads: a stubbed
	// rect per tile, and a clientX that survives onto the event (fireEvent's init
	// object drops mouse coordinates when it falls back to plain Event).
	afterEach(() => {
		vi.restoreAllMocks();
	});

	/** The draggable wrapper, not the img - the img carries draggable="false". */
	function tileOf(index: number): HTMLElement {
		return screen.getAllByRole('img')[index].closest('[draggable="true"]') as HTMLElement;
	}

	/** Lay the tiles out as two 100px-wide boxes side by side. */
	function stubTileLayout(tiles: HTMLElement[]) {
		const rects = new Map(tiles.map((tile, i) => [tile, { left: i * 100, width: 100 }]));
		vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
			this: Element
		) {
			const r = rects.get(this as HTMLElement) ?? { left: 0, width: 0 };
			return {
				...r,
				right: r.left + r.width,
				top: 0,
				bottom: 64,
				height: 64,
				x: r.left,
				y: 0,
				toJSON: () => ({}),
			} as DOMRect;
		});
	}

	function makeDataTransfer() {
		const store: Record<string, string> = {};
		return {
			types: [] as string[],
			effectAllowed: '',
			dropEffect: '',
			setData(type: string, value: string) {
				store[type] = value;
				if (!this.types.includes(type)) this.types.push(type);
			},
			getData(type: string) {
				return store[type] ?? '';
			},
		};
	}

	function fireAt(
		kind: 'dragOver' | 'drop',
		target: HTMLElement,
		dataTransfer: unknown,
		clientX: number
	) {
		const event = createEvent[kind](target, { dataTransfer });
		Object.defineProperty(event, 'clientX', { value: clientX });
		fireEvent(target, event);
	}

	it('reports a drop past a later tile as a forward move', () => {
		const onReorder = vi.fn();
		renderStrip({ onReorder });
		const tiles = [tileOf(0), tileOf(1)];
		stubTileLayout(tiles);
		const dataTransfer = makeDataTransfer();

		fireEvent.dragStart(tiles[0], { dataTransfer });
		// Right of the second tile's midpoint: the gap AFTER it.
		fireAt('dragOver', tiles[1], dataTransfer, 180);
		fireAt('drop', tiles[1], dataTransfer, 180);

		expect(onReorder).toHaveBeenCalledWith(0, 1);
	});

	it('reports a drop before an earlier tile as a backward move', () => {
		const onReorder = vi.fn();
		renderStrip({ onReorder });
		const tiles = [tileOf(0), tileOf(1)];
		stubTileLayout(tiles);
		const dataTransfer = makeDataTransfer();

		fireEvent.dragStart(tiles[1], { dataTransfer });
		// Left of the first tile's midpoint: the gap BEFORE it.
		fireAt('dragOver', tiles[0], dataTransfer, 20);
		fireAt('drop', tiles[0], dataTransfer, 20);

		expect(onReorder).toHaveBeenCalledWith(1, 0);
	});

	it('ignores a drop into the dragged image own gap', () => {
		const onReorder = vi.fn();
		renderStrip({ onReorder });
		const tiles = [tileOf(0), tileOf(1)];
		stubTileLayout(tiles);
		const dataTransfer = makeDataTransfer();

		fireEvent.dragStart(tiles[0], { dataTransfer });
		fireAt('dragOver', tiles[0], dataTransfer, 20);
		fireAt('drop', tiles[0], dataTransfer, 20);

		expect(onReorder).not.toHaveBeenCalled();
	});

	it('hides the organizer button when only one image is staged', () => {
		// Nothing to compare and nothing to reorder: the button would open a modal
		// with no work in it.
		renderStrip({ stagedImages: ['data:image/png;base64,a'] });

		expect(screen.queryByLabelText('Open image organizer')).not.toBeInTheDocument();
	});

	it('shows the organizer button from two images up', () => {
		renderStrip();

		expect(screen.getByLabelText('Open image organizer')).toBeInTheDocument();
	});

	it('carries the slot reference as plain text so a drop on the composer reads it', () => {
		renderStrip();
		const dataTransfer = makeDataTransfer();

		fireEvent.dragStart(tileOf(1), { dataTransfer });

		expect(dataTransfer.getData('text/plain')).toBe('Screenshot 2');
		expect(dataTransfer.getData('application/x-maestro-staged-image')).toBe('1');
	});
});
