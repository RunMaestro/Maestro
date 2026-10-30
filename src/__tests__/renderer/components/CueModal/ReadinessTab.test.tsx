/**
 * The Cue modal's Readiness tab: the same report as `maestro-cli cue engine
 * check`, in the same words, loaded on open and re-run by Refresh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ReadinessTab } from '../../../../renderer/components/CueModal/ReadinessTab';
import { THEMES } from '../../../../renderer/constants/themes';
import type { CueReadinessReport } from '../../../../shared/cue/readiness';

const theme = THEMES['dracula'];
const checkReadiness = () => window.maestro.cue.checkReadiness as ReturnType<typeof vi.fn>;

const ready: CueReadinessReport = {
	ready: true,
	checkedAt: '2026-10-20T12:00:00.000Z',
	agents: 2,
	workspaces: 1,
	subscriptions: 3,
	gaps: [],
};

const notReady: CueReadinessReport = {
	...ready,
	ready: false,
	gaps: [
		{
			kind: 'binary-missing',
			agentId: 'a1',
			agentName: 'Coder',
			message: 'Agent "Coder": Codex was not found. Install it.',
		},
		{
			kind: 'secret-missing',
			secret: 'DEPLOY_TOKEN',
			message: 'Agent "Coder" requires secret DEPLOY_TOKEN, which is not set.',
		},
		{
			kind: 'tool-missing',
			tool: 'gh',
			message: 'GitHub trigger "pr-review" needs the GitHub CLI (gh), which is not installed.',
		},
	],
};

beforeEach(() => {
	checkReadiness().mockReset();
});

describe('ReadinessTab', () => {
	it('shows a ready report with no gap list', async () => {
		checkReadiness().mockResolvedValue(ready);
		render(<ReadinessTab theme={theme} />);
		expect(
			await screen.findByText(
				'Ready: 2 agent(s), 1 workspace(s), 3 subscription(s) checked, no gaps.'
			)
		).toBeInTheDocument();
		expect(screen.queryByTestId('cue-readiness-gaps')).not.toBeInTheDocument();
	});

	it('shows a not-ready report and lists every gap with its kind and message', async () => {
		checkReadiness().mockResolvedValue(notReady);
		render(<ReadinessTab theme={theme} />);
		expect(
			await screen.findByText(
				'Not ready: 3 gap(s) across 2 agent(s), 1 workspace(s), 3 subscription(s).'
			)
		).toBeInTheDocument();
		const rows = within(screen.getByTestId('cue-readiness-gaps')).getAllByRole('listitem');
		expect(rows).toHaveLength(3);
		notReady.gaps.forEach((gap, i) => {
			expect(rows[i]).toHaveTextContent(gap.kind);
			expect(rows[i]).toHaveTextContent(gap.message);
		});
		// The modal root is select-none: gap messages stay copyable.
		expect(screen.getByText(notReady.gaps[0].message)).toHaveClass('select-text');
	});

	it('re-runs the check on Refresh', async () => {
		checkReadiness().mockResolvedValueOnce(notReady).mockResolvedValueOnce(ready);
		render(<ReadinessTab theme={theme} />);
		await screen.findByTestId('cue-readiness-gaps');
		expect(checkReadiness()).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTestId('cue-readiness-refresh'));
		await waitFor(() => expect(checkReadiness()).toHaveBeenCalledTimes(2));
		expect(await screen.findByText(/^Ready:/)).toBeInTheDocument();
		expect(screen.queryByTestId('cue-readiness-gaps')).not.toBeInTheDocument();
	});

	it('shows why the check failed instead of a report', async () => {
		checkReadiness().mockRejectedValue(new Error('CueDisabled'));
		render(<ReadinessTab theme={theme} />);
		expect(await screen.findByTestId('cue-readiness-error')).toHaveTextContent('CueDisabled');
		expect(screen.getByText('Readiness check failed')).toBeInTheDocument();
	});
});
