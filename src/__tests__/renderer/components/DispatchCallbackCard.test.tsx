import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../../renderer/utils/jumpToAgentConversation', () => ({
	jumpToAgentConversation: vi.fn(),
}));

import { DispatchCallbackCard } from '../../../renderer/components/DispatchCallbackCard';
import { jumpToAgentConversation } from '../../../renderer/utils/jumpToAgentConversation';
import { mockTheme } from '../../helpers/mockTheme';
import type { ParsedDispatchCallback } from '../../../shared/dispatchCallbackCard';

const parsed = (overrides: Partial<ParsedDispatchCallback> = {}): ParsedDispatchCallback => ({
	targetName: '🖥 Proxmox',
	status: 'completed',
	exitCode: '0',
	duration: '25m 39s',
	tabId: 'tab-9',
	targetAgentId: 'proxmox',
	tasksCompleted: 'n/a',
	tasksTotal: 'n/a',
	dispatchedPrompt: 'close the blockers',
	output: 'All five gates green. One gap reported.',
	...overrides,
});

describe('DispatchCallbackCard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('names who it came back from, the exit code, and the duration', () => {
		render(<DispatchCallbackCard parsed={parsed()} theme={mockTheme} />);
		expect(screen.getByText('Returned from')).toBeInTheDocument();
		expect(screen.getByTestId('dispatch-callback-target')).toHaveTextContent('🖥 Proxmox');
		expect(screen.getByTestId('dispatch-callback-meta')).toHaveTextContent('exit 0');
		expect(screen.getByTestId('dispatch-callback-meta')).toHaveTextContent('25m 39s');
	});

	it('keeps the result hidden until the toggle is clicked', () => {
		render(<DispatchCallbackCard parsed={parsed()} theme={mockTheme} />);
		expect(screen.queryByText(/All five gates green/)).not.toBeInTheDocument();
		fireEvent.click(screen.getByTestId('dispatch-callback-toggle'));
		expect(screen.getByText(/All five gates green/)).toBeInTheDocument();
	});

	it('shows Auto Run task counts when present', () => {
		render(
			<DispatchCallbackCard
				parsed={parsed({ tasksCompleted: '5', tasksTotal: '5' })}
				theme={mockTheme}
			/>
		);
		expect(screen.getByTestId('dispatch-callback-meta')).toHaveTextContent('5/5');
	});

	it('omits the exit label for a timeout with no exit code, and badges it', () => {
		render(
			<DispatchCallbackCard
				parsed={parsed({ status: 'timeout', exitCode: 'n/a' })}
				theme={mockTheme}
			/>
		);
		expect(screen.getByTestId('dispatch-callback-meta')).not.toHaveTextContent('exit');
		expect(screen.getByTestId('dispatch-callback-status')).toHaveTextContent('Timed out');
	});

	it('jumps to the source tab from the target name and the corner arrow', () => {
		render(<DispatchCallbackCard parsed={parsed()} theme={mockTheme} />);
		fireEvent.click(screen.getByTitle('Open "🖥 Proxmox"'));
		fireEvent.click(screen.getByLabelText('Open 🖥 Proxmox tab'));
		expect(jumpToAgentConversation).toHaveBeenCalledTimes(2);
		expect(jumpToAgentConversation).toHaveBeenCalledWith({
			sessionId: 'proxmox',
			tabId: 'tab-9',
			agentName: '🖥 Proxmox',
		});
	});

	it('offers no result toggle when there is no output', () => {
		render(<DispatchCallbackCard parsed={parsed({ output: '' })} theme={mockTheme} />);
		expect(screen.queryByTestId('dispatch-callback-toggle')).not.toBeInTheDocument();
	});
});
