/**
 * Tests for LaunchAgentCard: the read-only card that names the agent a launch runs on.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LaunchAgentCard } from '../../../../../renderer/components/MarketplaceModal/launch/LaunchAgentCard';
import type { LaunchAgentSummary } from '../../../../../renderer/components/MarketplaceModal/launch/launchAgents';
import { mockTheme } from '../../../../helpers/mockTheme';

function summary(overrides: Partial<LaunchAgentSummary> = {}): LaunchAgentSummary {
	return {
		name: 'Alpha',
		provider: 'Claude Code',
		model: 'opus',
		folder: '/work/alpha',
		remote: false,
		...overrides,
	};
}

function renderCard(overrides: Partial<LaunchAgentSummary> = {}, action?: React.ReactNode) {
	return render(<LaunchAgentCard theme={mockTheme} summary={summary(overrides)} action={action} />);
}

describe('LaunchAgentCard', () => {
	it('shows the name, provider, model and folder', () => {
		renderCard();

		expect(screen.getByTestId('launch-agent-card-name')).toHaveTextContent('Alpha');
		expect(screen.getByText('Provider').nextElementSibling).toHaveTextContent('Claude Code');
		expect(screen.getByText('Model').nextElementSibling).toHaveTextContent('opus');
		expect(screen.getByText('Folder').nextElementSibling).toHaveTextContent('/work/alpha');
	});

	it('says the provider default for an agent with no model of its own', () => {
		renderCard({ model: null });

		expect(screen.getByText('Model').nextElementSibling).toHaveTextContent('Provider default');
	});

	it('badges an agent on an SSH remote', () => {
		renderCard({ remote: true });

		expect(screen.getByText('SSH')).toBeInTheDocument();
	});

	it('shows no SSH badge for a local agent', () => {
		renderCard({ remote: false });

		expect(screen.queryByText('SSH')).not.toBeInTheDocument();
	});

	it('shows why a launch cannot run on the agent, as an alert', () => {
		renderCard({ problem: 'This agent has no Auto Run folder.' });

		expect(screen.getByRole('alert')).toHaveTextContent('This agent has no Auto Run folder.');
		expect(screen.getByTestId('launch-agent-card-problem')).toBeInTheDocument();
	});

	it('shows no alert when there is no problem', () => {
		renderCard();

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('puts a caller control in the corner', () => {
		renderCard({}, <button type="button">Edit</button>);

		expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
	});

	it('lets the person select the text (a path is worth copying)', () => {
		renderCard();

		expect(screen.getByTestId('launch-agent-card')).toHaveClass('select-text');
	});

	it('uses theme colors, not literals', () => {
		renderCard({ problem: 'No folder.' });

		expect(screen.getByTestId('launch-agent-card')).toHaveStyle({
			borderColor: mockTheme.colors.border,
			backgroundColor: mockTheme.colors.bgMain,
		});
		expect(screen.getByTestId('launch-agent-card-problem')).toHaveStyle({
			color: mockTheme.colors.error,
		});
	});
});
