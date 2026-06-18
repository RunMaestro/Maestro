import type { Theme } from '../../../types';
import { TaskCountBadge } from './TaskCountBadge';

interface DocumentSelectorFlatListProps {
	theme: Theme;
	allDocuments: string[];
	selectedDocs: Set<string>;
	taskCounts: Record<string, number>;
	loadingTaskCounts: boolean;
	onToggleDoc: (filename: string) => void;
}

function CheckMark() {
	return (
		<svg className="w-3 h-3 text-white" viewBox="0 0 12 12" fill="none">
			<path
				d="M2 6L5 9L10 3"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

export function DocumentSelectorFlatList({
	theme,
	allDocuments,
	selectedDocs,
	taskCounts,
	loadingTaskCounts,
	onToggleDoc,
}: DocumentSelectorFlatListProps) {
	return (
		<div className="space-y-1">
			{allDocuments.map((filename) => {
				const isSelected = selectedDocs.has(filename);
				const docTaskCount = taskCounts[filename] ?? 0;

				return (
					<button
						type="button"
						key={filename}
						onClick={() => onToggleDoc(filename)}
						className={`w-full flex items-center gap-3 px-3 py-2 rounded transition-colors ${
							isSelected ? 'bg-white/10' : 'hover:bg-white/5'
						}`}
					>
						<div
							className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
								isSelected ? 'bg-accent border-accent' : ''
							}`}
							style={{
								borderColor: isSelected ? theme.colors.accent : theme.colors.border,
								backgroundColor: isSelected ? theme.colors.accent : 'transparent',
							}}
						>
							{isSelected && <CheckMark />}
						</div>

						<span
							className="flex-1 text-sm text-left truncate"
							style={{ color: theme.colors.textMain }}
						>
							{filename}.md
						</span>

						<TaskCountBadge
							theme={theme}
							count={docTaskCount}
							loading={loadingTaskCounts}
							zeroTone="dim"
						/>
					</button>
				);
			})}
		</div>
	);
}
