/**
 * MarketplaceModal
 *
 * Modal component for browsing and importing playbooks from the Playbook Exchange.
 * Features category tabs, search filtering, keyboard navigation, and playbook tiles grid.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
	LayoutGrid,
	RefreshCw,
	X,
	Search,
	Loader2,
	Package,
	ArrowLeft,
	ChevronDown,
	Download,
	ExternalLink,
	FolderOpen,
	HelpCircle,
	Github,
} from 'lucide-react';
import type { Theme } from '../types';
import type { MarketplacePlaybook } from '../../shared/marketplace-types';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { useMarketplace } from '../hooks/batch/useMarketplace';
import { generateProseStyles, createMarkdownComponents } from '../utils/markdownConfig';

// ============================================================================
// Types
// ============================================================================

export interface MarketplaceModalProps {
	theme: Theme;
	isOpen: boolean;
	onClose: () => void;
	autoRunFolderPath: string;
	sessionId: string;
	/** SSH remote ID for importing to remote hosts */
	sshRemoteId?: string;
	onImportComplete: (folderName: string) => void;
}

interface PlaybookTileProps {
	playbook: MarketplacePlaybook;
	theme: Theme;
	isSelected: boolean;
	onSelect: () => void;
}

interface PlaybookDetailViewProps {
	theme: Theme;
	playbook: MarketplacePlaybook;
	readmeContent: string | null;
	selectedDocFilename: string | null;
	documentContent: string | null;
	isLoadingDocument: boolean;
	targetFolderName: string;
	isImporting: boolean;
	/** Whether this is a remote SSH session (disables local folder browsing) */
	isRemoteSession: boolean;
	onBack: () => void;
	onSelectDocument: (filename: string) => void;
	onTargetFolderChange: (name: string) => void;
	onBrowseFolder: () => void;
	onImport: () => void;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Format cache age into human-readable string
 */
function formatCacheAge(cacheAgeMs: number | null): string {
	if (cacheAgeMs === null || cacheAgeMs === 0) return 'just now';

	const seconds = Math.floor(cacheAgeMs / 1000);
	const minutes = Math.floor(seconds / 60);
	const hours = Math.floor(minutes / 60);

	if (hours > 0) {
		return `${hours}h ago`;
	} else if (minutes > 0) {
		return `${minutes}m ago`;
	} else {
		return 'just now';
	}
}

// ============================================================================
// PlaybookTileSkeleton Sub-component
// ============================================================================

function PlaybookTileSkeleton({ theme }: { theme: Theme }) {
	return (
		<div
			className="p-4 rounded-lg border animate-pulse"
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: theme.colors.border,
			}}
		>
			{/* Category badge skeleton */}
			<div className="flex items-center gap-2 mb-2">
				<div className="w-16 h-5 rounded" style={{ backgroundColor: theme.colors.bgMain }} />
			</div>
			{/* Title skeleton */}
			<div className="h-5 w-3/4 rounded mb-1" style={{ backgroundColor: theme.colors.bgMain }} />
			{/* Description skeleton lines */}
			<div className="h-4 w-full rounded mb-1" style={{ backgroundColor: theme.colors.bgMain }} />
			<div className="h-4 w-2/3 rounded mb-3" style={{ backgroundColor: theme.colors.bgMain }} />
			{/* Footer skeleton */}
			<div className="flex justify-between">
				<div className="h-3 w-20 rounded" style={{ backgroundColor: theme.colors.bgMain }} />
				<div className="h-3 w-12 rounded" style={{ backgroundColor: theme.colors.bgMain }} />
			</div>
		</div>
	);
}

// ============================================================================
// PlaybookTile Sub-component
// ============================================================================

function PlaybookTile({ playbook, theme, isSelected, onSelect }: PlaybookTileProps) {
	const tileRef = useRef<HTMLButtonElement>(null);

	// Scroll into view when selected
	useEffect(() => {
		if (isSelected && tileRef.current) {
			tileRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
	}, [isSelected]);

	return (
		<button
			ref={tileRef}
			onClick={onSelect}
			className={`p-4 rounded-lg border text-left transition-all hover:scale-[1.02] ${
				isSelected ? 'ring-2' : ''
			}`}
			style={{
				backgroundColor: theme.colors.bgActivity,
				borderColor: isSelected ? theme.colors.accent : theme.colors.border,
				outlineColor: 'transparent',
				// Ring color for focus state
				...(isSelected && {
					boxShadow: `0 0 0 2px ${theme.colors.accent}`,
				}),
			}}
		>
			{/* Category and source badges */}
			<div className="flex items-center gap-2 mb-2 flex-wrap">
				<span
					className="px-2 py-0.5 rounded text-xs"
					style={{
						backgroundColor: `${theme.colors.accent}20`,
						color: theme.colors.accent,
					}}
				>
					{playbook.category}
				</span>
				{playbook.subcategory && (
					<span className="text-xs" style={{ color: theme.colors.textDim }}>
						/ {playbook.subcategory}
					</span>
				)}
				{playbook.source === 'local' && (
					<span
						className="px-2 py-0.5 rounded text-xs font-medium"
						style={{
							backgroundColor: '#3b82f620',
							color: '#3b82f6',
						}}
						title="Custom local playbook"
					>
						Local
					</span>
				)}
			</div>

			{/* Title - with tooltip for truncated text */}
			<h3
				className="font-semibold mb-1 line-clamp-1"
				style={{ color: theme.colors.textMain }}
				title={playbook.title}
			>
				{playbook.title}
			</h3>

			{/* Description */}
			<p className="text-sm line-clamp-2 mb-3" style={{ color: theme.colors.textDim }}>
				{playbook.description}
			</p>

			{/* Footer: author + doc count */}
			<div
				className="flex items-center justify-between text-xs"
				style={{ color: theme.colors.textDim }}
			>
				<span>{playbook.author}</span>
				<span>{playbook.documents.length} docs</span>
			</div>
		</button>
	);
}

// ============================================================================
// PlaybookDetailView Sub-component
// ============================================================================

function PlaybookDetailView({
	theme,
	playbook,
	readmeContent,
	selectedDocFilename,
	documentContent,
	isLoadingDocument,
	targetFolderName,
	isImporting,
	isRemoteSession,
	onBack,
	onSelectDocument,
	onTargetFolderChange,
	onBrowseFolder,
	onImport,
}: PlaybookDetailViewProps) {
	const [showDocDropdown, setShowDocDropdown] = useState(false);
	const dropdownRef = useRef<HTMLDivElement>(null);
	const previewScrollRef = useRef<HTMLDivElement>(null);

	// Keyboard shortcuts for scrolling the document preview
	// OPT+Up/Down: page up/down, CMD+Up/Down: home/end
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const scrollContainer = previewScrollRef.current;
			if (!scrollContainer) return;

			// Don't handle if typing in an input
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
				return;
			}

			const pageHeight = scrollContainer.clientHeight * 0.9; // 90% of visible height

			// CMD+Up/Down: Home/End
			if (e.metaKey && !e.altKey && !e.shiftKey) {
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
				} else if (e.key === 'ArrowDown') {
					e.preventDefault();
					scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: 'smooth' });
				}
			}
			// OPT+Up/Down: Page up/down
			else if (e.altKey && !e.metaKey && !e.shiftKey) {
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					scrollContainer.scrollBy({ top: -pageHeight, behavior: 'smooth' });
				} else if (e.key === 'ArrowDown') {
					e.preventDefault();
					scrollContainer.scrollBy({ top: pageHeight, behavior: 'smooth' });
				}
			}
		};

		window.addEventListener('keydown', handleKeyDown);
		return () => window.removeEventListener('keydown', handleKeyDown);
	}, []);

	// Generate prose styles scoped to marketplace panel
	const proseStyles = useMemo(
		() =>
			generateProseStyles({
				theme,
				coloredHeadings: true,
				compactSpacing: false,
				includeCheckboxStyles: true,
				scopeSelector: '.marketplace-preview',
			}),
		[theme]
	);

	// Create markdown components with link handling
	const markdownComponents = useMemo(
		() =>
			createMarkdownComponents({
				theme,
				onExternalLinkClick: (href) => window.maestro.shell.openExternal(href),
			}),
		[theme]
	);

	// Close dropdown when clicking outside
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
				setShowDocDropdown(false);
			}
		};
		if (showDocDropdown) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [showDocDropdown]);

	const handleDocumentSelect = (filename: string | null) => {
		if (filename === null) {
			// Switch to README (null means show README)
			onSelectDocument('');
		} else {
			onSelectDocument(filename);
		}
		setShowDocDropdown(false);
	};

	return (
		<div className="flex flex-col h-full overflow-hidden">
			{/* Header with back button and playbook info */}
			<div
				className="flex items-center gap-4 px-4 py-3 border-b shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				{/* Back button */}
				<button
					onClick={onBack}
					className="p-1.5 rounded hover:bg-white/10 transition-colors"
					title="Back to list (Esc)"
				>
					<ArrowLeft className="w-5 h-5" style={{ color: theme.colors.textDim }} />
				</button>

				{/* Playbook title and category */}
				<div className="flex-1 min-w-0">
					<div className="flex items-center gap-2 mb-0.5">
						<span
							className="px-2 py-0.5 rounded text-xs"
							style={{ backgroundColor: `${theme.colors.accent}20`, color: theme.colors.accent }}
						>
							{playbook.category}
						</span>
						{playbook.subcategory && (
							<span className="text-xs" style={{ color: theme.colors.textDim }}>
								/ {playbook.subcategory}
							</span>
						)}
					</div>
					<h2 className="text-lg font-semibold truncate" style={{ color: theme.colors.textMain }}>
						{playbook.title}
					</h2>
				</div>
			</div>

			{/* Main content area with sidebar and document preview */}
			<div className="flex-1 flex min-h-0 overflow-hidden">
				{/* Left sidebar with playbook metadata */}
				<div
					className="w-64 shrink-0 p-4 border-r overflow-y-auto"
					style={{ borderColor: theme.colors.border }}
				>
					{/* Description */}
					<div className="mb-4">
						<h4
							className="text-xs font-semibold mb-1 uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Description
						</h4>
						<p className="text-sm" style={{ color: theme.colors.textMain }}>
							{playbook.description}{' '}
							<button
								onClick={() => onSelectDocument('')}
								className="hover:opacity-80 transition-colors px-1 rounded"
								style={{
									color: theme.colors.accent,
									backgroundColor: !selectedDocFilename
										? `${theme.colors.accent}20`
										: 'transparent',
								}}
							>
								Read more...
							</button>
						</p>
					</div>

					{/* Author */}
					<div className="mb-4">
						<h4
							className="text-xs font-semibold mb-1 uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Author
						</h4>
						{playbook.authorLink ? (
							<a
								href={playbook.authorLink}
								target="_blank"
								rel="noopener noreferrer"
								className="text-sm hover:underline inline-flex items-center gap-1"
								style={{ color: theme.colors.accent }}
								onClick={(e) => {
									e.preventDefault();
									window.maestro.shell.openExternal(playbook.authorLink!);
								}}
							>
								{playbook.author}
								<ExternalLink className="w-3 h-3" />
							</a>
						) : (
							<p className="text-sm" style={{ color: theme.colors.textMain }}>
								{playbook.author}
							</p>
						)}
					</div>

					{/* Tags */}
					{playbook.tags && playbook.tags.length > 0 && (
						<div className="mb-4">
							<h4
								className="text-xs font-semibold mb-1 uppercase tracking-wide"
								style={{ color: theme.colors.textDim }}
							>
								Tags
							</h4>
							<div className="flex flex-wrap gap-1.5">
								{playbook.tags.map((tag) => (
									<span
										key={tag}
										className="px-2 py-0.5 rounded-full text-xs font-medium"
										style={{
											backgroundColor: `${theme.colors.accent}20`,
											color: theme.colors.accent,
											border: `1px solid ${theme.colors.accent}40`,
										}}
									>
										{tag}
									</span>
								))}
							</div>
						</div>
					)}

					{/* Documents list - clickable to open in viewer */}
					<div className="mb-4">
						<h4
							className="text-xs font-semibold mb-1 uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Documents ({playbook.documents.length})
						</h4>
						<ul className="space-y-0.5">
							{playbook.documents.map((doc, i) => {
								const isActive = selectedDocFilename === doc.filename;
								return (
									<li key={doc.filename}>
										<button
											onClick={() => onSelectDocument(doc.filename)}
											className="text-sm text-left transition-colors hover:opacity-80 w-full px-2 py-1 rounded"
											style={{
												color: theme.colors.accent,
												fontWeight: isActive ? 600 : 400,
												backgroundColor: isActive ? `${theme.colors.accent}20` : 'transparent',
											}}
										>
											{i + 1}. {doc.filename}.md
										</button>
									</li>
								);
							})}
						</ul>
					</div>

					{/* Loop settings */}
					<div className="mb-4">
						<h4
							className="text-xs font-semibold mb-1 uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Settings
						</h4>
						<p className="text-sm" style={{ color: theme.colors.textMain }}>
							Loop:{' '}
							{playbook.loopEnabled
								? playbook.maxLoops
									? `Yes (max ${playbook.maxLoops})`
									: 'Yes (unlimited)'
								: 'No'}
						</p>
					</div>

					{/* Last updated */}
					<div className="mb-6">
						<h4
							className="text-xs font-semibold mb-1 uppercase tracking-wide"
							style={{ color: theme.colors.textDim }}
						>
							Last Updated
						</h4>
						<p className="text-sm" style={{ color: theme.colors.textMain }}>
							{playbook.lastUpdated}
						</p>
					</div>
				</div>

				{/* Main content area with document dropdown and markdown preview */}
				<div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
					{/* Document selector dropdown */}
					<div
						className="px-4 py-3 border-b shrink-0"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
					>
						<div className="relative" ref={dropdownRef}>
							<button
								onClick={() => setShowDocDropdown(!showDocDropdown)}
								className="w-full flex items-center justify-between px-3 py-2 rounded text-sm"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								<span>{selectedDocFilename ? `${selectedDocFilename}.md` : 'README.md'}</span>
								<ChevronDown
									className={`w-4 h-4 transition-transform ${showDocDropdown ? 'rotate-180' : ''}`}
								/>
							</button>

							{showDocDropdown && (
								<div
									className="absolute top-full left-0 right-0 mt-1 rounded shadow-lg z-10 overflow-hidden max-h-64 overflow-y-auto"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										border: `1px solid ${theme.colors.border}`,
									}}
								>
									{/* README option */}
									<button
										onClick={() => handleDocumentSelect(null)}
										className="w-full px-3 py-2 text-sm text-left hover:bg-white/5 transition-colors"
										style={{
											color: !selectedDocFilename ? theme.colors.accent : theme.colors.textMain,
											backgroundColor: !selectedDocFilename
												? theme.colors.bgActivity
												: 'transparent',
										}}
									>
										README.md
									</button>

									<div className="border-t" style={{ borderColor: theme.colors.border }} />

									{/* Document options */}
									{playbook.documents.map((doc) => (
										<button
											key={doc.filename}
											onClick={() => handleDocumentSelect(doc.filename)}
											className="w-full px-3 py-2 text-sm text-left hover:bg-white/5 transition-colors"
											style={{
												color:
													selectedDocFilename === doc.filename
														? theme.colors.accent
														: theme.colors.textMain,
												backgroundColor:
													selectedDocFilename === doc.filename
														? theme.colors.bgActivity
														: 'transparent',
											}}
										>
											{doc.filename}.md
										</button>
									))}
								</div>
							)}
						</div>
					</div>

					{/* Markdown preview - scrollable container with prose styles */}
					<div
						ref={previewScrollRef}
						className="marketplace-preview flex-1 min-h-0 overflow-y-auto p-4"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<style>{proseStyles}</style>
						{isLoadingDocument ? (
							<div className="flex items-center justify-center h-32">
								<Loader2 className="w-6 h-6 animate-spin" style={{ color: theme.colors.accent }} />
							</div>
						) : (
							<div className="prose prose-sm max-w-none" style={{ color: theme.colors.textMain }}>
								<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
									{selectedDocFilename
										? documentContent || '*Document not found*'
										: readmeContent || '*No README available*'}
								</ReactMarkdown>
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Fixed footer with folder name input and import button */}
			<div
				className="shrink-0 px-4 py-3 border-t"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="flex items-center gap-3">
					{/* Target folder input */}
					<div className="flex-1">
						<label className="block text-xs mb-1" style={{ color: theme.colors.textDim }}>
							Import to folder (relative to Auto Run folder or absolute path)
						</label>
						<div className="flex items-center gap-2">
							<input
								type="text"
								value={targetFolderName}
								onChange={(e) => onTargetFolderChange(e.target.value)}
								className="flex-1 px-3 py-2 rounded border outline-none text-sm focus:ring-1"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									backgroundColor: theme.colors.bgActivity,
								}}
								placeholder="folder-name or /absolute/path"
							/>
							<button
								onClick={onBrowseFolder}
								disabled={isRemoteSession}
								className={`p-2 rounded border transition-colors ${
									isRemoteSession ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5'
								}`}
								style={{ borderColor: theme.colors.border }}
								title={
									isRemoteSession
										? 'Browse is not available for remote sessions'
										: 'Browse for folder'
								}
							>
								<FolderOpen className="w-4 h-4" style={{ color: theme.colors.textDim }} />
							</button>
						</div>
					</div>

					{/* Import button */}
					<button
						onClick={onImport}
						disabled={isImporting || !targetFolderName.trim()}
						className="px-4 py-2 rounded font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed mt-5"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
					>
						{isImporting ? (
							<span className="flex items-center gap-2">
								<Loader2 className="w-4 h-4 animate-spin" />
								Importing...
							</span>
						) : (
							<span className="flex items-center gap-2">
								<Download className="w-4 h-4" />
								Import Playbook
							</span>
						)}
					</button>
				</div>
			</div>
		</div>
	);
}

// ============================================================================
// MarketplaceModal Component
// ============================================================================

export function MarketplaceModal({
	theme,
	isOpen,
	onClose,
	autoRunFolderPath,
	sessionId,
	sshRemoteId,
	onImportComplete,
}: MarketplaceModalProps) {
	// Layer stack for escape handling
	const { registerLayer, unregisterLayer } = useLayerStack();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// SSH remote awareness - local folder browsing is not available for remote sessions
	const isRemoteSession = !!sshRemoteId;

	// Marketplace hook for data and operations
	const {
		manifest,
		categories,
		isLoading,
		isRefreshing,
		isImporting,
		fromCache,
		cacheAge,
		error,
		selectedCategory,
		setSelectedCategory,
		searchQuery,
		setSearchQuery,
		filteredPlaybooks,
		refresh,
		importPlaybook,
		fetchReadme,
		fetchDocument,
	} = useMarketplace();

	// Tile selection state
	const [selectedTileIndex, setSelectedTileIndex] = useState(0);

	// Search input ref for focus
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Grid container ref for returning focus from search
	const gridContainerRef = useRef<HTMLDivElement>(null);

	// Detail view state
	const [selectedPlaybook, setSelectedPlaybook] = useState<MarketplacePlaybook | null>(null);
	const [showDetailView, setShowDetailView] = useState(false);
	const [readmeContent, setReadmeContent] = useState<string | null>(null);
	const [selectedDocFilename, setSelectedDocFilename] = useState<string | null>(null);
	const [documentContent, setDocumentContent] = useState<string | null>(null);
	const [isLoadingDocument, setIsLoadingDocument] = useState(false);
	const [targetFolderName, setTargetFolderName] = useState('');

	// Help popover state
	const [showHelp, setShowHelp] = useState(false);
	const helpButtonRef = useRef<HTMLButtonElement>(null);

	// Reset selection when filtered playbooks change
	useEffect(() => {
		setSelectedTileIndex(0);
	}, [filteredPlaybooks.length, selectedCategory, searchQuery]);

	// Calculate grid columns based on container width (default to 3)
	const gridColumns = 3;

	// Reference for escape handling to include showDetailView and showHelp state
	const showDetailViewRef = useRef(showDetailView);
	showDetailViewRef.current = showDetailView;
	const showHelpRef = useRef(showHelp);
	showHelpRef.current = showHelp;

	// Back navigation handler
	const handleBackToList = useCallback(() => {
		setShowDetailView(false);
		setSelectedPlaybook(null);
		setReadmeContent(null);
		setSelectedDocFilename(null);
		setDocumentContent(null);
		setTargetFolderName('');
	}, []);

	const handleBackToListRef = useRef(handleBackToList);
	handleBackToListRef.current = handleBackToList;

	// Register with layer stack for escape handling
	useEffect(() => {
		if (isOpen) {
			const id = registerLayer({
				type: 'modal',
				priority: MODAL_PRIORITIES.MARKETPLACE,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				ariaLabel: 'Playbook Exchange',
				onEscape: () => {
					if (showHelpRef.current) {
						setShowHelp(false);
					} else if (showDetailViewRef.current) {
						handleBackToListRef.current();
					} else {
						onCloseRef.current();
					}
				},
			});
			return () => unregisterLayer(id);
		}
	}, [isOpen, registerLayer, unregisterLayer]);

	// Focus search input when modal opens
	useEffect(() => {
		if (isOpen) {
			const timer = setTimeout(() => searchInputRef.current?.focus(), 50);
			return () => clearTimeout(timer);
		}
	}, [isOpen]);

	// Handle selecting a playbook (opens detail view)
	const handleSelectPlaybook = useCallback(
		async (playbook: MarketplacePlaybook) => {
			setSelectedPlaybook(playbook);
			setShowDetailView(true);
			setSelectedDocFilename(null);
			setDocumentContent(null);

			// Generate default folder name: category/title slug
			const slug = `${playbook.category}/${playbook.title}`
				.toLowerCase()
				.replace(/[^a-z0-9/]+/g, '-')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '');
			setTargetFolderName(slug);

			// Fetch README
			setIsLoadingDocument(true);
			const readme = await fetchReadme(playbook.path);
			setReadmeContent(readme);
			setIsLoadingDocument(false);
		},
		[fetchReadme]
	);

	// Handle selecting a document in detail view
	const handleSelectDocument = useCallback(
		async (filename: string) => {
			if (!selectedPlaybook) return;

			if (filename === '') {
				// Switch back to README
				setSelectedDocFilename(null);
				setDocumentContent(null);
				return;
			}

			setSelectedDocFilename(filename);
			setIsLoadingDocument(true);
			const content = await fetchDocument(selectedPlaybook.path, filename);
			setDocumentContent(content);
			setIsLoadingDocument(false);
		},
		[selectedPlaybook, fetchDocument]
	);

	// Handle import action (SSH-aware - imports to remote host if sshRemoteId provided)
	const handleImport = useCallback(async () => {
		if (!selectedPlaybook || !targetFolderName.trim()) return;

		const result = await importPlaybook(
			selectedPlaybook,
			targetFolderName,
			autoRunFolderPath,
			sessionId,
			sshRemoteId
		);

		if (result.success) {
			onImportComplete(targetFolderName);
			onClose();
		} else {
			// Could show an error toast here in future enhancement
			console.error('Import failed:', result.error);
		}
	}, [
		selectedPlaybook,
		targetFolderName,
		importPlaybook,
		autoRunFolderPath,
		sessionId,
		sshRemoteId,
		onImportComplete,
		onClose,
	]);

	// Handle browse folder action (disabled for remote sessions)
	const handleBrowseFolder = useCallback(async () => {
		// Browse is only available for local sessions
		if (isRemoteSession) return;
		const folder = await window.maestro.dialog.selectFolder();
		if (folder) {
			setTargetFolderName(folder);
		}
	}, [isRemoteSession]);

	// Cmd+F to focus search input
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Cmd+F or Ctrl+F to focus search (only in list view)
			if ((e.metaKey || e.ctrlKey) && e.key === 'f' && !showDetailView) {
				e.preventDefault();
				searchInputRef.current?.focus();
				searchInputRef.current?.select();
			}
		};

		if (isOpen) {
			window.addEventListener('keydown', handleKeyDown);
			return () => window.removeEventListener('keydown', handleKeyDown);
		}
	}, [isOpen, showDetailView]);

	// Keyboard shortcuts for category tabs (list view) or document navigation (detail view): Cmd+Shift+[ and Cmd+Shift+]
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
				if (e.key === '[' || e.key === ']') {
					e.preventDefault();

					// In detail view: navigate between documents
					if (showDetailView && selectedPlaybook) {
						// Build document list: README (null) + all playbook documents
						const docList: (string | null)[] = [
							null,
							...selectedPlaybook.documents.map((d) => d.filename),
						];
						const currentIndex =
							selectedDocFilename === null || selectedDocFilename === ''
								? 0
								: docList.indexOf(selectedDocFilename);

						let newIndex: number;
						if (e.key === '[') {
							// Go backwards, wrap around
							newIndex = currentIndex <= 0 ? docList.length - 1 : currentIndex - 1;
						} else {
							// Go forwards, wrap around
							newIndex = currentIndex >= docList.length - 1 ? 0 : currentIndex + 1;
						}

						const newDoc = docList[newIndex];
						if (newDoc === null) {
							// Switch to README
							handleSelectDocument('');
						} else {
							handleSelectDocument(newDoc);
						}
					} else {
						// In list view: navigate between category tabs
						if (e.key === '[') {
							const currentIndex = categories.indexOf(selectedCategory);
							const newIndex = Math.max(0, currentIndex - 1);
							setSelectedCategory(categories[newIndex]);
						} else {
							const currentIndex = categories.indexOf(selectedCategory);
							const newIndex = Math.min(categories.length - 1, currentIndex + 1);
							setSelectedCategory(categories[newIndex]);
						}
					}
				}
			}
		};

		if (isOpen) {
			window.addEventListener('keydown', handleKeyDown);
			return () => window.removeEventListener('keydown', handleKeyDown);
		}
	}, [
		isOpen,
		categories,
		selectedCategory,
		setSelectedCategory,
		showDetailView,
		selectedPlaybook,
		selectedDocFilename,
		handleSelectDocument,
	]);

	// Arrow key navigation for tiles (list view only)
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			// Only handle in list view, not detail view
			if (showDetailView) return;

			const total = filteredPlaybooks.length;
			if (total === 0) return;

			// Handle input elements specially
			if (e.target instanceof HTMLInputElement) {
				const input = e.target as HTMLInputElement;
				// For left/right arrows, only navigate tiles if the input is empty
				// (otherwise let user move cursor in the text)
				if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
					if (input.value.length > 0) {
						return; // Let cursor move in non-empty input
					}
					// Empty input: blur and navigate tiles
					input.blur();
				}
				// For up/down, always allow tile navigation (blur input first)
				if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
					input.blur();
				}
			}

			switch (e.key) {
				case 'ArrowRight':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.min(total - 1, i + 1));
					break;
				case 'ArrowLeft':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.max(0, i - 1));
					break;
				case 'ArrowDown':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.min(total - 1, i + gridColumns));
					break;
				case 'ArrowUp':
					e.preventDefault();
					setSelectedTileIndex((i) => Math.max(0, i - gridColumns));
					break;
				case 'Enter':
					e.preventDefault();
					if (filteredPlaybooks[selectedTileIndex]) {
						handleSelectPlaybook(filteredPlaybooks[selectedTileIndex]);
					}
					break;
			}
		};

		if (isOpen) {
			window.addEventListener('keydown', handleKeyDown);
			return () => window.removeEventListener('keydown', handleKeyDown);
		}
	}, [
		isOpen,
		showDetailView,
		filteredPlaybooks,
		selectedTileIndex,
		gridColumns,
		handleSelectPlaybook,
	]);

	// Don't render if not open
	if (!isOpen) return null;

	const modalContent = (
		<div
			className="fixed inset-0 modal-overlay flex items-start justify-center pt-16 z-[9999] animate-in fade-in duration-100"
			style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="marketplace-title"
				tabIndex={-1}
				className="w-[900px] max-w-[90vw] rounded-xl shadow-2xl border overflow-hidden flex flex-col h-[80vh] outline-none"
				style={{
					backgroundColor: theme.colors.bgActivity,
					borderColor: theme.colors.border,
				}}
			>
				{showDetailView && selectedPlaybook ? (
					// Detail View
					<PlaybookDetailView
						theme={theme}
						playbook={selectedPlaybook}
						readmeContent={readmeContent}
						selectedDocFilename={selectedDocFilename}
						documentContent={documentContent}
						isLoadingDocument={isLoadingDocument}
						targetFolderName={targetFolderName}
						isImporting={isImporting}
						isRemoteSession={isRemoteSession}
						onBack={handleBackToList}
						onSelectDocument={handleSelectDocument}
						onTargetFolderChange={setTargetFolderName}
						onBrowseFolder={handleBrowseFolder}
						onImport={handleImport}
					/>
				) : (
					// List View
					<>
						{/* Header */}
						<div
							className="flex items-center justify-between px-4 py-3 border-b"
							style={{ borderColor: theme.colors.border }}
						>
							<div className="flex items-center gap-2">
								<LayoutGrid className="w-5 h-5" style={{ color: theme.colors.accent }} />
								<h2
									id="marketplace-title"
									className="text-lg font-semibold"
									style={{ color: theme.colors.textMain }}
								>
									Playbook Exchange
								</h2>
								{/* Help button */}
								<div className="relative">
									<button
										ref={helpButtonRef}
										onClick={() => setShowHelp(!showHelp)}
										className="p-1 rounded hover:bg-white/10 transition-colors"
										title="About the Playbook Exchange"
										aria-label="Help"
									>
										<HelpCircle className="w-4 h-4" style={{ color: theme.colors.textDim }} />
									</button>
									{showHelp && (
										<div
											className="absolute top-full left-0 mt-2 w-80 p-4 rounded-lg shadow-xl z-50"
											style={{
												backgroundColor: theme.colors.bgSidebar,
												border: `1px solid ${theme.colors.border}`,
											}}
										>
											<h3
												className="text-sm font-semibold mb-2"
												style={{ color: theme.colors.textMain }}
											>
												About the Playbook Exchange
											</h3>
											<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
												The Playbook Exchange is a curated collection of Auto Run playbooks for
												common development workflows. Browse, preview, and import playbooks directly
												into your Auto Run folder.
											</p>
											<h4
												className="text-xs font-semibold mb-1"
												style={{ color: theme.colors.textMain }}
											>
												Submit Your Playbook
											</h4>
											<p className="text-xs mb-2" style={{ color: theme.colors.textDim }}>
												Want to share your playbook with the community? Submit a pull request to the
												Maestro-Playbooks repository:
											</p>
											<button
												onClick={() => {
													window.maestro.shell.openExternal(
														'https://github.com/pedramamini/Maestro-Playbooks'
													);
													setShowHelp(false);
												}}
												className="text-xs hover:opacity-80 transition-colors"
												style={{ color: theme.colors.accent }}
											>
												github.com/pedramamini/Maestro-Playbooks
											</button>
											<div
												className="mt-3 pt-3 border-t"
												style={{ borderColor: theme.colors.border }}
											>
												<button
													onClick={() => setShowHelp(false)}
													className="text-xs px-2 py-1 rounded hover:bg-white/10 transition-colors"
													style={{ color: theme.colors.textDim }}
												>
													Close
												</button>
											</div>
										</div>
									)}
								</div>
								{/* GitHub submit button */}
								<button
									onClick={() => {
										window.maestro.shell.openExternal(
											'https://github.com/pedramamini/Maestro-Playbooks'
										);
									}}
									className="px-2 py-1 rounded hover:bg-white/10 transition-colors flex items-center gap-1.5 text-xs"
									title="Submit your playbook to the community"
									style={{ color: theme.colors.textDim }}
								>
									<Github className="w-3.5 h-3.5" />
									<span>Submit Playbook via GitHub</span>
								</button>
							</div>
							<div className="flex items-center gap-3">
								{/* Cache status */}
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									{fromCache ? `Cached ${formatCacheAge(cacheAge)}` : 'Live'}
								</span>
								{/* Refresh button */}
								<button
									onClick={() => refresh()}
									disabled={isRefreshing}
									className="p-1.5 rounded hover:bg-white/10 transition-colors disabled:opacity-50"
									title="Refresh marketplace data"
									aria-label="Refresh marketplace"
									aria-busy={isRefreshing}
								>
									<RefreshCw
										className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`}
										style={{ color: theme.colors.textDim }}
									/>
								</button>
								{/* Close button */}
								<button
									onClick={onClose}
									className="p-1.5 rounded hover:bg-white/10 transition-colors"
									title="Close (Esc)"
									aria-label="Close marketplace"
								>
									<X className="w-5 h-5" style={{ color: theme.colors.textDim }} />
								</button>
							</div>
						</div>

						{/* Category Tabs */}
						<div
							className="flex items-center gap-1 px-4 py-2 border-b overflow-x-auto"
							style={{ borderColor: theme.colors.border }}
						>
							{categories.map((category) => {
								const count =
									category === 'All'
										? (manifest?.playbooks.length ?? 0)
										: (manifest?.playbooks.filter((p) => p.category === category).length ?? 0);
								return (
									<button
										key={category}
										onClick={() => setSelectedCategory(category)}
										className={`px-3 py-1.5 rounded text-sm whitespace-nowrap transition-colors ${
											selectedCategory === category ? 'font-semibold' : ''
										}`}
										style={{
											backgroundColor:
												selectedCategory === category ? theme.colors.accent : 'transparent',
											color:
												selectedCategory === category
													? theme.colors.accentForeground
													: theme.colors.textMain,
										}}
									>
										{category}
										<span className="ml-1.5 text-xs opacity-60">({count})</span>
									</button>
								);
							})}
						</div>

						{/* Search Bar */}
						<div
							className="px-4 py-3 border-b"
							style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
						>
							<div className="relative">
								<Search
									className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
									style={{ color: theme.colors.textDim }}
								/>
								<input
									ref={searchInputRef}
									type="text"
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === 'Escape') {
											e.preventDefault();
											e.stopPropagation();
											// Return focus to the grid container
											gridContainerRef.current?.focus();
										}
									}}
									placeholder="Search playbooks..."
									className="w-full pl-10 pr-4 py-2 rounded border outline-none"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										backgroundColor: theme.colors.bgActivity,
									}}
								/>
							</div>
						</div>

						{/* Playbook Grid */}
						<div
							ref={gridContainerRef}
							tabIndex={-1}
							className="flex-1 overflow-y-auto p-4 outline-none"
							style={{ backgroundColor: theme.colors.bgMain }}
						>
							{isLoading ? (
								// Loading skeleton tiles
								<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
									{[...Array(6)].map((_, i) => (
										<PlaybookTileSkeleton key={i} theme={theme} />
									))}
								</div>
							) : error ? (
								<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center py-12">
									<Package
										className="w-16 h-16 mb-4"
										style={{ color: theme.colors.error, opacity: 0.7 }}
									/>
									<p className="text-lg font-medium mb-2" style={{ color: theme.colors.error }}>
										Failed to load marketplace
									</p>
									<p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
										{error}
									</p>
									<button
										onClick={() => refresh()}
										className="px-4 py-2 rounded text-sm font-medium"
										style={{
											backgroundColor: theme.colors.accent,
											color: theme.colors.accentForeground,
										}}
									>
										Try Again
									</button>
								</div>
							) : filteredPlaybooks.length === 0 ? (
								<div className="flex flex-col items-center justify-center h-full min-h-[200px] text-center py-12">
									<Package
										className="w-16 h-16 mb-4"
										style={{ color: theme.colors.textDim, opacity: 0.5 }}
									/>
									{searchQuery ? (
										<>
											<p
												className="text-lg font-medium mb-2"
												style={{ color: theme.colors.textMain }}
											>
												No results found
											</p>
											<p className="text-sm" style={{ color: theme.colors.textDim }}>
												Try adjusting your search or browse a different category
											</p>
										</>
									) : (
										<>
											<p
												className="text-lg font-medium mb-2"
												style={{ color: theme.colors.textMain }}
											>
												No playbooks available
											</p>
											<p className="text-sm" style={{ color: theme.colors.textDim }}>
												Check back later for new playbooks
											</p>
										</>
									)}
								</div>
							) : (
								<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
									{filteredPlaybooks.map((playbook, index) => (
										<PlaybookTile
											key={playbook.id}
											playbook={playbook}
											theme={theme}
											isSelected={selectedTileIndex === index}
											onSelect={() => handleSelectPlaybook(playbook)}
										/>
									))}
								</div>
							)}
						</div>

						{/* Footer with keyboard shortcuts hint */}
						<div
							className="px-4 py-2 border-t text-xs flex items-center justify-between"
							style={{
								borderColor: theme.colors.border,
								color: theme.colors.textDim,
							}}
						>
							<span>Use arrow keys to navigate, Enter to select</span>
							<span className="flex items-center gap-3">
								<span>
									<kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px]">
										{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+F
									</kbd>{' '}
									search
								</span>
								<span>
									<kbd className="px-1.5 py-0.5 rounded bg-white/10 font-mono text-[10px]">
										{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+Shift+[/]
									</kbd>{' '}
									to switch tabs
								</span>
							</span>
						</div>
					</>
				)}
			</div>
		</div>
	);

	return createPortal(modalContent, document.body);
}
