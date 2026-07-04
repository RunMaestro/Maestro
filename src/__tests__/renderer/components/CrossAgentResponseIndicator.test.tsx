import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CrossAgentResponseIndicator } from '../../../renderer/components/CrossAgentResponseIndicator';
import {
	useCrossAgentInFlightStore,
	type InFlightCrossAgentRequest,
} from '../../../renderer/stores/crossAgentInFlightStore';
import { mockTheme } from '../../helpers/mockTheme';

const SESSION = 'sess-1';
const TAB = 'tab-1';

function req(over: Partial<InFlightCrossAgentRequest> = {}): InFlightCrossAgentRequest {
	return {
		requestId: 'r1',
		sourceSessionId: SESSION,
		sourceTabId: TAB,
		targetSessionId: 'target-1',
		targetAgentName: 'Backend',
		targetToolType: 'claude-code',
		startedAt: 1_700_000_000_000,
		...over,
	};
}

function seed(...requests: InFlightCrossAgentRequest[]): void {
	const { start } = useCrossAgentInFlightStore.getState();
	requests.forEach(start);
}

function renderIndicator(
	sourceSessionId: string | null = SESSION,
	sourceTabId: string | null = TAB
) {
	return render(
		<CrossAgentResponseIndicator
			theme={mockTheme}
			sourceSessionId={sourceSessionId}
			sourceTabId={sourceTabId}
		/>
	);
}

describe('CrossAgentResponseIndicator', () => {
	beforeEach(() => {
		useCrossAgentInFlightStore.setState({ requests: {} });
	});

	it('renders nothing when no cross-agent responses are in flight for this tab', () => {
		const { container } = renderIndicator();
		expect(container.firstChild).toBeNull();
	});

	it('shows a singular pill for one in-flight response', () => {
		seed(req());
		renderIndicator();
		expect(screen.getByText('1 agent responding…')).toBeInTheDocument();
	});

	it('pluralizes the count for multiple in-flight responses', () => {
		seed(req({ requestId: 'r1' }), req({ requestId: 'r2', targetAgentName: 'Frontend' }));
		renderIndicator();
		expect(screen.getByText('2 agents responding…')).toBeInTheDocument();
	});

	it('scopes to the source session + tab (ignores other tabs)', () => {
		seed(
			req({ requestId: 'mine' }),
			req({ requestId: 'other-tab', sourceTabId: 'tab-2', targetAgentName: 'Elsewhere' })
		);
		renderIndicator();
		// Only the request for THIS tab counts.
		expect(screen.getByText('1 agent responding…')).toBeInTheDocument();
	});

	it('is collapsed by default and reveals per-agent chips on click', () => {
		seed(req({ requestId: 'r1', targetAgentName: 'Backend' }));
		renderIndicator();

		// Collapsed: the agent-name chip is not shown yet.
		expect(screen.queryByText('Backend')).not.toBeInTheDocument();

		const toggle = screen.getByRole('button', { name: /agent responding/ });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		expect(toggle).toHaveAttribute('title', 'Show consulted agents');

		fireEvent.click(toggle);

		// Expanded: the chip appears and the toggle state/title flip.
		expect(screen.getByText('Backend')).toBeInTheDocument();
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(toggle).toHaveAttribute('title', 'Hide consulted agents');
	});

	it('renders nothing when the tab id is missing', () => {
		seed(req());
		const { container } = renderIndicator(SESSION, null);
		expect(container.firstChild).toBeNull();
	});
});
