/**
 * SwitchProviderModal - Confirmation modal for Virtuosos provider switching
 *
 * Lets users select a target provider and configure switch options (groom context,
 * archive source) before initiating a provider switch. Shows current provider,
 * available targets with availability status, and estimated token count.
 *
 * Pattern references:
 * - AccountSwitchModal for themed modal structure
 * - SendToAgentModal for agent selection + keyboard navigation
 * - Modal base component for consistent chrome + layer stack
 */

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { ArrowDown, Shuffle } from 'lucide-react';
import type { Theme, Session, ToolType, AgentConfig } from '../types';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { getAgentIcon } from '../constants/agentIcons';
import { getAgentDisplayName } from '../services/contextGroomer';
import { formatTokensCompact } from '../utils/formatters';

export interface SwitchProviderModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	/** The session being switched */
	sourceSession: Session;
	/** Active tab ID for context extraction */
	sourceTabId: string;
	/** Callback when user confirms the switch */
	onConfirmSwitch: (request: {
		targetProvider: ToolType;
		groomContext: boolean;
		archiveSource: boolean;
	}) => void;
}

interface ProviderOption {
	id: ToolType;
	name: string;
	available: boolean;
}

/**
 * Estimate token count from tab log entries.
 * Uses ~4 characters per token heuristic (same as SendToAgentModal).
 */
function estimateTokensFromLogs(logs: { text: string }[]): number {
	const totalChars = logs.reduce((sum, log) => sum + (log.text?.length || 0), 0);
	return Math.round(totalChars / 4);
}

export function SwitchProviderModal({
	theme,
	isOpen,
	onClose,
	sourceSession,
	sourceTabId,
	onConfirmSwitch,
}: SwitchProviderModalProps) {
	// Provider selection
	const [selectedProvider, setSelectedProvider] = useState<ToolType | null>(null);
	const [highlightedIndex, setHighlightedIndex] = useState(0);

	// Options
	const [groomContext, setGroomContext] = useState(true);
	const [archiveSource, setArchiveSource] = useState(true);

	// Detected agents
	const [providers, setProviders] = useState<ProviderOption[]>([]);

	// Ref for scrolling highlighted item into view
	const highlightedRef = useRef<HTMLButtonElement>(null);

	// Detect available providers when modal opens
	useEffect(() => {
		if (!isOpen) return;

		let mounted = true;

		(async () => {
			try {
				const agents: AgentConfig[] = await window.maestro.agents.detect();

				if (!mounted) return;

				const options: ProviderOption[] = agents
					// Filter out: current provider, terminal, hidden agents
					.filter((a) => {
						if (a.id === sourceSession.toolType) return false;
						if (a.id === 'terminal') return false;
						if (a.hidden) return false;
						return true;
					})
					.map((a) => ({
						id: a.id as ToolType,
						name: a.name || getAgentDisplayName(a.id as ToolType),
						available: a.available,
					}))
					// Sort: available first, then alphabetically
					.sort((a, b) => {
						if (a.available !== b.available) return a.available ? -1 : 1;
						return a.name.localeCompare(b.name);
					});

				setProviders(options);
			} catch (err) {
				console.error('Failed to detect agents for provider switch:', err);
			}
		})();

		return () => {
			mounted = false;
		};
	}, [isOpen, sourceSession.toolType]);

	// Reset state when modal opens
	useEffect(() => {
		if (isOpen) {
			setSelectedProvider(null);
			setHighlightedIndex(0);
			setGroomContext(true);
			setArchiveSource(true);
		}
	}, [isOpen]);

	// Scroll highlighted item into view
	useEffect(() => {
		highlightedRef.current?.scrollIntoView({ block: 'nearest' });
	}, [highlightedIndex]);

	// Token estimate from active tab
	const tokenEstimate = useMemo(() => {
		const tab = sourceSession.aiTabs.find((t) => t.id === sourceTabId);
		if (!tab) return 0;
		return estimateTokensFromLogs(tab.logs);
	}, [sourceSession, sourceTabId]);

	// Available (selectable) providers for keyboard nav
	const selectableProviders = useMemo(
		() => providers.filter((p) => p.available),
		[providers]
	);

	// Handle confirm
	const handleConfirm = useCallback(() => {
		if (!selectedProvider) return;
		onConfirmSwitch({
			targetProvider: selectedProvider,
			groomContext,
			archiveSource,
		});
	}, [selectedProvider, groomContext, archiveSource, onConfirmSwitch]);

	// Keyboard navigation handler
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setHighlightedIndex((prev) =>
					prev + 1 < selectableProviders.length ? prev + 1 : prev
				);
				return;
			}

			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setHighlightedIndex((prev) => (prev - 1 >= 0 ? prev - 1 : prev));
				return;
			}

			if (e.key === 'Enter') {
				e.preventDefault();
				e.stopPropagation();
				if (selectedProvider) {
					handleConfirm();
				} else if (selectableProviders[highlightedIndex]) {
					setSelectedProvider(selectableProviders[highlightedIndex].id);
				}
				return;
			}

			if (e.key === ' ') {
				e.preventDefault();
				if (selectableProviders[highlightedIndex]) {
					setSelectedProvider(selectableProviders[highlightedIndex].id);
				}
				return;
			}
		},
		[selectableProviders, highlightedIndex, selectedProvider, handleConfirm]
	);

	if (!isOpen) return null;

	const currentProviderName = getAgentDisplayName(sourceSession.toolType);
	const currentProviderIcon = getAgentIcon(sourceSession.toolType);

	return (
		<Modal
			theme={theme}
			title="Switch Provider"
			priority={MODAL_PRIORITIES.PROVIDER_SWITCH}
			onClose={onClose}
			headerIcon={<Shuffle className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={480}
			closeOnBackdropClick
			footer={
				<div className="flex items-center gap-2 w-full">
					<div className="flex-1" />
					<button
						type="button"
						onClick={onClose}
						className="px-4 py-2 rounded border text-xs transition-colors hover:bg-white/5"
						style={{
							borderColor: theme.colors.border,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgActivity,
						}}
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={handleConfirm}
						disabled={!selectedProvider}
						className="px-4 py-2 rounded text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						Switch Provider
					</button>
				</div>
			}
		>
			{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
			<div className="flex flex-col gap-4" onKeyDown={handleKeyDown}>
				{/* Current Provider */}
				<div>
					<div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: theme.colors.textDim }}>
						Current Provider
					</div>
					<div
						className="flex items-center gap-3 p-3 rounded-lg border"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
					>
						<span className="text-lg shrink-0">{currentProviderIcon}</span>
						<div className="flex-1 min-w-0">
							<div className="text-xs font-medium truncate" style={{ color: theme.colors.textMain }}>
								{currentProviderName}
							</div>
						</div>
						<span
							className="text-[10px] px-2 py-0.5 rounded-full"
							style={{
								backgroundColor: `${theme.colors.success}20`,
								color: theme.colors.success,
							}}
						>
							active
						</span>
					</div>
				</div>

				{/* Arrow */}
				<div className="flex justify-center">
					<ArrowDown className="w-4 h-4" style={{ color: theme.colors.textDim }} />
				</div>

				{/* Target Provider Selection */}
				<div>
					<div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: theme.colors.textDim }}>
						Select target provider:
					</div>
					<div
						className="rounded-lg border overflow-hidden"
						style={{
							borderColor: theme.colors.border,
							backgroundColor: theme.colors.bgMain,
						}}
						role="radiogroup"
						aria-label="Target provider"
					>
						{providers.length === 0 ? (
							<div
								className="p-4 text-center text-xs"
								style={{ color: theme.colors.textDim }}
							>
								No other providers detected
							</div>
						) : (
							providers.map((provider) => {
								const isSelected = selectedProvider === provider.id;
								const isAvailable = provider.available;
								const selectableIndex = selectableProviders.findIndex((p) => p.id === provider.id);
								const isHighlighted = isAvailable && selectableIndex === highlightedIndex;

								return (
									<button
										key={provider.id}
										ref={isHighlighted ? highlightedRef : undefined}
										type="button"
										role="radio"
										aria-checked={isSelected}
										aria-disabled={!isAvailable}
										disabled={!isAvailable}
										onClick={() => {
											setSelectedProvider(provider.id);
											if (selectableIndex >= 0) setHighlightedIndex(selectableIndex);
										}}
										className="w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed border-b last:border-b-0"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: isSelected
												? `${theme.colors.accent}15`
												: isHighlighted
													? `${theme.colors.accent}08`
													: 'transparent',
											opacity: isAvailable ? 1 : 0.5,
										}}
									>
										{/* Radio indicator */}
										<div
											className="w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center"
											style={{
												borderColor: isSelected ? theme.colors.accent : theme.colors.border,
											}}
										>
											{isSelected && (
												<div
													className="w-2 h-2 rounded-full"
													style={{ backgroundColor: theme.colors.accent }}
												/>
											)}
										</div>

										{/* Agent icon */}
										<span className="text-base shrink-0">{getAgentIcon(provider.id)}</span>

										{/* Name */}
										<span
											className="flex-1 text-xs font-medium"
											style={{ color: theme.colors.textMain }}
										>
											{provider.name}
										</span>

										{/* Availability badge */}
										<span
											className="text-[10px] flex items-center gap-1 shrink-0"
											style={{
												color: isAvailable ? theme.colors.success : theme.colors.textDim,
											}}
										>
											<span
												className="w-1.5 h-1.5 rounded-full inline-block"
												style={{
													backgroundColor: isAvailable ? theme.colors.success : theme.colors.textDim,
												}}
											/>
											{isAvailable ? 'available' : 'Not Installed'}
										</span>
									</button>
								);
							})
						)}
					</div>
				</div>

				{/* Options */}
				<div>
					<div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: theme.colors.textDim }}>
						Options
					</div>
					<div className="space-y-2">
						<label className="flex items-start gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={groomContext}
								onChange={(e) => setGroomContext(e.target.checked)}
								className="mt-0.5 rounded"
							/>
							<div>
								<div className="text-xs" style={{ color: theme.colors.textMain }}>
									Groom context for target provider
								</div>
								<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Remove agent-specific artifacts and adapt conversation for the target provider
								</div>
							</div>
						</label>
						<label className="flex items-start gap-2 cursor-pointer">
							<input
								type="checkbox"
								checked={archiveSource}
								onChange={(e) => setArchiveSource(e.target.checked)}
								className="mt-0.5 rounded"
							/>
							<div>
								<div className="text-xs" style={{ color: theme.colors.textMain }}>
									Archive source session
								</div>
								<div className="text-[10px]" style={{ color: theme.colors.textDim }}>
									Dim the original session in the sidebar
								</div>
							</div>
						</label>
					</div>
				</div>

				{/* Token estimate */}
				<div
					className="text-xs px-3 py-2 rounded-lg"
					style={{
						backgroundColor: `${theme.colors.textDim}10`,
						color: theme.colors.textDim,
					}}
				>
					Context size: ~{formatTokensCompact(tokenEstimate)} tokens
				</div>
			</div>
		</Modal>
	);
}

export default SwitchProviderModal;
