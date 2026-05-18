import { useState, useRef, useEffect, useMemo, useImperativeHandle, forwardRef } from 'react';
import { ChevronDown, RefreshCw, FolderOpen, Plus, Search } from 'lucide-react';
import type { Theme } from '../../types';
import { useClickOutside } from '../../hooks';
import { getExplorerFileIcon } from '../../utils/theme';
import { fuzzyMatchWithScore } from '../../utils/search';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';

// Tree node type for folder structure
export interface DocTreeNode {
	name: string;
	type: 'file' | 'folder';
	path: string;
	children?: DocTreeNode[];
}

// Task counts for a document: { completed, total }
export interface DocumentTaskCount {
	completed: number;
	total: number;
}

interface AutoRunDocumentSelectorProps {
	theme: Theme;
	documents: string[]; // List of document filenames (without .md extension) - flat list for backwards compat
	documentTree?: DocTreeNode[]; // Tree structure for folder display
	selectedDocument: string | null;
	onSelectDocument: (filename: string) => void;
	onRefresh: () => void;
	onChangeFolder: () => void;
	onCreateDocument: (filename: string) => Promise<boolean>; // Returns true if created successfully
	isLoading?: boolean;
	documentTaskCounts?: Map<string, DocumentTaskCount>; // Task counts per document path
}

export interface AutoRunDocumentSelectorHandle {
	open: () => void;
}

export const AutoRunDocumentSelector = forwardRef<
	AutoRunDocumentSelectorHandle,
	AutoRunDocumentSelectorProps
>(function AutoRunDocumentSelector(
	{
		theme,
		documents,
		documentTree,
		selectedDocument,
		onSelectDocument,
		onRefresh,
		onChangeFolder,
		onCreateDocument,
		isLoading = false,
		documentTaskCounts,
	},
	ref
) {
	const [isOpen, setIsOpen] = useState(false);
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [newDocName, setNewDocName] = useState('');
	const [isCreating, setIsCreating] = useState(false);
	const [selectedCreateFolder, setSelectedCreateFolder] = useState<string>(''); // For creating in subfolder
	const dropdownRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const createInputRef = useRef<HTMLInputElement>(null);
	const filterInputRef = useRef<HTMLInputElement>(null);

	// Fuzzy filter input + keyboard navigation (active while dropdown is open).
	const [filterQuery, setFilterQuery] = useState('');
	const [highlightedIndex, setHighlightedIndex] = useState(0);

	// Imperative handle: lets the expanded modal open the dropdown via cmd+o.
	useImperativeHandle(
		ref,
		() => ({
			open: () => setIsOpen(true),
		}),
		[]
	);

	// Reset filter every time the dropdown opens. Start the keyboard highlight
	// on the currently-selected document so the first ArrowUp/Down move feels
	// natural (and Enter without typing reopens the same doc).
	useEffect(() => {
		if (isOpen) {
			setFilterQuery('');
			const selectedIdx = selectedDocument ? documents.indexOf(selectedDocument) : -1;
			setHighlightedIndex(selectedIdx >= 0 ? selectedIdx : 0);
			// Focus the filter input shortly after open so keystrokes flow into it.
			requestAnimationFrame(() => {
				filterInputRef.current?.focus();
			});
		}
		// `documents`/`selectedDocument` intentionally omitted: we only want to
		// snap the highlight when the dropdown transitions to open, not when
		// the underlying list mutates while it's already open.
	}, [isOpen]);

	// Flat, ranked list of documents that match the current filter. Backs both
	// the rendered list and the arrow-key cursor — empty filter returns every
	// doc so ArrowUp/Down work immediately on open without typing.
	const filteredDocuments = useMemo(() => {
		if (!filterQuery.trim()) return documents;
		const scored = documents
			.map((doc) => ({ doc, ...fuzzyMatchWithScore(doc, filterQuery, '/') }))
			.filter((entry) => entry.matches)
			.sort((a, b) => b.score - a.score);
		return scored.map((entry) => entry.doc);
	}, [documents, filterQuery]);

	// Clamp highlight whenever the filtered list shrinks so we never point past
	// the end of the array (e.g. after typing a more restrictive query).
	useEffect(() => {
		if (highlightedIndex >= filteredDocuments.length) {
			setHighlightedIndex(Math.max(0, filteredDocuments.length - 1));
		}
	}, [filteredDocuments.length, highlightedIndex]);

	// Keep the highlighted row visible inside the scrollable list as the user
	// arrow-navigates (whether or not a filter is active).
	useEffect(() => {
		if (!isOpen) return;
		requestAnimationFrame(() => {
			const el = dropdownRef.current?.querySelector('[data-highlighted="true"]');
			el?.scrollIntoView({ block: 'nearest' });
		});
	}, [highlightedIndex, isOpen]);

	// While the dropdown is open we register it as a higher-priority modal
	// layer than AUTORUN_EXPANDED so an Escape press closes only the dropdown,
	// leaving the modal underneath for a second Escape (per UX request).
	useModalLayer(
		MODAL_PRIORITIES.AUTORUN_DOC_SELECTOR,
		'Auto Run document selector',
		() => {
			setIsOpen(false);
			buttonRef.current?.focus();
		},
		{ enabled: isOpen, focusTrap: 'none', blocksLowerLayers: false, capturesFocus: false }
	);

	// Check for duplicate document name (including path)
	const normalizedNewName = newDocName.trim().toLowerCase().replace(/\.md$/i, '');
	const fullNewPath = selectedCreateFolder
		? `${selectedCreateFolder}/${normalizedNewName}`.toLowerCase()
		: normalizedNewName;
	const isDuplicate = !!fullNewPath && documents.some((doc) => doc.toLowerCase() === fullNewPath);

	// Get percentage display for a document's task completion
	const getTaskPercentage = (docPath: string): number | null => {
		if (!documentTaskCounts) return null;
		const counts = documentTaskCounts.get(docPath);
		if (!counts || counts.total === 0) return null;
		return Math.round((counts.completed / counts.total) * 100);
	};

	// Get the selected document's task percentage for the button
	const selectedTaskPercentage = selectedDocument ? getTaskPercentage(selectedDocument) : null;

	// Close dropdown when clicking outside
	useClickOutside(dropdownRef, () => setIsOpen(false), isOpen);

	// Scroll the selected document into view when dropdown opens
	useEffect(() => {
		if (isOpen && selectedDocument) {
			// Allow DOM to render expanded folders first
			requestAnimationFrame(() => {
				const el = dropdownRef.current?.querySelector('[data-selected="true"]');
				el?.scrollIntoView({ block: 'nearest' });
			});
		}
	}, [isOpen, selectedDocument]);

	// Escape handling is owned by the AUTORUN_DOC_SELECTOR layer registered above.

	// Focus input when create modal opens
	useEffect(() => {
		if (showCreateModal) {
			requestAnimationFrame(() => {
				createInputRef.current?.focus();
			});
		}
	}, [showCreateModal]);

	const handleSelectDocument = (doc: string) => {
		onSelectDocument(doc);
		setIsOpen(false);
	};

	const handleCreateDocument = async () => {
		const trimmedName = newDocName.trim();
		if (!trimmedName || isCreating || isDuplicate) return;

		setIsCreating(true);

		// Add .md extension if not present
		let filename = trimmedName;
		if (!filename.toLowerCase().endsWith('.md')) {
			filename += '.md';
		}

		// Remove .md for the document name (our convention)
		let docName = filename.replace(/\.md$/i, '');

		// Include folder path if creating in a subfolder
		if (selectedCreateFolder) {
			docName = `${selectedCreateFolder}/${docName}`;
		}

		const success = await onCreateDocument(docName);

		if (success) {
			setShowCreateModal(false);
			setNewDocName('');
		}

		setIsCreating(false);
	};

	const handleCloseCreateModal = () => {
		setShowCreateModal(false);
		setNewDocName('');
		setSelectedCreateFolder('');
	};

	// Extract folders from tree for the create modal folder selector
	const getFoldersFromTree = (
		nodes: DocTreeNode[],
		parentPath: string = ''
	): { path: string; name: string; depth: number }[] => {
		const folders: { path: string; name: string; depth: number }[] = [];
		const depth = parentPath ? parentPath.split('/').length : 0;

		for (const node of nodes) {
			if (node.type === 'folder') {
				folders.push({ path: node.path, name: node.name, depth });
				if (node.children) {
					folders.push(...getFoldersFromTree(node.children, node.path));
				}
			}
		}
		return folders;
	};

	const availableFolders = documentTree ? getFoldersFromTree(documentTree) : [];

	return (
		<>
			<div className="flex items-center gap-2 mb-3">
				{/* Document Dropdown */}
				<div ref={dropdownRef} className="relative flex-1 min-w-0">
					<button
						ref={buttonRef}
						onClick={() => setIsOpen(!isOpen)}
						className="w-full min-w-0 flex items-center justify-between px-3 py-2 rounded text-sm transition-colors hover:opacity-90"
						style={{
							backgroundColor: theme.colors.bgActivity,
							color: theme.colors.textMain,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<span className="truncate min-w-0 flex-1 flex items-center gap-2">
							{selectedTaskPercentage !== null && (
								<span
									className="shrink-0 text-xs px-1.5 py-0.5 rounded"
									style={{
										backgroundColor:
											selectedTaskPercentage === 100
												? theme.colors.success
												: theme.colors.accentDim,
										color: selectedTaskPercentage === 100 ? '#000' : theme.colors.textDim,
									}}
								>
									{selectedTaskPercentage}%
								</span>
							)}
							<span className="truncate">
								{selectedDocument ? `${selectedDocument}.md` : 'Select a document...'}
							</span>
						</span>
						<ChevronDown
							className={`w-4 h-4 ml-2 shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
							style={{ color: theme.colors.textDim }}
						/>
					</button>

					{/* Dropdown Menu - extends right under the action buttons for more width */}
					{isOpen && (
						<div
							className="absolute top-full left-0 mt-1 rounded shadow-lg overflow-hidden z-50 flex flex-col"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								border: `1px solid ${theme.colors.border}`,
								maxHeight: '450px',
								minWidth: '100%',
								width: 'calc(100% + 120px)', // Extend under the +, refresh, and folder buttons
							}}
						>
							{/* Fuzzy filter input. Always present so the dropdown is keyboard-driven
							    whether opened by click or cmd+o. */}
							{documents.length > 0 && (
								<div
									className="flex items-center gap-2 px-3 py-2 border-b shrink-0"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgActivity,
									}}
								>
									<Search
										className="w-3.5 h-3.5 shrink-0"
										style={{ color: theme.colors.textDim }}
									/>
									<input
										ref={filterInputRef}
										type="text"
										value={filterQuery}
										onChange={(e) => {
											setFilterQuery(e.target.value);
											setHighlightedIndex(0);
										}}
										onKeyDown={(e) => {
											if (e.key === 'ArrowDown') {
												if (filteredDocuments.length === 0) return;
												e.preventDefault();
												setHighlightedIndex((i) => (i + 1) % filteredDocuments.length);
											} else if (e.key === 'ArrowUp') {
												if (filteredDocuments.length === 0) return;
												e.preventDefault();
												setHighlightedIndex(
													(i) => (i - 1 + filteredDocuments.length) % filteredDocuments.length
												);
											} else if (e.key === 'Enter') {
												const target = filteredDocuments[highlightedIndex];
												if (target) {
													e.preventDefault();
													handleSelectDocument(target);
												}
											}
										}}
										placeholder="Filter documents..."
										className="flex-1 min-w-0 bg-transparent text-sm outline-none"
										style={{ color: theme.colors.textMain }}
									/>
								</div>
							)}

							<div className="overflow-y-auto flex-1 min-h-0">
								{documents.length === 0 ? (
									<div className="px-3 py-2 text-sm" style={{ color: theme.colors.textDim }}>
										No markdown files found
									</div>
								) : filteredDocuments.length === 0 ? (
									<div className="px-3 py-2 text-sm" style={{ color: theme.colors.textDim }}>
										No matches for &ldquo;{filterQuery}&rdquo;
									</div>
								) : (
									// Unified flat keyboard-navigable list (empty filter shows all docs).
									filteredDocuments.map((doc, idx) => {
										const taskPct = getTaskPercentage(doc);
										const isDocSelected = doc === selectedDocument;
										const isHighlighted = idx === highlightedIndex;
										return (
											<button
												key={doc}
												onClick={() => handleSelectDocument(doc)}
												onMouseEnter={() => setHighlightedIndex(idx)}
												data-selected={isDocSelected || undefined}
												data-highlighted={isHighlighted || undefined}
												className="w-full flex items-center gap-1.5 px-3 py-1.5 text-sm transition-colors"
												style={{
													color: isDocSelected ? theme.colors.accent : theme.colors.textMain,
													backgroundColor: isHighlighted
														? `${theme.colors.accent}25`
														: isDocSelected
															? theme.colors.bgActivity
															: 'transparent',
												}}
											>
												<span
													className="shrink-0 w-3.5 h-3.5 flex items-center justify-center"
													style={{ color: theme.colors.textDim }}
												>
													{getExplorerFileIcon(`${doc}.md`, theme)}
												</span>
												<span className="truncate">{doc}.md</span>
												{taskPct !== null && (
													<span
														className="shrink-0 text-xs ml-auto px-1.5 py-0.5 rounded"
														style={{
															backgroundColor:
																taskPct === 100 ? theme.colors.success : theme.colors.accentDim,
															color: taskPct === 100 ? '#000' : theme.colors.textDim,
														}}
													>
														{taskPct}%
													</span>
												)}
											</button>
										);
									})
								)}
							</div>
							{/* Bottom action row */}
							<div className="shrink-0">
								{/* Divider above the Change Folder action */}
								<div className="border-t" style={{ borderColor: theme.colors.border }} />
								{/* Change Folder Option */}
								<button
									onClick={() => {
										setIsOpen(false);
										onChangeFolder();
									}}
									className="w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors hover:bg-white/5"
									style={{ color: theme.colors.textDim }}
								>
									<FolderOpen className="w-4 h-4" />
									Change Folder...
								</button>
							</div>
						</div>
					)}
				</div>

				{/* Create New Document Button */}
				<button
					onClick={() => setShowCreateModal(true)}
					className="inline-flex h-10 min-w-10 items-center justify-center p-2 rounded transition-colors hover:bg-white/10 shrink-0"
					style={{
						color: theme.colors.textDim,
						border: `1px solid ${theme.colors.border}`,
					}}
					title="Create new document"
				>
					<Plus className="w-4 h-4" />
				</button>

				{/* Refresh Button */}
				<button
					onClick={onRefresh}
					disabled={isLoading}
					className={`inline-flex h-10 min-w-10 items-center justify-center p-2 rounded transition-colors hover:bg-white/10 shrink-0 ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
					style={{
						color: theme.colors.textDim,
						border: `1px solid ${theme.colors.border}`,
					}}
					title="Refresh document list"
				>
					<RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
				</button>

				{/* Change Folder Button */}
				<button
					onClick={onChangeFolder}
					className="inline-flex h-10 min-w-10 items-center justify-center p-2 rounded transition-colors hover:bg-white/10 shrink-0"
					style={{
						color: theme.colors.textDim,
						border: `1px solid ${theme.colors.border}`,
					}}
					title="Change folder"
				>
					<FolderOpen className="w-4 h-4" />
				</button>
			</div>

			{/* Create New Document Modal */}
			{showCreateModal && (
				<div
					className="fixed inset-0 modal-overlay flex items-center justify-center z-[10000] animate-in fade-in duration-200"
					role="dialog"
					aria-modal="true"
					aria-label="Create New Document"
					onClick={(e) => {
						if (e.target === e.currentTarget) {
							handleCloseCreateModal();
						}
					}}
					onKeyDown={(e) => {
						if (e.key === 'Escape') {
							e.stopPropagation();
							handleCloseCreateModal();
						}
					}}
				>
					<div
						className="modal-w-xs border rounded-lg shadow-2xl overflow-hidden"
						style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
						onClick={(e) => e.stopPropagation()}
					>
						{/* Header */}
						<div
							className="p-4 border-b flex items-center justify-between"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-2">
								<Plus className="w-4 h-4" style={{ color: theme.colors.accent }} />
								<h3 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
									Create New Document
								</h3>
							</div>
						</div>

						{/* Content */}
						<div className="p-6 space-y-4">
							{/* Folder Selector - only show if there are subfolders */}
							{availableFolders.length > 0 && (
								<div>
									<label
										className="block text-xs mb-2 font-medium"
										style={{ color: theme.colors.textDim }}
									>
										Location
									</label>
									<select
										value={selectedCreateFolder}
										onChange={(e) => setSelectedCreateFolder(e.target.value)}
										className="w-full p-3 rounded border bg-transparent outline-none cursor-pointer"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
											backgroundColor: theme.colors.bgActivity,
										}}
									>
										<option value="" style={{ backgroundColor: theme.colors.bgSidebar }}>
											Root folder
										</option>
										{availableFolders.map((folder) => (
											<option
												key={folder.path}
												value={folder.path}
												style={{ backgroundColor: theme.colors.bgSidebar }}
											>
												{'  '.repeat(folder.depth)}
												{folder.depth > 0 ? '└ ' : ''}
												{folder.name}/
											</option>
										))}
									</select>
								</div>
							)}

							{/* Document Name Input */}
							<div>
								<label
									className="block text-xs mb-2 font-medium"
									style={{ color: theme.colors.textDim }}
								>
									Document Name
								</label>
								<input
									ref={createInputRef}
									type="text"
									value={newDocName}
									onChange={(e) => setNewDocName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Enter' && newDocName.trim() && !isDuplicate) {
											e.preventDefault();
											handleCreateDocument();
										}
									}}
									placeholder="my-tasks"
									className="w-full p-3 rounded border bg-transparent outline-none focus:ring-1"
									style={{
										borderColor: isDuplicate ? theme.colors.error : theme.colors.border,
										color: theme.colors.textMain,
									}}
								/>
								{isDuplicate ? (
									<p className="text-xs mt-2" style={{ color: theme.colors.error }}>
										A document with this name already exists
										{selectedCreateFolder ? ` in ${selectedCreateFolder}` : ''}
									</p>
								) : (
									<p className="text-xs mt-2" style={{ color: theme.colors.textDim }}>
										{selectedCreateFolder
											? `Will create: ${selectedCreateFolder}/${newDocName || 'my-tasks'}.md`
											: 'The .md extension will be added automatically if not provided.'}
									</p>
								)}
							</div>
						</div>

						{/* Footer */}
						<div
							className="p-4 border-t flex justify-end gap-3"
							style={{ borderColor: theme.colors.border }}
						>
							<button
								type="button"
								onClick={handleCloseCreateModal}
								className="px-4 py-2 rounded border hover:bg-white/5 transition-colors"
								style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
							>
								Cancel
							</button>
							<button
								type="button"
								onClick={handleCreateDocument}
								disabled={!newDocName.trim() || isCreating || isDuplicate}
								className="px-4 py-2 rounded font-bold transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
								style={{
									backgroundColor: theme.colors.accent,
									color: theme.colors.accentForeground,
								}}
							>
								{isCreating ? 'Creating...' : 'Create'}
							</button>
						</div>
					</div>
				</div>
			)}
		</>
	);
});
