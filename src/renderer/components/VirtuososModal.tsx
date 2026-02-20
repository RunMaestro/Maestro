/**
 * VirtuososModal - Standalone modal for account (Virtuoso) management
 *
 * Three-tab layout:
 * 1. Accounts — AccountsPanel (account CRUD, discovery, plan presets, auto-switch)
 * 2. Providers — ProviderPanel (provider status, failover config, migration history)
 * 3. Usage — VirtuosoUsageView (real-time metrics, predictions, history, throttle events)
 */

import React, { useState, useEffect } from 'react';
import { Users, Settings, BarChart3, ArrowRightLeft } from 'lucide-react';
import { AccountsPanel } from './AccountsPanel';
import { ProviderPanel } from './ProviderPanel';
import { VirtuosoUsageView } from './VirtuosoUsageView';
import { Modal } from './ui/Modal';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useProviderHealth } from '../hooks/useProviderHealth';
import type { Theme, Session } from '../types';

type VirtuosoTab = 'config' | 'providers' | 'usage';

const VIRTUOSO_TABS: { value: VirtuosoTab; label: string; icon: typeof Settings }[] = [
	{ value: 'config', label: 'Accounts', icon: Settings },
	{ value: 'providers', label: 'Providers', icon: ArrowRightLeft },
	{ value: 'usage', label: 'Usage', icon: BarChart3 },
];

interface VirtuososModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	sessions?: Session[];
	onSelectSession?: (sessionId: string) => void;
}

export function VirtuososModal({ isOpen, onClose, theme, sessions, onSelectSession }: VirtuososModalProps) {
	const [activeTab, setActiveTab] = useState<VirtuosoTab>('config');
	const { hasDegradedProvider, hasFailingProvider } = useProviderHealth(sessions);

	// Keyboard navigation: Cmd/Ctrl+Shift+[ and Cmd/Ctrl+Shift+]
	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === '[' || e.key === ']')) {
				e.preventDefault();
				e.stopPropagation();
				const currentIndex = VIRTUOSO_TABS.findIndex((t) => t.value === activeTab);
				if (e.key === '[') {
					const prev = currentIndex > 0 ? currentIndex - 1 : VIRTUOSO_TABS.length - 1;
					setActiveTab(VIRTUOSO_TABS[prev].value);
				} else {
					const next =
						currentIndex < VIRTUOSO_TABS.length - 1 ? currentIndex + 1 : 0;
					setActiveTab(VIRTUOSO_TABS[next].value);
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [isOpen, activeTab]);

	if (!isOpen) return null;

	const modalWidth = activeTab === 'usage' ? 900 : activeTab === 'providers' ? 860 : 720;

	return (
		<Modal
			theme={theme}
			title="Virtuosos"
			priority={MODAL_PRIORITIES.VIRTUOSOS}
			onClose={onClose}
			headerIcon={<Users className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={modalWidth}
			closeOnBackdropClick
		>
			<div className="mb-1">
				<p className="text-xs" style={{ color: theme.colors.textDim }}>
					AI Provider Accounts
				</p>
			</div>

			{/* Tab bar */}
			<div
				className="flex items-center gap-1 mb-4 border-b pb-2"
				style={{ borderColor: theme.colors.border }}
				role="tablist"
				aria-label="Virtuosos view"
			>
				{VIRTUOSO_TABS.map((tab) => {
					const Icon = tab.icon;
					return (
						<button
							key={tab.value}
							onClick={() => setActiveTab(tab.value)}
							className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
							style={{
								backgroundColor:
									activeTab === tab.value
										? `${theme.colors.accent}20`
										: 'transparent',
								color:
									activeTab === tab.value
										? theme.colors.accent
										: theme.colors.textDim,
							}}
							onMouseEnter={(e) => {
								if (activeTab !== tab.value) {
									e.currentTarget.style.backgroundColor = `${theme.colors.accent}10`;
								}
							}}
							onMouseLeave={(e) => {
								if (activeTab !== tab.value) {
									e.currentTarget.style.backgroundColor = 'transparent';
								}
							}}
							role="tab"
							aria-selected={activeTab === tab.value}
							aria-controls={`tabpanel-${tab.value}`}
							id={`virtuoso-tab-${tab.value}`}
							tabIndex={-1}
						>
							<Icon className="w-3.5 h-3.5" />
							{tab.label}
							{tab.value === 'providers' && hasDegradedProvider && (
								<span
									className="ml-1 w-2 h-2 rounded-full inline-block"
									style={{
										backgroundColor: hasFailingProvider
											? theme.colors.error
											: theme.colors.warning,
									}}
								/>
							)}
						</button>
					);
				})}
			</div>

			{/* Tab content */}
			{activeTab === 'config' && <AccountsPanel theme={theme} />}
			{activeTab === 'providers' && <ProviderPanel theme={theme} sessions={sessions} onSelectSession={onSelectSession} />}
			{activeTab === 'usage' && <VirtuosoUsageView theme={theme} sessions={sessions} />}
		</Modal>
	);
}
