import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusDot, PipelineDot } from '../../../../renderer/components/CueModal/StatusDot';
import { THEMES } from '../../../../renderer/constants/themes';

const darkTheme = THEMES['dracula'];
const lightTheme = THEMES['github-light'];

describe('StatusDot', () => {
	it('uses theme success color for active status', () => {
		const { container } = render(<StatusDot status="active" theme={darkTheme} />);
		const dot = container.firstElementChild as HTMLElement;
		expect(dot).toHaveStyle({ backgroundColor: darkTheme.colors.success });
	});

	it('uses theme warning color for paused status', () => {
		const { container } = render(<StatusDot status="paused" theme={lightTheme} />);
		const dot = container.firstElementChild as HTMLElement;
		expect(dot).toHaveStyle({ backgroundColor: lightTheme.colors.warning });
	});

	it('uses theme textDim color for none status', () => {
		const { container } = render(<StatusDot status="none" theme={darkTheme} />);
		const dot = container.firstElementChild as HTMLElement;
		expect(dot).toHaveStyle({ backgroundColor: darkTheme.colors.textDim });
	});

	it('falls back to hardcoded colors when no theme', () => {
		const { container } = render(<StatusDot status="active" />);
		const dot = container.firstElementChild as HTMLElement;
		expect(dot).toHaveStyle({ backgroundColor: '#22c55e' });
	});
});

describe('PipelineDot', () => {
	it('renders with the provided color', () => {
		const { container } = render(<PipelineDot color="#ef4444" name="Test" />);
		const dot = container.firstElementChild as HTMLElement;
		expect(dot).toHaveStyle({ backgroundColor: '#ef4444' });
	});

	it('sets title attribute for tooltip', () => {
		const { container } = render(<PipelineDot color="#ef4444" name="My Pipeline" />);
		const dot = container.firstElementChild as HTMLElement;
		expect(dot.title).toBe('My Pipeline');
	});
});
