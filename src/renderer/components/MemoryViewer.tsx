/**
 * MemoryViewer — full-panel overlay for browsing/editing Claude Code per-project memory.
 *
 * Mirrors the Claude Sessions browser shell (same header pattern, stats bar, close button) and
 * reuses the shared DualPaneFileEditor for the list + markdown editor layout. Gated by the
 * `supportsProjectMemory` capability on the active agent; today only Claude Code qualifies.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Plus, X, Database, FileText, Clock, Zap } from 'lucide-react';
import type { Session, Theme } from '../types';
import { formatSize, formatRelativeTime, formatNumber } from '../utils/formatters';
import { estimateTokenCount } from '../../shared/formatters';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { useLayerStack } from '../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { DualPaneFileEditor, type DualPaneFileEditorItem } from './shared/DualPaneFileEditor';
import { Modal, ModalFooter } from './ui/Modal';
import { FormInput } from './ui/FormInput';

interface MemoryViewerProps {
	theme: Theme;
	activeSession: Session | undefined;
	onClose: () => void;
}

interface MemoryEntry {
	name: string;
	size: number;
	createdAt: string;
	modifiedAt: string;
}

interface MemoryStats {
	fileCount: number;
	firstCreatedAt: string | null;
	lastModifiedAt: string | null;
	totalBytes: number;
}

const INDEX_STARTER_CONTENT = `# Memory index

Pointers to individual memory files. One line per entry, under ~150 chars:

- [Title](filename.md) — one-line hook
`;

const ENTRY_STARTER_CONTENT = `---
name: new memory
description: one-line description
type: user
---

Write the memory body here.
`;

function starterContentFor(filename: string): string {
	return filename === 'MEMORY.md' ? INDEX_STARTER_CONTENT : ENTRY_STARTER_CONTENT;
}

function suggestNewFilename(existing: Set<string>): string {
	// First file should always be MEMORY.md (the index that points at every other entry).
	if (existing.size === 0) return 'MEMORY.md';
	const base = 'new-memory';
	let candidate = `${base}.md`;
	let n = 2;
	while (existing.has(candidate)) {
		candidate = `${base}-${n}.md`;
		n += 1;
	}
	return candidate;
}

export function MemoryViewer({ theme, activeSession, onClose }: MemoryViewerProps): JSX.Element {
	const projectPath = activeSession?.projectRoot || activeSession?.cwd || '';
	const agentId = activeSession?.toolType || 'claude-code';

	const [entries, setEntries] = useState<MemoryEntry[]>([]);
	const [stats, setStats] = useState<MemoryStats>({
		fileCount: 0,
		firstCreatedAt: null,
		lastModifiedAt: null,
		totalBytes: 0,
	});
	const [directoryPath, setDirectoryPath] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);

	const [selectedName, setSelectedName] = useState<string | null>(null);
	const [originalContent, setOriginalContent] = useState<string>('');
	const [editedContent, setEditedContent] = useState<string>('');
	const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [actionError, setActionError] = useState<string | null>(null);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);

	const [createModalOpen, setCreateModalOpen] = useState(false);
	const [createName, setCreateName] = useState('');
	const [createError, setCreateError] = useState<string | null>(null);
	const [isCreating, setIsCreating] = useState(false);
	const createInputRef = useRef<HTMLInputElement>(null);

	const layerIdRef = useRef<string>();
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	const { registerLayer, unregisterLayer } = useLayerStack();

	// Register as a modal layer so Escape closes us at the right priority.
	useEffect(() => {
		layerIdRef.current = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.AGENT_SESSIONS,
			blocksLowerLayers: true,
			capturesFocus: false,
			focusTrap: 'lenient',
			ariaLabel: 'Project Memory Viewer',
			onEscape: () => onCloseRef.current(),
		});
		return () => {
			if (layerIdRef.current) unregisterLayer(layerIdRef.current);
		};
	}, [registerLayer, unregisterLayer]);

	// Auto-dismiss success message
	useEffect(() => {
		if (!successMessage) return;
		const t = setTimeout(() => setSuccessMessage(null), 3000);
		return () => clearTimeout(t);
	}, [successMessage]);

	const loadEntry = useCallback(
		async (name: string) => {
			if (!projectPath) return;
			try {
				const result = await window.maestro.memory.read(projectPath, name, agentId);
				if (!result.success) {
					setActionError(result.error || `Failed to read ${name}`);
					return;
				}
				setSelectedName(name);
				setOriginalContent(result.content ?? '');
				setEditedContent(result.content ?? '');
				setHasUnsavedChanges(false);
				setActionError(null);
			} catch (err) {
				setActionError(String(err));
			}
		},
		[projectPath, agentId]
	);

	const reloadList = useCallback(
		async (preferName?: string | null) => {
			if (!projectPath) {
				setLoading(false);
				setLoadError('No active agent session');
				return;
			}
			setLoading(true);
			try {
				const result = await window.maestro.memory.list(projectPath, agentId);
				if (!result.success) {
					setLoadError(result.error || 'Failed to load memory');
					return;
				}
				setDirectoryPath(result.directoryPath || null);
				setEntries(result.entries || []);
				setStats(
					result.stats || {
						fileCount: 0,
						firstCreatedAt: null,
						lastModifiedAt: null,
						totalBytes: 0,
					}
				);
				setLoadError(null);

				// Pick a selection: prefer the passed name, fall back to MEMORY.md, then first entry.
				const list = result.entries || [];
				const target =
					(preferName && list.find((e) => e.name === preferName)) ||
					list.find((e) => e.name === 'MEMORY.md') ||
					list[0] ||
					null;
				if (target) {
					await loadEntry(target.name);
				} else {
					setSelectedName(null);
					setOriginalContent('');
					setEditedContent('');
					setHasUnsavedChanges(false);
				}
			} catch (err) {
				setLoadError(String(err));
			} finally {
				setLoading(false);
			}
		},
		[projectPath, agentId, loadEntry]
	);

	useEffect(() => {
		void reloadList();
	}, [reloadList]);

	const handleSelect = useCallback(
		async (name: string) => {
			if (name === selectedName) return;
			if (hasUnsavedChanges) {
				const discard = window.confirm('You have unsaved changes. Discard them?');
				if (!discard) return;
			}
			await loadEntry(name);
		},
		[selectedName, hasUnsavedChanges, loadEntry]
	);

	const handleSave = useCallback(async () => {
		if (!selectedName || !hasUnsavedChanges) return;
		setIsSaving(true);
		setActionError(null);
		try {
			const result = await window.maestro.memory.write(
				projectPath,
				selectedName,
				editedContent,
				agentId
			);
			if (!result.success) {
				setActionError(result.error || 'Failed to save memory');
				return;
			}
			setOriginalContent(editedContent);
			setHasUnsavedChanges(false);
			setSuccessMessage('Changes saved');
			// Refresh stats and list (size/modified changed)
			await reloadList(selectedName);
		} finally {
			setIsSaving(false);
		}
	}, [selectedName, hasUnsavedChanges, editedContent, projectPath, agentId, reloadList]);

	const handleDelete = useCallback(async () => {
		if (!selectedName) return;
		if (selectedName === 'MEMORY.md') {
			setActionError('MEMORY.md is the index and cannot be deleted from the viewer');
			return;
		}
		const confirmed = window.confirm(
			`Delete memory file "${selectedName}"? This cannot be undone.`
		);
		if (!confirmed) return;

		setIsDeleting(true);
		setActionError(null);
		try {
			const result = await window.maestro.memory.delete(projectPath, selectedName, agentId);
			if (!result.success) {
				setActionError(result.error || `Failed to delete ${selectedName}`);
				return;
			}
			setSuccessMessage(`Deleted ${selectedName}`);
			await reloadList(null);
		} finally {
			setIsDeleting(false);
		}
	}, [selectedName, projectPath, agentId, reloadList]);

	const handleCreate = useCallback(() => {
		if (!projectPath) return;
		if (hasUnsavedChanges) {
			const discard = window.confirm('You have unsaved changes on the current file. Discard them?');
			if (!discard) return;
		}
		const existing = new Set(entries.map((e) => e.name));
		setCreateName(suggestNewFilename(existing));
		setCreateError(null);
		setCreateModalOpen(true);
	}, [projectPath, entries, hasUnsavedChanges]);

	const closeCreateModal = useCallback(() => {
		setCreateModalOpen(false);
		setCreateName('');
		setCreateError(null);
		setIsCreating(false);
	}, []);

	const handleConfirmCreate = useCallback(async () => {
		if (!projectPath) return;
		let filename = createName.trim();
		if (!filename) {
			setCreateError('Filename is required');
			return;
		}
		if (!filename.toLowerCase().endsWith('.md')) filename += '.md';
		const existing = new Set(entries.map((e) => e.name));
		if (existing.has(filename)) {
			setCreateError(`A memory file named "${filename}" already exists`);
			return;
		}
		setIsCreating(true);
		setCreateError(null);
		try {
			const result = await window.maestro.memory.create(
				projectPath,
				filename,
				starterContentFor(filename),
				agentId
			);
			if (!result.success) {
				setCreateError(result.error || `Failed to create ${filename}`);
				return;
			}
			setSuccessMessage(`Created ${filename}`);
			closeCreateModal();
			await reloadList(filename);
		} finally {
			setIsCreating(false);
		}
	}, [projectPath, createName, entries, agentId, reloadList, closeCreateModal]);

	const items = useMemo<DualPaneFileEditorItem[]>(
		() =>
			entries.map((e) => {
				const isCurrent = e.name === selectedName;
				return {
					id: e.name,
					label: e.name,
					description: `${formatSize(e.size)} • modified ${formatRelativeTime(e.modifiedAt)}`,
					isModified: isCurrent && hasUnsavedChanges,
				};
			}),
		[entries, selectedName, hasUnsavedChanges]
	);

	const editorTokenCount = useMemo(
		() => (selectedName ? estimateTokenCount(editedContent) : undefined),
		[selectedName, editedContent]
	);

	const renderEditorBody = useCallback(() => {
		return (
			<textarea
				className="dual-pane-textarea"
				value={editedContent}
				onChange={(e) => {
					setEditedContent(e.target.value);
					setHasUnsavedChanges(e.target.value !== originalContent);
				}}
				spellCheck={false}
				style={{
					borderColor: theme.colors.border,
					backgroundColor: theme.colors.bgMain,
					color: theme.colors.textMain,
				}}
			/>
		);
	}, [editedContent, originalContent, theme]);

	// Cheap estimate: ~4 bytes/token for English text (matches estimateTokenCount from shared/formatters).
	const estimatedTokens = useMemo(() => Math.ceil(stats.totalBytes / 4), [stats.totalBytes]);

	const agentDisplayName = getAgentDisplayName(agentId);

	return (
		<div className="flex-1 flex flex-col h-full" style={{ backgroundColor: theme.colors.bgMain }}>
			{/* Header */}
			<div
				className="h-16 border-b flex items-center justify-between px-6 shrink-0"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
			>
				<div className="flex items-center gap-3 min-w-0">
					<Brain className="w-5 h-5 shrink-0" style={{ color: theme.colors.textDim }} />
					<span className="text-sm font-medium truncate" style={{ color: theme.colors.textMain }}>
						{agentDisplayName} Memories for {activeSession?.name || 'Agent'}
					</span>
				</div>
				<div className="flex items-center gap-2">
					<button
						onClick={handleCreate}
						className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors hover:opacity-80"
						style={{
							backgroundColor: theme.colors.accent,
							color: theme.colors.accentForeground,
						}}
						title="Create a new memory file"
					>
						<Plus className="w-4 h-4" />
						New Memory
					</button>
					<button
						onClick={onClose}
						className="p-2 rounded hover:bg-white/5 transition-colors"
						style={{ color: theme.colors.textDim }}
						title="Close memory viewer"
					>
						<X className="w-4 h-4" />
					</button>
				</div>
			</div>

			{/* Stats bar */}
			<div
				className="px-6 py-3 border-b shrink-0 flex items-center gap-6 text-xs"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				<span className="flex items-center gap-1.5">
					<FileText className="w-3.5 h-3.5" />
					{stats.fileCount} {stats.fileCount === 1 ? 'file' : 'files'}
				</span>
				<span className="flex items-center gap-1.5">
					<Database className="w-3.5 h-3.5" />
					{formatSize(stats.totalBytes)}
				</span>
				<span className="flex items-center gap-1.5">
					<Zap className="w-3.5 h-3.5" />~{formatNumber(estimatedTokens)} tokens
				</span>
				{stats.firstCreatedAt && (
					<span
						className="flex items-center gap-1.5"
						title={new Date(stats.firstCreatedAt).toLocaleString()}
					>
						<Clock className="w-3.5 h-3.5" />
						first created {formatRelativeTime(stats.firstCreatedAt)}
					</span>
				)}
				{stats.lastModifiedAt && (
					<span
						className="flex items-center gap-1.5"
						title={new Date(stats.lastModifiedAt).toLocaleString()}
					>
						<Clock className="w-3.5 h-3.5" />
						last edited {formatRelativeTime(stats.lastModifiedAt)}
					</span>
				)}
			</div>

			{/* Body */}
			<div className="flex-1 flex flex-col min-h-0 p-4">
				{loadError ? (
					<div
						className="flex-1 flex items-center justify-center text-sm"
						style={{ color: theme.colors.error }}
					>
						{loadError}
					</div>
				) : loading ? (
					<div
						className="flex-1 flex items-center justify-center text-sm"
						style={{ color: theme.colors.textDim }}
					>
						Loading memory…
					</div>
				) : entries.length === 0 ? (
					<div
						className="flex-1 flex flex-col items-center justify-center text-sm gap-3"
						style={{ color: theme.colors.textDim }}
					>
						<Brain className="w-10 h-10 opacity-30" />
						<div>No memory files yet for this project.</div>
						<button
							onClick={handleCreate}
							className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm font-medium"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
						>
							<Plus className="w-4 h-4" />
							Create first memory
						</button>
					</div>
				) : (
					<DualPaneFileEditor
						theme={theme}
						items={items}
						selectedId={selectedName}
						onSelect={handleSelect}
						emptyStateMessage="Select a memory file to view"
						editorTitle={selectedName ?? undefined}
						editorTokenCount={editorTokenCount}
						showModifiedBadge={hasUnsavedChanges}
						renderEditorBody={renderEditorBody}
						successMessage={successMessage}
						errorMessage={actionError}
						listWidthStorageKey="maestro.memoryViewer.listWidth"
						primaryAction={{
							label: isSaving ? 'Saving…' : 'Save',
							loading: isSaving,
							disabled: !hasUnsavedChanges,
							onClick: handleSave,
						}}
						secondaryAction={
							selectedName && selectedName !== 'MEMORY.md'
								? {
										label: isDeleting ? 'Deleting…' : 'Delete',
										loading: isDeleting,
										disabled: isDeleting,
										variant: 'danger',
										onClick: handleDelete,
									}
								: undefined
						}
						openInFinderPath={directoryPath}
					/>
				)}
			</div>

			{createModalOpen && (
				<Modal
					theme={theme}
					title="New Memory"
					priority={MODAL_PRIORITIES.MEMORY_CREATE}
					onClose={closeCreateModal}
					width={420}
					initialFocusRef={createInputRef as React.RefObject<HTMLElement>}
					footer={
						<ModalFooter
							theme={theme}
							onCancel={closeCreateModal}
							onConfirm={handleConfirmCreate}
							confirmLabel={isCreating ? 'Creating…' : 'Create'}
							confirmDisabled={isCreating || !createName.trim()}
						/>
					}
				>
					<FormInput
						ref={createInputRef}
						theme={theme}
						value={createName}
						onChange={(v) => {
							setCreateName(v);
							if (createError) setCreateError(null);
						}}
						onSubmit={handleConfirmCreate}
						placeholder="memory-name.md"
						label="Filename"
						helperText="The .md extension is added automatically if omitted."
						error={createError ?? undefined}
						monospace
					/>
				</Modal>
			)}
		</div>
	);
}
