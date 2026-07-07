import { useRef } from 'react';
import { CheckSquare, RefreshCw, X } from 'lucide-react';
import { GhostIconButton } from '../../ui/GhostIconButton';
import { useModalLayer } from '../../../hooks/ui/useModalLayer';
import { useResizableModal } from '../../../hooks/ui/useResizableModal';
import { MODAL_PRIORITIES } from '../../../constants/modalPriorities';
import type { DocumentSelectorModalProps } from '../types';
import { useDocumentSelection } from '../hooks/useDocumentSelection';
import { useDocumentSelectorRefresh } from '../hooks/useDocumentSelectorRefresh';
import { DocumentSelectorFlatList } from './DocumentSelectorFlatList';
import { DocumentSelectorFooter } from './DocumentSelectorFooter';
import { DocumentSelectorTree } from './DocumentSelectorTree';
import { ResizeHandles } from '../../ui/ResizeHandles';

export function DocumentSelectorModal({
	theme,
	allDocuments,
	documentTree,
	taskCounts,
	loadingTaskCounts,
	documents,
	onClose,
	onAdd,
	onRefresh,
}: DocumentSelectorModalProps) {
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	useModalLayer(MODAL_PRIORITIES.DOCUMENT_SELECTOR, 'Select Documents', () => {
		onCloseRef.current();
	});

	const {
		selectedDocs,
		expandedFolders,
		toggleDoc,
		selectAll,
		deselectAll,
		toggleFolder,
		toggleFolderSelection,
		allSelected,
		totalTaskCount,
		selectedTaskCount,
	} = useDocumentSelection({
		documents,
		allDocuments,
		taskCounts,
	});

	const { refreshing, refreshMessage, handleRefresh } = useDocumentSelectorRefresh({
		allDocumentsLength: allDocuments.length,
		onRefresh,
	});
	const resizableModal = useResizableModal({
		resizeKey: 'document-selector',
		defaultSize: { width: 760, height: 620 },
		minSize: { width: 520, height: 360 },
	});

	return (
		<div
			className="fixed inset-0 bg-black/50 flex items-center justify-center z-[10000]"
			onClick={onClose}
		>
			<button
				type="button"
				className="absolute inset-0 outline-none"
				tabIndex={-1}
				onClick={(e) => {
					e.stopPropagation();
					onClose();
				}}
				aria-label="Close document selector"
			/>
			<div
				ref={resizableModal.modalRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="document-selector-title"
				className="relative z-10 border rounded-lg shadow-2xl overflow-hidden flex flex-col select-none"
				style={{
					...resizableModal.style,
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
				onClick={(e) => e.stopPropagation()}
				data-modal-resize-key="document-selector"
			>
				<ResizeHandles
					onResizeStart={resizableModal.onResizeStart}
					accentColor={theme.colors.accent}
				/>

				<div
					className="p-4 border-b flex items-center justify-between shrink-0"
					style={{ borderColor: theme.colors.border }}
				>
					<div className="flex items-center gap-2">
						<h3
							id="document-selector-title"
							className="text-sm font-bold"
							style={{ color: theme.colors.textMain }}
						>
							Select Documents
						</h3>
						<span
							className="text-xs px-2 py-0.5 rounded"
							style={{
								backgroundColor:
									totalTaskCount === 0 ? theme.colors.textDim + '20' : theme.colors.success + '20',
								color: totalTaskCount === 0 ? theme.colors.textDim : theme.colors.success,
							}}
						>
							{loadingTaskCounts
								? '...'
								: `${totalTaskCount} ${totalTaskCount === 1 ? 'task' : 'tasks'}`}
						</span>
						{refreshMessage && (
							<span
								className="text-xs px-2 py-0.5 rounded animate-in fade-in"
								style={{
									backgroundColor: theme.colors.success + '20',
									color: theme.colors.success,
								}}
							>
								{refreshMessage}
							</span>
						)}
					</div>
					<div className="flex items-center gap-1">
						<button
							type="button"
							onClick={allSelected ? deselectAll : selectAll}
							className="flex items-center gap-1 px-2 py-1 rounded text-xs hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.accent }}
							title={allSelected ? 'Deselect all documents' : 'Select all documents'}
						>
							<CheckSquare className="w-3.5 h-3.5" />
							{allSelected ? 'Deselect All' : 'Select All'}
						</button>
						<button
							type="button"
							onClick={handleRefresh}
							disabled={refreshing}
							className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
							style={{ color: theme.colors.textDim }}
							title="Refresh document list"
						>
							<RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
						</button>
						<GhostIconButton onClick={onClose} color={theme.colors.textDim}>
							<X className="w-4 h-4" />
						</GhostIconButton>
					</div>
				</div>

				<div className="flex-1 min-h-0 overflow-y-auto p-2">
					{allDocuments.length === 0 ? (
						<div className="p-4 text-center" style={{ color: theme.colors.textDim }}>
							<p className="text-sm">No documents found in folder</p>
						</div>
					) : documentTree && documentTree.length > 0 ? (
						<DocumentSelectorTree
							theme={theme}
							documentTree={documentTree}
							selectedDocs={selectedDocs}
							expandedFolders={expandedFolders}
							taskCounts={taskCounts}
							loadingTaskCounts={loadingTaskCounts}
							onToggleDoc={toggleDoc}
							onToggleFolder={toggleFolder}
							onToggleFolderSelection={toggleFolderSelection}
						/>
					) : (
						<DocumentSelectorFlatList
							theme={theme}
							allDocuments={allDocuments}
							selectedDocs={selectedDocs}
							taskCounts={taskCounts}
							loadingTaskCounts={loadingTaskCounts}
							onToggleDoc={toggleDoc}
						/>
					)}
				</div>

				<DocumentSelectorFooter
					theme={theme}
					selectedDocs={selectedDocs}
					selectedTaskCount={selectedTaskCount}
					loadingTaskCounts={loadingTaskCounts}
					onClose={onClose}
					onAdd={onAdd}
				/>
			</div>
		</div>
	);
}
