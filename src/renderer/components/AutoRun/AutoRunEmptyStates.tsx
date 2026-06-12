import { memo } from 'react';
import { FileText, CheckSquare, Play, FolderOpen, RefreshCw } from 'lucide-react';
import type { Theme } from '../../types';

export interface NoFolderStateProps {
	theme: Theme;
	onOpenSetup: () => void;
}

export interface EmptyFolderStateProps {
	theme: Theme;
	isRefreshingEmpty: boolean;
	onRefresh: () => void;
	onOpenSetup: () => void;
}

export const NoFolderState = memo(function NoFolderState({
	theme,
	onOpenSetup,
}: NoFolderStateProps) {
	return (
		<div className="flex-1 flex flex-col items-center justify-center px-4">
			<div className="max-w-sm space-y-4">
				{/* Explanation */}
				<p className="text-sm leading-relaxed text-center" style={{ color: theme.colors.textMain }}>
					Auto Run lets you manage and execute Markdown documents containing open tasks. Select a
					folder that contains your task documents.
				</p>

				{/* Feature list */}
				<div className="space-y-3">
					<div className="flex items-start gap-3">
						<FileText
							className="w-5 h-5 mt-0.5 flex-shrink-0"
							style={{ color: theme.colors.accent }}
						/>
						<div>
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Markdown Documents
							</div>
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Each .md file in your folder becomes a runnable document
							</div>
						</div>
					</div>

					<div className="flex items-start gap-3">
						<CheckSquare
							className="w-5 h-5 mt-0.5 flex-shrink-0"
							style={{ color: theme.colors.accent }}
						/>
						<div>
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Checkbox Tasks
							</div>
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Use markdown checkboxes (- [ ]) to define tasks that can be automated
							</div>
						</div>
					</div>

					<div className="flex items-start gap-3">
						<Play className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: theme.colors.accent }} />
						<div>
							<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
								Batch Execution
							</div>
							<div className="text-xs" style={{ color: theme.colors.textDim }}>
								Run multiple documents in sequence with loop and reset options
							</div>
						</div>
					</div>
				</div>

				{/* Select Folder Button */}
				<div className="pt-2 flex justify-center">
					<button
						onClick={onOpenSetup}
						className="flex items-center gap-1.5 px-4 py-2 rounded text-sm font-medium transition-colors hover:opacity-90"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						<FolderOpen className="w-4 h-4" />
						Select Auto Run Folder
					</button>
				</div>
			</div>
		</div>
	);
});

export const EmptyFolderState = memo(function EmptyFolderState({
	theme,
	isRefreshingEmpty,
	onRefresh,
	onOpenSetup,
}: EmptyFolderStateProps) {
	return (
		<div
			className="h-full flex flex-col items-center justify-center text-center px-6"
			style={{ color: theme.colors.textDim }}
		>
			<div
				className="w-16 h-16 rounded-full flex items-center justify-center mb-4"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<FileText className="w-8 h-8" style={{ color: theme.colors.textDim }} />
			</div>
			<h3 className="text-lg font-semibold mb-2" style={{ color: theme.colors.textMain }}>
				No Documents Found
			</h3>
			<p className="mb-4 max-w-xs text-sm">
				The selected folder doesn't contain any markdown (.md) files.
			</p>
			<p className="mb-6 max-w-xs text-xs" style={{ color: theme.colors.textDim }}>
				Create a markdown file in the folder to get started, or change to a different folder.
			</p>
			<div className="flex gap-3">
				<button
					onClick={isRefreshingEmpty ? undefined : onRefresh}
					disabled={isRefreshingEmpty}
					aria-busy={isRefreshingEmpty}
					className={`flex items-center gap-2 px-4 py-2 rounded text-sm transition-colors ${isRefreshingEmpty ? 'opacity-50 cursor-not-allowed' : 'hover:opacity-90'}`}
					style={{
						backgroundColor: 'transparent',
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					<RefreshCw className={`w-4 h-4 ${isRefreshingEmpty ? 'animate-spin' : ''}`} />
					Refresh
				</button>
				<button
					onClick={onOpenSetup}
					className="flex items-center gap-2 px-4 py-2 rounded text-sm transition-colors hover:opacity-90"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
				>
					<FolderOpen className="w-4 h-4" />
					Change Folder
				</button>
			</div>
		</div>
	);
});
