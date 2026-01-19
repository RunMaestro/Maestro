/**
 * SendToAgentModal - Modal for sending session context to another Maestro session
 *
 * Allows users to transfer context from the current session/tab to a different
 * Maestro session. The context can be groomed to remove agent-specific artifacts
 * before transfer.
 *
 * Features:
 * - Session selection list with availability status (idle, busy)
 * - Fuzzy search for session names
 * - Real-time token estimation
 * - Option for AI-powered context grooming
 * - Keyboard navigation with arrow keys, Enter, Escape
 */

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Search, ArrowRight, X, Loader2, Circle } from 'lucide-react';
import type { Theme, Session, AITab, ToolType } from '../types';
import type { MergeResult } from '../types/contextMerge';
import { fuzzyMatchWithScore } from '../utils/search';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { formatTokensCompact } from '../utils/formatters';
import { getAgentIcon } from '../constants/agentIcons';
import { ScreenReaderAnnouncement, useAnnouncement } from './Wizard/ScreenReaderAnnouncement';

/**
 * Session availability status for display in the selection list
 */
export type SessionStatus = 'idle' | 'busy' | 'current';

/**
 * Session option for display in the selection list
 */
export interface SessionOption {
	id: string;
	name: string;
	toolType: ToolType;
	status: SessionStatus;
	projectRoot: string;
}

/**
 * Send options that can be configured by the user
 */
export interface SendToAgentOptions {
	/** Use AI to groom/deduplicate context before sending */
	groomContext: boolean;
	/** Target session ID to send context to */
	targetSessionId: string;
	/** Whether to create a new session (default: true) */
	createNewSession?: boolean;
}

export interface SendToAgentModalProps {
	theme: Theme;
	isOpen: boolean;
	/** The session containing the source context */
	sourceSession: Session;
	/** The specific tab ID within the source session */
	sourceTabId: string;
	/** All sessions available as targets (will exclude source session) */
	allSessions: Session[];
	/** Callback when modal is closed */
	onClose: () => void;
	/** Callback when send is initiated */
	onSend: (targetSessionId: string, options: SendToAgentOptions) => Promise<MergeResult>;
}

/**
 * Get status label for a session
 */
function getStatusLabel(status: SessionStatus): string {
	switch (status) {
		case 'idle':
			return 'Idle';
		case 'busy':
			return 'Busy';
		case 'current':
			return 'Source';
		default:
			return '';
	}
}

/**
 * Get status color for a session
 */
function getStatusColor(status: SessionStatus, theme: Theme): string {
	switch (status) {
		case 'idle':
			return theme.colors.success;
		case 'busy':
			return theme.colors.warning;
		case 'current':
			return theme.colors.textDim;
		default:
			return theme.colors.textDim;
	}
}

/**
 * Get display name for a session
 */
function getSessionDisplayName(session: Session): string {
	return session.name || session.projectRoot.split('/').pop() || 'Unnamed Session';
}

/**
 * Estimate token count from log entries
 * Uses a simple heuristic: ~4 characters per token (average for English text)
 */
function estimateTokens(logs: { text: string }[]): number {
	const totalChars = logs.reduce((sum, log) => sum + (log.text?.length || 0), 0);
	return Math.round(totalChars / 4);
}

/**
 * Get display name for a tab
 */
function getTabDisplayName(tab: AITab): string {
	if (tab.name) return tab.name;
	if (tab.agentSessionId) {
		return tab.agentSessionId.split('-')[0].toUpperCase();
	}
	return 'New Tab';
}

/**
 * SendToAgentModal Component
 */
export function SendToAgentModal({
	theme,
	isOpen,
	sourceSession,
	sourceTabId,
	allSessions,
	onClose,
	onSend,
}: SendToAgentModalProps) {
	// Search state
	const [searchQuery, setSearchQuery] = useState('');

	// Selected target session
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

	// Keyboard navigation index
	const [selectedIndex, setSelectedIndex] = useState(0);

	// Send options
	const [groomContext, setGroomContext] = useState(true);

	// Sending state
	const [isSending, setIsSending] = useState(false);

	// Screen reader announcements
	const { announce, announcementProps } = useAnnouncement();

	// Refs
	const inputRef = useRef<HTMLInputElement>(null);
	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);
	const selectedItemRef = useRef<HTMLButtonElement>(null);

	// Keep onClose ref up to date
	useEffect(() => {
		onCloseRef.current = onClose;
	});

	const { registerLayer, unregisterLayer, updateLayerHandler } = useLayerStack();

	// Register layer on mount
	useEffect(() => {
		if (!isOpen) return;

		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.SEND_TO_AGENT,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: 'Send Context to Agent',
			onEscape: () => onCloseRef.current(),
		});

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [isOpen, registerLayer, unregisterLayer]);

	// Update handler when onClose changes
	useEffect(() => {
		if (layerIdRef.current) {
			updateLayerHandler(layerIdRef.current, () => onCloseRef.current());
		}
	}, [updateLayerHandler]);

	// Focus input on mount
	useEffect(() => {
		if (isOpen) {
			const timer = setTimeout(() => inputRef.current?.focus(), 50);
			return () => clearTimeout(timer);
		}
	}, [isOpen]);

	// Reset state when modal opens
	useEffect(() => {
		if (isOpen) {
			setSearchQuery('');
			setSelectedSessionId(null);
			setSelectedIndex(0);
			setIsSending(false);
		}
	}, [isOpen]);

	// Get source tab info
	const sourceTab = useMemo(() => {
		return sourceSession.aiTabs.find((t) => t.id === sourceTabId);
	}, [sourceSession, sourceTabId]);

	const sourceTokens = useMemo(() => {
		if (!sourceTab) return 0;
		return estimateTokens(sourceTab.logs);
	}, [sourceTab]);

	// Build list of sessions with status (excluding the source session and terminal-only sessions)
	const sessionOptions = useMemo((): SessionOption[] => {
		return allSessions
			.filter((session) => {
				// Exclude the source session
				if (session.id === sourceSession.id) return false;
				// Exclude terminal-only sessions
				if (session.toolType === 'terminal') return false;
				return true;
			})
			.map((session) => {
				let status: SessionStatus;

				if (session.id === sourceSession.id) {
					status = 'current';
				} else if (session.state === 'busy') {
					status = 'busy';
				} else {
					status = 'idle';
				}

				return {
					id: session.id,
					name: getSessionDisplayName(session),
					toolType: session.toolType,
					status,
					projectRoot: session.projectRoot,
				};
			});
	}, [allSessions, sourceSession.id]);

	// Filter sessions based on search query
	const filteredSessions = useMemo((): SessionOption[] => {
		if (!searchQuery.trim()) {
			return sessionOptions;
		}

		const query = searchQuery.trim();
		return sessionOptions
			.map((session) => {
				// Search by session name and project path
				const nameScore = fuzzyMatchWithScore(session.name, query).score;
				const pathScore = fuzzyMatchWithScore(session.projectRoot, query).score;
				const score = Math.max(nameScore, pathScore);
				return { session, score };
			})
			.filter((r) => r.score > 0)
			.sort((a, b) => b.score - a.score)
			.map((r) => r.session);
	}, [sessionOptions, searchQuery]);

	// Scroll selected item into view
	useEffect(() => {
		selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
	}, [selectedIndex]);

	// Reset selection when filter changes
	useEffect(() => {
		setSelectedIndex(0);
	}, [searchQuery]);

	// Announce search results to screen readers
	useEffect(() => {
		if (isOpen) {
			const availableCount = filteredSessions.length;
			if (searchQuery) {
				announce(
					`Found ${availableCount} session${availableCount !== 1 ? 's' : ''} matching "${searchQuery}"`
				);
			} else if (filteredSessions.length > 0) {
				announce(
					`${availableCount} session${availableCount !== 1 ? 's' : ''} available for transfer`
				);
			}
		}
	}, [filteredSessions, searchQuery, isOpen, announce]);

	// Announce session selection
	useEffect(() => {
		if (selectedSessionId) {
			const session = sessionOptions.find((s) => s.id === selectedSessionId);
			if (session) {
				announce(`Selected: ${session.name}`);
			}
		}
	}, [selectedSessionId, sessionOptions, announce]);

	// Announce sending status
	useEffect(() => {
		if (isSending) {
			announce('Sending context to session, please wait...', 'assertive');
		}
	}, [isSending, announce]);

	// Handle session selection
	const handleSelectSession = useCallback(
		(sessionId: string) => {
			const session = sessionOptions.find((s) => s.id === sessionId);
			if (session && session.status !== 'current') {
				setSelectedSessionId(sessionId);
			}
		},
		[sessionOptions]
	);

	// Handle send action
	const handleSend = useCallback(async () => {
		if (!selectedSessionId) return;

		setIsSending(true);
		try {
			await onSend(selectedSessionId, {
				groomContext,
				targetSessionId: selectedSessionId,
			});
			onClose();
		} catch (error) {
			console.error('Send to session failed:', error);
		} finally {
			setIsSending(false);
		}
	}, [selectedSessionId, groomContext, onSend, onClose]);

	// Handle key down - list navigation (up/down only)
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSelectedIndex((prev) => {
					const nextIndex = prev + 1;
					return nextIndex < filteredSessions.length ? nextIndex : prev;
				});
				return;
			}

			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSelectedIndex((prev) => {
					const nextIndex = prev - 1;
					return nextIndex >= 0 ? nextIndex : prev;
				});
				return;
			}

			// Number keys for quick selection (1-9)
			if (e.key >= '1' && e.key <= '9') {
				const index = parseInt(e.key, 10) - 1;
				if (index < filteredSessions.length) {
					const session = filteredSessions[index];
					if (session.status !== 'current') {
						handleSelectSession(session.id);
					}
				}
				return;
			}

			// Space to select highlighted session
			if (e.key === ' ' && !e.shiftKey && filteredSessions[selectedIndex]) {
				e.preventDefault();
				const session = filteredSessions[selectedIndex];
				if (session.status !== 'current') {
					handleSelectSession(session.id);
				}
				return;
			}

			// Enter to confirm send
			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				if (selectedSessionId) {
					handleSend();
				} else if (filteredSessions[selectedIndex]) {
					const session = filteredSessions[selectedIndex];
					if (session.status !== 'current') {
						handleSelectSession(session.id);
					}
				}
				return;
			}
		},
		[filteredSessions, selectedIndex, selectedSessionId, handleSelectSession, handleSend]
	);

	// Get selected session details
	const selectedSession = useMemo(() => {
		return sessionOptions.find((s) => s.id === selectedSessionId);
	}, [sessionOptions, selectedSessionId]);

	// Estimate groomed tokens (rough 25-30% reduction)
	const estimatedGroomedTokens = useMemo(() => {
		if (!groomContext) return sourceTokens;
		return Math.round(sourceTokens * 0.73);
	}, [sourceTokens, groomContext]);

	// Determine if send is possible
	const canSend = useMemo(() => {
		if (isSending) return false;
		if (!selectedSessionId) return false;
		const session = sessionOptions.find((s) => s.id === selectedSessionId);
		return session && session.status !== 'current';
	}, [selectedSessionId, sessionOptions, isSending]);

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-start justify-center pt-16 z-[9999] animate-in"
			role="dialog"
			aria-modal="true"
			aria-labelledby="send-to-agent-title"
			aria-describedby="send-to-agent-description"
			tabIndex={-1}
			onKeyDown={handleKeyDown}
		>
			{/* Screen reader announcements */}
			<ScreenReaderAnnouncement {...announcementProps} />

			<div
				className="w-[600px] rounded-xl shadow-2xl border outline-none flex flex-col animate-slide-up"
				style={{
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					maxHeight: 'calc(100vh - 128px)',
				}}
				onClick={(e) => e.stopPropagation()}
			>
				{/* Header */}
				<div
					className="p-4 border-b flex items-center justify-between shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<ArrowRight
							className="w-5 h-5"
							style={{ color: theme.colors.accent }}
							aria-hidden="true"
						/>
						<h2
							id="send-to-agent-title"
							className="text-sm font-bold"
							style={{ color: theme.colors.textMain }}
						>
							Send Context to Agent
						</h2>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="p-1 rounded hover:bg-white/10 transition-colors"
						style={{ color: theme.colors.textDim }}
						aria-label="Close dialog"
					>
						<X className="w-4 h-4" aria-hidden="true" />
					</button>
				</div>

				{/* Description for screen readers */}
				<p id="send-to-agent-description" className="sr-only">
					Select a session to transfer your current context to. Use arrow keys to navigate and Enter
					or Space to select.
				</p>

				{/* Content Area */}
				<div className="flex-1 overflow-hidden flex flex-col min-h-0">
					{/* Search Input */}
					<div className="p-4 pb-2">
						<div className="relative">
							<Search
								className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
								style={{ color: theme.colors.textDim }}
								aria-hidden="true"
							/>
							<label htmlFor="search-sessions-input" className="sr-only">
								Search sessions
							</label>
							<input
								id="search-sessions-input"
								ref={inputRef}
								type="text"
								placeholder="Search sessions..."
								value={searchQuery}
								onChange={(e) => setSearchQuery(e.target.value)}
								aria-controls="session-list"
								className="w-full pl-9 pr-3 py-2 rounded-lg border text-sm outline-none"
								style={{
									backgroundColor: theme.colors.bgMain,
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
								}}
							/>
						</div>
					</div>

					{/* Session List */}
					<div
						id="session-list"
						className="flex-1 overflow-y-auto px-4 pb-4"
						role="listbox"
						aria-label="Available sessions"
					>
						{filteredSessions.length === 0 ? (
							<div
								className="p-4 text-center text-sm"
								style={{ color: theme.colors.textDim }}
								role="status"
							>
								{searchQuery ? 'No matching sessions found' : 'No other sessions available'}
							</div>
						) : (
							<div className="space-y-1" role="presentation">
								{filteredSessions.map((session, index) => {
									const isHighlighted = index === selectedIndex;
									const isSelected = selectedSessionId === session.id;
									const isDisabled = session.status === 'current';

									return (
										<button
											key={session.id}
											ref={isHighlighted ? selectedItemRef : undefined}
											onClick={() => !isDisabled && handleSelectSession(session.id)}
											disabled={isDisabled}
											role="option"
											aria-selected={isSelected}
											aria-disabled={isDisabled}
											aria-label={`${session.name}, ${getStatusLabel(session.status)}${index < 9 ? `, press ${index + 1} to select` : ''}`}
											className={`w-full p-3 rounded-lg border text-left transition-all duration-150 disabled:cursor-not-allowed flex items-center gap-3 ${isSelected ? 'animate-highlight-pulse' : ''}`}
											style={
												{
													backgroundColor: isSelected
														? theme.colors.accent
														: isHighlighted && !isDisabled
															? `${theme.colors.accent}20`
															: theme.colors.bgMain,
													borderColor: isSelected
														? theme.colors.accent
														: isHighlighted && !isDisabled
															? theme.colors.accent
															: theme.colors.border,
													opacity: isDisabled ? 0.5 : 1,
													'--pulse-color': `${theme.colors.accent}40`,
												} as React.CSSProperties
											}
										>
											{/* Agent Icon */}
											<div className="text-xl shrink-0" aria-hidden="true">
												{getAgentIcon(session.toolType)}
											</div>

											{/* Session Info */}
											<div className="flex-1 min-w-0">
												{/* Session Name */}
												<div
													className="text-sm font-medium truncate"
													style={{
														color: isSelected
															? theme.colors.accentForeground
															: theme.colors.textMain,
													}}
												>
													{session.name}
												</div>

												{/* Project Path */}
												<div
													className="text-xs truncate"
													style={{
														color: isSelected
															? theme.colors.accentForeground
															: theme.colors.textDim,
														opacity: isSelected ? 0.8 : 1,
													}}
												>
													{session.projectRoot}
												</div>
											</div>

											{/* Status Badge */}
											<div
												className="text-xs flex items-center gap-1 shrink-0"
												style={{
													color: isSelected
														? theme.colors.accentForeground
														: getStatusColor(session.status, theme),
												}}
												aria-hidden="true"
											>
												{session.status === 'idle' && <Circle className="w-2 h-2 fill-current" />}
												{session.status === 'busy' && <Loader2 className="w-3 h-3 animate-spin" />}
												{getStatusLabel(session.status)}
											</div>

											{/* Quick Select Number */}
											{index < 9 && !isDisabled && (
												<div
													className="text-[10px] opacity-50 shrink-0"
													style={{
														color: isSelected
															? theme.colors.accentForeground
															: theme.colors.textDim,
													}}
													aria-hidden="true"
												>
													{index + 1}
												</div>
											)}
										</button>
									);
								})}
							</div>
						)}
					</div>
				</div>

				{/* Transfer Preview & Options */}
				<div
					className="p-4 border-t space-y-3"
					style={{ borderColor: theme.colors.border }}
					role="region"
					aria-label="Transfer preview and options"
				>
					{/* Token Preview */}
					<div
						className="p-3 rounded-lg text-xs space-y-1"
						style={{ backgroundColor: theme.colors.bgMain }}
						role="status"
						aria-live="polite"
						aria-label="Token estimate"
					>
						<div className="flex justify-between">
							<span style={{ color: theme.colors.textDim }}>
								Source: {sourceTab ? getTabDisplayName(sourceTab) : 'Unknown'}
							</span>
							<span style={{ color: theme.colors.textMain }}>
								~{formatTokensCompact(sourceTokens)} tokens
							</span>
						</div>

						{selectedSession && (
							<div className="flex justify-between">
								<span style={{ color: theme.colors.textDim }}>Target: {selectedSession.name}</span>
								<span className="flex items-center gap-1" style={{ color: theme.colors.textMain }}>
									<ArrowRight className="w-3 h-3" aria-hidden="true" />
									{getAgentIcon(selectedSession.toolType)}
								</span>
							</div>
						)}

						{groomContext && (
							<div className="flex justify-between">
								<span style={{ color: theme.colors.success }}>After cleaning:</span>
								<span style={{ color: theme.colors.success }}>
									~{formatTokensCompact(estimatedGroomedTokens)} tokens (estimated)
								</span>
							</div>
						)}
					</div>

					{/* Options */}
					<fieldset className="space-y-2">
						<legend className="sr-only">Transfer options</legend>
						<label
							className="flex items-center gap-2 cursor-pointer"
							style={{ color: theme.colors.textMain }}
						>
							<input
								type="checkbox"
								checked={groomContext}
								onChange={(e) => setGroomContext(e.target.checked)}
								className="rounded"
								aria-describedby="groom-context-send-desc"
							/>
							<span className="text-xs" id="groom-context-send-desc">
								Clean context (remove duplicates, reduce size)
							</span>
						</label>
					</fieldset>
				</div>

				{/* Footer */}
				<div
					className="p-4 border-t flex justify-end gap-2"
					style={{ borderColor: theme.colors.border }}
				>
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 rounded text-sm border hover:bg-white/5 transition-colors"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
						}}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleSend}
						disabled={!canSend}
						aria-busy={isSending}
						className="px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						{isSending ? (
							<>
								<Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
								Sending...
							</>
						) : (
							<>
								<ArrowRight className="w-4 h-4" aria-hidden="true" />
								Send to Session
							</>
						)}
					</button>
				</div>
			</div>
		</div>
	);
}

export default SendToAgentModal;
