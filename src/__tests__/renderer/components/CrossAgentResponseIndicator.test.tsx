import { describe, it, expect, beforeEach, vi } from 'vitest';
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
		startedAt: Date.now(),
		...over,
	};
}

function seed(...requests: InFlightCrossAgentRequest[]): void {
	const { start } = useCrossAgentInFlightStore.getState();
	requests.forEach(start);
}

function renderIndicator(
	sourceSessionId: string | null = SESSION,
	sourceTabId: string | null = TAB,
	onSessionClick?: (sessionId: string, tabId?: string) => void
) {
	return render(
		<CrossAgentResponseIndicator
			theme={mockTheme}
			sourceSessionId={sourceSessionId}
			sourceTabId={sourceTabId}
			onSessionClick={onSessionClick}
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

	it('jumps to the consulted agent AND its consult tab when a chip is clicked', () => {
		seed(req({ targetSessionId: 'target-1', targetTabId: 'consult-tab-9' }));
		const onSessionClick = vi.fn();
		renderIndicator(SESSION, TAB, onSessionClick);

		fireEvent.click(screen.getByRole('button', { name: /agent responding/ }));
		const chip = screen.getByRole('button', { name: /Backend/ });
		expect(chip).toHaveAttribute('title', expect.stringContaining('Jump to Backend'));

		fireEvent.click(chip);
		expect(onSessionClick).toHaveBeenCalledWith('target-1', 'consult-tab-9');
	});

	it('still jumps to the agent when the consult tab is unknown', () => {
		seed(req({ targetSessionId: 'target-1', targetTabId: undefined }));
		const onSessionClick = vi.fn();
		renderIndicator(SESSION, TAB, onSessionClick);

		fireEvent.click(screen.getByRole('button', { name: /agent responding/ }));
		fireEvent.click(screen.getByRole('button', { name: /Backend/ }));
		expect(onSessionClick).toHaveBeenCalledWith('target-1', undefined);
	});

	it('leaves the chip inert when no navigation handler is provided', () => {
		seed(req());
		renderIndicator();

		fireEvent.click(screen.getByRole('button', { name: /agent responding/ }));
		const chip = screen.getByRole('button', { name: /Backend/ });
		expect(chip).toBeDisabled();
		expect(chip.getAttribute('title')).toMatch(/^Backend · \d+s$/);
	});

	it('humanizes the chip elapsed time past a minute', () => {
		// Below a minute a bare seconds count reads fine; past it, `1203s` does not.
		seed(req({ startedAt: Date.now() - (20 * 60 + 4) * 1000 }));
		renderIndicator();

		fireEvent.click(screen.getByRole('button', { name: /agent responding/ }));
		const chip = screen.getByRole('button', { name: /Backend/ });
		expect(chip.getAttribute('title')).toBe('Backend · 20m 4s');
	});

	it('renders nothing when the tab id is missing', () => {
		seed(req());
		const { container } = renderIndicator(SESSION, null);
		expect(container.firstChild).toBeNull();
	});
});
