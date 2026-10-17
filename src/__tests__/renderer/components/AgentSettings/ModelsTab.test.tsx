/**
 * @fileoverview Tests for ModelsTab: the intro line, the Run on, tiers and
 * gateway slots, and the empty state when a modal fills none.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ModelsTab } from '../../../../renderer/components/AgentSettings/ModelsTab';
import { createMockTheme } from '../../../helpers/mockTheme';

const theme = createMockTheme();
const INTRO = "Where this agent's model runs, and what its requests pass through.";

describe('ModelsTab', () => {
	it('renders the intro, then Run on, then the gateway', () => {
		render(
			<ModelsTab
				theme={theme}
				idPrefix="edit-agent"
				runOn={<div data-testid="run-on-slot" />}
				gateway={<div data-testid="gateway-slot" />}
			/>
		);

		expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'edit-agent-tabpanel-models');
		expect(screen.getByText(INTRO)).toBeInTheDocument();
		const runOn = screen.getByTestId('run-on-slot');
		const gateway = screen.getByTestId('gateway-slot');
		expect(runOn.compareDocumentPosition(gateway) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(screen.queryByText('Nothing to set here yet.')).not.toBeInTheDocument();
	});

	it('renders the tiers between Run on and the gateway', () => {
		render(
			<ModelsTab
				theme={theme}
				idPrefix="edit-agent"
				runOn={<div data-testid="run-on-slot" />}
				tiers={<div data-testid="tiers-slot" />}
				gateway={<div data-testid="gateway-slot" />}
			/>
		);

		const tiers = screen.getByTestId('tiers-slot');
		expect(
			screen.getByTestId('run-on-slot').compareDocumentPosition(tiers) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
		expect(
			tiers.compareDocumentPosition(screen.getByTestId('gateway-slot')) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
	});

	it('is not empty when a modal fills the tiers slot alone', () => {
		render(
			<ModelsTab theme={theme} idPrefix="edit-agent" tiers={<div data-testid="tiers-slot" />} />
		);
		expect(screen.queryByText('Nothing to set here yet.')).not.toBeInTheDocument();
	});

	it('renders the gateway alone while Run on is not built', () => {
		render(
			<ModelsTab theme={theme} idPrefix="edit-agent" gateway={<div data-testid="gateway-slot" />} />
		);
		expect(screen.getByTestId('gateway-slot')).toBeInTheDocument();
		expect(screen.queryByText('Nothing to set here yet.')).not.toBeInTheDocument();
	});

	it('shows an empty state when the modal fills neither slot', () => {
		render(<ModelsTab theme={theme} idPrefix="new-agent" />);
		expect(screen.getByText(INTRO)).toBeInTheDocument();
		expect(screen.getByText('Nothing to set here yet.')).toBeInTheDocument();
	});
});
