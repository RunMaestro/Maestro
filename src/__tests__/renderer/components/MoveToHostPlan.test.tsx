/**
 * The Move to Host plan view: stays fold to one row per kind, the active conversation leads, and
 * a long conversation list folds behind "+ N more".
 */

import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
	MoveToHostPlan,
	groupLiftStays,
	liftPlanOneLine,
} from '../../../renderer/components/MoveToHostPlan';
import { THEMES } from '../../../renderer/constants/themes';
import type { LiftPlanSummary } from '../../../shared/maestro-lib/agents/lift-plan';

const theme = THEMES['dracula'];

const HIDDEN_REASON = 'A hidden consult tab belongs to the consult that opened it on this machine.';

function summaryWith(overrides: Partial<LiftPlanSummary> = {}): LiftPlanSummary {
	return {
		agent: { id: 'a1', name: 'Substrate', provider: 'claude-code' },
		peer: 'pedtome',
		remote: { id: 'r1', name: 'pedtome' },
		cwd: '/Users/me/Substrate',
		model: 'opus',
		effort: 'high',
		env: { sent: ['CLAUDE_CONFIG_DIR'], secretsSent: [], withheld: [] },
		tabs: Array.from({ length: 7 }, (_, index) => ({
			id: `t${index}`,
			name: `Tab ${index}`,
			agentSessionId: `s${index}`,
			entries: index + 1,
		})),
		activeTabId: 't6',
		queued: [],
		stays: [],
		...overrides,
	};
}

describe('groupLiftStays', () => {
	it('folds identical hidden tabs into one row and names secret keys', () => {
		const rows = groupLiftStays([
			{ kind: 'hidden-tab', ref: 'h1', reason: HIDDEN_REASON },
			{ kind: 'hidden-tab', ref: 'h2', reason: HIDDEN_REASON },
			{ kind: 'secret-env', ref: 'API_KEY', reason: 'Secret.' },
			{ kind: 'secret-env', ref: 'TOKEN', reason: 'Secret.' },
		]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({ kind: 'hidden-tab', title: '2 hidden consult tabs' });
		expect(rows[1].title).toBe('2 secret env vars');
		expect(rows[1].detail).toContain('API_KEY, TOKEN');
	});

	it('counts queued messages and keeps each distinct reason once', () => {
		const rows = groupLiftStays([
			{ kind: 'queued-command', ref: 'q1', reason: 'Queued /x is a command.' },
			{ kind: 'queued-command', ref: 'q2', reason: 'Queued /x is a command.' },
			{ kind: 'queued-image', ref: 'q3', reason: 'Images stay.' },
		]);
		expect(rows.map((row) => row.title)).toEqual(['2 queued messages', '1 queued message']);
		expect(rows[0].detail).toBe('Queued /x is a command.');
	});
});

// Parity R52: transcript images that cannot move are one row, counted by image.
describe('groupLiftStays: transcript images (R52)', () => {
	it('counts the images of every tab whose transcript keeps some here', () => {
		const rows = groupLiftStays([
			{ kind: 'transcript-image', ref: 't1', count: 2, reason: '2 image(s) in "Main" stay.' },
			{ kind: 'transcript-image', ref: 't2', count: 1, reason: '1 image(s) in "Notes" stay.' },
		]);
		expect(rows).toEqual([
			{
				kind: 'transcript-image',
				title: '3 conversation images',
				detail: '2 image(s) in "Main" stay. 1 image(s) in "Notes" stay.',
			},
		]);
	});
});

describe('liftPlanOneLine', () => {
	it('names the counts and where they go', () => {
		const line = liftPlanOneLine(
			summaryWith({ stays: [{ kind: 'hidden-tab', ref: 'h1', reason: HIDDEN_REASON }] })
		);
		expect(line).toBe('7 conversations · 1 env var · 1 hidden consult tab stay → pedtome');
	});
});

describe('MoveToHostPlan', () => {
	it('leads with the open tab and folds the rest behind + N more', () => {
		render(<MoveToHostPlan theme={theme} summary={summaryWith()} />);
		expect(screen.getByText('7 conversations continue on pedtome')).toBeTruthy();
		const rows = screen.getAllByText(/^Tab \d$/).map((row) => row.textContent);
		expect(rows).toEqual(['Tab 6', 'Tab 0', 'Tab 1', 'Tab 2', 'Tab 3']);
		expect(screen.getByText('open tab')).toBeTruthy();

		fireEvent.click(screen.getByText('+ 2 more'));
		expect(screen.getAllByText(/^Tab \d$/)).toHaveLength(7);
	});

	it('says a tab with no provider session starts fresh', () => {
		render(
			<MoveToHostPlan
				theme={theme}
				summary={summaryWith({
					tabs: [{ id: 't0', name: 'New', agentSessionId: null, entries: 0 }],
					activeTabId: undefined,
				})}
			/>
		);
		expect(screen.getByText('starts fresh')).toBeTruthy();
	});

	it("says how many of the earlier copy's tabs merge and how many stay as copies (U4)", () => {
		const { rerender } = render(
			<MoveToHostPlan
				theme={theme}
				summary={summaryWith({
					replaces: 'pedtome:old',
					tabMerge: { merged: 11, copies: 1, added: 1 },
				})}
			/>
		);
		expect(screen.getByTestId('move-to-host-tab-merge').textContent).toBe(
			'The host copy\'s tabs: 11 tabs merge into the tab of the same conversation; 1 tab stays as a copy named "(on the host)" (both sides went on after the Move Back); 1 tab comes in that only the host had.'
		);
		// A plain lift replaces no copy and says nothing about one.
		rerender(<MoveToHostPlan theme={theme} summary={summaryWith()} />);
		expect(screen.queryByTestId('move-to-host-tab-merge')).toBeNull();
	});
});
