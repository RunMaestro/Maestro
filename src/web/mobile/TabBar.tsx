/**
 * TabBar component for web interface
 *
 * Displays Claude Code session tabs within a Maestro session.
 * Styled like browser tabs (Safari/Chrome) where active tab connects to content.
 */

import React, { useState } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type { AITabData } from '../hooks/useWebSocket';

interface TabBarProps {
	tabs: AITabData[];
	activeTabId: string;
	onSelectTab: (tabId: string) => void;
	onNewTab: () => void;
	onCloseTab: (tabId: string) => void;
	onOpenTabSearch?: () => void;
}

interface TabProps {
	tab: AITabData;
	isActive: boolean;
	canClose: boolean;
	colors: ReturnType<typeof useThemeColors>;
	onSelect: () => void;
	onClose: () => void;
}

function Tab({ tab, isActive, canClose, colors, onSelect, onClose }: TabProps) {
	const [isHovered, setIsHovered] = useState(false);

	const displayName =
		tab.name || (tab.agentSessionId ? tab.agentSessionId.split('-')[0].toUpperCase() : 'New');

	return (
		<button
			onClick={onSelect}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: '6px',
				padding: '6px 10px',
				// Browser-style tab with rounded top corners
				borderTopLeftRadius: '6px',
				borderTopRightRadius: '6px',
				// Active tab has visible borders, inactive tabs have no borders
				borderTop: isActive ? `1px solid ${colors.border}` : '1px solid transparent',
				borderLeft: isActive ? `1px solid ${colors.border}` : '1px solid transparent',
				borderRight: isActive ? `1px solid ${colors.border}` : '1px solid transparent',
				// Active tab connects to content (no bottom border)
				borderBottom: isActive ? `1px solid ${colors.bgMain}` : '1px solid transparent',
				// Active tab has bright background matching content, inactive are transparent
				backgroundColor: isActive
					? colors.bgMain
					: isHovered
						? 'rgba(255, 255, 255, 0.08)'
						: 'transparent',
				color: isActive ? colors.textMain : colors.textDim,
				fontSize: '12px',
				fontWeight: isActive ? 600 : 400,
				fontFamily: 'monospace',
				cursor: 'pointer',
				whiteSpace: 'nowrap',
				flexShrink: 0, // Prevent tabs from shrinking - allow horizontal scroll instead
				transition: 'all 0.15s ease',
				// Active tab sits on top of the bar's bottom border
				marginBottom: isActive ? '-1px' : '0',
				zIndex: isActive ? 1 : 0,
				position: 'relative',
			}}
		>
			{/* Pulsing dot for busy tabs */}
			{tab.state === 'busy' && (
				<span
					style={{
						width: '6px',
						height: '6px',
						borderRadius: '50%',
						backgroundColor: colors.warning,
						animation: 'pulse 1.5s infinite',
						flexShrink: 0,
					}}
				/>
			)}

			{/* Star indicator */}
			{tab.starred && (
				<span style={{ fontSize: '10px', flexShrink: 0, color: colors.warning }}>★</span>
			)}

			{/* Tab name - minimum 8 characters visible */}
			<span
				style={{
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					minWidth: '48px', // ~8 characters at 12px monospace (6px per char)
					maxWidth: '80px',
				}}
			>
				{displayName}
			</span>

			{/* Close button - visible on hover or when active */}
			{canClose && (isHovered || isActive) && (
				<span
					onClick={(e) => {
						e.stopPropagation();
						onClose();
					}}
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '14px',
						height: '14px',
						borderRadius: '50%',
						fontSize: '10px',
						color: colors.textDim,
						backgroundColor: 'transparent',
						cursor: 'pointer',
						marginLeft: '2px',
						flexShrink: 0,
					}}
				>
					×
				</span>
			)}
		</button>
	);
}

export function TabBar({
	tabs,
	activeTabId,
	onSelectTab,
	onNewTab,
	onCloseTab,
	onOpenTabSearch,
}: TabBarProps) {
	const colors = useThemeColors();

	// Don't render if there's only one tab
	if (tabs.length <= 1) {
		return null;
	}

	const canClose = tabs.length > 1;

	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'flex-end',
				backgroundColor: colors.bgSidebar,
				borderBottom: `1px solid ${colors.border}`,
			}}
		>
			{/* Pinned buttons - search and new tab */}
			<div
				style={{
					flexShrink: 0,
					padding: '8px 0 0 8px',
					display: 'flex',
					alignItems: 'center',
					gap: '6px',
				}}
			>
				{/* Search tabs button */}
				{onOpenTabSearch && (
					<button
						onClick={onOpenTabSearch}
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: '28px',
							height: '28px',
							borderRadius: '14px',
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.bgMain,
							color: colors.textDim,
							cursor: 'pointer',
							marginBottom: '4px',
						}}
						title={`Search ${tabs.length} tabs`}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<circle cx="11" cy="11" r="8" />
							<line x1="21" y1="21" x2="16.65" y2="16.65" />
						</svg>
					</button>
				)}

				{/* New tab button */}
				<button
					onClick={onNewTab}
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '28px',
						height: '28px',
						borderRadius: '14px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgMain,
						color: colors.textDim,
						cursor: 'pointer',
						marginBottom: '4px',
					}}
					title="New Tab"
				>
					<svg
						width="14"
						height="14"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<line x1="12" y1="5" x2="12" y2="19" />
						<line x1="5" y1="12" x2="19" y2="12" />
					</svg>
				</button>
			</div>

			{/* Scrollable tabs area */}
			<div
				style={{
					display: 'flex',
					flex: 1,
					alignItems: 'flex-end',
					gap: '2px',
					padding: '8px 8px 0 8px',
					overflowX: 'auto',
					WebkitOverflowScrolling: 'touch',
					scrollbarWidth: 'none',
					msOverflowStyle: 'none',
				}}
				className="hide-scrollbar"
			>
				{tabs.map((tab) => (
					<Tab
						key={tab.id}
						tab={tab}
						isActive={tab.id === activeTabId}
						canClose={canClose}
						colors={colors}
						onSelect={() => onSelectTab(tab.id)}
						onClose={() => onCloseTab(tab.id)}
					/>
				))}
			</div>

			{/* CSS for pulse animation */}
			<style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>
		</div>
	);
}

export default TabBar;
