import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { Theme } from '../../types';
import {
	type BundledLanguageEntry as LanguageEntry,
	getBundledLanguageEntries,
} from '../../utils/shiki/highlighterManager';

let cachedEntries: LanguageEntry[] | null = null;
let cachedEntriesPromise: Promise<LanguageEntry[]> | null = null;

async function loadLanguageEntries(): Promise<LanguageEntry[]> {
	if (cachedEntries) return cachedEntries;
	if (cachedEntriesPromise) return cachedEntriesPromise;
	cachedEntriesPromise = (async () => {
		const entries = await getBundledLanguageEntries();
		// Always offer the plaintext escape hatch even though Shiki treats it
		// specially (it ships a "plaintext" grammar but it isn't in
		// `bundledLanguagesInfo`).
		const withText = entries.some((e) => e.id === 'text')
			? entries
			: [{ id: 'text', name: 'Plain Text', aliases: ['plain', 'plaintext'] }, ...entries];
		cachedEntries = withText;
		return withText;
	})();
	return cachedEntriesPromise;
}

function scoreEntry(entry: LanguageEntry, query: string): number {
	if (!query) return 1;
	const q = query.toLowerCase();
	const id = entry.id.toLowerCase();
	const name = entry.name.toLowerCase();
	if (id === q || entry.aliases.some((a) => a.toLowerCase() === q)) return 100;
	if (id.startsWith(q) || name.startsWith(q)) return 75;
	if (entry.aliases.some((a) => a.toLowerCase().startsWith(q))) return 70;
	if (id.includes(q) || name.includes(q)) return 50;
	if (entry.aliases.some((a) => a.toLowerCase().includes(q))) return 40;
	return 0;
}

interface LanguagePickerProps {
	theme: Theme;
	language: string;
	onChange: (language: string) => void;
}

export const LanguagePicker = memo(function LanguagePicker({
	theme,
	language,
	onChange,
}: LanguagePickerProps) {
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	const [query, setQuery] = useState('');
	const [entries, setEntries] = useState<LanguageEntry[]>(cachedEntries ?? []);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void loadLanguageEntries().then((loaded) => {
			if (!cancelled) setEntries(loaded);
		});
		return () => {
			cancelled = true;
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onMouseDown = (e: MouseEvent) => {
			if (buttonRef.current?.contains(e.target as Node)) return;
			if (popoverRef.current?.contains(e.target as Node)) return;
			setOpen(false);
		};
		document.addEventListener('mousedown', onMouseDown);
		return () => document.removeEventListener('mousedown', onMouseDown);
	}, [open]);

	useEffect(() => {
		if (open) {
			requestAnimationFrame(() => inputRef.current?.focus());
		}
	}, [open]);

	const filtered = useMemo(() => {
		if (!query) return entries.slice(0, 200);
		const scored = entries
			.map((e) => ({ entry: e, score: scoreEntry(e, query) }))
			.filter((s) => s.score > 0)
			.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
		return scored.slice(0, 200).map((s) => s.entry);
	}, [entries, query]);

	useEffect(() => {
		setSelectedIndex(0);
	}, [query]);

	const handleOpen = useCallback(() => {
		const btn = buttonRef.current;
		if (!btn) return;
		const rect = btn.getBoundingClientRect();
		// Anchor the popover below the button, right-aligned so it doesn't
		// hang off the code block's right edge.
		const popoverWidth = 280;
		setPosition({
			top: rect.bottom + 4,
			left: Math.max(8, rect.right - popoverWidth),
		});
		setOpen(true);
		setQuery('');
	}, []);

	const handleSelect = useCallback(
		(lang: string) => {
			onChange(lang);
			setOpen(false);
			setQuery('');
		},
		[onChange]
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				setOpen(false);
				return;
			}
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				setSelectedIndex((i) => Math.max(i - 1, 0));
				return;
			}
			if (e.key === 'Enter') {
				e.preventDefault();
				const choice = filtered[selectedIndex];
				if (choice) handleSelect(choice.id);
			}
		},
		[filtered, selectedIndex, handleSelect]
	);

	const displayName = useMemo(() => {
		const match = entries.find((e) => e.id === language);
		return match?.name ?? language;
	}, [entries, language]);

	return (
		<>
			<button
				ref={buttonRef}
				type="button"
				onClick={handleOpen}
				className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-mono opacity-50 hover:!opacity-100 transition-opacity"
				style={{
					backgroundColor: theme.colors.bgActivity,
					color: theme.colors.textDim,
					border: `1px solid ${theme.colors.border}`,
				}}
				title="Change language"
			>
				<span>{displayName}</span>
				<ChevronDown className="w-3 h-3" />
			</button>
			{open &&
				position &&
				createPortal(
					<div
						ref={popoverRef}
						tabIndex={-1}
						onKeyDown={handleKeyDown}
						className="fixed z-[1000] rounded-lg shadow-xl overflow-hidden outline-none flex flex-col"
						style={{
							top: position.top,
							left: position.left,
							width: 280,
							maxHeight: 320,
							backgroundColor: theme.colors.bgSidebar,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<div
							className="flex items-center gap-2 px-2 py-1.5 border-b"
							style={{ borderColor: theme.colors.border }}
						>
							<Search className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							<input
								ref={inputRef}
								type="text"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Filter languages…"
								className="flex-1 bg-transparent outline-none text-sm"
								style={{ color: theme.colors.textMain }}
							/>
						</div>
						<div className="overflow-y-auto scrollbar-thin flex-1">
							{filtered.length === 0 && (
								<div className="px-3 py-2 text-xs" style={{ color: theme.colors.textDim }}>
									No matches
								</div>
							)}
							{filtered.map((entry, idx) => {
								const isSelected = idx === selectedIndex;
								const isCurrent = entry.id === language;
								return (
									<button
										key={entry.id}
										type="button"
										onClick={() => handleSelect(entry.id)}
										onMouseEnter={() => setSelectedIndex(idx)}
										className="w-full flex items-center gap-2 px-2 py-1 text-left text-sm"
										style={{
											backgroundColor: isSelected ? theme.colors.bgActivity : 'transparent',
											color: theme.colors.textMain,
										}}
									>
										<span className="flex-1 truncate">{entry.name}</span>
										<span className="text-[10px] font-mono" style={{ color: theme.colors.textDim }}>
											{entry.id}
										</span>
										{isCurrent && (
											<Check className="w-3 h-3 shrink-0" style={{ color: theme.colors.accent }} />
										)}
									</button>
								);
							})}
						</div>
					</div>,
					document.body
				)}
		</>
	);
});
