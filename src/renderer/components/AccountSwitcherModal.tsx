/**
 * AccountSwitcherModal - run an agent on another provider account without
 * logging in again.
 *
 * Lists every account directory Maestro can see for the agent's provider,
 * labeled by WHO is signed in (directory names are picked once and nothing
 * keeps them honest), with each account's live quota from the same snapshots
 * the Usage Dashboard draws. The ordering puts the account worth switching to
 * first when the current one is spent, which is the moment this is opened from
 * a quota outage card.
 *
 * Refuses, with the reason, for an agent whose credential is not a login (API
 * key, gateway, Bedrock/Vertex) or that runs over SSH - see
 * `accountSwitchBlocker()`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, UserRoundCog } from 'lucide-react';
import type { Session, Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { Modal } from './ui';
import { useListNavigation } from '../hooks/keyboard/useListNavigation';
import { useClaudeUsageStore } from '../stores/claudeUsageStore';
import { useCodexUsageStore } from '../stores/codexUsageStore';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { notifyToast } from '../stores/notificationStore';
import {
	loadAgentAccountContext,
	switchAgentAccount,
	type AgentAccountContext,
} from '../services/agentAccountSwitch';
import {
	buildSwitchableAccounts,
	claudeSnapshotWindows,
	codexSnapshotWindows,
	recommendedAccount,
	type AccountQuotaWindow,
	type SwitchableAccount,
} from '../../shared/providerAccountSwitch';
import { getProviderProfileConfig } from '../../shared/providerProfiles';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { formatDurationHuman } from '../../shared/formatters';

export interface AccountSwitcherModalProps {
	theme: Theme;
	session: Session;
	onClose: () => void;
}

/** Quota windows per account key, from whichever snapshot store serves the provider. */
function useQuotaByAccountKey(toolType: string): Record<string, AccountQuotaWindow[]> {
	const claude = useClaudeUsageStore((s) => s.snapshots);
	const codex = useCodexUsageStore((s) => s.snapshots);
	return useMemo(() => {
		const result: Record<string, AccountQuotaWindow[]> = {};
		if (toolType === 'claude-code') {
			for (const [key, snapshot] of Object.entries(claude)) {
				result[key.replace(/\/+$/, '')] = claudeSnapshotWindows(snapshot);
			}
		} else if (toolType === 'codex') {
			for (const [key, snapshot] of Object.entries(codex)) {
				result[key.replace(/\/+$/, '')] = codexSnapshotWindows(snapshot);
			}
		}
		return result;
	}, [toolType, claude, codex]);
}

function windowSummary(windows: AccountQuotaWindow[]): string {
	if (windows.length === 0) return 'No usage sampled yet';
	return windows.map((w) => `${w.label} ${Math.round(w.percent)}%`).join(' · ');
}

export function AccountSwitcherModal({ theme, session, onClose }: AccountSwitcherModalProps) {
	const [context, setContext] = useState<AgentAccountContext | null>(null);
	const [switchingKey, setSwitchingKey] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const quotaByAccountKey = useQuotaByAccountKey(session.toolType);
	const providerName = getAgentDisplayName(session.toolType);

	useEffect(() => {
		let cancelled = false;
		void loadAgentAccountContext(session).then((next) => {
			if (!cancelled) setContext(next);
		});
		return () => {
			cancelled = true;
		};
		// Loaded once per agent: the env only changes through this modal, which
		// closes on a switch.
	}, [session.id]);

	// The snapshot mirrors are filled lazily; make sure the bars are there.
	useEffect(() => {
		if (session.toolType === 'claude-code' && !useClaudeUsageStore.getState().loaded) {
			void useClaudeUsageStore.getState().refresh();
		}
		if (session.toolType === 'codex' && !useCodexUsageStore.getState().loaded) {
			void useCodexUsageStore.getState().refresh();
		}
	}, [session.toolType]);

	// Keep "reopens in ..." honest while the modal sits open.
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(id);
	}, []);

	const accounts = useMemo(
		() =>
			context && !context.blocker
				? buildSwitchableAccounts({
						toolType: session.toolType,
						identities: context.identities,
						quotaByAccountKey,
						currentAccountKey: context.currentAccountKey,
						now,
					})
				: [],
		[context, session.toolType, quotaByAccountKey, now]
	);
	const suggested = recommendedAccount(accounts);

	const handleSwitch = useCallback(
		async (account: SwitchableAccount) => {
			if (account.isCurrent || !account.signedIn || switchingKey) return;
			setSwitchingKey(account.accountKey);
			const result = await switchAgentAccount(session.id, account.accountKey);
			setSwitchingKey(null);
			if (!result.ok) {
				notifyToast({ color: 'red', title: 'Could not switch account', message: result.error });
				return;
			}
			notifyCenterFlash({
				message: `${session.name} now runs as ${account.label}`,
				color: 'green',
				detail:
					result.missingConversations > 0
						? `${result.missingConversations} conversation${result.missingConversations === 1 ? '' : 's'} could not be carried over and will start fresh.`
						: undefined,
			});
			onClose();
		},
		[session.id, session.name, switchingKey, onClose]
	);

	const handleRefresh = useCallback(async () => {
		setRefreshing(true);
		try {
			if (session.toolType === 'claude-code') {
				await window.maestro.agents.refreshClaudeUsageSnapshots();
				await useClaudeUsageStore.getState().refresh();
			} else if (session.toolType === 'codex') {
				await window.maestro.agents.refreshCodexUsageSnapshots();
				await useCodexUsageStore.getState().refresh();
			}
		} finally {
			setRefreshing(false);
		}
	}, [session.toolType]);

	const initialIndex = Math.max(
		0,
		accounts.findIndex((a) => a === suggested)
	);
	const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
		listLength: accounts.length,
		initialIndex,
		onSelect: (index) => {
			const account = accounts[index];
			if (account) void handleSwitch(account);
		},
	});

	// Land on the suggestion once the list arrives, not on whatever row 0 was.
	useEffect(() => {
		setSelectedIndex(initialIndex);
	}, [initialIndex, setSelectedIndex]);

	// Keyed on the index, not a per-render ref callback: focusing from the ref
	// would re-fire on every render and pull focus back from anything clicked.
	const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
	useEffect(() => {
		const row = rowRefs.current[selectedIndex];
		if (row && !row.disabled) row.focus();
	}, [selectedIndex, accounts.length]);

	const config = getProviderProfileConfig(session.toolType);

	return (
		<Modal
			theme={theme}
			title="Switch Account"
			headerIcon={<UserRoundCog className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			priority={MODAL_PRIORITIES.ACCOUNT_SWITCHER}
			onClose={onClose}
			width={560}
			resizeKey="account-switcher"
			testId="account-switcher-modal"
			headerActions={
				context && !context.blocker ? (
					<button
						type="button"
						onClick={() => void handleRefresh()}
						disabled={refreshing}
						className="flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:bg-white/10 transition-colors disabled:opacity-50"
						style={{ color: theme.colors.textDim }}
						title="Sample every account's quota again"
					>
						<RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
						Refresh usage
					</button>
				) : undefined
			}
		>
			<div className="flex flex-col gap-3 select-none" onKeyDown={handleKeyDown}>
				<div className="text-xs" style={{ color: theme.colors.textDim }}>
					<span style={{ color: theme.colors.textMain }}>{session.name}</span> · {providerName}. The
					next turn on every tab runs on the account you pick and resumes the same conversation.
				</div>

				{!context && (
					<div className="text-sm py-6 text-center" style={{ color: theme.colors.textDim }}>
						Reading accounts...
					</div>
				)}

				{context?.blocker && (
					<div
						className="text-sm px-3 py-2.5 rounded-lg border"
						style={{
							borderColor: theme.colors.warning + '55',
							backgroundColor: theme.colors.warning + '12',
							color: theme.colors.textMain,
						}}
						data-testid="account-switcher-blocked"
					>
						{context.blocker}
					</div>
				)}

				{context && !context.blocker && accounts.length <= 1 && config && (
					<div className="text-sm px-1" style={{ color: theme.colors.textDim }}>
						No other {providerName} accounts found. Maestro lists every{' '}
						<code>~/{config.defaultSubdir}-*</code> directory; sign one in by running the CLI with{' '}
						<code>{config.envVar}</code> pointed at it.
					</div>
				)}

				{accounts.length > 0 && (
					<div className="flex flex-col gap-1.5" role="listbox" aria-label="Accounts">
						{accounts.map((account, index) => {
							const isSuggested = account === suggested;
							const selected = index === selectedIndex;
							const disabled = account.isCurrent || !account.signedIn || !!switchingKey;
							return (
								<button
									key={account.accountKey}
									type="button"
									role="option"
									aria-selected={selected}
									disabled={disabled}
									onClick={() => void handleSwitch(account)}
									onMouseEnter={() => setSelectedIndex(index)}
									ref={(el) => {
										rowRefs.current[index] = el;
									}}
									className="w-full flex items-start gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors outline-none disabled:cursor-default"
									style={{
										borderColor: selected ? theme.colors.accent : theme.colors.border,
										backgroundColor: account.isCurrent
											? theme.colors.accent + '14'
											: selected
												? theme.colors.bgActivity
												: 'transparent',
										opacity: !account.signedIn ? 0.6 : 1,
									}}
									title={
										!account.signedIn
											? `Nobody is signed in to ${account.dirLabel}. Run the ${providerName} CLI with ${config?.envVar}=${account.accountKey} to log in.`
											: account.accountKey
									}
									data-testid={`account-row-${account.dirLabel}`}
								>
									<div className="flex-1 min-w-0">
										<div
											className="text-sm font-medium truncate select-text"
											style={{ color: theme.colors.textMain }}
										>
											{account.label}
										</div>
										<div
											className="text-xs truncate select-text"
											style={{ color: theme.colors.textDim }}
										>
											{account.dirLabel} · {windowSummary(account.windows)}
										</div>
									</div>
									<div className="flex flex-col items-end gap-1 flex-shrink-0 text-2xs">
										{account.isCurrent && (
											<span style={{ color: theme.colors.accent }}>Current</span>
										)}
										{isSuggested && <span style={{ color: theme.colors.success }}>Suggested</span>}
										{account.exhausted && (
											<span style={{ color: theme.colors.warning }}>
												{account.reopensAt
													? `Spent, reopens in ${formatDurationHuman(Math.max(0, Date.parse(account.reopensAt) - now))}`
													: 'Spent'}
											</span>
										)}
										{!account.signedIn && (
											<span style={{ color: theme.colors.textDim }}>Not signed in</span>
										)}
										{switchingKey === account.accountKey && (
											<span style={{ color: theme.colors.textDim }}>Switching...</span>
										)}
									</div>
								</button>
							);
						})}
					</div>
				)}
			</div>
		</Modal>
	);
}
