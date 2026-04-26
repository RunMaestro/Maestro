/**
 * TabSearchModal component for web interface
 *
 * A command-palette-like modal for searching and selecting tabs within a
 * session. Uses `ResponsiveModal` so it renders as a bottom sheet on phones
 * and a centered dialog at tablet+. The search input auto-focuses on open
 * so the user can start typing immediately — the defining behaviour of a
 * command palette.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { ResponsiveModal } from '../components';
import type { AITabData } from '../hooks/useWebSocket';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

interface TabSearchModalProps {
	isOpen: boolean;
	tabs: AITabData[];
	activeTabId: string;
	onSelectTab: (tabId: string) => void;
	onClose: () => void;
}

interface TabCardProps {
	tab: AITabData;
	isActive: boolean;
	colors: ReturnType<typeof useThemeColors>;
	onSelect: () => void;
}

function TabCard({ tab, isActive, colors, onSelect }: TabCardProps) {
	const displayName =
		tab.name || (tab.agentSessionId ? tab.agentSessionId.split('-')[0].toUpperCase() : 'New Tab');

	// Get status color (state is 'idle' | 'busy')
	const getStatusColor = () => {
		if (tab.state === 'busy') return colors.warning;
		return colors.success; // idle
	};

	return (
		<button
			onClick={() => {
				triggerHaptic(HAPTIC_PATTERNS.tap);
				onSelect();
			}}
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: '12px',
				width: '100%',
				padding: '12px 16px',
				backgroundColor: isActive ? `${colors.accent}20` : colors.bgSidebar,
				border: isActive ? `1px solid ${colors.accent}` : `1px solid ${colors.border}`,
				borderRadius: '8px',
				cursor: 'pointer',
				textAlign: 'left',
				transition: 'all 0.15s ease',
			}}
		>
			{/* Status dot */}
			<span
				style={{
					width: '10px',
					height: '10px',
					borderRadius: '50%',
					backgroundColor: getStatusColor(),
					flexShrink: 0,
					animation: tab.state === 'busy' ? 'pulse 1.5s infinite' : 'none',
				}}
			/>

			{/* Tab info */}
			<div style={{ flex: 1, minWidth: 0 }}>
				<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
					{/* Starred indicator */}
					{tab.starred && <span style={{ color: colors.warning, fontSize: '12px' }}>★</span>}
					{/* Tab name */}
					<span
						style={{
							fontSize: '14px',
							fontWeight: isActive ? 600 : 500,
							color: colors.textMain,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
					>
						{displayName}
					</span>
				</div>

				{/* Claude session ID */}
				{tab.agentSessionId && (
					<span
						style={{
							fontSize: '11px',
							color: colors.textDim,
							fontFamily: 'monospace',
						}}
					>
						{tab.agentSessionId}
					</span>
				)}
			</div>

			{/* Active indicator */}
			{isActive && (
				<span
					style={{
						fontSize: '11px',
						color: colors.accent,
						fontWeight: 600,
						flexShrink: 0,
					}}
				>
					ACTIVE
				</span>
			)}
		</button>
	);
}

export function TabSearchModal({
	isOpen,
	tabs,
	activeTabId,
	onSelectTab,
	onClose,
}: TabSearchModalProps) {
	const colors = useThemeColors();
	const [searchQuery, setSearchQuery] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);

	// Focus the search input on open. ResponsiveModal schedules a single
	// requestAnimationFrame to focus its dialog container; a nested rAF here
	// runs after that and re-claims focus for the search field — the command
	// palette pattern where typing should work immediately on open.
	// On close, also clear the search query so reopening doesn't land users
	// in a stale-filtered list (the component now stays mounted behind isOpen).
	useEffect(() => {
		if (!isOpen) {
			setSearchQuery('');
			return;
		}
		let innerHandle: number | null = null;
		const outerHandle = requestAnimationFrame(() => {
			innerHandle = requestAnimationFrame(() => {
				inputRef.current?.focus();
			});
		});
		return () => {
			cancelAnimationFrame(outerHandle);
			if (innerHandle !== null) cancelAnimationFrame(innerHandle);
		};
	}, [isOpen]);

	// Filter tabs by search query
	const filteredTabs = useMemo(() => {
		if (!searchQuery.trim()) return tabs;
		const query = searchQuery.toLowerCase();
		return tabs.filter((tab) => {
			const name = tab.name || '';
			const claudeId = tab.agentSessionId || '';
			return name.toLowerCase().includes(query) || claudeId.toLowerCase().includes(query);
		});
	}, [tabs, searchQuery]);

	// Handle tab selection
	const handleSelectTab = useCallback(
		(tabId: string) => {
			onSelectTab(tabId);
			onClose();
		},
		[onSelectTab, onClose]
	);

	return (
		<ResponsiveModal isOpen={isOpen} onClose={onClose} title="Search Tabs" zIndex={1000}>
			{/* Search input */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					padding: '8px 12px',
					backgroundColor: colors.bgMain,
					border: `1px solid ${colors.border}`,
					borderRadius: '8px',
					marginBottom: '12px',
				}}
			>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke={colors.textDim}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="11" cy="11" r="8" />
					<line x1="21" y1="21" x2="16.65" y2="16.65" />
				</svg>
				<input
					ref={inputRef}
					type="text"
					value={searchQuery}
					onChange={(e) => setSearchQuery(e.target.value)}
					placeholder={`Search ${tabs.length} tabs...`}
					style={{
						flex: 1,
						border: 'none',
						backgroundColor: 'transparent',
						color: colors.textMain,
						fontSize: '14px',
						outline: 'none',
					}}
				/>
				{searchQuery && (
					<button
						onClick={() => setSearchQuery('')}
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: '20px',
							height: '20px',
							borderRadius: '10px',
							border: 'none',
							backgroundColor: colors.textDim,
							color: colors.bgMain,
							cursor: 'pointer',
							fontSize: '12px',
						}}
						aria-label="Clear search"
					>
						×
					</button>
				)}
			</div>

			{/* Tab list */}
			{filteredTabs.length === 0 ? (
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						height: '100px',
						color: colors.textDim,
						fontSize: '14px',
					}}
				>
					{searchQuery ? 'No tabs match your search' : 'No tabs available'}
				</div>
			) : (
				<div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
					{filteredTabs.map((tab) => (
						<TabCard
							key={tab.id}
							tab={tab}
							isActive={tab.id === activeTabId}
							colors={colors}
							onSelect={() => handleSelectTab(tab.id)}
						/>
					))}
				</div>
			)}
		</ResponsiveModal>
	);
}

export default TabSearchModal;
