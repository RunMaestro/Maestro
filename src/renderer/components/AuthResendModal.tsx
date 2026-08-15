/**
 * AuthResendModal - the one question a repaired login has to ask.
 *
 * When a prompt dies on an expired credential the work is not lost, it is
 * parked (see `retryStore` -> auth-blocked prompts). Once the login succeeds
 * that prompt can go straight back out, which is the whole point of the
 * feature. It is NOT sent silently:
 *
 *   - Minutes can pass between the failure and the login. A prompt the user has
 *     since thought better of, rewritten, or answered another way must not
 *     leave on its own - a wrong send costs real money and real edits, and
 *     "press one key" is a very cheap insurance premium against it.
 *   - The auth patterns can produce a false positive (`opencode` matches any
 *     line containing "authentication"), so the parked prompt may belong to a
 *     turn that never actually failed on auth. Showing the list makes that
 *     visible instead of replaying it behind the user's back.
 *
 * So the modal states exactly what will be sent, to which agent and tab, and
 * offers one button per answer. Declining forgets the queue rather than
 * deferring it: a prompt that outlives two logins is not a resume, it is a
 * ghost.
 *
 * Click-driven (two buttons and a read-only list), so `select-none` on the root
 * with `select-text` back on the prompt text the user may want to copy - see
 * UI-PATTERNS.md -> Text Selection in Modals.
 */

import { KeyRound, Send } from 'lucide-react';
import { Modal } from './ui/Modal';
import { EscCloseButton } from './ui/EscCloseButton';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { formatRelativeTime } from '../../shared/formatters';
import type { CredentialIdentity } from '../../shared/providerAuth';
import type { Theme } from '../types';

/** One parked prompt, resolved for display by the slot that owns the store reads. */
export interface AuthResendRow {
	/** `${sessionId}:${tabId}` - stable list key. */
	key: string;
	agentName: string;
	tabName: string;
	/** One-line label of the prompt that will be resent. */
	preview: string;
	/** Epoch ms of the failure. The list is ordered by it, oldest first. */
	failedAt: number;
}

export interface AuthResendModalProps {
	/** The credential that was just repaired, for the account line. */
	identity: CredentialIdentity;
	/** Prompts on offer, already in failure order. Never empty - the slot renders nothing then. */
	rows: AuthResendRow[];
	theme: Theme;
	/** Send them all, oldest first. */
	onResend: () => void;
	/** Send nothing and forget the queue. Escape and the X do exactly this. */
	onDecline: () => void;
}

export function AuthResendModal({
	identity,
	rows,
	theme,
	onResend,
	onDecline,
}: AuthResendModalProps) {
	const providerName = getAgentDisplayName(identity.provider);
	const count = rows.length;
	const title = count === 1 ? 'Resume the prompt that was blocked?' : `Resume ${count} prompts?`;

	const header = (
		<div
			className="p-4 border-b flex items-start justify-between gap-3 shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-start gap-2 min-w-0">
				<KeyRound className="w-5 h-5 mt-0.5 shrink-0" style={{ color: theme.colors.accent }} />
				<div className="min-w-0">
					<h2 className="text-sm font-bold truncate" style={{ color: theme.colors.textMain }}>
						{title}
					</h2>
					<p className="text-xs mt-0.5" style={{ color: theme.colors.textDim }}>
						{providerName} ({identity.label}) is signed in again
					</p>
				</div>
			</div>
			<EscCloseButton theme={theme} onClose={onDecline} testId="auth-resend-esc" />
		</div>
	);

	const footer = (
		<>
			<button
				type="button"
				onClick={onDecline}
				className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
				data-testid="auth-resend-decline"
			>
				Not now
			</button>
			<button
				type="button"
				onClick={onResend}
				className="px-4 py-2 rounded transition-colors flex items-center gap-2"
				style={{ backgroundColor: theme.colors.accent, color: theme.colors.accentForeground }}
				data-testid="auth-resend-confirm"
			>
				<Send className="w-3.5 h-3.5" />
				{count === 1 ? 'Resend it' : `Resend all ${count}`}
			</button>
		</>
	);

	return (
		<Modal
			theme={theme}
			title={title}
			priority={MODAL_PRIORITIES.AUTH_RESEND}
			onClose={onDecline}
			customHeader={header}
			footer={footer}
			width={620}
			contentClassName="p-4 flex flex-col gap-2 overflow-y-auto select-none"
			testId="auth-resend-modal"
		>
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				{count === 1
					? 'This prompt never reached the agent. Sending it again resumes the turn where it stopped.'
					: 'These prompts never reached their agents. They are sent in the order they failed.'}
			</p>

			<ul className="flex flex-col gap-2">
				{rows.map((row) => (
					<li
						key={row.key}
						className="rounded border p-3 flex flex-col gap-1"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						data-testid="auth-resend-row"
					>
						<div className="flex items-baseline gap-2 min-w-0">
							<span className="text-xs font-bold truncate" style={{ color: theme.colors.textMain }}>
								{row.agentName}
							</span>
							<span className="text-xs truncate" style={{ color: theme.colors.textDim }}>
								{row.tabName}
							</span>
							<span
								className="text-xs ml-auto shrink-0"
								style={{ color: theme.colors.textDim }}
								title={new Date(row.failedAt).toLocaleString()}
							>
								{formatRelativeTime(row.failedAt)}
							</span>
						</div>
						{/* The prompt itself is content, not chrome: it is the thing the user
						    is deciding about, and copying it out is a reasonable answer too. */}
						<span
							className="text-sm break-words select-text"
							style={{ color: theme.colors.textMain }}
						>
							{row.preview}
						</span>
					</li>
				))}
			</ul>
		</Modal>
	);
}

export default AuthResendModal;
