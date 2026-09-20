import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../../../renderer/utils/jumpToAgentConversation', () => ({
	jumpToAgentConversation: vi.fn(),
}));

import {
	AgentDelegationCard,
	describeDelegation,
} from '../../../renderer/components/AgentDelegationCard';
import { jumpToAgentConversation } from '../../../renderer/utils/jumpToAgentConversation';
import { mockTheme } from '../../helpers/mockTheme';
import type { LogEntry } from '../../../renderer/types';

type DelegationRecord = NonNullable<LogEntry['delegation']>;

const delegation = (overrides: Partial<DelegationRecord> = {}): DelegationRecord => ({
	kind: 'dispatch',
	toSessionId: 'proxmox',
	toTabId: 'tab-9',
	toAgentName: '🖥 Proxmox',
	toToolType: 'claude-code',
	subject: 'Fix the advisory recovery bug',
	...overrides,
});

const logWith = (record?: DelegationRecord): LogEntry => ({
	id: 'log-1',
	timestamp: 0,
	source: 'system',
	text: 'Delegated to 🖥 Proxmox: Fix the advisory recovery bug',
	...(record ? { delegation: record } : {}),
});

describe('AgentDelegationCard', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('names the verb, the target agent, its provider, and the subject', () => {
		render(<AgentDelegationCard log={logWith(delegation())} theme={mockTheme} />);

		expect(screen.getByText('Delegated to')).toBeInTheDocument();
		expect(screen.getByText('🖥 Proxmox')).toBeInTheDocument();
		expect(screen.getByText('Claude Code')).toBeInTheDocument();
		expect(screen.getByText('Fix the advisory recovery bug')).toBeInTheDocument();
	});

	it('jumps to the tab the work landed in from both the name and the arrow', () => {
		render(<AgentDelegationCard log={logWith(delegation())} theme={mockTheme} />);

		fireEvent.click(screen.getByTitle('Open "🖥 Proxmox"'));
		fireEvent.click(screen.getByLabelText('Jump to 🖥 Proxmox'));

		expect(jumpToAgentConversation).toHaveBeenCalledTimes(2);
		expect(jumpToAgentConversation).toHaveBeenCalledWith({
			sessionId: 'proxmox',
			tabId: 'tab-9',
			agentName: '🖥 Proxmox',
		});
	});

	it('spins while an ask is still waiting on its answer', () => {
		render(
			<AgentDelegationCard
				log={logWith(delegation({ kind: 'ask', status: 'pending' }))}
				theme={mockTheme}
			/>
		);

		expect(screen.getByText('Asking')).toBeInTheDocument();
		expect(screen.getByTestId('loader2-icon')).toBeInTheDocument();
	});

	it('renders nothing for an entry that is not a delegation', () => {
		const { container } = render(<AgentDelegationCard log={logWith()} theme={mockTheme} />);
		expect(container).toBeEmptyDOMElement();
	});
});

describe('describeDelegation', () => {
	it.each([
		[{}, { verb: 'Delegated to' }],
		[{ newTab: true }, { verb: 'Delegated to', badge: 'New tab' }],
		[{ queued: true }, { verb: 'Delegated to', badge: 'Queued' }],
		[{ kind: 'ask' as const, status: 'pending' as const }, { verb: 'Asking' }],
		[{ kind: 'ask' as const, status: 'done' as const }, { verb: 'Asked' }],
		[
			{ kind: 'ask' as const, status: 'error' as const },
			{ verb: 'Asked', badge: 'No answer' },
		],
		[
			{ kind: 'ask' as const, status: 'canceled' as const },
			{ verb: 'Asked', badge: 'Stopped' },
		],
	])('describes %o', (overrides, expected) => {
		expect(describeDelegation(delegation(overrides))).toEqual(expected);
	});
});
