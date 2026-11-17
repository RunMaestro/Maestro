/**
 * The right pane of the Prompt Links window for one existing link: its full
 * prompt, its numbers, and the two things you can do with it (duplicate it into
 * a new link, or revoke it). The URL is never shown here: Maestro keeps only a
 * hash of the token, which is why "Duplicate" exists - a lost URL is replaced,
 * not recovered.
 */

import { useState } from 'react';
import { CopyPlus, Trash2 } from 'lucide-react';
import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';
import { CopyIconButton } from '../ui/CopyIconButton';
import { formatRelativeTime } from '../../../shared/formatters';
import {
	describePromptLinkUses,
	promptLinkStatus,
	type PromptLinkPublic,
} from '../../../shared/promptLinks';
import { promptLinkStatusColor, promptLinkTitle } from './PromptLinkList';

interface PromptLinkDetailProps {
	theme: Theme;
	link: PromptLinkPublic;
	agentName: string | undefined;
	now: number;
	busy: boolean;
	onRevoke: (link: PromptLinkPublic) => void;
	onDuplicate: (link: PromptLinkPublic) => void;
}

function formatWhen(ms: number): string {
	return new Date(ms).toLocaleString(undefined, {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

export function PromptLinkDetail({
	theme,
	link,
	agentName,
	now,
	busy,
	onRevoke,
	onDuplicate,
}: PromptLinkDetailProps) {
	const [confirming, setConfirming] = useState(false);
	const status = promptLinkStatus(link, now);

	const facts: Array<[string, string]> = [
		['Agent', agentName ?? 'Deleted agent'],
		['Opens in', link.open === 'foreground' ? 'Foreground' : 'Background'],
		['Uses', describePromptLinkUses(link)],
		[
			'Expires',
			link.expiresAt === undefined
				? 'Never'
				: `${formatWhen(link.expiresAt)}${status === 'expired' ? ' (expired)' : ''}`,
		],
		['Created', `${formatWhen(link.createdAt)} (${formatRelativeTime(link.createdAt)})`],
		['Last run', link.lastUsedAt ? formatRelativeTime(link.lastUsedAt) : 'Never'],
	];
	if (link.revokedAt !== undefined) facts.push(['Revoked', formatRelativeTime(link.revokedAt)]);

	return (
		<div className="flex flex-col gap-4 p-5" data-testid="prompt-link-detail">
			<div>
				<div className="flex items-center gap-2 min-w-0">
					<h3
						className="text-base font-semibold truncate"
						style={{ color: theme.colors.textMain }}
						title={promptLinkTitle(link, 500)}
					>
						{promptLinkTitle(link)}
					</h3>
					<MiniBadge
						label={status}
						theme={theme}
						color={promptLinkStatusColor(theme, status)}
						testId="prompt-link-status"
					/>
				</div>
				{!link.label && (
					<p className="text-2xs mt-0.5" style={{ color: theme.colors.textDim }}>
						No label. The first line of the prompt is shown instead.
					</p>
				)}
			</div>

			<div>
				<div className="flex items-center justify-between mb-1.5">
					<span
						className="text-2xs uppercase tracking-wide font-medium"
						style={{ color: theme.colors.textDim }}
					>
						Prompt
					</span>
					<CopyIconButton
						value={link.prompt}
						theme={theme}
						title="Copy prompt"
						iconClassName="w-3.5 h-3.5"
						testId="prompt-link-copy-prompt"
					/>
				</div>
				<pre
					className="text-xs font-mono whitespace-pre-wrap break-words rounded-lg border p-3 max-h-64 overflow-y-auto select-text"
					style={{
						backgroundColor: theme.colors.bgActivity,
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				>
					{link.prompt}
				</pre>
			</div>

			<dl className="grid gap-x-4 gap-y-2 text-xs" style={{ gridTemplateColumns: 'auto 1fr' }}>
				{facts.map(([term, value]) => (
					<div key={term} className="contents">
						<dt style={{ color: theme.colors.textDim }}>{term}</dt>
						<dd className="min-w-0 truncate" style={{ color: theme.colors.textMain }}>
							{value}
						</dd>
					</div>
				))}
			</dl>

			<p className="text-2xs" style={{ color: theme.colors.textDim }}>
				The URL was shown once, when the link was made. Lost it? Duplicate the link for a new URL,
				then revoke this one.
			</p>

			<div className="flex items-center justify-between gap-2 pt-1">
				<button
					type="button"
					data-testid="prompt-link-duplicate"
					onClick={() => onDuplicate(link)}
					className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition-colors hover:bg-white/5"
					style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				>
					<CopyPlus className="w-3.5 h-3.5" /> Duplicate
				</button>

				{status !== 'revoked' &&
					(confirming ? (
						<div className="flex items-center gap-2">
							<span className="text-2xs" style={{ color: theme.colors.textDim }}>
								It can never run again.
							</span>
							<button
								type="button"
								data-testid="prompt-link-revoke-cancel"
								onClick={() => setConfirming(false)}
								className="px-3 py-1.5 rounded-lg border text-xs transition-colors hover:bg-white/5"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							>
								Cancel
							</button>
							<button
								type="button"
								data-testid="prompt-link-revoke-confirm"
								disabled={busy}
								onClick={() => {
									setConfirming(false);
									onRevoke(link);
								}}
								className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
								style={{ backgroundColor: theme.colors.error, color: theme.colors.bgMain }}
							>
								<Trash2 className="w-3.5 h-3.5" /> Revoke
							</button>
						</div>
					) : (
						<button
							type="button"
							data-testid="prompt-link-revoke"
							disabled={busy}
							onClick={() => setConfirming(true)}
							className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs transition-colors hover:bg-white/5 disabled:opacity-50"
							style={{ borderColor: theme.colors.error, color: theme.colors.error }}
						>
							<Trash2 className="w-3.5 h-3.5" /> Revoke
						</button>
					))}
			</div>
		</div>
	);
}
