import { useMemo } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { Theme } from '../../../../types';
import type { GeneratedDocument } from '../../../Wizard/WizardContext';
import { formatSize } from '../../../../../shared/formatters';
import { countTasks, extractDocumentDescription } from '../utils/documentStats';

interface CreatedFileEntryProps {
	doc: GeneratedDocument;
	isExpanded: boolean;
	isNewest: boolean;
	theme: Theme;
	onToggle: () => void;
}

export function CreatedFileEntry({
	doc,
	isExpanded,
	isNewest,
	theme,
	onToggle,
}: CreatedFileEntryProps): JSX.Element {
	const taskCount = countTasks(doc.content);
	const fileSize = new Blob([doc.content]).size;
	const description = useMemo(() => extractDocumentDescription(doc.content), [doc.content]);

	return (
		<div
			className="overflow-hidden transition-all duration-300"
			style={{
				animation: isNewest ? 'fadeSlideIn 0.3s ease-out' : undefined,
			}}
		>
			<button
				onClick={onToggle}
				className="w-full px-4 py-2.5 flex items-center justify-between text-sm text-left hover:opacity-80 transition-opacity"
				style={{
					backgroundColor: isExpanded ? `${theme.colors.accent}10` : 'transparent',
				}}
			>
				<div className="flex items-center gap-2 min-w-0">
					{isExpanded ? (
						<ChevronDown
							className="w-4 h-4 shrink-0 transition-transform duration-200"
							style={{ color: theme.colors.textDim }}
						/>
					) : (
						<ChevronRight
							className="w-4 h-4 shrink-0 transition-transform duration-200"
							style={{ color: theme.colors.textDim }}
						/>
					)}
					<span style={{ color: theme.colors.success }}>✓</span>
					<span
						className="truncate font-medium"
						style={{ color: theme.colors.textMain }}
						title={doc.filename}
					>
						{doc.filename}
					</span>
				</div>
				<div className="flex items-center gap-3 shrink-0 ml-2">
					{taskCount > 0 && (
						<span
							className="text-xs font-medium px-1.5 py-0.5 rounded"
							style={{
								backgroundColor: `${theme.colors.accent}20`,
								color: theme.colors.accent,
							}}
						>
							{taskCount} {taskCount === 1 ? 'task' : 'tasks'}
						</span>
					)}
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						{formatSize(fileSize)}
					</span>
				</div>
			</button>

			<div
				className="overflow-hidden transition-all duration-300 ease-out"
				style={{
					maxHeight: isExpanded ? '120px' : '0px',
					opacity: isExpanded ? 1 : 0,
				}}
			>
				{description && (
					<div
						className="px-4 pb-3 pl-12 text-xs leading-relaxed"
						style={{ color: theme.colors.textDim }}
					>
						{description}
					</div>
				)}
			</div>
		</div>
	);
}
