import type React from 'react';
import { Search } from 'lucide-react';
import type { Session, Theme } from '../../../types';
import type { QuickActionMode } from '../types';

interface QuickActionsSearchBarProps {
	theme: Theme;
	mode: QuickActionMode;
	activeSession: Session | undefined;
	/** True while an inline rename (session or window) is active - shows the rename input. */
	renaming: boolean;
	search: string;
	setSearch: (value: string) => void;
	renameValue: string;
	setRenameValue: (value: string) => void;
	inputRef: React.Ref<HTMLInputElement>;
	onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function QuickActionsSearchBar({
	theme,
	mode,
	activeSession,
	renaming,
	search,
	setSearch,
	renameValue,
	setRenameValue,
	inputRef,
	onKeyDown,
}: QuickActionsSearchBarProps) {
	return (
		<div
			className="p-4 border-b flex items-center gap-3"
			style={{ borderColor: theme.colors.border }}
		>
			<Search className="w-5 h-5" style={{ color: theme.colors.textDim }} />
			{renaming ? (
				<input
					ref={inputRef}
					className="flex-1 bg-transparent outline-none text-lg"
					placeholder="Enter new name..."
					style={{ color: theme.colors.textMain }}
					value={renameValue}
					onChange={(e) => setRenameValue(e.target.value)}
					onKeyDown={onKeyDown}
					autoFocus
				/>
			) : (
				<input
					ref={inputRef}
					className="flex-1 bg-transparent outline-none text-lg placeholder-opacity-50"
					placeholder={
						mode === 'move-to-group'
							? `Move ${activeSession?.name || 'session'} to...`
							: mode === 'agents'
								? 'Jump to agent...'
								: 'Type a command or jump to agent...'
					}
					style={{ color: theme.colors.textMain }}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					onKeyDown={onKeyDown}
				/>
			)}
			<div
				className="px-2 py-0.5 rounded text-xs font-bold"
				style={{ backgroundColor: theme.colors.bgMain, color: theme.colors.textDim }}
			>
				ESC
			</div>
		</div>
	);
}
