import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import type { Theme } from '../types';

interface TerminalSearchBarProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	onSearch: (query: string) => boolean;
	onSearchNext: () => boolean;
	onSearchPrevious: () => boolean;
}

export const TerminalSearchBar = memo(function TerminalSearchBar({
	theme,
	isOpen,
	onClose,
	onSearch,
	onSearchNext,
	onSearchPrevious,
}: TerminalSearchBarProps) {
	const [query, setQuery] = useState('');
	const [hasResults, setHasResults] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);

	const setInputRef = useCallback(
		(el: HTMLInputElement | null) => {
			inputRef.current = el;
			if (el && isOpen) {
				el.focus();
				el.select();
			}
		},
		[isOpen]
	);

	useEffect(() => {
		if (!isOpen) return;
		if (!query) {
			setHasResults(false);
			return;
		}

		setHasResults(onSearch(query));
	}, [isOpen, onSearch, query]);

	const handleSearchNext = useCallback(() => {
		onSearchNext();
	}, [onSearchNext]);

	const handleSearchPrevious = useCallback(() => {
		onSearchPrevious();
	}, [onSearchPrevious]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLInputElement>) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				onClose();
				return;
			}

			if (e.key === 'Enter') {
				e.preventDefault();
				if (e.shiftKey) {
					handleSearchPrevious();
				} else {
					handleSearchNext();
				}
			}
		},
		[handleSearchNext, handleSearchPrevious, onClose]
	);

	if (!isOpen) return null;

	const showNoResults = query.length > 0 && !hasResults;

	return (
		<div
			className="absolute top-2 right-2 z-50 flex items-center gap-1 px-2 py-1.5 rounded-md shadow-lg border"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			<Search className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
			<input
				ref={setInputRef}
				tabIndex={0}
				type="text"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Search..."
				className="w-48 px-2 py-0.5 text-sm bg-transparent outline-none"
				style={{ color: theme.colors.textMain }}
			/>
			{query.length > 0 && (
				<span
					className="text-xs px-1"
					style={{ color: showNoResults ? theme.colors.error : theme.colors.textDim }}
				>
					{showNoResults ? 'No results' : ''}
				</span>
			)}
			<button
				onClick={handleSearchPrevious}
				disabled={!hasResults}
				className="p-0.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
				title="Previous match (Shift+Enter)"
			>
				<ChevronUp className="w-4 h-4" style={{ color: theme.colors.textMain }} />
			</button>
			<button
				onClick={handleSearchNext}
				disabled={!hasResults}
				className="p-0.5 rounded hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed"
				title="Next match (Enter)"
			>
				<ChevronDown className="w-4 h-4" style={{ color: theme.colors.textMain }} />
			</button>
			<button
				onClick={onClose}
				className="p-0.5 ml-1 rounded hover:bg-white/10"
				title="Close (Escape)"
			>
				<X className="w-4 h-4" style={{ color: theme.colors.textDim }} />
			</button>
		</div>
	);
});

export type { TerminalSearchBarProps };
