/**
 * Tests for "System One for agents" in Models > System One: the switch and what
 * it says while the setup still stops agents, the two budgets (a typed value is
 * checked before it is sent, an empty cap is "no cap", an empty daily budget is
 * never zero), today's spend against the budget, and the per-agent table with
 * its window picker.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import type { Theme } from '../../../../../renderer/types';
import {
	SystemOneAgentsSection,
	systemOneUsageWindowStart,
} from '../../../../../renderer/components/Settings/tabs/LocalModelsTab/SystemOneAgentsSection';
import type { SystemOneHookState } from '../../../../../renderer/hooks/localModels';
import {
	SYSTEM_ONE_AGENT_USE_DESCRIPTIONS,
	SYSTEM_ONE_ENGINE_DISCLOSURES,
	type SystemOneAgentSettings,
	type SystemOneReport,
} from '../../../../../shared/local-models/system-one-settings';
import type { SystemOneUsageReport } from '../../../../../shared/local-models/system-one-spend';

const theme = {
	colors: {
		accent: '#a78bfa',
		accentDim: '#a78bfa33',
		accentForeground: '#ffffff',
		textMain: '#ffffff',
		textDim: '#888888',
		border: '#333333',
		bgMain: '#000000',
		bgActivity: '#111111',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as unknown as Theme;

const DEFAULT_AGENTS: SystemOneAgentSettings = {
	enabled: true,
	dailyBudgetUsd: 1,
	perAgentBudgetUsd: null,
};

function report(
	agents: Partial<SystemOneAgentSettings> = {},
	overrides: Partial<SystemOneReport> = {}
): SystemOneReport {
	return {
		settings: {
			engine: 'jev-cloud',
			openJevUrl: null,
			timeoutMs: 1500,
			models: {},
			failPolicies: {},
			keepInputs: false,
			agents: { ...DEFAULT_AGENTS, ...agents },
		},
		engineLabel: 'Jev (TypeSafe cloud)',
		disclosure: SYSTEM_ONE_ENGINE_DISCLOSURES['jev-cloud'],
		baseUrl: 'https://api.typesafe.ai',
		model: null,
		modelLabel: null,
		timeoutMs: 1500,
		calibrated: true,
		keys: { 'jev-cloud': { source: 'stored', storage: 'os' }, openjev: { source: 'none' } },
		problem: null,
		testPassedAt: 1_700_000_000_000,
		failPolicies: [],
		...overrides,
	};
}

function systemOne(
	current: SystemOneReport | null,
	overrides: Partial<SystemOneHookState> = {}
): SystemOneHookState {
	return {
		report: current,
		busy: null,
		error: null,
		test: null,
		refresh: vi.fn(async () => {}),
		set: vi.fn(async () => true),
		setKey: vi.fn(async () => true),
		clearKey: vi.fn(async () => true),
		runTest: vi.fn(async () => {}),
		...overrides,
	};
}

function usage(overrides: Partial<SystemOneUsageReport> = {}): SystemOneUsageReport {
	return {
		since: 0,
		retentionDays: 30,
		rows: [
			{
				agentId: 'agent-1',
				agentName: 'Backend',
				requests: 1200,
				cachedRequests: 300,
				tokensIn: 480_000,
				tokensOut: 2400,
				costUsd: 0.02016,
				averageLatencyMs: 212,
			},
			{
				agentId: 'agent-gone-0001',
				agentName: null,
				requests: 4,
				cachedRequests: 0,
				tokensIn: 1600,
				tokensOut: 8,
				costUsd: 0.0000672,
				averageLatencyMs: 190,
			},
			{
				agentId: null,
				agentName: null,
				requests: 1,
				cachedRequests: 1,
				tokensIn: 0,
				tokensOut: 0,
				costUsd: 0,
				averageLatencyMs: 0,
			},
		],
		totals: {
			requests: 1205,
			cachedRequests: 301,
			tokensIn: 481_600,
			tokensOut: 2408,
			costUsd: 0.0202272,
			averageLatencyMs: 0,
		} as never,
		budget: { dayStartedAt: 0, dailyBudgetUsd: 1, spentTodayUsd: 0.25, remainingTodayUsd: 0.75 },
		engine: 'jev-cloud',
		engineLabel: 'Jev (TypeSafe cloud)',
		notice: null,
		...overrides,
	};
}

const api = () => window.maestro.localModels.systemOne;
const toggle = () => screen.getByRole('switch', { name: 'Let agents use System One' });
const input = (testId: string) =>
	screen.getByTestId(testId).querySelector('input') as HTMLInputElement;

beforeEach(() => {
	vi.mocked(api().usage).mockReset().mockResolvedValue(usage());
	vi.mocked(api().test).mockClear();
});

describe('the switch', () => {
	it('is on by default, says what on means, and names where one agent is switched off', async () => {
		render(<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />);

		expect(toggle()).toHaveAttribute('aria-checked', 'true');
		const row = screen.getByTestId('system-one-agents-use');
		expect(row).toHaveTextContent(SYSTEM_ONE_AGENT_USE_DESCRIPTIONS.on);
		expect(row).toHaveTextContent('Models tab of its own settings');
		// A tested engine: nothing stands in the way, so nothing is warned.
		expect(screen.queryByTestId('system-one-agents-blocker')).toBeNull();
		await screen.findByTestId('system-one-agents-table');
	});

	it('sends off and on as one field, through the tab hook', () => {
		const state = systemOne(report());
		const { rerender } = render(<SystemOneAgentsSection theme={theme} systemOne={state} />);

		fireEvent.click(toggle());
		expect(state.set).toHaveBeenCalledWith({ agents: { enabled: false } });

		const off = systemOne(report({ enabled: false }));
		rerender(<SystemOneAgentsSection theme={theme} systemOne={off} />);
		expect(toggle()).toHaveAttribute('aria-checked', 'false');
		expect(screen.getByTestId('system-one-agents-use')).toHaveTextContent(
			SYSTEM_ONE_AGENT_USE_DESCRIPTIONS.off
		);
		fireEvent.click(toggle());
		expect(off.set).toHaveBeenCalledWith({ agents: { enabled: true } });
	});

	it('says what still stops agents while it is on', () => {
		const { rerender } = render(
			<SystemOneAgentsSection
				theme={theme}
				systemOne={systemOne(report({}, { testPassedAt: null }))}
			/>
		);
		expect(screen.getByTestId('system-one-agents-blocker')).toHaveTextContent(
			'Agents can ask once the engine passes its Test'
		);

		const off = report();
		off.settings.engine = 'off';
		rerender(<SystemOneAgentsSection theme={theme} systemOne={systemOne(off)} />);
		expect(screen.getByTestId('system-one-agents-blocker')).toHaveTextContent(
			'No engine is chosen, so no agent can ask.'
		);

		// Switched off is the whole answer: no second reason under it.
		rerender(
			<SystemOneAgentsSection
				theme={theme}
				systemOne={systemOne(report({ enabled: false }, { testPassedAt: null }))}
			/>
		);
		expect(screen.queryByTestId('system-one-agents-blocker')).toBeNull();
	});

	it('waits for the report and for a change in flight', () => {
		const { rerender } = render(
			<SystemOneAgentsSection theme={theme} systemOne={systemOne(null)} />
		);
		expect(toggle()).toBeDisabled();
		// No budget field is drawn from a default while the report is unread.
		expect(screen.queryByTestId('system-one-agents-daily-budget')).toBeNull();

		rerender(
			<SystemOneAgentsSection theme={theme} systemOne={systemOne(report(), { busy: 'set' })} />
		);
		expect(toggle()).toBeDisabled();
		expect(input('system-one-agents-daily-budget-input')).toBeDisabled();
	});
});

describe('the budgets', () => {
	it('shows what is stored, and saves a typed daily budget as a number', () => {
		const state = systemOne(report({ dailyBudgetUsd: 2.5, perAgentBudgetUsd: 0.25 }));
		render(<SystemOneAgentsSection theme={theme} systemOne={state} />);

		expect(input('system-one-agents-daily-budget-input')).toHaveValue('2.5');
		expect(input('system-one-agents-own-budget-input')).toHaveValue('0.25');
		// Nothing changed yet: nothing to save.
		expect(screen.getByTestId('system-one-agents-daily-budget-save')).toBeDisabled();

		fireEvent.change(input('system-one-agents-daily-budget-input'), { target: { value: '$4' } });
		fireEvent.click(screen.getByTestId('system-one-agents-daily-budget-save'));
		expect(state.set).toHaveBeenCalledWith({ agents: { dailyBudgetUsd: 4 } });
	});

	it('refuses text that is not a budget, an emptied field included, before anything is sent', () => {
		const state = systemOne(report());
		render(<SystemOneAgentsSection theme={theme} systemOne={state} />);

		for (const value of ['', 'lots', '-1', '1001']) {
			fireEvent.change(input('system-one-agents-daily-budget-input'), { target: { value } });
			expect(screen.getByTestId('system-one-agents-daily-budget'), value).toHaveTextContent(
				'A budget is a number of US dollars a day'
			);
			expect(screen.getByTestId('system-one-agents-daily-budget-save')).toBeDisabled();
		}
		expect(state.set).not.toHaveBeenCalled();
	});

	it('takes zero, which is a value: it refuses every agent request', () => {
		const state = systemOne(report());
		render(<SystemOneAgentsSection theme={theme} systemOne={state} />);

		fireEvent.change(input('system-one-agents-daily-budget-input'), { target: { value: '0' } });
		fireEvent.click(screen.getByTestId('system-one-agents-daily-budget-save'));
		expect(state.set).toHaveBeenCalledWith({ agents: { dailyBudgetUsd: 0 } });
		expect(screen.getByTestId('system-one-agents-daily-budget')).toHaveTextContent(
			'0 refuses every agent request'
		);
	});

	it('sets a cap per agent, and removes it when the field is emptied', () => {
		const state = systemOne(report());
		const { rerender } = render(<SystemOneAgentsSection theme={theme} systemOne={state} />);

		// No cap stored and an empty field: the same thing, so nothing to save.
		expect(input('system-one-agents-own-budget-input')).toHaveValue('');
		expect(screen.getByTestId('system-one-agents-own-budget-save')).toBeDisabled();

		fireEvent.change(input('system-one-agents-own-budget-input'), { target: { value: '0.5' } });
		fireEvent.click(screen.getByTestId('system-one-agents-own-budget-save'));
		expect(state.set).toHaveBeenCalledWith({ agents: { perAgentBudgetUsd: 0.5 } });

		const capped = systemOne(report({ perAgentBudgetUsd: 0.5 }));
		rerender(<SystemOneAgentsSection theme={theme} systemOne={capped} />);
		expect(input('system-one-agents-own-budget-input')).toHaveValue('0.5');
		fireEvent.change(input('system-one-agents-own-budget-input'), { target: { value: '  ' } });
		fireEvent.click(screen.getByTestId('system-one-agents-own-budget-save'));
		expect(capped.set).toHaveBeenCalledWith({ agents: { perAgentBudgetUsd: null } });
	});

	it('refuses a cap that is not a budget', () => {
		const state = systemOne(report());
		render(<SystemOneAgentsSection theme={theme} systemOne={state} />);

		fireEvent.change(input('system-one-agents-own-budget-input'), { target: { value: 'none' } });
		expect(screen.getByTestId('system-one-agents-own-budget')).toHaveTextContent(
			'A budget is a number of US dollars a day'
		);
		expect(screen.getByTestId('system-one-agents-own-budget-save')).toBeDisabled();
		expect(state.set).not.toHaveBeenCalled();
	});

	it('follows a budget changed from outside, as after maestro-cli s1 set budget', () => {
		const { rerender } = render(
			<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />
		);
		expect(input('system-one-agents-daily-budget-input')).toHaveValue('1');

		rerender(
			<SystemOneAgentsSection
				theme={theme}
				systemOne={systemOne(report({ dailyBudgetUsd: 3, perAgentBudgetUsd: 0.1 }))}
			/>
		);
		expect(input('system-one-agents-daily-budget-input')).toHaveValue('3');
		expect(input('system-one-agents-own-budget-input')).toHaveValue('0.1');
	});

	it('says a budget never binds on an engine with no price, and not on the hosted one', () => {
		const { rerender } = render(
			<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />
		);
		expect(screen.getByTestId('system-one-agents-daily-budget')).not.toHaveTextContent(
			'has no price'
		);

		const judge = report();
		judge.settings.engine = 'local-judge';
		rerender(<SystemOneAgentsSection theme={theme} systemOne={systemOne(judge)} />);
		expect(screen.getByTestId('system-one-agents-daily-budget')).toHaveTextContent(
			'has no price, so a budget above 0 never binds'
		);
	});
});

describe('the spend', () => {
	it('reads today first, and asks the engine nothing', async () => {
		render(<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />);

		await screen.findByTestId('system-one-agents-table');
		expect(api().usage).toHaveBeenCalledTimes(1);
		const [query] = vi.mocked(api().usage).mock.calls[0];
		expect(query).toEqual({ since: systemOneUsageWindowStart('today', Date.now()) });
		expect(api().test).not.toHaveBeenCalled();
	});

	it("says today's spend against the budget, in a cost a person can read", async () => {
		render(<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />);

		const today = await screen.findByTestId('system-one-agents-today');
		expect(today).toHaveTextContent('$0.25 of $1.00 by all agents, $0.75 left.');
		expect(today).toHaveTextContent('The day starts at local midnight.');
	});

	it('says when the budget is spent and what that does', async () => {
		vi.mocked(api().usage).mockResolvedValue(
			usage({
				budget: { dayStartedAt: 0, dailyBudgetUsd: 1, spentTodayUsd: 1.002, remainingTodayUsd: 0 },
			})
		);
		render(<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />);

		expect(await screen.findByTestId('system-one-agents-today')).toHaveTextContent(
			'The budget is spent: agent requests are refused until local midnight.'
		);
	});

	it('lists one row per agent with its name, and a cost that is not rounded to nothing', async () => {
		render(<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />);

		const rows = await screen.findAllByTestId('system-one-agents-row');
		expect(rows).toHaveLength(3);
		expect(rows[0]).toHaveTextContent('Backend');
		expect(rows[0]).toHaveTextContent('1,200');
		expect(rows[0]).toHaveTextContent('300');
		expect(rows[0]).toHaveTextContent('480,000');
		expect(rows[0]).toHaveTextContent('$0.02');
		expect(rows[0]).toHaveTextContent('212');
		// An agent that no longer exists keeps its row, by the start of its id.
		expect(rows[1]).toHaveTextContent('Removed agent agent-go');
		// Millionths of a dollar are shown, not "<$0.01".
		expect(rows[1]).toHaveTextContent('$0.000067');
		expect(rows[2]).toHaveTextContent('No agent named');
		expect(within(screen.getByTestId('system-one-agents-total')).getByText('1,205')).toBeTruthy();
	});

	it('says so when no agent asked in the window, and draws no total for one row', async () => {
		vi.mocked(api().usage).mockResolvedValue(usage({ rows: [] }));
		const { unmount } = render(
			<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />
		);
		expect(await screen.findByTestId('system-one-agents-empty')).toHaveTextContent(
			'No agent requests in this window.'
		);
		unmount();

		vi.mocked(api().usage).mockResolvedValue(usage({ rows: usage().rows.slice(0, 1) }));
		render(<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />);
		expect(await screen.findAllByTestId('system-one-agents-row')).toHaveLength(1);
		expect(screen.queryByTestId('system-one-agents-total')).toBeNull();
	});

	it('reads again for another window, and everything the ledger keeps asks for no start', async () => {
		render(<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />);
		await screen.findByTestId('system-one-agents-table');

		fireEvent.change(screen.getByTestId('system-one-agents-window'), {
			target: { value: 'all' },
		});
		await waitFor(() => expect(api().usage).toHaveBeenCalledTimes(2));
		expect(vi.mocked(api().usage).mock.calls[1][0]).toBeUndefined();

		fireEvent.change(screen.getByTestId('system-one-agents-window'), {
			target: { value: 'week' },
		});
		await waitFor(() => expect(api().usage).toHaveBeenCalledTimes(3));
		const since = (vi.mocked(api().usage).mock.calls[2][0] as { since: number }).since;
		expect(Date.now() - since).toBeGreaterThanOrEqual(7 * 86_400_000);
		expect(Date.now() - since).toBeLessThan(7 * 86_400_000 + 60_000);
	});

	it('reads again on Refresh, and when main says the settings changed', async () => {
		let changed: (() => void) | undefined;
		vi.mocked(api().onChanged).mockImplementation((handler: () => void) => {
			changed = handler;
			return () => {};
		});
		render(<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />);
		await screen.findByTestId('system-one-agents-table');

		fireEvent.click(screen.getByTestId('system-one-agents-refresh'));
		await waitFor(() => expect(api().usage).toHaveBeenCalledTimes(2));

		// A budget set with `maestro-cli s1 set budget` moves the numbers here.
		changed?.();
		await waitFor(() => expect(api().usage).toHaveBeenCalledTimes(3));
		vi.mocked(api().onChanged).mockReturnValue(() => {});
	});

	it('shows why the rows may be short, and a read that failed', async () => {
		vi.mocked(api().usage).mockResolvedValue(
			usage({ rows: [], notice: 'Usage statistics are off, so the ledger keeps nothing new.' })
		);
		const { unmount } = render(
			<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />
		);
		expect(await screen.findByTestId('system-one-agents-notice')).toHaveTextContent(
			'Usage statistics are off'
		);
		unmount();

		vi.mocked(api().usage).mockRejectedValue(new Error('stats database is locked'));
		render(<SystemOneAgentsSection theme={theme} systemOne={systemOne(report())} />);
		expect(await screen.findByTestId('system-one-agents-error')).toHaveTextContent(
			'stats database is locked'
		);
	});
});

describe('systemOneUsageWindowStart', () => {
	it('starts today at local midnight, a week seven days back, and all with no start', () => {
		const now = new Date(2026, 9, 12, 15, 30, 0).getTime();
		expect(systemOneUsageWindowStart('today', now)).toBe(new Date(2026, 9, 12).getTime());
		expect(systemOneUsageWindowStart('week', now)).toBe(now - 7 * 86_400_000);
		expect(systemOneUsageWindowStart('all', now)).toBeUndefined();
	});
});
