import React, {
	useState,
	useRef,
	useEffect,
	useMemo,
	useImperativeHandle,
	forwardRef,
} from 'react';
import {
	ChevronDown,
	ChevronRight,
	RefreshCw,
	FolderOpen,
	Plus,
	Folder,
	Search,
} from 'lucide-react';
import type { Theme } from '../../types';
import { useClickOutside } from '../../hooks';
import { getExplorerFileIcon } from '../../utils/theme';
import { fuzzyMatchWithScore } from '../../utils/search';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { useResizableModal } from '../../hooks/ui/useResizableModal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { ResizeHandles } from '../ui/ResizeHandles';

// Module-level cache so the user's expand/collapse choices survive the dropdown
// closing/reopening and the component remounting (e.g. switching agents) until
// the app restarts. Folders start collapsed; only paths the user explicitly
// expands land here.
const persistedExpandedFolders = new Set<string>();

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
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
		() => new Set(persistedExpandedFolders)
	);
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

	// Set of document paths that match the current filter (file paths only).
	// Null when the filter is empty — the tree renders unchanged in that case.
	const matchingPaths = useMemo<Set<string> | null>(() => {
		if (!filterQuery.trim()) return null;
		const set = new Set<string>();
		for (const doc of documents) {
			if (fuzzyMatchWithScore(doc, filterQuery, '/').matches) set.add(doc);
		}
		return set;
	}, [documents, filterQuery]);

	// Pruned tree: when filtering, drop files that don't match and folders that
	// have no matching descendants. Folders that survive get auto-expanded
	// below so the matches are actually visible.
	const filteredTree = useMemo<DocTreeNode[] | null>(() => {
		if (!documentTree) return null;
		if (!matchingPaths) return documentTree;
		const prune = (nodes: DocTreeNode[]): DocTreeNode[] => {
			const kept: DocTreeNode[] = [];
			for (const n of nodes) {
				if (n.type === 'file') {
					if (matchingPaths.has(n.path)) kept.push(n);
				} else if (n.children) {
					const childKept = prune(n.children);
					if (childKept.length > 0) kept.push({ ...n, children: childKept });
				}
			}
			return kept;
		};
		return prune(documentTree);
	}, [documentTree, matchingPaths]);

	// Effective set of expanded folders. While filtering, force-expand every
	// folder that survived pruning so the matched files are immediately
	// visible; otherwise honor the user's manual expansion state.
	const effectiveExpanded = useMemo<Set<string>>(() => {
		if (!matchingPaths || !filteredTree) return expandedFolders;
		const all = new Set<string>();
		const walk = (nodes: DocTreeNode[]) => {
			for (const n of nodes) {
				if (n.type === 'folder') {
					all.add(n.path);
					if (n.children) walk(n.children);
				}
			}
		};
		walk(filteredTree);
		return all;
	}, [matchingPaths, filteredTree, expandedFolders]);

	// Flat, in-order list of file paths currently visible to the user. This is
	// the keyboard-navigation cursor's domain — ArrowUp/Down cycle through it,
	// Enter opens the highlighted entry.
	const visibleFiles = useMemo<string[]>(() => {
		// Flat-list fallback when no tree structure is provided.
		if (!filteredTree) {
			return matchingPaths ? documents.filter((d) => matchingPaths.has(d)) : documents;
		}
		const out: string[] = [];
		const walk = (nodes: DocTreeNode[]) => {
			for (const n of nodes) {
				if (n.type === 'file') {
					out.push(n.path);
				} else if (n.children && effectiveExpanded.has(n.path)) {
					walk(n.children);
				}
			}
		};
		walk(filteredTree);
		return out;
	}, [filteredTree, effectiveExpanded, matchingPaths, documents]);

	// Toggle a folder's manual expansion state (no-op visually while filtering
	// since effectiveExpanded ignores this set in that mode, but we still
	// update it so the state is right when the filter is cleared).
	const toggleFolder = (folderPath: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(folderPath)) next.delete(folderPath);
			else next.add(folderPath);
			// Mirror into the module-level cache so the choice survives reopen/remount.
			persistedExpandedFolders.clear();
			for (const f of next) persistedExpandedFolders.add(f);
			return next;
		});
	};

	// Reset filter every time the dropdown opens. Start the keyboard highlight
	// on the currently-selected document so the first ArrowUp/Down move feels
	// natural (and Enter without typing reopens the same doc).
	useEffect(() => {
		if (isOpen) {
			setFilterQuery('');
			// Folders start collapsed and only open when the user expands them;
			// their state is remembered across reopens via persistedExpandedFolders.
			// Focus the filter input shortly after open so keystrokes flow into it.
			requestAnimationFrame(() => {
				filterInputRef.current?.focus();
			});
		}
		// `documents`/`selectedDocument` intentionally omitted: we only want to
		// snap state when the dropdown transitions to open, not when the
		// underlying list mutates while it's already open.
	}, [isOpen]);

	// Anchor the initial highlight on the selected doc once visibleFiles is
	// computed for the freshly-opened dropdown (separate effect so it can react
	// to visibleFiles becoming available).
	useEffect(() => {
		if (!isOpen) return;
		const idx = selectedDocument ? visibleFiles.indexOf(selectedDocument) : -1;
		setHighlightedIndex(idx >= 0 ? idx : 0);
		// Run only on open, not on every visibleFiles mutation.
	}, [isOpen]);

	// Clamp highlight whenever the visible list shrinks so we never point past
	// the end (e.g. after typing a more restrictive query).
	useEffect(() => {
		if (highlightedIndex >= visibleFiles.length) {
			setHighlightedIndex(Math.max(0, visibleFiles.length - 1));
		}
	}, [visibleFiles.length, highlightedIndex]);

	const highlightedPath = visibleFiles[highlightedIndex];

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

	// Get percentage and total task count for a document
	const getTaskStats = (docPath: string): { pct: number; total: number } | null => {
		if (!documentTaskCounts) return null;
		const counts = documentTaskCounts.get(docPath);
		if (!counts || counts.total === 0) return null;
		return {
			pct: Math.round((counts.completed / counts.total) * 100),
			total: counts.total,
		};
	};

	// Pill badge showing "{pct}% ({total})" — rendered next to file entries in
	// the dropdown list. Green when 100% complete, dim accent otherwise.
	const renderTaskBadge = (stats: { pct: number; total: number }, extraClass = '') => (
		<span
			className={`shrink-0 text-xs px-1.5 py-0.5 rounded ${extraClass}`.trim()}
			style={{
				backgroundColor: stats.pct === 100 ? theme.colors.success : theme.colors.accentDim,
				color: stats.pct === 100 ? '#000' : theme.colors.textDim,
			}}
		>
			{stats.pct}% ({stats.total})
		</span>
	);

	// Render a tree node recursively. File nodes participate in arrow-key
	// highlight via `highlightedPath`; folder nodes toggle their own expansion
	// (no-op visually while filtering, since effectiveExpanded ignores the
	// manual set in that mode).
	const renderTreeNode = (node: DocTreeNode, depth: number = 0): React.ReactNode => {
		const isExpanded = effectiveExpanded.has(node.path);
		const paddingLeft = depth * 16 + 12;

		if (node.type === 'folder') {
			return (
				<div key={node.path}>
					<button
						onClick={() => toggleFolder(node.path)}
						className="w-full flex items-center gap-1.5 py-1.5 text-sm transition-colors hover:bg-white/5"
						style={{ paddingLeft, color: theme.colors.textDim }}
					>
						{isExpanded ? (
							<ChevronDown className="w-3 h-3 shrink-0" />
						) : (
							<ChevronRight className="w-3 h-3 shrink-0" />
						)}
						<Folder className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
						<span className="truncate">{node.name}</span>
					</button>
					{isExpanded && node.children && (
						<div>{node.children.map((child) => renderTreeNode(child, depth + 1))}</div>
					)}
				</div>
			);
		}

		// File node
		const isSelected = node.path === selectedDocument;
		const isHighlighted = node.path === highlightedPath;
		const taskStats = getTaskStats(node.path);
		return (
			<button
				key={node.path}
				onClick={() => handleSelectDocument(node.path)}
				onMouseEnter={() => {
					const idx = visibleFiles.indexOf(node.path);
					if (idx >= 0) setHighlightedIndex(idx);
				}}
				data-selected={isSelected || undefined}
				data-highlighted={isHighlighted || undefined}
				className="w-full flex items-center gap-1.5 py-1.5 pr-3 text-sm transition-colors"
				style={{
					paddingLeft,
					color: isSelected ? theme.colors.accent : theme.colors.textMain,
					backgroundColor: isHighlighted
						? `${theme.colors.accent}25`
						: isSelected
							? theme.colors.bgActivity
							: 'transparent',
				}}
			>
				{/* Spacer matching chevron width for alignment with folders */}
				<span className="w-3 shrink-0" />
				<span
					className="shrink-0 w-3.5 h-3.5 flex items-center justify-center"
					style={{ color: theme.colors.textDim }}
				>
					{getExplorerFileIcon(`${node.name}.md`, theme)}
				</span>
				<span className="truncate">{node.name}.md</span>
				{taskStats && renderTaskBadge(taskStats, 'ml-auto')}
			</button>
		);
	};

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
	const createDocumentModal = useResizableModal({
		resizeKey: 'auto-run-create-document',
		defaultSize: { width: 400, height: 360 },
		minSize: { width: 320, height: 280 },
		enabled: showCreateModal,
	});

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
						<span className="truncate min-w-0 flex-1">
							{selectedDocument ? `${selectedDocument}.md` : 'Select a document...'}
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
								maxHeight: '562px',
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
												if (visibleFiles.length === 0) return;
												e.preventDefault();
												setHighlightedIndex((i) => (i + 1) % visibleFiles.length);
											} else if (e.key === 'ArrowUp') {
												if (visibleFiles.length === 0) return;
												e.preventDefault();
												setHighlightedIndex(
													(i) => (i - 1 + visibleFiles.length) % visibleFiles.length
												);
											} else if (e.key === 'Enter') {
												const target = visibleFiles[highlightedIndex];
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
								) : visibleFiles.length === 0 && filterQuery.trim() ? (
									<div className="px-3 py-2 text-sm" style={{ color: theme.colors.textDim }}>
										No matches for &ldquo;{filterQuery}&rdquo;
									</div>
								) : filteredTree ? (
									// Nested tree view. Empty filter → full tree honoring the user's
									// manual folder expansion. Non-empty filter → tree pruned to
									// matches with surviving folders auto-expanded.
									<div className="py-1">{filteredTree.map((node) => renderTreeNode(node))}</div>
								) : (
									// Flat fallback (no documentTree provided) — still keyboard-navigable.
									visibleFiles.map((doc) => {
										const taskStats = getTaskStats(doc);
										const isDocSelected = doc === selectedDocument;
										const isHighlighted = doc === highlightedPath;
										return (
											<button
												key={doc}
												onClick={() => handleSelectDocument(doc)}
												onMouseEnter={() => {
													const idx = visibleFiles.indexOf(doc);
													if (idx >= 0) setHighlightedIndex(idx);
												}}
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
												{taskStats && renderTaskBadge(taskStats, 'ml-auto')}
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
						ref={createDocumentModal.modalRef}
						className="relative border rounded-lg shadow-2xl overflow-hidden flex flex-col"
						style={{
							...createDocumentModal.style,
							backgroundColor: theme.colors.bgSidebar,
							borderColor: theme.colors.border,
						}}
						onClick={(e) => e.stopPropagation()}
						data-modal-resize-key="auto-run-create-document"
					>
						<ResizeHandles
							onResizeStart={createDocumentModal.onResizeStart}
							accentColor={theme.colors.accent}
						/>

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
