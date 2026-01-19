import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown, ChevronRight, RefreshCw, FolderOpen, Plus, Folder } from 'lucide-react';
import type { Theme } from '../types';
import { useClickOutside } from '../hooks';

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

export function AutoRunDocumentSelector({
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
}: AutoRunDocumentSelectorProps) {
	const [isOpen, setIsOpen] = useState(false);
	const [showCreateModal, setShowCreateModal] = useState(false);
	const [newDocName, setNewDocName] = useState('');
	const [isCreating, setIsCreating] = useState(false);
	const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
	const [selectedCreateFolder, setSelectedCreateFolder] = useState<string>(''); // For creating in subfolder
	const dropdownRef = useRef<HTMLDivElement>(null);
	const buttonRef = useRef<HTMLButtonElement>(null);
	const createInputRef = useRef<HTMLInputElement>(null);

	// Check for duplicate document name (including path)
	const normalizedNewName = newDocName.trim().toLowerCase().replace(/\.md$/i, '');
	const fullNewPath = selectedCreateFolder
		? `${selectedCreateFolder}/${normalizedNewName}`.toLowerCase()
		: normalizedNewName;
	const isDuplicate = !!fullNewPath && documents.some((doc) => doc.toLowerCase() === fullNewPath);

	// Toggle folder expansion
	const toggleFolder = (folderPath: string) => {
		setExpandedFolders((prev) => {
			const next = new Set(prev);
			if (next.has(folderPath)) {
				next.delete(folderPath);
			} else {
				next.add(folderPath);
			}
			return next;
		});
	};

	// Get display name for selected document (just the filename, not full path)
	const _getDisplayName = (path: string) => {
		const parts = path.split('/');
		return parts[parts.length - 1];
	};

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

	// Close dropdown on Escape
	useEffect(() => {
		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === 'Escape' && isOpen) {
				setIsOpen(false);
				buttonRef.current?.focus();
			}
		}

		if (isOpen) {
			document.addEventListener('keydown', handleKeyDown);
			return () => document.removeEventListener('keydown', handleKeyDown);
		}
	}, [isOpen]);

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

	// Render tree node recursively
	const renderTreeNode = (node: DocTreeNode, depth: number = 0): React.ReactNode => {
		const isExpanded = expandedFolders.has(node.path);
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
		const taskPct = getTaskPercentage(node.path);
		return (
			<button
				key={node.path}
				onClick={() => handleSelectDocument(node.path)}
				className="w-full flex items-center py-1.5 pr-3 text-sm transition-colors hover:bg-white/5"
				style={{
					paddingLeft,
					color: node.path === selectedDocument ? theme.colors.accent : theme.colors.textMain,
					backgroundColor: node.path === selectedDocument ? theme.colors.bgActivity : 'transparent',
				}}
			>
				{/* Fixed-width percentage column for alignment */}
				<span
					className="shrink-0 text-xs mr-2 px-1.5 py-0.5 rounded text-right"
					style={{
						width: '40px',
						backgroundColor:
							taskPct !== null
								? taskPct === 100
									? theme.colors.success
									: theme.colors.accentDim
								: 'transparent',
						color:
							taskPct !== null ? (taskPct === 100 ? '#000' : theme.colors.textDim) : 'transparent',
					}}
				>
					{taskPct !== null ? `${taskPct}%` : ''}
				</span>
				<span className="truncate">{node.name}.md</span>
			</button>
		);
	};

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
							className="absolute top-full left-0 mt-1 rounded shadow-lg overflow-hidden z-50"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								border: `1px solid ${theme.colors.border}`,
								maxHeight: '450px',
								overflowY: 'auto',
								minWidth: '100%',
								width: 'calc(100% + 120px)', // Extend under the +, refresh, and folder buttons
							}}
						>
							{documents.length === 0 ? (
								<div className="px-3 py-2 text-sm" style={{ color: theme.colors.textDim }}>
									No markdown files found
								</div>
							) : documentTree && documentTree.length > 0 ? (
								// Render tree structure if available
								<div className="py-1">{documentTree.map((node) => renderTreeNode(node))}</div>
							) : (
								// Fallback to flat list
								documents.map((doc) => {
									const taskPct = getTaskPercentage(doc);
									return (
										<button
											key={doc}
											onClick={() => handleSelectDocument(doc)}
											className="w-full flex items-center px-3 py-2 text-sm transition-colors hover:bg-white/5"
											style={{
												color:
													doc === selectedDocument ? theme.colors.accent : theme.colors.textMain,
												backgroundColor:
													doc === selectedDocument ? theme.colors.bgActivity : 'transparent',
											}}
										>
											{/* Fixed-width percentage column for alignment */}
											<span
												className="shrink-0 text-xs mr-2 px-1.5 py-0.5 rounded text-right"
												style={{
													width: '40px',
													backgroundColor:
														taskPct !== null
															? taskPct === 100
																? theme.colors.success
																: theme.colors.accentDim
															: 'transparent',
													color:
														taskPct !== null
															? taskPct === 100
																? '#000'
																: theme.colors.textDim
															: 'transparent',
												}}
											>
												{taskPct !== null ? `${taskPct}%` : ''}
											</span>
											<span className="truncate">{doc}.md</span>
										</button>
									);
								})
							)}

							{/* Divider */}
							<div className="border-t my-1" style={{ borderColor: theme.colors.border }} />

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
					)}
				</div>

				{/* Create New Document Button */}
				<button
					onClick={() => setShowCreateModal(true)}
					className="p-2 rounded transition-colors hover:bg-white/10 shrink-0"
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
					className={`p-2 rounded transition-colors hover:bg-white/10 shrink-0 ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
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
					className="p-2 rounded transition-colors hover:bg-white/10 shrink-0"
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
						className="w-[400px] border rounded-lg shadow-2xl overflow-hidden"
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
}
