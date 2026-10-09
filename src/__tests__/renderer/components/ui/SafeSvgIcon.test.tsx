import '@testing-library/jest-dom';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SafeSvgIcon } from '../../../../renderer/components/ui/SafeSvgIcon';

describe('SafeSvgIcon', () => {
	it('renders host-owned SVG markup containing only the contributed path data', () => {
		render(<SafeSvgIcon data-testid="safe-svg-icon" path="M3 12H21" viewBox="0 0 24 24" />);

		const svg = screen.getByTestId('safe-svg-icon');
		expect(svg).toHaveAttribute('viewBox', '0 0 24 24');
		expect(svg).toHaveAttribute('fill', 'none');
		expect(svg).toHaveAttribute('stroke', 'currentColor');
		expect(svg.querySelectorAll('path')).toHaveLength(1);
		expect(svg.querySelector('path')).toHaveAttribute('d', 'M3 12H21');
		expect(svg.querySelector('script, foreignObject, image, use')).toBeNull();
	});
});
