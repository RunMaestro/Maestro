/**
 * Tests for AgentCountTrendChart (Agent Overview: "Agents Over Time").
 *
 * The series rules are covered in `src/__tests__/shared/agentCountTimeline.test.ts`;
 * these tests cover the wiring: lifecycle rows are fetched for ALL time, and
 * the caption reports the live count plus range churn.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AgentCountTrendChart } from '../../../../renderer/components/UsageDashboard/AgentCountTrendChart';
import { clearCachedResources } from '../../../../renderer/hooks/utils/useCachedResource';
import type { Session } from '../../../../renderer/types';
import { THEMES } from '../../../../shared/themes';

const theme = THEMES['dracula'];
const DAY = 24 * 60 * 60 * 1000;

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
	return {
		id,
		name: id,
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
		fullPath: '/tmp',
		projectRoot: '/tmp',
		aiLogs: [],
		shellLogs: [],
		createdAt: Date.now() - 2 * DAY,
		...overrides,
	} as Session;
}

describe('AgentCountTrendChart', () => {
	beforeEach(() => {
		clearCachedResources();
		vi.mocked(window.maestro.stats.getSessionLifecycle).mockResolvedValue([]);
	});

	it('fetches lifecycle rows for all time, whatever the selected range', async () => {
		render(<AgentCountTrendChart sessions={[]} timeRange="week" theme={theme} />);
		await waitFor(() =>
			expect(window.maestro.stats.getSessionLifecycle).toHaveBeenCalledWith('all')
		);
	});

	it('reports the live count, created, and deleted agents, ignoring terminals', async () => {
		vi.mocked(window.maestro.stats.getSessionLifecycle).mockResolvedValue([
			{
				id: 'row-1',
				sessionId: 'deleted-agent',
				agentType: 'codex',
				createdAt: Date.now() - 20 * DAY,
				closedAt: Date.now() - DAY,
			},
		]);

		render(
			<AgentCountTrendChart
				sessions={[
					makeSession('a'),
					makeSession('b', { createdAt: Date.now() - 20 * DAY }),
					makeSession('term', { toolType: 'terminal' }),
				]}
				timeRange="week"
				theme={theme}
			/>
		);

		await waitFor(() =>
			expect(screen.getByTestId('agent-count-trend').textContent).toContain(
				'2 now · 1 created · 1 deleted in this range'
			)
		);
		expect(screen.getByRole('img', { name: 'Agent count over time' })).toBeInTheDocument();
	});
});
