import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SessionListStatsBar } from '../../../../../renderer/components/AgentSessionsBrowser/components/SessionListStatsBar';

const theme = {
	colors: {
		textDim: '#888',
		textMain: '#fff',
		accent: '#7C3AED',
		success: '#22c55e',
		warning: '#f59e0b',
		border: '#333',
		bgActivity: '#111',
	},
} as any;

function makeStats(overrides: any = {}) {
	return {
		totalSessions: 10,
		totalMessages: 100,
		totalSize: 1024 * 1024,
		totalCost: 2.5,
		totalTokens: 5000,
		oldestSession: null,
		isComplete: true,
		...overrides,
	};
}

describe('SessionListStatsBar', () => {
	it('renders nothing when loading', () => {
		const { container } = render(
			<SessionListStatsBar
				loading={true}
				sessionsCount={5}
				stats={makeStats()}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it('renders nothing when sessions is empty', () => {
		const { container } = render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={0}
				stats={makeStats()}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(container.firstChild).toBeNull();
	});

	it('shows singular "session" when totalSessions is 1', () => {
		render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={1}
				stats={makeStats({ totalSessions: 1 })}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(screen.getByText(/1 session\b/)).toBeTruthy();
	});

	it('shows plural "sessions" when totalSessions > 1', () => {
		render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={5}
				stats={makeStats({ totalSessions: 5 })}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(screen.getByText(/5 sessions/)).toBeTruthy();
	});

	it('shows messages count', () => {
		render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={5}
				stats={makeStats({ totalMessages: 42 })}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(screen.getByText(/42 messages/)).toBeTruthy();
	});

	it('shows cost when totalCost > 0 and isComplete', () => {
		render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={5}
				stats={makeStats({ totalCost: 1.23, isComplete: true })}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(screen.getByText(/\$1\.23/)).toBeTruthy();
	});

	it('shows cost when not isComplete (loading)', () => {
		render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={5}
				stats={makeStats({ totalCost: 0, isComplete: false })}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(screen.getByText(/\$0\.00/)).toBeTruthy();
	});

	it('hides cost when totalCost is 0 AND isComplete', () => {
		const { container } = render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={5}
				stats={makeStats({ totalCost: 0, isComplete: true })}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(container.textContent).not.toContain('$');
	});

	it('shows sessionSinceDate when provided', () => {
		const date = new Date('2024-01-15');
		render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={5}
				stats={makeStats()}
				sessionSinceDate={date}
				theme={theme}
			/>
		);
		expect(screen.getByText(new RegExp(date.toLocaleDateString()))).toBeTruthy();
	});

	it('hides sessionSinceDate when null', () => {
		render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={5}
				stats={makeStats()}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(screen.queryByText(/Since/)).toBeNull();
	});

	it('shows animate-pulse class when not isComplete', () => {
		const { container } = render(
			<SessionListStatsBar
				loading={false}
				sessionsCount={5}
				stats={makeStats({ isComplete: false })}
				sessionSinceDate={null}
				theme={theme}
			/>
		);
		expect(container.innerHTML).toContain('animate-pulse');
	});
});
