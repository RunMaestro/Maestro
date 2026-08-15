/**
 * ProviderAccountsSection - the manual way into the auth recovery flow.
 *
 * Every other entry point in this feature is reactive: a badge appears because
 * something already broke, a toast fires because a prompt already died. That is
 * the wrong moment to discover the flow exists, and it leaves a user who KNOWS
 * their login is stale (they revoked it, they switched accounts, they are about
 * to start a long Auto Run) with nothing to click.
 *
 * So this lists every credential Maestro knows about, signed in or not, with the
 * two actions that matter per row: re-check it, or sign in. A row is a
 * CREDENTIAL, never an agent - fifteen agents on one Anthropic account are one
 * row here for the same reason they are one toast.
 *
 * The sign-in button is offered only where `resolveLoginCommand()` returns a
 * command. An API key, a gateway token, and a Bedrock role are all genuinely
 * repairable, just not by logging in, so those rows say what to go change
 * instead of showing a button that cannot work.
 *
 * Click-driven, so the root carries `select-none`; the identity line underneath
 * each row shows config-dir paths and env var names, so it opts back in with
 * `select-text`.
 */

import { useCallback, useState } from 'react';
import { KeyRound, LogIn, RefreshCw } from 'lucide-react';

import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { formatRelativeTime } from '../../../shared/formatters';
import { resolveLoginCommand, sshRemoteIdFromHost } from '../../../shared/providerAuth';
import type { ProviderAuthStatus } from '../../../shared/providerAuth';
import { describeCredentialFix } from '../../hooks/agent/useAgentErrorRecovery';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { getModalActions } from '../../stores/modalStore';
import { useKnownIdentities, useProviderAuthStore } from '../../stores/providerAuthStore';
import type { KnownIdentity } from '../../stores/providerAuthStore';
import type { Theme } from '../../types';
import { Spinner } from '../ui/Spinner';
import { ToggleSwitch } from '../ui/ToggleSwitch';
import { SettingsSectionHeading } from './SettingsSectionHeading';

export interface ProviderAccountsSectionProps {
	theme: Theme;
	/** Whether the startup pass probes logins. See the toggle row's description. */
	probeOnStartup: boolean;
	onProbeOnStartupChange: (value: boolean) => void;
}

/**
 * How one status reads to a user, and in which color.
 *
 * `unsupported` is the overloaded one: the store writes it both for a provider
 * with no probe Maestro trusts and for a credential that was rejected but cannot
 * be repaired by signing in. "Can't verify" is true of both, and the detail line
 * under it carries the specifics.
 */
function describeAuthStatus(
	status: ProviderAuthStatus | null,
	theme: Theme
): { label: string; color: string } {
	switch (status) {
		case 'authenticated':
			return { label: 'Signed in', color: theme.colors.success };
		case 'logged-out':
			return { label: 'Signed out', color: theme.colors.error };
		case 'unsupported':
			return { label: "Can't verify", color: theme.colors.warning };
		default:
			return { label: 'Not checked', color: theme.colors.textDim };
	}
}

/**
 * When this row last learned something, and from what.
 *
 * "Checked" is reserved for a snapshot a probe produced. An `error-pattern`
 * record is stamped at the moment an agent's output matched, with no status
 * command anywhere in the story, so calling that "Checked 2 minutes ago" asserts
 * a check that never ran - next to a red "Signed out" badge, that is the most
 * confident line in the panel and the least earned.
 */
function describeLastLearned(
	snapshot: KnownIdentity['snapshot'] | undefined | null
): string | null {
	if (!snapshot) return 'Never checked';
	if (typeof snapshot.checkedAt !== 'number') return null;
	const when = formatRelativeTime(snapshot.checkedAt);
	return snapshot.source === 'error-pattern' ? `Reported ${when}` : `Checked ${when}`;
}

/** "3 agents", "1 agent", or the honest empty answer. */
function describeAgentCount(count: number): string {
	if (count === 0) return 'No agents use this account';
	return count === 1 ? 'Used by 1 agent' : `Used by ${count} agents`;
}

/**
 * Where the credential lives, in one line: the config directory for a browser
 * sign-in, the env var for everything else, plus the remote host when the
 * account is not on this machine.
 */
function describeCredentialSource(entry: KnownIdentity): string {
	const { identity } = entry;
	const where = identity.configDir ?? identity.envVarName ?? identity.scope;
	const remoteId = sshRemoteIdFromHost(identity.host);
	const host = remoteId ? ` on ${remoteId}` : '';
	return `${where}${host}`;
}

export function ProviderAccountsSection({
	theme,
	probeOnStartup,
	onProbeOnStartupChange,
}: ProviderAccountsSectionProps) {
	const identities = useKnownIdentities();
	const refreshIdentity = useProviderAuthStore((s) => s.refreshIdentity);
	const refreshAllIdentities = useProviderAuthStore((s) => s.refreshAllIdentities);

	/** Keys with a probe in flight, so a row can show it is working. */
	const [checking, setChecking] = useState<Record<string, true>>({});
	const [checkingAll, setCheckingAll] = useState(false);

	const handleRecheck = useCallback(
		async (identityKey: string) => {
			setChecking((prev) => ({ ...prev, [identityKey]: true }));
			try {
				const outcome = await refreshIdentity(identityKey);
				// A pass that declined to probe still resolves, and the row then
				// redisplays the status it already had. Without this the spinner
				// stopping is the only feedback, and it reads as "checked, unchanged"
				// for a check that never happened.
				if (!outcome?.probed) {
					notifyCenterFlash({
						color: 'orange',
						message: 'Could not check this account',
						detail: 'The provider CLI may not be installed on this machine.',
					});
				}
			} finally {
				setChecking((prev) => {
					const { [identityKey]: _removed, ...rest } = prev;
					return rest;
				});
			}
		},
		[refreshIdentity]
	);

	const handleRecheckAll = useCallback(async () => {
		setCheckingAll(true);
		try {
			await refreshAllIdentities();
		} finally {
			setCheckingAll(false);
		}
	}, [refreshAllIdentities]);

	const handleSignIn = useCallback((identityKey: string) => {
		getModalActions().openAuthRecovery(identityKey);
	}, []);

	return (
		<div data-setting-id="environment-provider-accounts" className="select-none">
			<SettingsSectionHeading icon={KeyRound}>Provider Accounts</SettingsSectionHeading>
			<div
				className="p-3 rounded border space-y-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<p className="text-xs opacity-70">
					The login each agent presents, one row per account rather than per agent. Sign in here and
					every agent on that account is unblocked at once.
				</p>

				{identities.length === 0 && (
					<p className="text-xs opacity-70">
						No provider accounts have been resolved yet. Create an agent, or re-check to probe the
						providers installed on this machine.
					</p>
				)}

				{identities.map((entry) => {
					const { identity, snapshot } = entry;
					const status = describeAuthStatus(snapshot?.status ?? null, theme);
					const providerName = getAgentDisplayName(identity.provider);
					const canLogIn = resolveLoginCommand(identity) !== null;
					const isChecking = checking[identity.key] === true;
					const lastLearned = describeLastLearned(snapshot);

					return (
						<div
							key={identity.key}
							className="p-3 rounded border"
							style={{
								borderColor: theme.colors.border,
								backgroundColor: theme.colors.bgActivity,
							}}
						>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2 flex-wrap">
										<span className="font-medium" style={{ color: theme.colors.textMain }}>
											{providerName} ({identity.label})
										</span>
										<span
											className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase"
											style={{ backgroundColor: `${status.color}30`, color: status.color }}
										>
											{status.label}
										</span>
									</div>
									<p className="text-xs opacity-70 mt-0.5">
										{snapshot?.accountLabel ? `${snapshot.accountLabel} · ` : ''}
										{lastLearned ? `${lastLearned} · ` : ''}
										{describeAgentCount(entry.sessionIds.length)}
									</p>
									<p className="text-[11px] opacity-55 mt-0.5 font-mono break-all select-text">
										{describeCredentialSource(entry)}
									</p>
									{!canLogIn && (
										<p className="text-[11px] opacity-55 mt-0.5 select-text">
											{describeCredentialFix(identity, providerName)}
										</p>
									)}
								</div>

								<div className="flex items-center gap-2 flex-shrink-0">
									{canLogIn && (
										<button
											type="button"
											onClick={() => handleSignIn(identity.key)}
											className="px-2.5 py-1.5 rounded text-xs font-medium flex items-center gap-1.5 transition-colors"
											style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
											title={`Sign in to ${providerName} (${identity.label})`}
										>
											<LogIn className="w-3.5 h-3.5" />
											Sign In
										</button>
									)}
									<button
										type="button"
										onClick={() => void handleRecheck(identity.key)}
										disabled={isChecking}
										className="p-1.5 rounded border hover:bg-white/5 transition-colors disabled:opacity-50"
										style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
										title="Re-check this account"
										aria-label={`Re-check ${providerName} (${identity.label})`}
									>
										{isChecking ? <Spinner size={14} /> : <RefreshCw className="w-3.5 h-3.5" />}
									</button>
								</div>
							</div>
						</div>
					);
				})}

				<button
					type="button"
					onClick={() => void handleRecheckAll()}
					disabled={checkingAll}
					className="w-full px-3 py-2 rounded border text-sm font-medium flex items-center justify-center gap-2 hover:bg-white/5 transition-colors disabled:opacity-50"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					{checkingAll ? <Spinner size={14} /> : <RefreshCw className="w-4 h-4" />}
					Re-Check All Accounts
				</button>

				<div
					className="flex items-center justify-between gap-3 cursor-pointer"
					role="button"
					tabIndex={0}
					onClick={() => onProbeOnStartupChange(!probeOnStartup)}
					onKeyDown={(e) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							onProbeOnStartupChange(!probeOnStartup);
						}
					}}
				>
					<div className="flex-1 pr-3">
						<div className="font-medium" style={{ color: theme.colors.textMain }}>
							Check provider logins at startup
						</div>
						<p className="text-xs opacity-70 mt-0.5">
							Runs one status command per account when Maestro launches, so an expired login shows
							up before a prompt burns on it. Turn this off to skip it and check accounts by hand.
						</p>
					</div>
					<ToggleSwitch
						checked={probeOnStartup}
						onChange={onProbeOnStartupChange}
						theme={theme}
						ariaLabel="Check provider logins at startup"
					/>
				</div>
			</div>
		</div>
	);
}

export default ProviderAccountsSection;
