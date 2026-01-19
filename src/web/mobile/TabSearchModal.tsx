/**
 * TabSearchModal component for web interface
 *
 * A full-screen modal for searching and selecting tabs within a session.
 * Similar to AllSessionsView but for tabs.
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type { AITabData } from '../hooks/useWebSocket';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';

interface TabSearchModalProps {
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

export function TabSearchModal({ tabs, activeTabId, onSelectTab, onClose }: TabSearchModalProps) {
	const colors = useThemeColors();
	const [searchQuery, setSearchQuery] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);

	// Focus input on mount
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

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

	// Handle close
	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onClose();
	}, [onClose]);

	// Handle escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				handleClose();
			}
		};
		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, [handleClose]);

	return (
		<div
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: colors.bgMain,
				zIndex: 1000,
				display: 'flex',
				flexDirection: 'column',
				animation: 'slideUp 0.2s ease-out',
			}}
		>
			{/* Header */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '12px',
					padding: '12px 16px',
					paddingTop: 'max(12px, env(safe-area-inset-top))',
					borderBottom: `1px solid ${colors.border}`,
					backgroundColor: colors.bgSidebar,
				}}
			>
				{/* Close button */}
				<button
					onClick={handleClose}
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '32px',
						height: '32px',
						borderRadius: '16px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgMain,
						color: colors.textMain,
						cursor: 'pointer',
						flexShrink: 0,
					}}
					title="Close"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<line x1="18" y1="6" x2="6" y2="18" />
						<line x1="6" y1="6" x2="18" y2="18" />
					</svg>
				</button>

				{/* Search input */}
				<div
					style={{
						flex: 1,
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						padding: '8px 12px',
						backgroundColor: colors.bgMain,
						border: `1px solid ${colors.border}`,
						borderRadius: '8px',
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
						>
							×
						</button>
					)}
				</div>
			</div>

			{/* Tab list */}
			<div
				style={{
					flex: 1,
					overflow: 'auto',
					padding: '12px 16px',
					paddingBottom: 'max(12px, env(safe-area-inset-bottom))',
				}}
			>
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
			</div>

			{/* Animation keyframes */}
			<style>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
		</div>
	);
}

export default TabSearchModal;
