import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentsLoadingView } from '../../../renderer/components/AgentsLoadingView';
import { mockTheme } from '../../helpers/mockTheme';

describe('AgentsLoadingView', () => {
	it('renders the MAESTRO branding and a loading message', () => {
		render(<AgentsLoadingView theme={mockTheme} />);
		expect(screen.getByText('MAESTRO')).toBeInTheDocument();
		expect(screen.getByText('Loading your agents...')).toBeInTheDocument();
	});

	it('renders an accessible spinner so the load state is announced', () => {
		render(<AgentsLoadingView theme={mockTheme} />);
		// Spinner renders Loader2 with role="status" and the aria-label below.
		expect(screen.getByLabelText('Loading agents')).toBeInTheDocument();
	});
});
