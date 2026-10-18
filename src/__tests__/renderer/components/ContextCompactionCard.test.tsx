import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

import {
	ContextCompactionCard,
	describeContextCompaction,
} from '../../../renderer/components/ContextCompactionCard';
import { useRetryStore, type RetryEntry } from '../../../renderer/stores/retryStore';
import { mockTheme } from '../../helpers/mockTheme';
import type { AgentError, LogEntry } from '../../../renderer/types';

type CompactionRecord = NonNullable<LogEntry['contextCompaction']>;

const logWith = (record?: CompactionRecord): LogEntry => ({
	id: 'log-1',
	timestamp: 0,
	source: 'system',
	text: 'Compacted the conversation to fit the context window',
	...(record ? { contextCompaction: record } : {}),
});

/** A recovery in the retry store that is driving the pill with this log id. */
function liveRecovery(entryId: string): RetryEntry {
	return {
		sessionId: 's1',
		tabId: 't1',
		key: 's1:t1',
		outageId: 'o1',
		strategy: 'context-compaction',
		mode: 'resend',
		status: 'in-flight',
		attempt: 0,
		startedAt: 0,
		nextRetryAt: 0,
		lastMessage: 'Prompt is too long',
		compaction: {
			pill: { sessionId: 's1', tabId: 't1', entryId },
			error: { type: 'token_exhaustion', message: 'Prompt is too long' } as AgentError,
			compacted: false,
		},
	};
}

describe('ContextCompactionCard', () => {
	beforeEach(() => {
		useRetryStore.setState({ retries: {}, outages: {} });
	});

	it('renders nothing for an entry with no compaction record', () => {
		const { container } = render(<ContextCompactionCard log={logWith()} theme={mockTheme} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('spins while a live recovery is compacting', () => {
		useRetryStore.setState({ retries: { 's1:t1': liveRecovery('log-1') }, outages: {} });
		render(<ContextCompactionCard log={logWith({ status: 'pending' })} theme={mockTheme} />);

		expect(screen.getByText('Compacting context')).toBeInTheDocument();
		expect(screen.getByTestId('context-compaction-card')).toHaveAttribute('data-state', 'working');
	});

	it('does not spin for a pending pill nothing is driving', () => {
		// What an app quit mid-compaction leaves behind in the saved transcript.
		render(<ContextCompactionCard log={logWith({ status: 'pending' })} theme={mockTheme} />);

		expect(screen.getByText('Context compaction stopped')).toBeInTheDocument();
		expect(screen.getByTestId('context-compaction-card')).toHaveAttribute('data-state', 'stopped');
	});

	it('says the message was sent again once the compaction lands', () => {
		render(<ContextCompactionCard log={logWith({ status: 'done' })} theme={mockTheme} />);

		expect(screen.getByText('Context compacted')).toBeInTheDocument();
		expect(screen.getByText(/Your message was sent again/)).toBeInTheDocument();
	});

	it('carries the reason on a failed compaction', () => {
		render(
			<ContextCompactionCard
				log={logWith({ status: 'error', error: 'Prompt is too long' })}
				theme={mockTheme}
			/>
		);

		const card = screen.getByTestId('context-compaction-card');
		expect(screen.getByText('Context compaction failed')).toBeInTheDocument();
		expect(card).toHaveAttribute('title', 'Prompt is too long');
		expect(card).toHaveAttribute('data-state', 'failed');
	});

	it('maps every outcome to a state', () => {
		expect(describeContextCompaction('pending', true).state).toBe('working');
		expect(describeContextCompaction('pending', false).state).toBe('stopped');
		expect(describeContextCompaction('done', false).state).toBe('done');
		expect(describeContextCompaction('error', false).state).toBe('failed');
		expect(describeContextCompaction('canceled', false).state).toBe('stopped');
	});
});
