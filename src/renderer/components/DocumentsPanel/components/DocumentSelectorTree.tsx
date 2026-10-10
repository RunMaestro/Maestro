import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import type React from 'react';
import type { Theme } from '../../../types';
import type { DocTreeNode } from '../types';
import {
	getFilesInNode,
	getFolderTaskCount,
	isFolderFullySelected,
	isFolderPartiallySelected,
} from '../utils/documentTree';
import { TaskCountBadge } from './TaskCountBadge';

interface DocumentSelectorTreeProps {
	theme: Theme;
	documentTree: DocTreeNode[];
	selectedDocs: Set<string>;
	expandedFolders: Set<string>;
	taskCounts: Record<string, number>;
	loadingTaskCounts: boolean;
	onToggleDoc: (filename: string) => void;
	onToggleFolder: (folderPath: string) => void;
	onToggleFolderSelection: (node: DocTreeNode) => void;
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

export function DocumentSelectorTree({
	theme,
	documentTree,
	selectedDocs,
	expandedFolders,
	taskCounts,
	loadingTaskCounts,
	onToggleDoc,
	onToggleFolder,
	onToggleFolderSelection,
}: DocumentSelectorTreeProps) {
	const renderTreeNode = (node: DocTreeNode, depth = 0): React.ReactNode => {
		const paddingLeft = depth * 20 + 12;

		if (node.type === 'folder') {
			const isExpanded = expandedFolders.has(node.path);
			const isFullySelected = isFolderFullySelected(node, selectedDocs);
			const isPartiallySelected = isFolderPartiallySelected(node, selectedDocs);
			const filesInFolder = getFilesInNode(node);
			const folderTaskCount = getFolderTaskCount(node, taskCounts);

			return (
				<div key={node.path}>
					<div
						className={`w-full flex items-center gap-2 py-1.5 rounded transition-colors ${
							isFullySelected ? 'bg-white/10' : 'hover:bg-white/5'
						}`}
						style={{ paddingLeft }}
					>
						<button
							type="button"
							onClick={() => onToggleFolder(node.path)}
							aria-label={`${isExpanded ? 'Collapse' : 'Expand'} folder ${node.name}`}
							aria-expanded={isExpanded}
							className="p-0.5 rounded hover:bg-white/10 shrink-0"
							style={{ color: theme.colors.textDim }}
						>
							{isExpanded ? (
								<ChevronDown className="w-3 h-3" />
							) : (
								<ChevronRight className="w-3 h-3" />
							)}
						</button>

						<button
							type="button"
							onClick={() => onToggleFolderSelection(node)}
							className="flex items-center gap-2 flex-1 min-w-0"
						>
							<div
								className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
								style={{
									borderColor:
										isFullySelected || isPartiallySelected
											? theme.colors.accent
											: theme.colors.border,
									backgroundColor: isFullySelected ? theme.colors.accent : 'transparent',
								}}
							>
								{isFullySelected && <CheckMark />}
								{isPartiallySelected && (
									<div
										className="w-2 h-2 rounded-sm"
										style={{ backgroundColor: theme.colors.accent }}
									/>
								)}
							</div>

							<Folder className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
							<span className="text-sm truncate" style={{ color: theme.colors.textMain }}>
								{node.name}
							</span>
						</button>

						<span
							className="text-xs px-2 py-0.5 rounded shrink-0"
							style={{
								backgroundColor: theme.colors.textDim + '20',
								color: theme.colors.textDim,
							}}
						>
							{filesInFolder.length} {filesInFolder.length === 1 ? 'file' : 'files'}
						</span>

						<TaskCountBadge
							theme={theme}
							count={folderTaskCount}
							loading={loadingTaskCounts}
							zeroTone="dim"
							className="mr-3"
						/>
					</div>

					{isExpanded && node.children && (
						<div>{node.children.map((child) => renderTreeNode(child, depth + 1))}</div>
					)}
				</div>
			);
		}

		const isSelected = selectedDocs.has(node.path);
		const docTaskCount = taskCounts[node.path] ?? 0;

		return (
			<button
				type="button"
				key={node.path}
				onClick={() => onToggleDoc(node.path)}
				className={`w-full flex items-center gap-3 py-1.5 rounded transition-colors ${
					isSelected ? 'bg-white/10' : 'hover:bg-white/5'
				}`}
				style={{ paddingLeft: paddingLeft + 20 }}
			>
				<div
					className="w-4 h-4 rounded border flex items-center justify-center shrink-0"
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
					{node.name}.md
				</span>

				<TaskCountBadge
					theme={theme}
					count={docTaskCount}
					loading={loadingTaskCounts}
					zeroTone="dim"
					className="mr-3"
				/>
			</button>
		);
	};

	return <div className="space-y-0.5">{documentTree.map((node) => renderTreeNode(node))}</div>;
}
