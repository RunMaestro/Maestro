/**
 * SessionRecoveryCard - inline expandable card rendered inside a session_not_found
 * system log entry. Lets the user reconstitute the dead session in place by
 * sending the prior conversation (optionally groomed) as context plus the
 * prompt that originally hit the dead session.
 *
 * The card is rendered directly inside TerminalOutput when a LogEntry carries
 * `recoveryAction`. It is NOT a floating modal - it sits in the conversation
 * flow next to the error that explains why it exists. The grooming pipeline
 * is the exact same `contextGroomingService` used by SendToAgent and
 * MergeSession; we just point it at the same agent (in-place recovery).
 */

import { useMemo, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import type { Theme, AITab, LogEntry } from '../types';
import { formatTokensCompact } from '../utils/formatters';
import { estimateTokensFromLogs } from '../../shared/formatters';

export interface SessionRecoveryCardProps {
	theme: Theme;
	sessionId: string;
	tab: AITab;
	lastUserPrompt: string;
	isRecovering: boolean;
	recoveryError: string | null;
	onRecover: (opts: {
		sessionId: string;
		tabId: string;
		lastUserPrompt: string;
		groomContext: boolean;
	}) => void;
}

export function SessionRecoveryCard({
	theme,
	sessionId,
	tab,
	lastUserPrompt,
	isRecovering,
	recoveryError,
	onRecover,
}: SessionRecoveryCardProps) {
	const [groomContext, setGroomContext] = useState(true);

	const sourceTokens = useMemo<number>(
		() => estimateTokensFromLogs(tab.logs as LogEntry[]),
		[tab.logs]
	);

	// Match SendToAgentModal's 27% reduction estimate (line 384 there).
	const estimatedGroomedTokens = useMemo<number>(
		() => (groomContext ? Math.round(sourceTokens * 0.73) : sourceTokens),
		[sourceTokens, groomContext]
	);

	const handleSend = () => {
		onRecover({ sessionId, tabId: tab.id, lastUserPrompt, groomContext });
	};

	return (
		<div
			className="mt-3 rounded-lg border p-3 space-y-3 select-none"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
			}}
			role="region"
			aria-label="Session recovery options"
		>
			<div className="space-y-1 text-xs">
				<div className="flex justify-between">
					<span style={{ color: theme.colors.textDim }}>Raw session size:</span>
					<span style={{ color: theme.colors.textMain }}>
						~{formatTokensCompact(sourceTokens)} tokens
					</span>
				</div>
				{groomContext && (
					<div className="flex justify-between">
						<span style={{ color: theme.colors.success }}>After cleaning:</span>
						<span style={{ color: theme.colors.success }}>
							~{formatTokensCompact(estimatedGroomedTokens)} tokens (estimated)
						</span>
					</div>
				)}
			</div>

			<label
				className="flex items-center gap-2 cursor-pointer select-none"
				style={{ color: theme.colors.textMain }}
			>
				<input
					type="checkbox"
					checked={groomContext}
					onChange={(e) => setGroomContext(e.target.checked)}
					disabled={isRecovering}
					className="rounded"
				/>
				<span className="text-xs">Clean context (remove duplicates, reduce size)</span>
			</label>

			{recoveryError && (
				<div className="text-xs" style={{ color: theme.colors.error }} role="alert">
					{recoveryError}
				</div>
			)}

			<div className="flex justify-end gap-2">
				<button
					type="button"
					onClick={handleSend}
					disabled={isRecovering}
					aria-busy={isRecovering}
					className="px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
				>
					{isRecovering ? (
						<>
							<Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
							Recovering...
						</>
					) : (
						<>
							<ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
							Recover Session
						</>
					)}
				</button>
			</div>
		</div>
	);
}

export default SessionRecoveryCard;
