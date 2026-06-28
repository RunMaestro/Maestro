import type { Theme } from '../../../types';

interface DocumentSelectorFooterProps {
	theme: Theme;
	selectedDocs: Set<string>;
	selectedTaskCount: number;
	loadingTaskCounts: boolean;
	onClose: () => void;
	onAdd: (selectedDocs: Set<string>) => void;
}

export function DocumentSelectorFooter({
	theme,
	selectedDocs,
	selectedTaskCount,
	loadingTaskCounts,
	onClose,
	onAdd,
}: DocumentSelectorFooterProps) {
	return (
		<div
			className="p-4 border-t flex justify-end gap-2 shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<button
				type="button"
				onClick={onClose}
				className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
				style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			>
				Cancel
			</button>
			<button
				type="button"
				onClick={() => onAdd(selectedDocs)}
				className="px-4 py-2 rounded text-white font-bold"
				style={{ backgroundColor: theme.colors.accent }}
			>
				Add {selectedDocs.size} {selectedDocs.size === 1 ? 'file' : 'files'} ·{' '}
				{loadingTaskCounts
					? '...'
					: `${selectedTaskCount} ${selectedTaskCount === 1 ? 'task' : 'tasks'}`}
			</button>
		</div>
	);
}
