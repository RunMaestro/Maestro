import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { mockTheme } from '../../../../helpers/mockTheme';
import { PlannerModelBar } from '../../../../../renderer/components/Wizard/shared/PlannerModelBar';

describe('PlannerModelBar', () => {
	it('names the model the wizard is about to plan with', () => {
		render(
			<PlannerModelBar
				theme={mockTheme}
				selectedAgent="claude-code"
				effectiveModel="sonnet"
				topTierModel="opus"
			/>
		);

		expect(screen.getByText('Claude')).toBeInTheDocument();
		expect(screen.getByText('sonnet')).toBeInTheDocument();
	});

	it('says so plainly when no model can be named', () => {
		render(
			<PlannerModelBar
				theme={mockTheme}
				selectedAgent="opencode"
				effectiveModel={null}
				topTierModel={null}
			/>
		);

		expect(screen.getByText(/its configured model/)).toBeInTheDocument();
	});

	it('offers the top tier only when a handler is wired and it differs', () => {
		const onUseTopTier = vi.fn();
		const { rerender } = render(
			<PlannerModelBar
				theme={mockTheme}
				selectedAgent="claude-code"
				effectiveModel="sonnet"
				topTierModel="opus"
				onUseTopTier={onUseTopTier}
			/>
		);

		fireEvent.click(screen.getByText('Use opus'));
		expect(onUseTopTier).toHaveBeenCalled();

		// Already on the top tier: nothing left to offer.
		rerender(
			<PlannerModelBar
				theme={mockTheme}
				selectedAgent="claude-code"
				effectiveModel="opus"
				topTierModel="opus"
				onUseTopTier={onUseTopTier}
			/>
		);
		expect(screen.queryByText('Use opus')).not.toBeInTheDocument();
	});

	it('renders read-only during generation', () => {
		render(
			<PlannerModelBar
				theme={mockTheme}
				selectedAgent="claude-code"
				effectiveModel="opus"
				topTierModel={null}
			/>
		);

		expect(screen.queryByRole('button')).not.toBeInTheDocument();
	});

	it('lets the user drop back to the agent default', () => {
		const onUseAgentDefault = vi.fn();
		render(
			<PlannerModelBar
				theme={mockTheme}
				selectedAgent="claude-code"
				effectiveModel="opus"
				topTierModel="opus"
				isOverridden
				onUseAgentDefault={onUseAgentDefault}
			/>
		);

		fireEvent.click(screen.getByText('Reset'));
		expect(onUseAgentDefault).toHaveBeenCalled();
	});
});
