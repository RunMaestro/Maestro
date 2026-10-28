/**
 * ParticipantCard.tsx
 *
 * Displays a single group chat participant with their status,
 * session ID, context usage, stats, and cost.
 */

import {
	MessageSquare,
	Copy,
	Check,
	DollarSign,
	RotateCcw,
	UserMinus,
	Eye,
	EyeOff,
} from 'lucide-react';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Theme, GroupChatParticipant, SessionState } from '../types';
import { getStatusColor } from '../utils/theme';
import { formatCost } from '../utils/formatters';
import { safeClipboardWrite } from '../utils/clipboard';
import { parsePeekOutput, formatPeekLines } from '../utils/peekOutputParser';
import { formatTimestamp, formatRelativeTime } from '../../shared/formatters';
import { DURATION_MS } from '../../shared/duration';
import { notifyToast } from '../stores/notificationStore';
import { logger } from '../utils/logger';
import { SshRemotePill } from './ui/SshRemotePill';
import { GhostIconButton } from './ui/GhostIconButton';

interface ParticipantCardProps {
	theme: Theme;
	participant: GroupChatParticipant;
	state: SessionState;
	color?: string;
	groupChatId?: string;
	onContextReset?: (participantName: string) => void;
	onRemove?: (participantName: string) => boolean | Promise<boolean>;
	liveOutput?: string;
}

/**
 * Recent activity uses the shared relative formatter (`just now` / `Xm ago`).
 * Older than an hour stays a clock time so a day-old participant does not
 * read as `23h ago` / `2d ago` (that would change the card's existing display).
 */
function formatParticipantActivity(timestamp: number): string {
	if (Date.now() - timestamp < DURATION_MS.hour) {
		return formatRelativeTime(timestamp);
	}
	return formatTimestamp(timestamp, 'time');
}

export function ParticipantCard({
	theme,
	participant,
	state,
	color,
	groupChatId,
	onContextReset,
	onRemove,
	liveOutput,
}: ParticipantCardProps): JSX.Element {
	const [copied, setCopied] = useState(false);
	const [isResetting, setIsResetting] = useState(false);
	const [isRemoving, setIsRemoving] = useState(false);
	const [confirmRemove, setConfirmRemove] = useState(false);
	const [peekOpen, setPeekOpen] = useState(false);
	const peekRef = useRef<HTMLPreElement>(null);

	// Parse raw JSONL into formatted output
	const formattedOutput = useMemo(() => {
		if (!liveOutput) return '';
		const trimmed = liveOutput.length > 50000 ? liveOutput.slice(-50000) : liveOutput;
		const parsed = parsePeekOutput(trimmed);
		return formatPeekLines(parsed);
	}, [liveOutput]);

	// Auto-scroll peek output to bottom
	useEffect(() => {
		if (peekOpen && peekRef.current) {
			peekRef.current.scrollTop = peekRef.current.scrollHeight;
		}
	}, [peekOpen, formattedOutput]);

	// Use agent's session ID (clean GUID) when available, otherwise show pending
	const agentSessionId = participant.agentSessionId;
	const isPending = !agentSessionId;

	const copySessionId = useCallback(async () => {
		if (agentSessionId) {
			await safeClipboardWrite(agentSessionId);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	}, [agentSessionId]);

	// Determine if state should animate (busy or connecting)
	const shouldPulse = state === 'busy' || state === 'connecting';

	const getStatusLabel = (): string => {
		switch (state) {
			case 'busy':
				return 'Working';
			case 'error':
				return 'Error';
			case 'connecting':
				return 'Connecting';
			default:
				return 'Idle';
		}
	};

	// Context usage percentage (default to 0 if not set)
	const contextUsage = participant.contextUsage ?? 0;

	// Always show reset button (useful for disconnected sessions, not just high context)
	const showResetButton = onContextReset && groupChatId && !isResetting;

	const handleReset = useCallback(async () => {
		if (!onContextReset || !groupChatId) return;
		setIsResetting(true);
		try {
			await onContextReset(participant.name);
		} finally {
			setIsResetting(false);
		}
	}, [onContextReset, groupChatId, participant.name]);

	const handleRemove = useCallback(async () => {
		if (!onRemove || !groupChatId) return;
		setIsRemoving(true);
		try {
			const removed = await onRemove(participant.name);
			if (!removed) {
				throw new Error(`Participant ${participant.name} was not removed`);
			}
			setConfirmRemove(false);
		} catch (error) {
			logger.error(`Failed to remove participant ${participant.name}:`, undefined, error);
			notifyToast({
				type: 'error',
				title: 'Group Chat',
				message: `Failed to remove ${participant.name}`,
			});
		} finally {
			setIsRemoving(false);
		}
	}, [onRemove, groupChatId, participant.name]);

	const showRemoveButton = onRemove && groupChatId && !isRemoving;

	return (
		<div
			className="min-w-0 max-w-full rounded-lg border p-3"
			style={{
				backgroundColor: theme.colors.bgMain,
				borderColor: theme.colors.border,
				borderLeftWidth: '3px',
				borderLeftColor: color || theme.colors.accent,
			}}
		>
			{/* Header: status dot + name, session ID aligned right */}
			<div className="flex items-center gap-2">
				<div
					className={`w-2 h-2 rounded-full shrink-0 ${shouldPulse ? 'animate-pulse' : ''}`}
					style={{ backgroundColor: getStatusColor(state, theme) }}
					title={getStatusLabel()}
				/>
				<span
					className="min-w-0 flex-1 truncate font-medium"
					style={{ color: color || theme.colors.textMain }}
					title={participant.name}
				>
					{participant.name}
				</span>
				{/* Session ID pill */}
				{isPending ? (
					<span
						className="text-2xs px-2 py-0.5 rounded-full shrink-0 italic"
						style={{
							backgroundColor: `${theme.colors.textDim}20`,
							color: theme.colors.textDim,
							border: `1px solid ${theme.colors.textDim}40`,
						}}
					>
						pending
					</span>
				) : (
					<button
						onClick={copySessionId}
						className="flex items-center gap-1 text-2xs px-2 py-0.5 rounded-full hover:opacity-80 transition-opacity cursor-pointer shrink-0"
						style={{
							backgroundColor: `${theme.colors.accent}20`,
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}40`,
						}}
						title={`Session: ${agentSessionId}\nClick to copy`}
					>
						<span className="font-mono">{agentSessionId.slice(0, 8).toUpperCase()}</span>
						{copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
					</button>
				)}
			</div>

			{participant.sshRemoteName && (
				<div className="flex mt-1.5">
					<SshRemotePill remoteName={participant.sshRemoteName} size="sm" className="max-w-full" />
				</div>
			)}

			{/* Stats row: message count + last time (left), agent type (right) */}
			<div
				className="text-xs mt-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1"
				style={{ color: theme.colors.textDim }}
			>
				<div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
					{participant.messageCount !== undefined && participant.messageCount > 0 && (
						<span className="flex items-center gap-1" title="Messages sent">
							<MessageSquare className="w-3 h-3" />
							{participant.messageCount}
						</span>
					)}
					{participant.lastActivity && (
						<span title="Last activity">{formatParticipantActivity(participant.lastActivity)}</span>
					)}
				</div>
				<span className="min-w-0 break-all">{participant.agentId}</span>
			</div>

			{/* Context gauge + optional cost */}
			<div className="mt-2 flex flex-wrap items-center gap-2">
				<div className="min-w-[2.5rem] flex-1" title={`Context usage: ${contextUsage}%`}>
					<div className="mb-1">
						<span className="text-2xs" style={{ color: theme.colors.textDim }}>
							{contextUsage}%
						</span>
					</div>
					<div
						className="h-1 rounded-full overflow-hidden"
						role="meter"
						aria-label="Context usage"
						aria-valuenow={contextUsage}
						aria-valuemin={0}
						aria-valuemax={100}
						style={{ backgroundColor: theme.colors.border }}
					>
						<div
							className="h-full rounded-full transition-all"
							style={{
								width: `${contextUsage}%`,
								backgroundColor: contextUsage > 80 ? theme.colors.warning : theme.colors.accent,
							}}
						/>
					</div>
				</div>
				{/* Cost pill (optional) */}
				{participant.totalCost !== undefined && participant.totalCost > 0 && (
					<span
						className="max-w-full flex items-center gap-0.5 text-2xs px-1.5 py-0.5 rounded"
						style={{
							backgroundColor: `${theme.colors.success}20`,
							color: theme.colors.success,
						}}
						title="Total cost"
					>
						<DollarSign className="w-3 h-3 shrink-0" />
						<span className="truncate">{formatCost(participant.totalCost).slice(1)}</span>
					</span>
				)}
				{/* Reset button */}
				{showResetButton && (
					<GhostIconButton
						onClick={handleReset}
						ariaLabel="Reset context"
						className="shrink-0 hover:opacity-80 cursor-pointer"
						style={{
							backgroundColor: `${theme.colors.warning}20`,
							color: theme.colors.warning,
							border: `1px solid ${theme.colors.warning}40`,
						}}
						title="Reset context: Summarize current session and start fresh"
					>
						<RotateCcw className="w-3 h-3" />
					</GhostIconButton>
				)}
				{/* Reset in progress indicator */}
				{isResetting && (
					<span
						className="inline-flex items-center justify-center p-1 rounded shrink-0 animate-pulse"
						role="status"
						aria-label="Resetting context"
						title="Resetting context..."
						style={{
							backgroundColor: `${theme.colors.warning}20`,
							color: theme.colors.warning,
						}}
					>
						<RotateCcw className="w-3 h-3 animate-spin" />
					</span>
				)}
				{/* Remove button */}
				{showRemoveButton && !confirmRemove && (
					<GhostIconButton
						onClick={() => setConfirmRemove(true)}
						ariaLabel="Remove participant"
						className="shrink-0 hover:opacity-80 cursor-pointer"
						style={{
							backgroundColor: `${theme.colors.error}20`,
							color: theme.colors.error,
							border: `1px solid ${theme.colors.error}40`,
						}}
						title="Remove participant from group chat"
					>
						<UserMinus className="w-3 h-3" />
					</GhostIconButton>
				)}
				{/* Remove confirmation */}
				{confirmRemove && !isRemoving && (
					<span className="max-w-full flex flex-wrap items-center gap-1 text-2xs">
						<button
							onClick={handleRemove}
							className="px-1.5 py-0.5 rounded cursor-pointer hover:opacity-80 transition-opacity"
							style={{
								backgroundColor: `${theme.colors.error}30`,
								color: theme.colors.error,
								border: `1px solid ${theme.colors.error}60`,
							}}
						>
							Confirm
						</button>
						<button
							onClick={() => setConfirmRemove(false)}
							className="px-1.5 py-0.5 rounded cursor-pointer hover:opacity-80 transition-opacity"
							style={{
								backgroundColor: `${theme.colors.textDim}20`,
								color: theme.colors.textDim,
							}}
						>
							Cancel
						</button>
					</span>
				)}
				{/* Remove in progress indicator */}
				{isRemoving && (
					<span
						className="inline-flex items-center justify-center p-1 rounded shrink-0 animate-pulse"
						role="status"
						aria-label="Removing participant"
						title="Removing participant..."
						style={{
							backgroundColor: `${theme.colors.error}20`,
							color: theme.colors.error,
						}}
					>
						<UserMinus className="w-3 h-3" />
					</span>
				)}
				{/* Peek button - always visible */}
				<GhostIconButton
					onClick={() => setPeekOpen((v) => !v)}
					ariaLabel="Peek at live output"
					pressed={peekOpen}
					className="shrink-0 hover:opacity-80 cursor-pointer"
					style={{
						backgroundColor: peekOpen ? `${theme.colors.accent}25` : `${theme.colors.accent}10`,
						color: peekOpen ? theme.colors.accent : theme.colors.textDim,
						border: `1px solid ${peekOpen ? theme.colors.accent + '60' : theme.colors.border}`,
					}}
					title="Peek at live output"
				>
					{peekOpen ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
				</GhostIconButton>
			</div>

			{/* Live output peek panel */}
			{peekOpen && (
				<pre
					ref={peekRef}
					className="mt-2 text-2xs leading-tight rounded p-2 overflow-y-auto overflow-x-hidden whitespace-pre-wrap break-words font-mono"
					style={{
						maxHeight: '200px',
						backgroundColor: `${theme.colors.bgMain}80`,
						color: theme.colors.textDim,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					{formattedOutput || '(no live output yet)'}
				</pre>
			)}
		</div>
	);
}
