import type { BatchDocumentEntry, Theme } from '../../../types';
import type { DragHandlers } from '../types';
import { DocumentRow } from './DocumentRow';

interface DocumentListProps extends DragHandlers {
	theme: Theme;
	documents: BatchDocumentEntry[];
	taskCounts: Record<string, number>;
	loadingTaskCounts: boolean;
	loopEnabled: boolean;
	draggedId: string | null;
	dropTargetIndex: number | null;
	isCopyDrag: boolean;
	onRemoveDocument: (id: string) => void;
	onToggleReset: (id: string) => void;
	onDuplicateDocument: (id: string) => void;
}

export function DocumentList({
	theme,
	documents,
	taskCounts,
	loadingTaskCounts,
	loopEnabled,
	draggedId,
	dropTargetIndex,
	isCopyDrag,
	handleDragStart,
	handleDrag,
	handleDragOver,
	handleDragLeave,
	handleDrop,
	handleDragEnd,
	onRemoveDocument,
	onToggleReset,
	onDuplicateDocument,
}: DocumentListProps) {
	return (
		<div className={`relative ${loopEnabled && documents.length > 1 ? 'ml-7' : ''}`}>
			{loopEnabled && documents.length > 1 && (
				<>
					<div
						className="absolute pointer-events-none"
						style={{
							left: -24,
							top: 8,
							bottom: 8,
							width: 3,
							backgroundColor: theme.colors.accent,
							borderRadius: 1.5,
						}}
					/>
					<div
						className="absolute pointer-events-none"
						style={{
							left: -24,
							top: 8,
							width: 18,
							height: 3,
							backgroundColor: theme.colors.accent,
							borderRadius: 1.5,
						}}
					/>
					<div
						className="absolute pointer-events-none"
						style={{
							left: -24,
							bottom: 8,
							width: 18,
							height: 3,
							backgroundColor: theme.colors.accent,
							borderRadius: 1.5,
						}}
					/>
					<div
						className="absolute pointer-events-none"
						style={{
							left: -10,
							top: 2,
							width: 0,
							height: 0,
							borderTop: '6px solid transparent',
							borderBottom: '6px solid transparent',
							borderLeft: `9px solid ${theme.colors.accent}`,
						}}
					/>
				</>
			)}
			<div
				className="rounded-lg border overflow-hidden"
				style={{ backgroundColor: theme.colors.bgMain, borderColor: theme.colors.border }}
			>
				{documents.length === 0 ? (
					<div className="p-4 text-center" style={{ color: theme.colors.textDim }}>
						<p className="text-sm">No documents selected</p>
						<p className="text-xs mt-1">
							Load a playbook or click "+ Add Docs" to select documents to run
						</p>
					</div>
				) : (
					<div
						onDragLeave={handleDragLeave}
						onDrop={handleDrop}
						onDragOver={(e) => e.preventDefault()}
					>
						{documents.map((doc, index) => (
							<DocumentRow
								key={doc.id}
								theme={theme}
								doc={doc}
								index={index}
								documents={documents}
								taskCount={taskCounts[doc.filename] ?? 0}
								loadingTaskCounts={loadingTaskCounts}
								draggedId={draggedId}
								dropTargetIndex={dropTargetIndex}
								isCopyDrag={isCopyDrag}
								onDragStart={handleDragStart}
								onDrag={handleDrag}
								onDragOver={handleDragOver}
								onDrop={handleDrop}
								onDragEnd={handleDragEnd}
								onRemove={onRemoveDocument}
								onToggleReset={onToggleReset}
								onDuplicate={onDuplicateDocument}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
