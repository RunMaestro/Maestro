import { createEvent, fireEvent, render, screen, within } from '@testing-library/react';
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

		// The tile, not the <img>: the image is decorative and pointer-events-none,
		// so a real press lands on the wrapper that carries the drag and the click.
		fireEvent.click(tileOf(0));

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

	/**
	 * The tile wrapper: drag source, drop target, and click target at once. The
	 * thumbnail image is `pointer-events-none`, so this is also the element a
	 * real press hit-tests to.
	 */
	function tileOf(index: number): HTMLElement {
		return screen.getAllByRole('button', { name: /^Staged image/ })[index];
	}

	/** Where a drag starts. Same element as the tile now; kept for readability. */
	function thumbOf(index: number): HTMLElement {
		return tileOf(index);
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

		fireEvent.dragStart(thumbOf(0), { dataTransfer });
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

		fireEvent.dragStart(thumbOf(1), { dataTransfer });
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

		fireEvent.dragStart(thumbOf(0), { dataTransfer });
		fireAt('dragOver', tiles[0], dataTransfer, 20);
		fireAt('drop', tiles[0], dataTransfer, 20);

		expect(onReorder).not.toHaveBeenCalled();
	});

	it('drags from a plain element, never a form control', () => {
		// Regression guard for the reason the strip could not be dragged into the
		// chat at all: the thumbnail was wrapped in a <button>, and Blink drops
		// the drag when a form control consumes the press for activation. That
		// held whether `draggable` sat on the button or on an ancestor, so the
		// test asserts the shape of the DOM rather than which element carries the
		// attribute.
		renderStrip();

		const tile = tileOf(0);
		expect(tile.tagName).not.toBe('BUTTON');
		expect(tile.getAttribute('draggable')).toBe('true');
		// The image must not be hit-testable: its own draggable="false" computes
		// -webkit-user-drag: none, which would stop the drag if it were the target.
		const img = screen.getAllByRole('presentation', { hidden: true })[0];
		expect(img.className).toContain('pointer-events-none');
		// The per-image controls opt out, so pressing one cannot start a tile drag.
		for (const control of within(tile).getAllByRole('button')) {
			expect(control.getAttribute('draggable')).toBe('false');
		}
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

	// The number is how you name an image in the message ("annotate screenshot
	// 3"), so it has to be readable before a drag starts, not only during one.
	describe('slot numbers', () => {
		/** The badge is faded rather than unmounted, so read its opacity. */
		function badgeOf(index: number): HTMLElement {
			return within(tileOf(index)).getByText(String(index + 1));
		}

		it('labels every thumbnail once there is more than one to pick from', () => {
			renderStrip();

			expect(badgeOf(0)).toHaveStyle({ opacity: '1' });
			expect(badgeOf(1)).toHaveStyle({ opacity: '1' });
		});

		it('leaves a lone thumbnail unlabelled, since there is nothing to pick', () => {
			renderStrip({ stagedImages: ['data:image/png;base64,a'] });

			expect(badgeOf(0)).toHaveStyle({ opacity: '0' });
		});

		// Mid-drag the number answers a different question - "which slot am I
		// aiming at" - so it appears even when there is only one image.
		it('labels a lone thumbnail while a drag is in flight', () => {
			renderStrip({ stagedImages: ['data:image/png;base64,a'] });

			fireEvent.dragStart(thumbOf(0), { dataTransfer: makeDataTransfer() });

			expect(badgeOf(0)).toHaveStyle({ opacity: '1' });
		});
	});

	it('carries the slot reference as plain text so a drop on the composer reads it', () => {
		renderStrip();
		const dataTransfer = makeDataTransfer();

		fireEvent.dragStart(thumbOf(1), { dataTransfer });

		expect(dataTransfer.getData('text/plain')).toBe('Screenshot 2');
		expect(dataTransfer.getData('application/x-maestro-staged-image')).toBe('1');
	});
});
