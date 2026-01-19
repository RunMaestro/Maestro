/**
 * usePlaybookManagement Hook
 *
 * Extracted from BatchRunnerModal.tsx to manage playbook state and operations.
 *
 * This hook encapsulates:
 * - Playbook list state and loading
 * - Currently loaded playbook tracking
 * - CRUD operations (load, save, update, delete, export, import)
 * - Dropdown and modal visibility state
 * - Modification detection (comparing current config vs loaded playbook)
 * - Click-outside dropdown handling
 *
 * Dependencies:
 * - sessionId: For playbook storage scope
 * - folderPath: For export/import operations
 * - allDocuments: For detecting missing documents when loading playbooks
 * - Current configuration state (documents, loop, prompt) for modification detection
 *
 * Note: Worktree configuration has been moved to WorktreeConfigModal (git branch overlay)
 */

import { generateId } from '../../utils/ids';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useClickOutside } from '../ui';
import type { Playbook, BatchDocumentEntry } from '../../types';

/**
 * Configuration passed to the hook for modification detection
 * Note: Worktree configuration has been moved to WorktreeConfigModal
 */
export interface PlaybookConfigState {
	documents: BatchDocumentEntry[];
	loopEnabled: boolean;
	maxLoops: number | null;
	prompt: string;
}

/**
 * Dependencies required by the hook
 */
export interface UsePlaybookManagementDeps {
	/** Session ID for playbook storage */
	sessionId: string;
	/** Folder path for export/import file operations */
	folderPath: string;
	/** All available documents in the folder (for detecting missing docs) */
	allDocuments: string[];
	/** Current configuration state for modification detection */
	config: PlaybookConfigState;
	/** Callback to apply loaded playbook configuration (receives same shape as config) */
	onApplyPlaybook: (data: PlaybookConfigState) => void;
}

/**
 * Return type for the hook
 */
export interface UsePlaybookManagementReturn {
	// State
	playbooks: Playbook[];
	loadedPlaybook: Playbook | null;
	loadingPlaybooks: boolean;
	savingPlaybook: boolean;
	isPlaybookModified: boolean;

	// UI State
	showPlaybookDropdown: boolean;
	setShowPlaybookDropdown: React.Dispatch<React.SetStateAction<boolean>>;
	showSavePlaybookModal: boolean;
	setShowSavePlaybookModal: React.Dispatch<React.SetStateAction<boolean>>;
	showDeleteConfirmModal: boolean;
	playbookToDelete: Playbook | null;
	playbackDropdownRef: React.RefObject<HTMLDivElement>;

	// Handlers
	handleLoadPlaybook: (playbook: Playbook) => void;
	handleDeletePlaybook: (playbook: Playbook, e: React.MouseEvent) => void;
	handleConfirmDeletePlaybook: () => Promise<void>;
	handleCancelDeletePlaybook: () => void;
	handleExportPlaybook: (playbook: Playbook) => Promise<void>;
	handleImportPlaybook: () => Promise<void>;
	handleSaveAsPlaybook: (name: string) => Promise<void>;
	handleSaveUpdate: () => Promise<void>;
	handleDiscardChanges: () => void;
}

/**
 * Hook for managing playbook state and operations in BatchRunnerModal
 */
export function usePlaybookManagement(
	deps: UsePlaybookManagementDeps
): UsePlaybookManagementReturn {
	const { sessionId, folderPath, allDocuments, config, onApplyPlaybook } = deps;

	// Playbook list state
	const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
	const [loadedPlaybook, setLoadedPlaybook] = useState<Playbook | null>(null);
	const [loadingPlaybooks, setLoadingPlaybooks] = useState(true);

	// UI state
	const [showPlaybookDropdown, setShowPlaybookDropdown] = useState(false);
	const [showSavePlaybookModal, setShowSavePlaybookModal] = useState(false);
	const [savingPlaybook, setSavingPlaybook] = useState(false);
	const [showDeleteConfirmModal, setShowDeleteConfirmModal] = useState(false);
	const [playbookToDelete, setPlaybookToDelete] = useState<Playbook | null>(null);

	// Ref for dropdown click-outside detection
	const playbackDropdownRef = useRef<HTMLDivElement>(null);

	// Load playbooks on mount
	useEffect(() => {
		const loadPlaybooks = async () => {
			setLoadingPlaybooks(true);
			try {
				const result = await window.maestro.playbooks.list(sessionId);
				if (result.success) {
					setPlaybooks(result.playbooks);
				}
			} catch (error) {
				console.error('Failed to load playbooks:', error);
			}
			setLoadingPlaybooks(false);
		};

		loadPlaybooks();
	}, [sessionId]);

	// Close dropdown when clicking outside
	useClickOutside(playbackDropdownRef, () => setShowPlaybookDropdown(false), showPlaybookDropdown);

	// Track if the current configuration differs from the loaded playbook
	const isPlaybookModified = useMemo(() => {
		if (!loadedPlaybook) return false;

		const { documents, loopEnabled, maxLoops, prompt } = config;

		// Compare documents
		const currentDocs = documents.map((d) => ({
			filename: d.filename,
			resetOnCompletion: d.resetOnCompletion,
		}));
		const savedDocs = loadedPlaybook.documents;

		if (currentDocs.length !== savedDocs.length) return true;
		for (let i = 0; i < currentDocs.length; i++) {
			if (
				currentDocs[i].filename !== savedDocs[i].filename ||
				currentDocs[i].resetOnCompletion !== savedDocs[i].resetOnCompletion
			) {
				return true;
			}
		}

		// Compare loop setting
		if (loopEnabled !== loadedPlaybook.loopEnabled) return true;

		// Compare maxLoops setting
		const savedMaxLoops = loadedPlaybook.maxLoops ?? null;
		if (maxLoops !== savedMaxLoops) return true;

		// Compare prompt
		if (prompt !== loadedPlaybook.prompt) return true;

		return false;
	}, [config, loadedPlaybook]);

	// Handle loading a playbook
	const handleLoadPlaybook = useCallback(
		(playbook: Playbook) => {
			// Convert stored entries to BatchDocumentEntry with IDs
			// Also detect missing documents (documents in playbook that don't exist in allDocuments)
			const allDocsSet = new Set(allDocuments);

			const entries: BatchDocumentEntry[] = playbook.documents.map((doc, index) => ({
				id: generateId(),
				filename: doc.filename,
				resetOnCompletion: doc.resetOnCompletion,
				// Mark as duplicate if same filename appears earlier
				isDuplicate: playbook.documents.slice(0, index).some((d) => d.filename === doc.filename),
				// Mark as missing if document doesn't exist in the folder
				isMissing: !allDocsSet.has(doc.filename),
			}));

			// Apply configuration through callback
			// Note: Worktree settings are no longer managed here - see WorktreeConfigModal
			onApplyPlaybook({
				documents: entries,
				loopEnabled: playbook.loopEnabled,
				maxLoops: playbook.maxLoops ?? null,
				prompt: playbook.prompt,
			});

			setLoadedPlaybook(playbook);
			setShowPlaybookDropdown(false);
		},
		[allDocuments, onApplyPlaybook]
	);

	// Handle opening the delete confirmation modal
	const handleDeletePlaybook = useCallback((playbook: Playbook, e: React.MouseEvent) => {
		e.stopPropagation();
		setPlaybookToDelete(playbook);
		setShowDeleteConfirmModal(true);
	}, []);

	// Handle confirming the delete action
	const handleConfirmDeletePlaybook = useCallback(async () => {
		if (!playbookToDelete) return;

		try {
			const result = await window.maestro.playbooks.delete(sessionId, playbookToDelete.id);
			if (result.success) {
				setPlaybooks((prev) => prev.filter((p) => p.id !== playbookToDelete.id));
				// If the deleted playbook was loaded, clear it
				if (loadedPlaybook?.id === playbookToDelete.id) {
					setLoadedPlaybook(null);
				}
			}
		} catch (error) {
			console.error('Failed to delete playbook:', error);
		}

		setShowDeleteConfirmModal(false);
		setPlaybookToDelete(null);
	}, [sessionId, playbookToDelete, loadedPlaybook]);

	// Handle canceling the delete action
	const handleCancelDeletePlaybook = useCallback(() => {
		setShowDeleteConfirmModal(false);
		setPlaybookToDelete(null);
	}, []);

	// Handle exporting a playbook
	const handleExportPlaybook = useCallback(
		async (playbook: Playbook) => {
			try {
				const result = await window.maestro.playbooks.export(sessionId, playbook.id, folderPath);
				if (!result.success && result.error !== 'Export cancelled') {
					console.error('Failed to export playbook:', result.error);
				}
			} catch (error) {
				console.error('Failed to export playbook:', error);
			}
		},
		[sessionId, folderPath]
	);

	// Handle importing a playbook
	const handleImportPlaybook = useCallback(async () => {
		try {
			const result = await window.maestro.playbooks.import(sessionId, folderPath);
			if (result.success && result.playbook) {
				// Add to local playbooks list
				setPlaybooks((prev) => [...prev, result.playbook]);
				// Load the imported playbook
				handleLoadPlaybook(result.playbook);
			} else if (result.error && result.error !== 'Import cancelled') {
				console.error('Failed to import playbook:', result.error);
			}
		} catch (error) {
			console.error('Failed to import playbook:', error);
		}
	}, [sessionId, folderPath, handleLoadPlaybook]);

	// Handle saving a new playbook
	const handleSaveAsPlaybook = useCallback(
		async (name: string) => {
			if (savingPlaybook) return;

			setSavingPlaybook(true);
			try {
				const { documents, loopEnabled, maxLoops, prompt } = config;

				// Build playbook data
				// Note: Worktree settings are no longer stored in playbooks - see WorktreeConfigModal
				const playbookData: Parameters<typeof window.maestro.playbooks.create>[1] = {
					name,
					documents: documents.map((d) => ({
						filename: d.filename,
						resetOnCompletion: d.resetOnCompletion,
					})),
					loopEnabled,
					maxLoops,
					prompt,
				};

				const result = await window.maestro.playbooks.create(sessionId, playbookData);

				if (result.success) {
					setPlaybooks((prev) => [...prev, result.playbook]);
					setLoadedPlaybook(result.playbook);
					setShowSavePlaybookModal(false);
				}
			} catch (error) {
				console.error('Failed to save playbook:', error);
			}
			setSavingPlaybook(false);
		},
		[sessionId, config, savingPlaybook]
	);

	// Handle updating an existing playbook
	const handleSaveUpdate = useCallback(async () => {
		if (!loadedPlaybook || savingPlaybook) return;

		setSavingPlaybook(true);
		try {
			const { documents, loopEnabled, maxLoops, prompt } = config;

			// Build update data
			// Note: Worktree settings are no longer stored in playbooks - see WorktreeConfigModal
			const updateData: Parameters<typeof window.maestro.playbooks.update>[2] = {
				documents: documents.map((d) => ({
					filename: d.filename,
					resetOnCompletion: d.resetOnCompletion,
				})),
				loopEnabled,
				maxLoops,
				prompt,
				updatedAt: Date.now(),
			};

			const result = await window.maestro.playbooks.update(
				sessionId,
				loadedPlaybook.id,
				updateData
			);

			if (result.success) {
				setLoadedPlaybook(result.playbook);
				setPlaybooks((prev) =>
					prev.map((p) => (p.id === result.playbook.id ? result.playbook : p))
				);
			}
		} catch (error) {
			console.error('Failed to update playbook:', error);
		}
		setSavingPlaybook(false);
	}, [sessionId, loadedPlaybook, config, savingPlaybook]);

	// Handle discarding changes and reloading original playbook configuration
	const handleDiscardChanges = useCallback(() => {
		if (loadedPlaybook) {
			handleLoadPlaybook(loadedPlaybook);
		}
	}, [loadedPlaybook, handleLoadPlaybook]);

	return {
		// State
		playbooks,
		loadedPlaybook,
		loadingPlaybooks,
		savingPlaybook,
		isPlaybookModified,

		// UI State
		showPlaybookDropdown,
		setShowPlaybookDropdown,
		showSavePlaybookModal,
		setShowSavePlaybookModal,
		showDeleteConfirmModal,
		playbookToDelete,
		playbackDropdownRef,

		// Handlers
		handleLoadPlaybook,
		handleDeletePlaybook,
		handleConfirmDeletePlaybook,
		handleCancelDeletePlaybook,
		handleExportPlaybook,
		handleImportPlaybook,
		handleSaveAsPlaybook,
		handleSaveUpdate,
		handleDiscardChanges,
	};
}
