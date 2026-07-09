import { ChevronDown, ChevronUp } from 'lucide-react';
import type { Theme } from '../../../types';

interface OutputSearchBarProps {
	theme: Theme;
	outputSearchQuery: string;
	outputSearchRegex: boolean;
	regexError: string | null;
	currentMatchIndex: number;
	totalMatches: number;
	setOutputSearchQuery: (query: string) => void;
	setOutputSearchRegex: (regex: boolean) => void;
	goToNextMatch: () => void;
	goToPrevMatch: () => void;
}

export function OutputSearchBar({
	theme,
	outputSearchQuery,
	outputSearchRegex,
	regexError,
	currentMatchIndex,
	totalMatches,
	setOutputSearchQuery,
	setOutputSearchRegex,
	goToNextMatch,
	goToPrevMatch,
}: OutputSearchBarProps) {
	return (
		<div
			className="sticky top-0 z-10 px-3 pt-3 pb-4"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<input
						type="text"
						value={outputSearchQuery}
						onChange={(e) => setOutputSearchQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault();
								goToNextMatch();
							} else if (e.key === 'Enter' && e.shiftKey) {
								e.preventDefault();
								goToPrevMatch();
							}
						}}
						placeholder={
							outputSearchRegex
								? 'Regex search... (Enter: next, Shift+Enter: prev)'
								: 'Search output... (Enter: next, Shift+Enter: prev)'
						}
						className="w-full pl-3 pr-14 py-2 rounded border bg-transparent outline-none text-sm"
						style={{
							borderColor: regexError ? theme.colors.error : theme.colors.accent,
							color: theme.colors.textMain,
							backgroundColor: theme.colors.bgSidebar,
							fontFamily: outputSearchRegex
								? 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
								: undefined,
						}}
						spellCheck={outputSearchRegex ? false : undefined}
						autoFocus
					/>
					<div
						className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-xs font-bold pointer-events-none"
						style={{
							backgroundColor: theme.colors.bgMain,
							color: theme.colors.textDim,
						}}
					>
						ESC
					</div>
				</div>
				<button
					onClick={() => setOutputSearchRegex(!outputSearchRegex)}
					className="flex items-center justify-center gap-1.5 pl-1 pr-2 rounded border text-xs font-medium whitespace-nowrap transition-colors self-stretch min-w-[7rem]"
					style={{
						borderColor: regexError ? theme.colors.error : theme.colors.accent,
						backgroundColor: theme.colors.accent + '20',
						color: theme.colors.accent,
					}}
					title={outputSearchRegex ? 'Switch to plain-text search' : 'Switch to regex search'}
				>
					<span
						className="px-1.5 py-0.5 rounded font-mono leading-none"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						{outputSearchRegex ? '.*' : 'Aa'}
					</span>
					<span>{outputSearchRegex ? 'Regex' : 'Plain Text'}</span>
				</button>
				{outputSearchQuery.trim() && (
					<>
						<span
							className="text-xs whitespace-nowrap"
							style={{
								color: regexError ? theme.colors.error : theme.colors.textDim,
							}}
							title={regexError ?? undefined}
						>
							{regexError
								? 'Invalid regex'
								: totalMatches > 0
									? `${currentMatchIndex + 1}/${totalMatches}`
									: 'No matches'}
						</span>
						<button
							onClick={goToPrevMatch}
							disabled={totalMatches === 0}
							className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
							style={{ color: theme.colors.textDim }}
							title="Previous match (Shift+Enter)"
						>
							<ChevronUp className="w-4 h-4" />
						</button>
						<button
							onClick={goToNextMatch}
							disabled={totalMatches === 0}
							className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30"
							style={{ color: theme.colors.textDim }}
							title="Next match (Enter)"
						>
							<ChevronDown className="w-4 h-4" />
						</button>
					</>
				)}
			</div>
		</div>
	);
}
