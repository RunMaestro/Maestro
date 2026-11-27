/**
 * CodexPlanUsage - the OpenAI Usage tab: ChatGPT/Codex plan quota per account.
 *
 * One row per `CODEX_HOME` account, with a bar for the session window, the
 * weekly window, and any extra named limit the endpoint reports. The panel is
 * the shared `PlanUsagePanel`; this file supplies only the Codex wiring:
 * - sanitized snapshots from `codexUsageStore`;
 * - window labels classified by declared length, never by slot;
 * - the login email and plan chips, and the reset-credit control under the bars.
 */

import { memo } from 'react';
import { DURATION_LADDER_DAYS, DURATION_MS, humanizeDuration } from '../../../shared/duration';
import { useCodexUsageStore, type CodexUsageSnapshot } from '../../stores/codexUsageStore';
import { MiniBadge } from '../ui/MiniBadge';
import { QuotaAccountEmail } from './quota/quotaPrimitives';
import { CodexResetCredits } from './quota/CodexResetCredits';
import { quotaAuthStateNeedsLogin } from './quota/useQuotaAccountLogin';
import {
	PlanUsagePanel,
	type PlanUsageConfig,
	type PlanUsagePanelProps,
	type QuotaWindowRow,
} from './quota/PlanUsagePanel';

/**
 * Window length the session row claims when the quota endpoint did not declare
 * one. Every plan Codex ships today reports a 5h session window, so this is the
 * right guess for an older response - but it stays a fallback, because a row
 * that asserts a length the account does not have is the bug this label had
 * before windows were classified by duration (#1596).
 */
const FALLBACK_SESSION_WINDOW_LABEL = '5h';
/** Seconds in seven days, the length "Weekly" names without qualification. */
const WEEK_SECONDS = DURATION_MS.week / 1000;

/**
 * Render a declared window length as a bar-row suffix: `18000` -> `"5h"`,
 * `604800` -> `"7d"`. Returns null when the endpoint did not declare one, so
 * each caller decides what to say in its absence rather than printing a guess
 * that looks measured.
 */
function windowLengthLabel(windowSeconds: number | undefined): string | null {
	if (typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
		return null;
	}
	return humanizeDuration(windowSeconds * 1000, { units: DURATION_LADDER_DAYS });
}

/**
 * "Weekly" is the name of the bucket, not a measurement, so it is only spelled
 * out when the window really is seven days. Anything else prints its own
 * length - the whole point of classifying by duration is that a row never
 * claims a span the account does not have.
 */
function weeklyRowLabel(windowSeconds: number | undefined): string {
	const label = windowLengthLabel(windowSeconds);
	if (label === null || windowSeconds === WEEK_SECONDS) return 'Weekly';
	return `Weekly (${label})`;
}

function codexWindows(snapshot: CodexUsageSnapshot): QuotaWindowRow[] {
	const rows: QuotaWindowRow[] = [];
	if (snapshot.session) {
		rows.push({
			key: 'session',
			label: `Session (${windowLengthLabel(snapshot.session.windowSeconds) ?? FALLBACK_SESSION_WINDOW_LABEL})`,
			percent: snapshot.session.percent,
			resetsAt: snapshot.session.resetsAt,
		});
	}
	if (snapshot.weekly) {
		rows.push({
			key: 'weekly',
			label: weeklyRowLabel(snapshot.weekly.windowSeconds),
			percent: snapshot.weekly.percent,
			resetsAt: snapshot.weekly.resetsAt,
		});
	}
	// A wall is a wall whatever the sampler calls it: extra named limits are
	// drawn (and count toward the footer peak) like the two standard windows.
	for (const limit of snapshot.additionalLimits ?? []) {
		rows.push({
			key: `limit-${limit.name}`,
			label: limit.name,
			percent: limit.percent,
			resetsAt: limit.resetsAt,
		});
	}
	return rows;
}

const CODEX_PLAN_CONFIG: PlanUsageConfig<CodexUsageSnapshot> = {
	providerId: 'codex',
	footerTab: 'codex-usage',
	testIdPrefix: 'codex-plan',
	providerLabel: 'Codex',
	heading: 'Codex Plan Usage',
	accountDirPrefix: '.codex',
	useSnapshots: () => useCodexUsageStore((s) => s.snapshots),
	useBusy: () => useCodexUsageStore((s) => s.refreshing || s.sampling),
	sample: () => useCodexUsageStore.getState().sample(),
	fetchAgentEnvVars: () => window.maestro.agents.getCustomEnvVars('codex'),
	fetchAccountKeys: () => {
		const fn = window.maestro.agents.getCodexUsageAccountKeys;
		return typeof fn === 'function' ? fn() : undefined;
	},
	windows: codexWindows,
	// Codex states its auth explicitly, so anything but 'authenticated' has no bars.
	authNotice: (snapshot) =>
		snapshot.authState === 'authenticated'
			? null
			: (snapshot.error ?? 'Codex quota is unavailable for this account.'),
	authState: (snapshot) => snapshot.authState,
	// A network or server error is not fixed by logging in.
	loginFixes: (snapshot) => quotaAuthStateNeedsLogin(snapshot.authState),
	renderIdentity: ({ snapshot, shortName, testIdPrefix, theme }) => (
		<>
			{snapshot.email && (
				<QuotaAccountEmail
					email={snapshot.email}
					testId={`${testIdPrefix}-email-${shortName}`}
					theme={theme}
				/>
			)}
			{snapshot.planType && (
				<MiniBadge
					label={snapshot.planType}
					theme={theme}
					title="ChatGPT plan"
					testId={`${testIdPrefix}-plan-${shortName}`}
				/>
			)}
		</>
	),
	// Reset credits sit under the bars they act on, and only for an
	// authenticated account (the panel skips this for a row with a notice): an
	// account we cannot read quota for cannot redeem either.
	renderBelowBars: ({ snapshot, accountKey, displayName, testIdPrefix, shortName, theme }) => (
		<CodexResetCredits
			codexHomeKey={accountKey}
			accountLabel={displayName}
			snapshotCounts={snapshot.resetCredits}
			theme={theme}
			testIdPrefix={`${testIdPrefix}-${shortName}`}
		/>
	),
};

export const CodexPlanUsage = memo(function CodexPlanUsage(props: PlanUsagePanelProps) {
	return <PlanUsagePanel config={CODEX_PLAN_CONFIG} {...props} />;
});

export default CodexPlanUsage;
