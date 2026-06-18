import React from 'react';
import { X, Filter, PlusCircle, MinusCircle } from 'lucide-react';
import type { Theme } from '../types';

// ============================================================================
// LogFilterControls - Local filter controls for log entries
// ============================================================================
// Extracted from TerminalOutput.tsx to reduce component size
// Provides include/exclude filtering with plain text or regex matching
// ============================================================================

export interface LogFilterControlsProps {
	/** Unique identifier for the log entry */
	logId: string;
	/** Font family for monospace elements */
	fontFamily: string;
	/** Current theme for styling */
	theme: Theme;
	/** Current filter query string */
	filterQuery: string;
	/** Filter mode configuration */
	filterMode: { mode: 'include' | 'exclude'; regex: boolean };
	/** Whether this log's filter is actively open (input focused) */
	isActive: boolean;
	/** Callback when filter is toggled open/closed */
	onToggleFilter: (logId: string) => void;
	/** Callback when filter query changes */
	onSetFilterQuery: (logId: string, query: string) => void;
	/** Callback when filter mode changes */
	onSetFilterMode: (
		logId: string,
		update: (current: { mode: 'include' | 'exclude'; regex: boolean }) => {
			mode: 'include' | 'exclude';
			regex: boolean;
		}
	) => void;
	/** Callback when filter is cleared */
	onClearFilter: (logId: string) => void;
}

/**
 * LogFilterControls component displays local filtering controls for individual log entries.
 *
 * Features:
 * - Include/Exclude mode toggle (filter in or filter out matching lines)
 * - Plain text or Regex matching toggle
 * - Search input with auto-focus when opened
 * - Escape key to close and clear filter
 * - Auto-close when input loses focus if query is empty
 *
 * When collapsed, shows a filter icon that appears on hover.
 * When expanded, shows the full filter bar with mode toggles and input.
 */
export const LogFilterControls: React.FC<LogFilterControlsProps> = ({
	logId,
	fontFamily,
	theme,
	filterQuery,
	filterMode,
	isActive,
	onToggleFilter,
	onSetFilterQuery,
	onSetFilterMode,
	onClearFilter,
}) => {
	// Show expanded filter bar when active or when there's a query
	const showExpanded = isActive || filterQuery;

	if (showExpanded) {
		return (
			<div
				className="flex items-center gap-2 p-2 rounded border"
				style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
			>
				{/* Include/Exclude mode toggle */}
				<button
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => {
						onSetFilterMode(logId, (current) => ({
							...current,
							mode: current.mode === 'include' ? 'exclude' : 'include',
						}));
					}}
					className="p-1 rounded hover:opacity-70 transition-opacity"
					style={{
						color: filterMode.mode === 'include' ? theme.colors.success : theme.colors.error,
					}}
					title={
						filterMode.mode === 'include' ? 'Include matching lines' : 'Exclude matching lines'
					}
				>
					{filterMode.mode === 'include' ? (
						<PlusCircle className="w-3.5 h-3.5" />
					) : (
						<MinusCircle className="w-3.5 h-3.5" />
					)}
				</button>

				{/* Regex/Plain text toggle */}
				<button
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => {
						onSetFilterMode(logId, (current) => ({ ...current, regex: !current.regex }));
					}}
					className="px-2 py-1 rounded hover:opacity-70 transition-opacity text-xs font-bold"
					style={{
						fontFamily,
						color: filterMode.regex ? theme.colors.accent : theme.colors.textDim,
					}}
					title={filterMode.regex ? 'Using regex' : 'Using plain text'}
				>
					{filterMode.regex ? '.*' : 'Aa'}
				</button>

				{/* Filter input */}
				<input
					type="text"
					value={filterQuery}
					onChange={(e) => onSetFilterQuery(logId, e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							e.stopPropagation();
							onClearFilter(logId);
						}
					}}
					onBlur={() => {
						if (!filterQuery) {
							onToggleFilter(logId);
						}
					}}
					placeholder={
						filterMode.mode === 'include'
							? filterMode.regex
								? 'Include by RegEx'
								: 'Include by keyword'
							: filterMode.regex
								? 'Exclude by RegEx'
								: 'Exclude by keyword'
					}
					className="w-40 px-2 py-1 text-xs rounded border bg-transparent outline-none"
					style={{
						borderColor: theme.colors.accent,
						color: theme.colors.textMain,
						backgroundColor: theme.colors.bgMain,
					}}
					autoFocus={isActive}
				/>

				{/* Clear/Close button */}
				<button
					onClick={() => onClearFilter(logId)}
					className="p-1 rounded hover:opacity-70 transition-opacity"
					style={{ color: theme.colors.textDim }}
				>
					<X className="w-3 h-3" />
				</button>
			</div>
		);
	}

	// Collapsed state: show filter icon on hover
	return (
		<button
			onClick={() => onToggleFilter(logId)}
			className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-opacity-10 transition-opacity"
			style={{
				color: filterQuery ? theme.colors.accent : theme.colors.textDim,
				backgroundColor: filterQuery ? theme.colors.bgActivity : 'transparent',
			}}
			title="Filter this output"
		>
			<Filter className="w-3 h-3" />
		</button>
	);
};

LogFilterControls.displayName = 'LogFilterControls';
