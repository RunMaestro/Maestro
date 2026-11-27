/**
 * ClaudePlanUsage - the Anthropic Usage tab: Claude plan quota per account.
 *
 * One row per canonical `CLAUDE_CONFIG_DIR` account, with a bar for the
 * session window (when the /usage panel paints one), the all-models week, and
 * the separately metered premium-model week. The panel itself is the shared
 * `PlanUsagePanel`; this file supplies only the Claude wiring:
 * - snapshots from `claudeUsageStore` (the renderer mirror of main's map);
 * - the "run /login" notice for a logged-out dir;
 * - the login email and the "shared with" chip for dirs logged into the same
 *   Anthropic account (identical bars by construction, so they are labeled).
 */

import { memo } from 'react';
import { useClaudeUsageStore, type ClaudeUsageSnapshot } from '../../stores/claudeUsageStore';
import { groupAccountKeysByIdentity } from '../../../shared/claudeAccountIdentity';
import { QuotaAccountEmail, QuotaSharedAccountBadge } from './quota/quotaPrimitives';
import {
	PlanUsagePanel,
	type PlanUsageConfig,
	type PlanUsagePanelProps,
	type QuotaWindowRow,
} from './quota/PlanUsagePanel';

/** Display names of the other config dirs on the same Anthropic account, per dir. */
type SharedSiblings = Record<string, string[]>;

/** Stable identity for "no shared siblings". */
const NO_SIBLINGS: string[] = [];

function claudeWindows(snapshot: ClaudeUsageSnapshot): QuotaWindowRow[] {
	const rows: QuotaWindowRow[] = [];
	// claude paints no session block for some accounts; draw no row rather than 0%.
	if (snapshot.session) {
		rows.push({ key: 'session', label: 'Session window', ...snapshot.session });
	}
	rows.push({ key: 'week-all', label: 'Week (all models)', ...snapshot.weekAllModels });
	// Claude names its second weekly window after the model tier it meters
	// separately, and that name moves ("Sonnet only" -> "Opus" -> "Fable").
	// Print the scraped one; the fallback only applies to snapshots cached
	// before the label was captured.
	rows.push({
		key: 'week-premium',
		label: `Week (${snapshot.weekSonnetOnly.label ?? 'Sonnet only'})`,
		percent: snapshot.weekSonnetOnly.percent,
		resetsAt: snapshot.weekSonnetOnly.resetsAt,
	});
	return rows;
}

const CLAUDE_PLAN_CONFIG: PlanUsageConfig<ClaudeUsageSnapshot, SharedSiblings> = {
	providerId: 'claude-code',
	footerTab: 'anthropic-usage',
	testIdPrefix: 'claude-plan',
	providerLabel: 'Claude',
	heading: 'Claude Plan Usage',
	accountDirPrefix: '.claude',
	useSnapshots: () => useClaudeUsageStore((s) => s.snapshots),
	useBusy: () => useClaudeUsageStore((s) => s.refreshing || s.sampling),
	sample: () => useClaudeUsageStore.getState().sample(),
	fetchAgentEnvVars: () => window.maestro.agents.getCustomEnvVars('claude-code'),
	fetchAccountKeys: () => {
		const fn = window.maestro.agents.getClaudeUsageAccountKeys;
		return typeof fn === 'function' ? fn() : undefined;
	},
	windows: claudeWindows,
	// `authState` is optional for back-compat: absence means authenticated.
	authNotice: (snapshot, theme) =>
		snapshot.authState === 'unauthenticated' ? (
			<>
				Not logged in. Run <code style={{ color: theme.colors.accent }}>/login</code> in a Claude
				session that uses this account.
			</>
		) : null,
	authState: (snapshot) => snapshot.authState ?? 'authenticated',
	loginFixes: (snapshot) => snapshot.authState === 'unauthenticated',
	// Config dirs that resolve to one Anthropic account share a single quota
	// bucket. Resolved over every snapshot (not just the rendered rows) so a
	// hidden sibling is still named.
	deriveShared: (snapshots, helpers) => {
		const identities: Record<string, { accountUuid?: string; email?: string }> = {};
		for (const [key, snapshot] of Object.entries(snapshots)) {
			identities[key] = { accountUuid: snapshot.accountUuid, email: snapshot.accountEmail };
		}
		const named: SharedSiblings = {};
		for (const [key, siblings] of Object.entries(groupAccountKeysByIdentity(identities))) {
			named[key] = siblings.map(helpers.deriveDisplayName);
		}
		return named;
	},
	renderIdentity: ({ snapshot, accountKey, shortName, testIdPrefix, theme, shared }) => (
		<>
			{/* The pill is the config dir the user named; this is who that dir is
			    actually logged in as. They drift apart whenever `/login` is re-run
			    inside an existing dir. */}
			{snapshot.accountEmail && (
				<QuotaAccountEmail
					email={snapshot.accountEmail}
					testId={`${testIdPrefix}-email-${shortName}`}
					theme={theme}
				/>
			)}
			<QuotaSharedAccountBadge
				siblingNames={shared?.[accountKey] ?? NO_SIBLINGS}
				testId={`${testIdPrefix}-shared-${shortName}`}
				theme={theme}
			/>
		</>
	),
};

export const ClaudePlanUsage = memo(function ClaudePlanUsage(props: PlanUsagePanelProps) {
	return <PlanUsagePanel config={CLAUDE_PLAN_CONFIG} {...props} />;
});

export default ClaudePlanUsage;
