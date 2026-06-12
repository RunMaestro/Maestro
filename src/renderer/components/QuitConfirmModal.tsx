/**
 * QuitConfirmModal.tsx
 *
 * Confirmation modal displayed when user attempts to quit the app
 * while one or more AI agents are actively thinking (busy state).
 * Focus defaults to Cancel to prevent accidental data loss.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, MessageSquare, Hourglass } from 'lucide-react';
import type { Theme } from '../types';
import { useModalLayer } from '../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';

interface QuitConfirmModalProps {
	theme: Theme;
	/** Number of agents currently busy/thinking */
	busyAgentCount: number;
	/** Names of busy agents for display */
	busyAgentNames: string[];
	/** Active terminal tasks (e.g., "rc: npm test") */
	activeTerminalTasks?: string[];
	/** Number of in-flight Maestro Cue runs */
	activeCueRunCount?: number;
	/** Number of active (non-idle) group chats */
	activeGroupChatCount?: number;
	/** True when the Feedback modal has an unsent draft (typed text, attachments, or messages) */
	hasFeedbackDraft?: boolean;
	/** Callback when user confirms quit */
	onConfirmQuit: () => void;
	/** Callback when user chooses to quit once all operations finish */
	onQuitWhenIdle?: () => void;
	/** Callback when user cancels (stays in app) */
	onCancel: () => void;
}

/**
 * QuitConfirmModal - Confirmation dialog for quitting with active agents
 *
 * Warns the user that AI agents are actively thinking and quitting will
 * interrupt their work. Focus defaults to Cancel to prevent accidental quit.
 */
export function QuitConfirmModal({
	theme,
	busyAgentCount,
	busyAgentNames,
	activeTerminalTasks = [],
	activeCueRunCount = 0,
	activeGroupChatCount = 0,
	hasFeedbackDraft = false,
	onConfirmQuit,
	onQuitWhenIdle,
	onCancel,
}: QuitConfirmModalProps): JSX.Element {
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	// When checked, the app stays open and quits itself once everything is idle.
	const [quitWhenIdle, setQuitWhenIdle] = useState(false);

	useModalLayer(MODAL_PRIORITIES.QUIT_CONFIRM, 'Confirm Quit Application', onCancel);

	// Focus Cancel button on mount (safer default action)
	useEffect(() => {
		cancelButtonRef.current?.focus();
	}, []);

	// Handle keyboard navigation
	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Tab') {
			// Let natural tab flow work
			return;
		}
		e.stopPropagation();
	};

	const agentText = busyAgentCount === 1 ? 'agent is' : 'agents are';
	const hasAutoRun = busyAgentNames.some((n) => n.includes('(Auto Run)'));
	const hasTerminalTasks = activeTerminalTasks.length > 0;
	const hasCueRuns = activeCueRunCount > 0;
	const hasGroupChats = activeGroupChatCount > 0;
	const displayNames = busyAgentNames.slice(0, 3);
	const remainingCount = busyAgentNames.length - 3;
	const displayTerminalTasks = activeTerminalTasks.slice(0, 3);
	const remainingTerminalCount = activeTerminalTasks.length - 3;

	// Real operations in flight (excludes a feedback draft, which never "finishes"
	// and so can't be waited out by the idle watcher).
	const hasActiveOperations = busyAgentCount > 0 || hasTerminalTasks || hasCueRuns || hasGroupChats;

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[10000] animate-in fade-in duration-200"
			role="dialog"
			aria-modal="true"
			aria-labelledby="quit-confirm-title"
			aria-describedby="quit-confirm-description"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			<div
				className="modal-w-sm border rounded-xl shadow-2xl overflow-hidden"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
			>
				{/* Header */}
				<div
					className="p-4 border-b flex items-center gap-3"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="p-2 rounded-lg" style={{ backgroundColor: `${theme.colors.warning}20` }}>
						<AlertTriangle className="w-5 h-5" style={{ color: theme.colors.warning }} />
					</div>
					<h2
						id="quit-confirm-title"
						className="text-base font-semibold"
						style={{ color: theme.colors.textMain }}
					>
						Quit Maestro?
					</h2>
				</div>

				{/* Content */}
				<div className="p-6">
					<p
						id="quit-confirm-description"
						className="text-sm leading-relaxed"
						style={{ color: theme.colors.textMain }}
					>
						{busyAgentCount > 0 && (
							<>
								{busyAgentCount} {agentText} currently {hasAutoRun ? 'active' : 'thinking'}.{' '}
							</>
						)}
						{hasTerminalTasks && (
							<>
								{activeTerminalTasks.length} terminal{' '}
								{activeTerminalTasks.length === 1 ? 'task is' : 'tasks are'} running.{' '}
							</>
						)}
						{hasCueRuns && (
							<>
								{activeCueRunCount} Maestro Cue{' '}
								{activeCueRunCount === 1 ? 'operation is' : 'operations are'} running.{' '}
							</>
						)}
						{hasGroupChats && (
							<>
								{activeGroupChatCount} group {activeGroupChatCount === 1 ? 'chat is' : 'chats are'}{' '}
								active.{' '}
							</>
						)}
						{hasFeedbackDraft && <>You have unsent feedback in the Feedback window. </>}
						{!hasActiveOperations && hasFeedbackDraft ? (
							'Quitting now will discard your draft.'
						) : (
							<>
								Quitting now will interrupt active work
								{hasFeedbackDraft ? ' and discard your feedback draft' : ''}.
							</>
						)}
					</p>

					{/* List of busy agents */}
					{busyAgentCount > 0 && (
						<div
							className="mt-4 p-3 rounded-lg border"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							<div className="text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
								Active Agents
							</div>
							<div className="flex flex-wrap gap-2">
								{displayNames.map((name, index) => (
									<span
										key={`${name}-${index}`}
										className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium"
										style={{
											backgroundColor: `${theme.colors.warning}15`,
											color: theme.colors.warning,
										}}
									>
										<span
											className="w-1.5 h-1.5 rounded-full animate-pulse"
											style={{ backgroundColor: theme.colors.warning }}
										/>
										{name}
									</span>
								))}
								{remainingCount > 0 && (
									<span
										className="inline-flex items-center px-2 py-1 rounded text-xs"
										style={{ color: theme.colors.textDim }}
									>
										+{remainingCount} more
									</span>
								)}
							</div>
						</div>
					)}

					{/* List of active terminal tasks */}
					{hasTerminalTasks && (
						<div
							className="mt-4 p-3 rounded-lg border"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							<div className="text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
								Running Terminal Tasks
							</div>
							<div className="flex flex-wrap gap-2">
								{displayTerminalTasks.map((task, index) => (
									<span
										key={`${task}-${index}`}
										className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium font-mono"
										style={{
											backgroundColor: `${theme.colors.success}15`,
											color: theme.colors.success,
										}}
									>
										<span
											className="w-1.5 h-1.5 rounded-full"
											style={{ backgroundColor: theme.colors.success }}
										/>
										{task}
									</span>
								))}
								{remainingTerminalCount > 0 && (
									<span
										className="inline-flex items-center px-2 py-1 rounded text-xs"
										style={{ color: theme.colors.textDim }}
									>
										+{remainingTerminalCount} more
									</span>
								)}
							</div>
						</div>
					)}

					{/* Background operations: Maestro Cue runs and active group chats */}
					{(hasCueRuns || hasGroupChats) && (
						<div
							className="mt-4 p-3 rounded-lg border"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							<div className="text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
								Background Operations
							</div>
							<div className="flex flex-wrap gap-2">
								{hasCueRuns && (
									<span
										className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium"
										style={{
											backgroundColor: `${theme.colors.warning}15`,
											color: theme.colors.warning,
										}}
									>
										<span
											className="w-1.5 h-1.5 rounded-full animate-pulse"
											style={{ backgroundColor: theme.colors.warning }}
										/>
										Maestro Cue: {activeCueRunCount}
									</span>
								)}
								{hasGroupChats && (
									<span
										className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium"
										style={{
											backgroundColor: `${theme.colors.warning}15`,
											color: theme.colors.warning,
										}}
									>
										<span
											className="w-1.5 h-1.5 rounded-full animate-pulse"
											style={{ backgroundColor: theme.colors.warning }}
										/>
										Group {activeGroupChatCount === 1 ? 'Chat' : 'Chats'}: {activeGroupChatCount}
									</span>
								)}
							</div>
						</div>
					)}

					{/* Feedback draft warning */}
					{hasFeedbackDraft && (
						<div
							className="mt-4 p-3 rounded-lg border"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
						>
							<div className="text-xs font-medium mb-2" style={{ color: theme.colors.textDim }}>
								Unsent Feedback
							</div>
							<span
								className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium"
								style={{
									backgroundColor: `${theme.colors.warning}15`,
									color: theme.colors.warning,
								}}
							>
								<MessageSquare className="w-3 h-3" />
								Draft will be discarded
							</span>
						</div>
					)}

					{/* Quit-when-idle option: only meaningful when real operations are
					    running (a feedback draft never goes idle on its own). */}
					{hasActiveOperations && (
						<label
							className="mt-5 flex items-start gap-2 cursor-pointer select-none"
							style={{ color: theme.colors.textMain }}
						>
							<input
								type="checkbox"
								checked={quitWhenIdle}
								onChange={(e) => setQuitWhenIdle(e.target.checked)}
								className="mt-0.5 cursor-pointer"
								style={{ accentColor: theme.colors.accent }}
							/>
							<span className="text-xs leading-relaxed">
								<span className="font-medium inline-flex items-center gap-1">
									<Hourglass className="w-3 h-3" style={{ color: theme.colors.warning }} />
									Quit when idle
								</span>
								<span className="block" style={{ color: theme.colors.textDim }}>
									Keep running and quit automatically once all operations finish.
								</span>
							</span>
						</label>
					)}

					{/* Actions */}
					<div className="mt-5 flex items-center justify-center gap-2 flex-nowrap">
						<button
							onClick={quitWhenIdle && onQuitWhenIdle ? onQuitWhenIdle : onConfirmQuit}
							className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-90 whitespace-nowrap"
							style={{
								backgroundColor: quitWhenIdle ? theme.colors.accent : theme.colors.error,
								color: quitWhenIdle ? theme.colors.accentForeground : '#ffffff',
							}}
						>
							{quitWhenIdle ? 'Quit When Idle' : 'Quit Anyway'}
						</button>
						<button
							ref={cancelButtonRef}
							onClick={onCancel}
							className="px-3 py-1.5 rounded-lg text-xs font-medium outline-none focus:ring-2 focus:ring-offset-1 transition-colors whitespace-nowrap"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							Cancel
						</button>
					</div>

					{/* Keyboard hints */}
					<div className="mt-4 text-xs text-center" style={{ color: theme.colors.textDim }}>
						<kbd
							className="px-1.5 py-0.5 rounded border"
							style={{ borderColor: theme.colors.border }}
						>
							Tab
						</kbd>{' '}
						to switch •{' '}
						<kbd
							className="px-1.5 py-0.5 rounded border"
							style={{ borderColor: theme.colors.border }}
						>
							Enter
						</kbd>{' '}
						to confirm •{' '}
						<kbd
							className="px-1.5 py-0.5 rounded border"
							style={{ borderColor: theme.colors.border }}
						>
							Esc
						</kbd>{' '}
						to cancel
					</div>
				</div>
			</div>
		</div>
	);
}
