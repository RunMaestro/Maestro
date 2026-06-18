import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionDetailStatsPanel } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionDetailStatsPanel';
import type { AgentSession } from '../../../../../renderer/hooks/agent/useSessionViewer';

const theme = {
	colors: {
		textDim: '#888',
		textMain: '#fff',
		accent: '#7C3AED',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
		border: '#333',
		bgActivity: '#111',
	},
} as any;

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		sessionId: 's1',
		projectPath: '/p',
		timestamp: '2024-01-01T00:00:00Z',
		modifiedAt: '2024-01-01T00:00:00Z',
		firstMessage: '',
		messageCount: 10,
		sizeBytes: 2048,
		costUsd: 1.23,
		inputTokens: 500,
		outputTokens: 300,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 125,
		...overrides,
	};
}

describe('SessionDetailStatsPanel', () => {
	it('displays cost as $X.XX', () => {
		render(
			<SessionDetailStatsPanel viewingSession={makeSession({ costUsd: 1.23 })} theme={theme} />
		);
		expect(screen.getByText('$1.23')).toBeTruthy();
	});

	it('displays $0.00 when costUsd is 0', () => {
		render(<SessionDetailStatsPanel viewingSession={makeSession({ costUsd: 0 })} theme={theme} />);
		expect(screen.getByText('$0.00')).toBeTruthy();
	});

	it('displays $0.00 when costUsd is null/undefined', () => {
		render(
			<SessionDetailStatsPanel viewingSession={makeSession({ costUsd: undefined })} theme={theme} />
		);
		expect(screen.getByText('$0.00')).toBeTruthy();
	});

	it('formats duration <60s as Ns', () => {
		render(
			<SessionDetailStatsPanel
				viewingSession={makeSession({ durationSeconds: 45 })}
				theme={theme}
			/>
		);
		expect(screen.getByText('45s')).toBeTruthy();
	});

	it('formats duration <3600s as Nm Ns', () => {
		render(
			<SessionDetailStatsPanel
				viewingSession={makeSession({ durationSeconds: 125 })}
				theme={theme}
			/>
		);
		expect(screen.getByText('2m 5s')).toBeTruthy();
	});

	it('formats duration >=3600s as Nh Nm', () => {
		render(
			<SessionDetailStatsPanel
				viewingSession={makeSession({ durationSeconds: 3725 })}
				theme={theme}
			/>
		);
		expect(screen.getByText('1h 2m')).toBeTruthy();
	});

	it('displays messages count', () => {
		render(
			<SessionDetailStatsPanel viewingSession={makeSession({ messageCount: 42 })} theme={theme} />
		);
		expect(screen.getByText('42')).toBeTruthy();
	});

	it('shows cache read row when cacheReadTokens > 0', () => {
		render(
			<SessionDetailStatsPanel
				viewingSession={makeSession({ cacheReadTokens: 100 })}
				theme={theme}
			/>
		);
		expect(screen.getByText(/Cache Read:/)).toBeTruthy();
	});

	it('hides cache read row when cacheReadTokens is 0', () => {
		render(
			<SessionDetailStatsPanel viewingSession={makeSession({ cacheReadTokens: 0 })} theme={theme} />
		);
		expect(screen.queryByText(/Cache Read:/)).toBeNull();
	});

	it('shows cache write row when cacheCreationTokens > 0', () => {
		render(
			<SessionDetailStatsPanel
				viewingSession={makeSession({ cacheCreationTokens: 50 })}
				theme={theme}
			/>
		);
		expect(screen.getByText(/Cache Write:/)).toBeTruthy();
	});

	it('hides cache write row when cacheCreationTokens is 0', () => {
		render(
			<SessionDetailStatsPanel
				viewingSession={makeSession({ cacheCreationTokens: 0 })}
				theme={theme}
			/>
		);
		expect(screen.queryByText(/Cache Write:/)).toBeNull();
	});

	it('shows Input and Output token rows', () => {
		render(
			<SessionDetailStatsPanel
				viewingSession={makeSession({ inputTokens: 500, outputTokens: 300 })}
				theme={theme}
			/>
		);
		expect(screen.getByText(/Input:/)).toBeTruthy();
		expect(screen.getByText(/Output:/)).toBeTruthy();
	});
});
