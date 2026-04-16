/**
 * SettingsSearch - Cross-tab search for the Settings modal
 *
 * Two components:
 *   SettingsSearchInput — the search bar (always visible in the header)
 *   SettingsSearchResults — the results list (shown when search is active, fills remaining space)
 *
 * Keyboard: Cmd+F focuses the input, Escape clears or blurs.
 */

import React, { type ReactNode } from 'react';
import { useState, useRef, useEffect, useCallback } from 'react';
import { Search, X } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import type { Theme } from '../../types';
import { searchSettings, type SearchableSetting } from './searchableSettings';

export interface SettingsSearchProps {
	theme: Theme;
	onNavigate: (tab: SearchableSetting['tab'], settingId: string) => void;
	isOpen: boolean;
	onSearchActiveChange: (active: boolean) => void;
}

export function useSettingsSearch({
	isOpen,
	onSearchActiveChange,
}: Pick<SettingsSearchProps, 'isOpen' | 'onSearchActiveChange'>) {
	const [query, setQuery] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);
	const results = searchSettings(query);
	const isActive = query.length > 0;

	// Notify parent when search active state changes
	useEffect(() => {
		onSearchActiveChange(isActive);
	}, [isActive, onSearchActiveChange]);

	// Reset query when modal closes
	useEffect(() => {
		if (!isOpen) setQuery('');
	}, [isOpen]);

	// Cmd+F focuses the search input, Escape clears or blurs
	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
				e.preventDefault();
				inputRef.current?.focus();
			}
			if (e.key === 'Escape' && document.activeElement === inputRef.current) {
				e.preventDefault();
				e.stopPropagation();
				if (query) {
					setQuery('');
				} else {
					inputRef.current?.blur();
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown, true);
		return () => window.removeEventListener('keydown', handleKeyDown, true);
	}, [isOpen, query]);

	const clear = useCallback(() => {
		setQuery('');
		inputRef.current?.focus();
	}, []);

	return { query, setQuery, inputRef, results, isActive, clear };
}

/** Search input bar — renders inline in the modal header */
export function SettingsSearchInput({
	theme,
	query,
	setQuery,
	inputRef,
	isActive,
	results,
	onClear,
}: {
	theme: Theme;
	query: string;
	setQuery: (q: string) => void;
	inputRef: React.RefObject<HTMLInputElement>;
	isActive: boolean;
	results: SearchableSetting[];
	onClear: () => void;
}) {
	return (
		<div className="flex items-center gap-2 px-4 py-2">
			<Search
				className="w-4 h-4 flex-shrink-0"
				style={{ color: isActive ? theme.colors.accent : theme.colors.textDim }}
			/>
			<input
				ref={inputRef}
				type="text"
				value={query}
				onChange={(e) => setQuery(e.target.value)}
				placeholder="Search settings..."
				className="flex-1 bg-transparent outline-none text-sm"
				style={{ color: theme.colors.textMain }}
				aria-label="Search settings"
			/>
			{isActive && (
				<>
					<span
						className="text-xs px-2 py-0.5 rounded font-medium"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textDim,
						}}
					>
						{results.length}
					</span>
					<GhostIconButton onClick={onClear} padding="p-0.5" ariaLabel="Clear search">
						<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
					</GhostIconButton>
				</>
			)}
			{!isActive && (
				<kbd
					className="text-[10px] px-1.5 py-0.5 rounded font-mono opacity-40"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					{typeof navigator !== 'undefined' && navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl+'}F
				</kbd>
			)}
		</div>
	);
}

/** Search results list — renders as a full-height panel replacing the sidebar+content */
export function SettingsSearchResults({
	theme,
	query,
	results,
	onNavigate,
}: {
	theme: Theme;
	query: string;
	results: SearchableSetting[];
	onNavigate: (tab: SearchableSetting['tab'], settingId: string) => void;
}) {
	// Group results by tab for display
	const grouped = results.reduce<Record<string, SearchableSetting[]>>((acc, setting) => {
		if (!acc[setting.tabLabel]) acc[setting.tabLabel] = [];
		acc[setting.tabLabel].push(setting);
		return acc;
	}, {});

	return (
		<div className="flex-1 p-4 overflow-y-auto scrollbar-thin">
			{results.length === 0 ? (
				<div className="text-center py-8">
					<p className="text-sm" style={{ color: theme.colors.textDim }}>
						No settings found for &ldquo;{query}&rdquo;
					</p>
				</div>
			) : (
				<div className="space-y-4">
					{Object.entries(grouped).map(([tabLabel, settings]) => (
						<div key={tabLabel}>
							<h3
								className="text-xs font-bold uppercase mb-2 px-1"
								style={{ color: theme.colors.textDim }}
							>
								{tabLabel}
							</h3>
							<div className="space-y-1">
								{settings.map((setting) => (
									<button
										key={setting.id}
										onClick={() => onNavigate(setting.tab, setting.id)}
										className="w-full text-left p-3 rounded border transition-colors hover:bg-white/5"
										style={{
											borderColor: theme.colors.border,
											backgroundColor: theme.colors.bgMain,
										}}
									>
										<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
											{highlightMatch(setting.label, query, theme)}
										</div>
										{setting.description && (
											<div
												className="text-xs mt-0.5 opacity-60"
												style={{ color: theme.colors.textDim }}
											>
												{highlightMatch(setting.description, query, theme)}
											</div>
										)}
									</button>
								))}
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Highlights matching portions of text with the accent color.
 */
function highlightMatch(text: string, query: string, theme: Theme): ReactNode {
	if (!query.trim()) return text;

	const terms = query.toLowerCase().trim().split(/\s+/);
	// Build a regex that matches any of the search terms
	const escapedTerms = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
	const regex = new RegExp(`(${escapedTerms.join('|')})`, 'gi');
	const parts = text.split(regex);

	if (parts.length === 1) return text;

	return parts.map((part, i) => {
		const isMatch = terms.some((t) => part.toLowerCase() === t);
		if (isMatch) {
			return (
				<span
					key={i}
					style={{
						color: theme.colors.accent,
						fontWeight: 600,
					}}
				>
					{part}
				</span>
			);
		}
		return part;
	});
}
