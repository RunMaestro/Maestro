/**
 * CodexResetCredits - the reset credits one Codex account holds, and the button
 * that spends one.
 *
 * Renders under that account's usage bars in the OpenAI Usage tab. Redeeming a
 * credit reopens the account's consumed 5-hour and weekly windows immediately,
 * which until now meant leaving Maestro for the Codex TUI.
 *
 * Two things this component exists to get right, both of which a naive
 * "count + button" would get wrong:
 *
 *  1. **A credit spent while nothing is exhausted is simply gone.** The API
 *     reports `applicable` separately from `available` for exactly this reason,
 *     and `describeCreditSpend()` turns the pair into the verdict. A `wasteful`
 *     verdict still offers the button - they are the user's credits - but the
 *     confirmation says plainly that nothing would be reset.
 *
 *  2. **Redemption is irreversible, so it always confirms.** No amount of
 *     "are you sure" fatigue justifies letting a stray click burn a finite
 *     grant, and the dialog is where the wasteful case gets to speak up.
 *
 * The list itself is fetched lazily (one request per account) because the COUNT
 * already rides the usage snapshot - a panel showing three collapsed accounts
 * should not fire three extra requests to render a number it already has.
 */

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { RotateCcw, Ticket } from 'lucide-react';

import type { Theme } from '../../../types';
import type { CodexResetCreditCounts } from '../../../../shared/codexResetCredits';
import {
	describeCreditSpend,
	describeCreditExpiry,
	spendableCredits,
} from '../../../../shared/codexResetCredits';
import { useCodexResetCreditsStore } from '../../../stores/codexResetCreditsStore';
import { useModalStore } from '../../../stores/modalStore';
import { notifyToast } from '../../../stores/notificationStore';

interface CodexResetCreditsProps {
	/** Canonical CODEX_HOME this list belongs to. */
	codexHomeKey: string;
	/** Short display name for the account, used in confirmation copy. */
	accountLabel: string;
	/** Counts from the usage snapshot, available before the list is read. */
	snapshotCounts: CodexResetCreditCounts | undefined;
	theme: Theme;
	testIdPrefix: string;
}

export const CodexResetCredits = memo(function CodexResetCredits({
	codexHomeKey,
	accountLabel,
	snapshotCounts,
	theme,
	testIdPrefix,
}: CodexResetCreditsProps) {
	const entry = useCodexResetCreditsStore((s) => s.entries[codexHomeKey]);
	const loading = useCodexResetCreditsStore((s) => !!s.loading[codexHomeKey]);
	const redeeming = useCodexResetCreditsStore((s) => !!s.redeeming[codexHomeKey]);
	const load = useCodexResetCreditsStore((s) => s.load);
	const [now, setNow] = useState(() => Date.now());

	// The snapshot count is the cheap signal for "is there anything to show?".
	// Only accounts that actually hold credits pay for the detail read.
	const snapshotAvailable = snapshotCounts?.available ?? 0;
	const hasAnything = snapshotAvailable > 0 || (entry?.credits.length ?? 0) > 0;

	useEffect(() => {
		if (snapshotAvailable > 0 && !entry && !loading) {
			void load(codexHomeKey);
		}
	}, [snapshotAvailable, entry, loading, load, codexHomeKey]);

	// Expiry is rendered at day resolution, so re-deriving "now" once per minute
	// is far more often than the copy can change. It only exists so a dashboard
	// left open across midnight does not keep claiming a lapsed credit is live.
	useEffect(() => {
		if (!hasAnything) return;
		const timer = setInterval(() => setNow(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, [hasAnything]);

	// Prefer the detail read's counts once we have them: they were measured at
	// the same instant as the list, so the verdict and the rows agree.
	const counts: CodexResetCreditCounts = entry?.counts ?? snapshotCounts ?? { available: 0 };
	const credits = useMemo(() => spendableCredits(entry?.credits ?? []), [entry?.credits]);
	const spend = useMemo(
		() => describeCreditSpend(counts, entry?.credits ?? []),
		[counts, entry?.credits]
	);

	const handleRedeem = useCallback(
		(creditId: string, title: string) => {
			const wasteful = spend.verdict === 'wasteful';
			useModalStore.getState().openModal('confirm', {
				title: 'Redeem reset credit',
				message: wasteful
					? `${spend.reason} Redeem "${title}" on ${accountLabel} anyway? This cannot be undone.`
					: `Redeem "${title}" on ${accountLabel}? This reopens the account's usage windows now and cannot be undone.`,
				destructive: true,
				onConfirm: () => {
					void useCodexResetCreditsStore
						.getState()
						.redeem(codexHomeKey, creditId)
						.then((result) => {
							if (!result.attempted) return;
							notifyToast(
								result.ok
									? {
											color: 'green',
											title: 'Usage limits reset',
											message: `${accountLabel}: ${result.windowsReset} ${
												result.windowsReset === 1 ? 'window' : 'windows'
											} reopened.`,
										}
									: {
											color: 'red',
											title: 'Reset failed',
											// The credit may be gone either way, so never imply it
											// was preserved - just say what happened.
											message: result.message ?? 'Codex redeemed no usage windows.',
											dismissible: true,
										}
							);
						});
				},
			});
		},
		[accountLabel, codexHomeKey, spend]
	);

	// Nothing owned and nothing read: draw nothing rather than an empty shell.
	// An account with no credits is the common case and a permanent "0 credits"
	// row under every account is pure noise.
	if (!hasAnything) return null;

	return (
		<div
			className="mt-2 pt-2 border-t"
			style={{ borderColor: `${theme.colors.border}80` }}
			data-testid={`${testIdPrefix}-reset-credits`}
		>
			<div className="flex items-center gap-2 mb-1.5">
				<Ticket className="w-3.5 h-3.5" style={{ color: theme.colors.accent }} />
				<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
					Usage resets
				</span>
				<span className="text-xs" style={{ color: theme.colors.textDim }}>
					{counts.available} available
					{/* Only ever spell out the applicable count when it DISAGREES with
					    inventory. Saying "2 available, 2 usable now" on the happy path is
					    a distinction the user does not need to think about. */}
					{counts.applicable !== undefined && counts.applicable < counts.available
						? ` · ${counts.applicable} would take effect now`
						: ''}
				</span>
			</div>

			{entry?.error && (
				<p className="text-xs mb-1.5" style={{ color: theme.colors.warning }}>
					{entry.error}
				</p>
			)}

			{loading && !entry && (
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					Loading resets...
				</p>
			)}

			{credits.map((credit) => (
				<div
					key={credit.id}
					className="flex items-center gap-2 py-1"
					data-testid={`${testIdPrefix}-reset-credit-${credit.id}`}
				>
					{/* Button first: the action is what the row is for, and parking it
					    at the far right of a full-width panel strands it acres away
					    from the credit it acts on. */}
					<button
						type="button"
						disabled={redeeming}
						onClick={() => handleRedeem(credit.id, credit.title ?? 'Usage reset')}
						className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
						style={{
							backgroundColor: `${theme.colors.accent}22`,
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}40`,
						}}
						// The tooltip is where the wasteful verdict earns its keep: the
						// button looks identical either way, so the warning has to be
						// reachable before the click, not only in the dialog after it.
						title={spend.reason}
						data-testid={`${testIdPrefix}-reset-credit-redeem-${credit.id}`}
					>
						<RotateCcw className="w-3 h-3" />
						{redeeming ? 'Resetting...' : 'Reset now'}
					</button>
					<div className="flex flex-col min-w-0 flex-1">
						<span className="text-xs truncate" style={{ color: theme.colors.textMain }}>
							{credit.title ?? 'Usage reset'}
						</span>
						<span className="text-xs" style={{ color: theme.colors.textDim }}>
							{describeCreditExpiry(credit, now)}
							{credit.grantedBy ? ` · from ${credit.grantedBy}` : ''}
						</span>
					</div>
				</div>
			))}

			{/* Inventory without a list: the detail read failed or has not landed,
			    but the usage sample says credits exist. Say so rather than showing
			    nothing, which would read as the account holding none. */}
			{credits.length === 0 && snapshotAvailable > 0 && !loading && (
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					{entry
						? 'No redeemable resets on this account right now.'
						: `${snapshotAvailable} reset${snapshotAvailable === 1 ? '' : 's'} reported, details unavailable.`}
				</p>
			)}
		</div>
	);
});
