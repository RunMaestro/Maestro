import { useCallback, useState } from 'react';
import { Plus } from 'lucide-react';
import type { DocumentsPanelProps } from './types';
import {
	CopyDragIndicator,
	DocumentList,
	DocumentSelectorModal,
	LoopControls,
	MissingDocumentsWarning,
} from './components';
import { useDocumentDragReorder, useDocumentListActions } from './hooks';
import { getMissingDocumentCount, getTotalDocumentTaskCount } from './utils';

export function DocumentsPanel({
	theme,
	documents,
	setDocuments,
	taskCounts,
	loadingTaskCounts,
	loopEnabled,
	setLoopEnabled,
	maxLoops,
	setMaxLoops,
	allDocuments,
	documentTree,
	onRefreshDocuments,
}: DocumentsPanelProps) {
	const [showDocSelector, setShowDocSelector] = useState(false);

	const missingDocCount = getMissingDocumentCount(documents);
	const hasMissingDocs = missingDocCount > 0;
	const totalTaskCount = getTotalDocumentTaskCount(documents, taskCounts);

	const handleCloseDocSelector = useCallback(() => {
		setShowDocSelector(false);
	}, []);

	const {
		handleRemoveDocument,
		handleToggleReset,
		handleDuplicateDocument,
		handleAddSelectedDocs,
	} = useDocumentListActions({
		documents,
		setDocuments,
		onAddComplete: handleCloseDocSelector,
	});

	const {
		draggedId,
		dropTargetIndex,
		isCopyDrag,
		cursorPosition,
		handleDragStart,
		handleDrag,
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handleDragEnd,
	} = useDocumentDragReorder({
		documents,
		setDocuments,
	});

	return (
		<div className="mb-6">
			<div className="flex items-center justify-between mb-3">
				<div className="text-xs font-bold uppercase" style={{ color: theme.colors.textDim }}>
					Documents to Run
				</div>
				<button
					type="button"
					onClick={() => setShowDocSelector(true)}
					className="flex items-center gap-1 text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.accent }}
				>
					<Plus className="w-3 h-3" />
					Add Docs
				</button>
			</div>

			<DocumentList
				theme={theme}
				documents={documents}
				taskCounts={taskCounts}
				loadingTaskCounts={loadingTaskCounts}
				loopEnabled={loopEnabled}
				draggedId={draggedId}
				dropTargetIndex={dropTargetIndex}
				isCopyDrag={isCopyDrag}
				handleDragStart={handleDragStart}
				handleDrag={handleDrag}
				handleDragOver={handleDragOver}
				handleDragLeave={handleDragLeave}
				handleDrop={handleDrop}
				handleDragEnd={handleDragEnd}
				onRemoveDocument={handleRemoveDocument}
				onToggleReset={handleToggleReset}
				onDuplicateDocument={handleDuplicateDocument}
			/>

			<LoopControls
				theme={theme}
				documents={documents}
				loopEnabled={loopEnabled}
				setLoopEnabled={setLoopEnabled}
				maxLoops={maxLoops}
				setMaxLoops={setMaxLoops}
				totalTaskCount={totalTaskCount}
				missingDocCount={missingDocCount}
				hasMissingDocs={hasMissingDocs}
				loadingTaskCounts={loadingTaskCounts}
			/>

			<MissingDocumentsWarning theme={theme} missingDocCount={missingDocCount} />

			{showDocSelector && (
				<DocumentSelectorModal
					theme={theme}
					allDocuments={allDocuments}
					documentTree={documentTree}
					taskCounts={taskCounts}
					loadingTaskCounts={loadingTaskCounts}
					documents={documents}
					onClose={handleCloseDocSelector}
					onAdd={handleAddSelectedDocs}
					onRefresh={onRefreshDocuments}
				/>
			)}

			<CopyDragIndicator theme={theme} cursorPosition={cursorPosition} isCopyDrag={isCopyDrag} />
		</div>
	);
}
