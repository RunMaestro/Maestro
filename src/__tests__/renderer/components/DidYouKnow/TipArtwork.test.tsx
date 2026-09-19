import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DID_YOU_KNOW_TIPS } from '../../../../shared/didYouKnow';
import { TIP_ART, TipArtwork } from '../../../../renderer/components/DidYouKnow/TipArtwork';
import frameSrc from '../../../../renderer/assets/did-you-know-frame.png';
import { createMockTheme, mockTheme } from '../../../helpers/mockTheme';

vi.unmock('lucide-react');

describe('TipArtwork', () => {
	it.each(DID_YOU_KNOW_TIPS)('renders the registered icon for $id', (tip) => {
		const { container } = render(<TipArtwork tip={tip} theme={mockTheme} />);
		const icon = container.querySelector('svg')!;
		expect(icon).toBeInTheDocument();
		expect(icon).not.toHaveClass('lucide-lightbulb');
		expect(icon).toHaveStyle({ height: '40%', width: 'auto' });
		expect(container.querySelector('img')).toBeNull();
	});

	it.each(['UnknownIcon', 'constructor', 'toString'])('falls back for unknown icon %s', (icon) => {
		const { container } = render(
			<TipArtwork tip={{ ...DID_YOU_KNOW_TIPS[0], icon }} theme={mockTheme} />
		);
		expect(container.querySelector('svg')).toHaveClass('lucide-lightbulb');
	});

	it('fills its parent and follows theme changes without setting an aspect ratio', () => {
		const { container, rerender } = render(
			<TipArtwork tip={DID_YOU_KNOW_TIPS[0]} theme={mockTheme} />
		);
		const plate = container.firstElementChild as HTMLElement;
		expect(plate).toHaveClass('w-full', 'h-full', 'items-center', 'justify-center');
		expect(plate).toHaveAttribute('aria-hidden', 'true');
		expect(plate).toHaveStyle({ color: mockTheme.colors.accent });
		expect(plate.style.backgroundImage).toContain('radial-gradient');
		expect(plate.style.backgroundImage).toContain('linear-gradient(135deg');
		expect(plate.style.backgroundImage).toContain('12%');
		expect(plate.style.backgroundImage).toContain('4%');
		expect(plate.style.aspectRatio).toBe('');
		const theme = createMockTheme({ colors: { accent: '#126789', bgMain: '#ffffff' } });
		rerender(<TipArtwork tip={DID_YOU_KNOW_TIPS[0]} theme={theme} />);
		expect(plate).toHaveStyle({ color: theme.colors.accent, backgroundColor: theme.colors.bgMain });
		expect(plate.style.backgroundImage).toContain('rgb(18, 103, 137)');
	});

	it.each(['missing.png', 'constructor'])('uses the icon plate for unmapped art %s', (art) => {
		const { container } = render(
			<TipArtwork tip={{ ...DID_YOU_KNOW_TIPS[0], art }} theme={mockTheme} />
		);
		expect(container.querySelector('img')).toBeNull();
		expect(container.querySelector('svg')).toHaveClass('lucide-zap');
	});

	it('prefers a mapped screenshot over the icon and returns to the plate on the next tip', () => {
		// Exercise the screenshot branch with an existing bundled image until tip art ships.
		TIP_ART['test-preview.png'] = frameSrc;
		try {
			const tip = { ...DID_YOU_KNOW_TIPS[0], art: 'test-preview.png' };
			const { container, rerender } = render(<TipArtwork tip={tip} theme={mockTheme} />);
			const image = screen.getByRole('img', { name: tip.title });
			expect(image).toHaveAttribute('src', frameSrc);
			expect(image).toHaveClass('w-full', 'h-full', 'object-cover');
			expect(container.querySelector('svg')).toBeNull();
			rerender(<TipArtwork tip={DID_YOU_KNOW_TIPS[1]} theme={mockTheme} />);
			expect(screen.queryByRole('img')).toBeNull();
			expect(container.querySelector('svg')).toHaveClass('lucide-play');
		} finally {
			delete TIP_ART['test-preview.png'];
		}
	});
});
