import React, { useRef, useEffect, useCallback } from 'react';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import type { Theme } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

export interface AutoRunSearchBarProps {
	theme: Theme;
	searchQuery: string;
	onSearchQueryChange: (query: string) => void;
	currentMatchIndex: number;
	totalMatches: number;
	onNextMatch: () => void;
	onPrevMatch: () => void;
	onClose: () => void;
}

/**
 * AutoRunSearchBar - A search bar component for finding text within Auto Run documents.
 *
 * Features:
 * - Text search input with auto-focus
 * - Match counter (e.g., "1/5")
 * - Navigation buttons for next/previous match
 * - Keyboard shortcuts: Enter (next), Shift+Enter (prev), Escape (close)
 *
 * Extracted from AutoRun.tsx to reduce file size (~70 lines).
 */
export function AutoRunSearchBar({
	theme,
	searchQuery,
	onSearchQueryChange,
	currentMatchIndex,
	totalMatches,
	onNextMatch,
	onPrevMatch,
	onClose,
}: AutoRunSearchBarProps) {
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Register with layer stack so Escape closes search before modal
	useModalLayer(MODAL_PRIORITIES.AUTORUN_SEARCH, undefined, onClose, {
		blocksLowerLayers: false,
		focusTrap: 'lenient',
	});

	// Auto-focus the search input when the component mounts
	useEffect(() => {
		searchInputRef.current?.focus();
	}, []);

	// Handle keyboard navigation within the search input
	// Note: Escape is now handled by the layer stack, not here
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				onNextMatch();
			} else if (e.key === 'Enter' && e.shiftKey) {
				e.preventDefault();
				onPrevMatch();
			}
		},
		[onNextMatch, onPrevMatch]
	);

	return (
		<div
			className="mx-2 mb-2 flex items-center gap-2 px-3 py-2 rounded"
			style={{
				backgroundColor: theme.colors.bgActivity,
				border: `1px solid ${theme.colors.accent}`,
			}}
		>
			<Search className="w-4 h-4 shrink-0" style={{ color: theme.colors.accent }} />
			<input
				ref={searchInputRef}
				type="text"
				value={searchQuery}
				onChange={(e) => onSearchQueryChange(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Search..."
				className="flex-1 bg-transparent outline-none text-sm"
				style={{ color: theme.colors.textMain }}
				autoFocus
			/>
			{searchQuery.trim() && (
				<>
					<span className="text-xs whitespace-nowrap" style={{ color: theme.colors.textDim }}>
						{totalMatches > 0 ? `${currentMatchIndex + 1}/${totalMatches}` : 'No matches'}
					</span>
					<button
						onClick={onPrevMatch}
						disabled={totalMatches === 0}
						className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
						style={{ color: theme.colors.textDim }}
						title="Previous match (Shift+Enter)"
					>
						<ChevronUp className="w-4 h-4" />
					</button>
					<button
						onClick={onNextMatch}
						disabled={totalMatches === 0}
						className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
						style={{ color: theme.colors.textDim }}
						title="Next match (Enter)"
					>
						<ChevronDown className="w-4 h-4" />
					</button>
				</>
			)}
			<GhostIconButton onClick={onClose} title="Close search (Esc)" color={theme.colors.textDim}>
				<X className="w-4 h-4" />
			</GhostIconButton>
		</div>
	);
}
