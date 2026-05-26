import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
});
