import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { AgentErrorBanner } from '../../../../renderer/components/MainPanel/AgentErrorBanner';
import type { AgentError, Theme } from '../../../../renderer/types';

import { mockTheme } from '../../../helpers/mockTheme';

function makeError(overrides: Partial<AgentError> = {}): AgentError {
	return {
		message: 'Something went wrong',
		recoverable: true,
		...overrides,
	} as AgentError;
}

describe('AgentErrorBanner', () => {
	it('renders error message', () => {
		render(<AgentErrorBanner error={makeError()} theme={mockTheme} />);
		expect(screen.getByText('Something went wrong')).toBeInTheDocument();
	});

	it('renders View Details button when onShowDetails is provided', () => {
		const onShowDetails = vi.fn();
		render(
			<AgentErrorBanner error={makeError()} theme={mockTheme} onShowDetails={onShowDetails} />
		);

		const button = screen.getByText('View Details');
		expect(button).toBeInTheDocument();

		fireEvent.click(button);
		expect(onShowDetails).toHaveBeenCalledTimes(1);
	});

	it('does not render View Details button when onShowDetails is not provided', () => {
		render(<AgentErrorBanner error={makeError()} theme={mockTheme} />);
		expect(screen.queryByText('View Details')).not.toBeInTheDocument();
	});

	it('renders dismiss button for recoverable errors', () => {
		const onClear = vi.fn();
		render(
			<AgentErrorBanner
				error={makeError({ recoverable: true })}
				theme={mockTheme}
				onClear={onClear}
			/>
		);

		const button = screen.getByTitle('Dismiss error');
		fireEvent.click(button);
		expect(onClear).toHaveBeenCalledTimes(1);
	});

	it('does not render dismiss button for non-recoverable errors', () => {
		const onClear = vi.fn();
		render(
			<AgentErrorBanner
				error={makeError({ recoverable: false })}
				theme={mockTheme}
				onClear={onClear}
			/>
		);

		expect(screen.queryByTitle('Dismiss error')).not.toBeInTheDocument();
	});

	it('does not render dismiss button when onClear is not provided', () => {
		render(<AgentErrorBanner error={makeError({ recoverable: true })} theme={mockTheme} />);
		expect(screen.queryByTitle('Dismiss error')).not.toBeInTheDocument();
	});

	it('applies theme error color styling', () => {
		const { container } = render(<AgentErrorBanner error={makeError()} theme={mockTheme} />);
		const banner = container.firstChild as HTMLElement;
		expect(banner.style.backgroundColor).toBeTruthy();
		expect(banner.style.borderColor).toBeTruthy();
	});
});
