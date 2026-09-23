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

import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Clock, Loader2 } from 'lucide-react';
import type { Theme, AITab, LogEntry } from '../types';
import { formatTokensCompact } from '../utils/formatters';
import { estimateTokensFromLogs } from '../../shared/formatters';
import { useSessionStore } from '../stores/sessionStore';

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
	// This card fires a send; a send does not always start a turn. When the agent
	// is working, the prompt lands in the execution queue and runs later, which
	// looks identical to nothing happening - so the card has to say which one it
	// was and stop offering the button, or the user clicks again and queues a
	// second copy of the same prompt (and a third, and a fourth).
	const [attempted, setAttempted] = useState(false);

	// How many copies of this recovery are waiting on this tab right now.
	const queuedOnTab = useSessionStore((s) => {
		const session = s.sessions.find((sess) => sess.id === sessionId);
		if (!session) return 0;
		return session.executionQueue.filter((item) => item.tabId === tab.id).length;
	});

	// A failure re-arms the button: the send never happened, so the user has to
	// be able to try again.
	useEffect(() => {
		if (recoveryError) setAttempted(false);
	}, [recoveryError]);

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
		setAttempted(true);
		onRecover({ sessionId, tabId: tab.id, lastUserPrompt, groomContext });
	};

	const settled = attempted && !isRecovering && !recoveryError;
	const queued = settled && queuedOnTab > 0;

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

			<div className="flex items-center justify-between gap-2">
				<div className="text-xs" style={{ color: theme.colors.textDim }} role="status">
					{queued
						? `Queued behind this agent's current work${queuedOnTab > 1 ? ` (${queuedOnTab} waiting)` : ''}. It sends as soon as the agent is free.`
						: settled
							? 'Sent. The reply appears below.'
							: null}
				</div>
				<button
					type="button"
					onClick={handleSend}
					disabled={isRecovering || settled}
					aria-busy={isRecovering}
					className="shrink-0 px-3 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
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
					) : settled ? (
						<>
							{queued ? (
								<Clock className="w-3.5 h-3.5" aria-hidden="true" />
							) : (
								<Check className="w-3.5 h-3.5" aria-hidden="true" />
							)}
							{queued ? 'Queued' : 'Recovered'}
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
