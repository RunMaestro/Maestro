/**
 * SystemOneAgentsSection - "System One for agents" in Models > System One:
 * whether agents may ask System One with `maestro-cli s1`, what they may spend
 * in a day, and what each of them has spent.
 *
 * The switch is on by default and means nothing until an engine is chosen and
 * has passed its Test; the line under it says which of those is missing. The
 * budgets are US dollars per local day. Today's spend is the count the main
 * process refuses by, so it is right while usage statistics are off; the table
 * under it is read from the decision ledger.
 *
 * Opening the section reads the settings, the day's count and the ledger, and
 * sends nothing to an engine.
 *
 * Every control has a `maestro-cli s1` verb that calls the same main-process
 * function: `s1 set agents on|off`, `s1 set budget [usd] [--per-agent
 * <usd|none>]`, and `s1 usage [--since]` for the table. One agent is switched
 * off on the Models tab of its own settings (`update-agent --system-one`).
 */

import { useEffect, useMemo, useState } from 'react';
import { Bot, Check, RefreshCw } from 'lucide-react';

import { formatCount } from '../../../../../shared/formatters';
import { SYSTEM_ONE_LEDGER_RETENTION_DAYS } from '../../../../../shared/local-models/system-one-ledger';
import {
	SYSTEM_ONE_AGENT_USE_DESCRIPTIONS,
	SYSTEM_ONE_MAX_DAILY_BUDGET_USD,
	parseSystemOneBudgetText,
	systemOneAgentUseBlocker,
	type SystemOneReport,
} from '../../../../../shared/local-models/system-one-settings';
import {
	formatSystemOneCost,
	type SystemOneAgentUsageRow,
	type SystemOneUsageReport,
} from '../../../../../shared/local-models/system-one-spend';
import { useSystemOneUsage, type SystemOneHookState } from '../../../../hooks/localModels';
import type { Theme } from '../../../../types';
import { FormInput } from '../../../ui/FormInput';
import { ToggleSwitch } from '../../../ui/ToggleSwitch';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { CardButton } from './CardButton';
import { CardRowTitle, CardWarning } from './CardParts';

const DAY_MS = 86_400_000;

/** How far back the per-agent table reads. The ledger keeps nothing older than its own window. */
const USAGE_WINDOWS = [
	{ id: 'today', label: 'Today' },
	{ id: 'week', label: 'Last 7 days' },
	{ id: 'all', label: `Last ${SYSTEM_ONE_LEDGER_RETENTION_DAYS} days` },
] as const;

type UsageWindowId = (typeof USAGE_WINDOWS)[number]['id'];

function isUsageWindowId(value: string): value is UsageWindowId {
	return USAGE_WINDOWS.some((choice) => choice.id === value);
}

/** Epoch ms a window starts at, or undefined for everything the ledger keeps. Pure, for the tests. */
export function systemOneUsageWindowStart(
	windowId: UsageWindowId,
	now: number
): number | undefined {
	if (windowId === 'all') return undefined;
	if (windowId === 'week') return now - 7 * DAY_MS;
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
}

/** A budget as the field shows it: no trailing zeros, so "1" stays "1". */
function budgetText(usd: number | null): string {
	return usd === null ? '' : String(usd);
}

/** Who a row of the table is for. */
function usageRowName(row: SystemOneAgentUsageRow): string {
	if (row.agentId === null) return 'No agent named';
	return row.agentName ?? `Removed agent ${row.agentId.slice(0, 8)}`;
}

export interface SystemOneAgentsSectionProps {
	theme: Theme;
	/** The tab's one `useSystemOne()`: the switch and the budgets read and change it. */
	systemOne: SystemOneHookState;
}

export function SystemOneAgentsSection({ theme, systemOne }: SystemOneAgentsSectionProps) {
	const [windowId, setWindowId] = useState<UsageWindowId>('today');
	// One start per choice: a start taken on every render would re-read on every render.
	const since = useMemo(() => systemOneUsageWindowStart(windowId, Date.now()), [windowId]);
	const usage = useSystemOneUsage(since);

	const { report } = systemOne;
	const disabled = !report || systemOne.busy !== null;
	const enabled = report?.settings.agents.enabled ?? true;
	const blocker = report && enabled ? systemOneAgentUseBlocker(report) : null;

	return (
		<div
			data-setting-id="local-models-system-one-agents"
			className="select-none"
			data-testid="system-one-agents-section"
		>
			<SettingsSectionHeading
				icon={Bot}
				description="Whether agents may ask System One with maestro-cli s1, what they may spend in a day, and what each has spent."
			>
				System One for agents
			</SettingsSectionHeading>
			<SectionCard theme={theme} className="space-y-3">
				<div className="flex items-start justify-between gap-3" data-testid="system-one-agents-use">
					<div className="min-w-0">
						<CardRowTitle theme={theme}>Let agents use System One</CardRowTitle>
						<p className="text-xs opacity-70 mt-0.5">
							{SYSTEM_ONE_AGENT_USE_DESCRIPTIONS[enabled ? 'on' : 'off']} One agent is switched off
							on the Models tab of its own settings.
						</p>
					</div>
					<ToggleSwitch
						theme={theme}
						checked={enabled}
						onChange={(next) => void systemOne.set({ agents: { enabled: next } })}
						disabled={disabled}
						size="sm"
						ariaLabel="Let agents use System One"
					/>
				</div>
				{blocker && (
					<div data-testid="system-one-agents-blocker">
						<CardWarning theme={theme}>{blocker}</CardWarning>
					</div>
				)}

				{report && <BudgetRows theme={theme} report={report} systemOne={systemOne} />}

				<SpendToday theme={theme} usage={usage.report} />

				<div className="flex flex-wrap items-center gap-2">
					<CardRowTitle theme={theme}>Spend per agent</CardRowTitle>
					<select
						aria-label="Show spend since"
						value={windowId}
						onChange={(event) => {
							if (isUsageWindowId(event.target.value)) setWindowId(event.target.value);
						}}
						className="p-1.5 rounded border bg-transparent outline-none text-xs"
						style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						data-testid="system-one-agents-window"
					>
						{USAGE_WINDOWS.map((choice) => (
							<option key={choice.id} value={choice.id}>
								{choice.label}
							</option>
						))}
					</select>
					<div className="ml-auto">
						<CardButton
							theme={theme}
							icon={RefreshCw}
							label={usage.loading ? 'Reading...' : 'Refresh'}
							onClick={() => void usage.refresh()}
							disabled={usage.loading}
							testId="system-one-agents-refresh"
						/>
					</div>
				</div>

				{usage.error && (
					<p
						className="text-xs select-text"
						style={{ color: theme.colors.error }}
						data-testid="system-one-agents-error"
					>
						{usage.error}
					</p>
				)}
				{usage.report?.notice && (
					<div data-testid="system-one-agents-notice">
						<CardWarning theme={theme}>{usage.report.notice}</CardWarning>
					</div>
				)}
				{usage.report && <SpendTable theme={theme} usage={usage.report} />}
			</SectionCard>
		</div>
	);
}

interface BudgetRowsProps {
	theme: Theme;
	report: SystemOneReport;
	systemOne: SystemOneHookState;
}

/** The two budgets: all agents together, and one agent's own cap. */
function BudgetRows({ theme, report, systemOne }: BudgetRowsProps) {
	const { agents, engine } = report.settings;
	const disabled = systemOne.busy !== null;
	const savedDaily = budgetText(agents.dailyBudgetUsd);
	const savedOwn = budgetText(agents.perAgentBudgetUsd);
	const [daily, setDaily] = useState(savedDaily);
	const [own, setOwn] = useState(savedOwn);
	// A change from outside (`maestro-cli s1 set budget`) replaces the field.
	useEffect(() => setDaily(savedDaily), [savedDaily]);
	useEffect(() => setOwn(savedOwn), [savedOwn]);

	const dailyParse = parseSystemOneBudgetText(daily);
	const dailyChanged = dailyParse.ok && dailyParse.usd !== agents.dailyBudgetUsd;
	const saveDaily = () => {
		if (dailyParse.ok && dailyChanged) {
			void systemOne.set({ agents: { dailyBudgetUsd: dailyParse.usd } });
		}
	};

	// An empty field is "no cap of its own", which is a value, not a mistake.
	const ownEmpty = own.trim() === '';
	const ownParse = ownEmpty ? null : parseSystemOneBudgetText(own);
	const ownValue = ownEmpty ? null : ownParse?.ok ? ownParse.usd : undefined;
	const ownChanged = ownValue !== undefined && ownValue !== agents.perAgentBudgetUsd;
	const saveOwn = () => {
		if (ownValue !== undefined && ownChanged) {
			void systemOne.set({ agents: { perAgentBudgetUsd: ownValue } });
		}
	};

	// Only the hosted Jev has a price. Said here, or a budget reads as a limit it is not.
	const unpriced = engine === 'openjev' || engine === 'local-judge';

	return (
		<>
			<div className="space-y-2" data-testid="system-one-agents-daily-budget">
				<FormInput
					theme={theme}
					label="Daily budget (US dollars, all agents)"
					value={daily}
					onChange={setDaily}
					onSubmit={saveDaily}
					submitEnabled={dailyChanged && !disabled}
					placeholder="1"
					error={dailyParse.ok ? undefined : dailyParse.message}
					helperText={`The most all agents together may spend in a local day, from 0 to ${SYSTEM_ONE_MAX_DAILY_BUDGET_USD}. A request over it is refused by name and sends nothing. 0 refuses every agent request.${unpriced ? ' The engine in force has no price, so a budget above 0 never binds.' : ''}`}
					disabled={disabled}
					testId="system-one-agents-daily-budget-input"
				/>
				<CardButton
					theme={theme}
					icon={Check}
					label="Save"
					onClick={saveDaily}
					disabled={!dailyChanged || disabled}
					primary
					testId="system-one-agents-daily-budget-save"
				/>
			</div>

			<div className="space-y-2" data-testid="system-one-agents-own-budget">
				<FormInput
					theme={theme}
					label="Budget per agent (optional)"
					value={own}
					onChange={setOwn}
					onSubmit={saveOwn}
					submitEnabled={ownChanged && !disabled}
					placeholder="no cap of its own"
					error={ownParse && !ownParse.ok ? ownParse.message : undefined}
					helperText="The most one agent may spend in a local day. Empty means an agent is held only by the daily budget."
					disabled={disabled}
					testId="system-one-agents-own-budget-input"
				/>
				<CardButton
					theme={theme}
					icon={Check}
					label="Save"
					onClick={saveOwn}
					disabled={!ownChanged || disabled}
					primary
					testId="system-one-agents-own-budget-save"
				/>
			</div>
		</>
	);
}

/** Today's count against the daily budget: the number a request is refused by. */
function SpendToday({ theme, usage }: { theme: Theme; usage: SystemOneUsageReport | null }) {
	if (!usage) return null;
	const { budget } = usage;
	const spent = budget.spentTodayUsd >= budget.dailyBudgetUsd;
	return (
		<div className="space-y-1" data-testid="system-one-agents-today">
			<CardRowTitle theme={theme}>Spent today</CardRowTitle>
			<p
				className="text-xs select-text"
				style={{ color: spent ? theme.colors.warning : theme.colors.textDim }}
			>
				{formatSystemOneCost(budget.spentTodayUsd)} of {formatSystemOneCost(budget.dailyBudgetUsd)}{' '}
				by all agents, {formatSystemOneCost(budget.remainingTodayUsd)} left.{' '}
				{spent
					? 'The budget is spent: agent requests are refused until local midnight.'
					: 'The day starts at local midnight.'}
			</p>
		</div>
	);
}

/** One row per agent, highest spend first, as the ledger holds it. */
function SpendTable({ theme, usage }: { theme: Theme; usage: SystemOneUsageReport }) {
	if (usage.rows.length === 0) {
		return (
			<p className="text-xs opacity-70" data-testid="system-one-agents-empty">
				No agent requests in this window.
			</p>
		);
	}
	const cell = 'py-1 pr-3 text-right tabular-nums';
	return (
		<table
			className="w-full text-xs select-text"
			style={{ color: theme.colors.textMain }}
			data-testid="system-one-agents-table"
		>
			<thead>
				<tr className="opacity-70 text-left">
					<th className="py-1 pr-3 font-normal">Agent</th>
					<th className={`${cell} font-normal`}>Requests</th>
					<th className={`${cell} font-normal`}>Cached</th>
					<th className={`${cell} font-normal`}>Tokens in</th>
					<th className={`${cell} font-normal`}>Cost</th>
					<th className={`${cell} font-normal`}>Avg ms</th>
				</tr>
			</thead>
			<tbody>
				{usage.rows.map((row) => (
					<tr key={row.agentId ?? ''} data-testid="system-one-agents-row">
						<td className="py-1 pr-3 min-w-0 break-words">{usageRowName(row)}</td>
						<td className={cell}>{formatCount(row.requests)}</td>
						<td className={cell}>{formatCount(row.cachedRequests)}</td>
						<td className={cell}>{formatCount(row.tokensIn)}</td>
						<td className={cell}>{formatSystemOneCost(row.costUsd)}</td>
						<td className={cell}>{formatCount(row.averageLatencyMs)}</td>
					</tr>
				))}
				{usage.rows.length > 1 && (
					<tr className="opacity-70" data-testid="system-one-agents-total">
						<td className="py-1 pr-3">Total</td>
						<td className={cell}>{formatCount(usage.totals.requests)}</td>
						<td className={cell}>{formatCount(usage.totals.cachedRequests)}</td>
						<td className={cell}>{formatCount(usage.totals.tokensIn)}</td>
						<td className={cell}>{formatSystemOneCost(usage.totals.costUsd)}</td>
						<td className={cell} />
					</tr>
				)}
			</tbody>
		</table>
	);
}
