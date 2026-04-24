/**
 * AutoRunSetupSheet component for Maestro mobile web interface
 *
 * Bottom sheet modal for configuring Auto Run before launch.
 * Allows document selection, custom prompt, and loop settings.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { useAutoRun } from '../hooks/useAutoRun';
import type { AutoRunDocument, LaunchConfig, Playbook } from '../hooks/useAutoRun';
import type { UseWebSocketReturn } from '../hooks/useWebSocket';

/**
 * Props for AutoRunSetupSheet component
 */
export interface AutoRunSetupSheetProps {
	sessionId: string;
	documents: AutoRunDocument[];
	onLaunch: (config: LaunchConfig) => void;
	onClose: () => void;
	/** WebSocket sendRequest — required so the sheet can list/save/delete playbooks. */
	sendRequest: UseWebSocketReturn['sendRequest'];
	/** WebSocket send — passed through to useAutoRun (unused inside the sheet directly). */
	send: UseWebSocketReturn['send'];
}

/**
 * AutoRunSetupSheet component
 *
 * Bottom sheet modal that slides up from the bottom of the screen.
 * Provides document selection, optional prompt, and loop configuration.
 */
export function AutoRunSetupSheet({
	sessionId,
	documents,
	onLaunch,
	onClose,
	sendRequest,
	send,
}: AutoRunSetupSheetProps) {
	const colors = useThemeColors();
	const [selectedFiles, setSelectedFiles] = useState<Set<string>>(
		() => new Set(documents.map((d) => d.path || d.filename))
	);
	const [prompt, setPrompt] = useState('');
	const [loopEnabled, setLoopEnabled] = useState(false);
	const [maxLoops, setMaxLoops] = useState(3);
	const [isVisible, setIsVisible] = useState(false);
	const sheetRef = useRef<HTMLDivElement>(null);

	// Playbook state — loaded once when the sheet opens, plus the id of the
	// currently-loaded playbook (used to disambiguate "Save" vs. "Update").
	const {
		playbooks,
		isLoadingPlaybooks,
		loadPlaybooks,
		createPlaybook,
		updatePlaybook,
		deletePlaybook,
	} = useAutoRun(sendRequest, send);
	const [activePlaybookId, setActivePlaybookId] = useState<string | null>(null);
	const [isSavingPlaybook, setIsSavingPlaybook] = useState(false);
	const [showPlaybooks, setShowPlaybooks] = useState(true);
	// In-sheet prompt/confirm modals for playbook name entry and delete confirmation.
	// `window.prompt` / `window.confirm` are unreliable in mobile WebViews (iOS Safari
	// can disable dialogs after repeated use; some embedded WebViews stub them to no-ops),
	// so we render our own inline modals instead.
	const [playbookNamePromptState, setPlaybookNamePromptState] = useState<{
		initialValue: string;
		title: string;
		submitLabel: string;
	} | null>(null);
	const [playbookNameDraft, setPlaybookNameDraft] = useState('');
	const [confirmDeletePlaybookState, setConfirmDeletePlaybookState] = useState<Playbook | null>(
		null
	);
	// Transient error banner shown at the top of the sheet when a save/delete
	// operation fails. On mobile, haptics alone aren't enough feedback: they
	// may be disabled, and a failed save otherwise looks identical to success.
	const [playbookActionError, setPlaybookActionError] = useState<string | null>(null);
	const playbookActionErrorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		return () => {
			if (playbookActionErrorTimerRef.current) {
				clearTimeout(playbookActionErrorTimerRef.current);
			}
		};
	}, []);
	const showPlaybookActionError = useCallback((message: string) => {
		setPlaybookActionError(message);
		if (playbookActionErrorTimerRef.current) {
			clearTimeout(playbookActionErrorTimerRef.current);
		}
		playbookActionErrorTimerRef.current = setTimeout(() => {
			setPlaybookActionError(null);
		}, 4000);
	}, []);

	// Resolve the currently-loaded playbook. Used to detect modifications and
	// to switch the "Save Playbook" button between Create / Update modes.
	const activePlaybook: Playbook | null =
		(activePlaybookId && playbooks.find((p) => p.id === activePlaybookId)) || null;
	const isPlaybookModified = (() => {
		if (!activePlaybook) return false;
		const currentDocs = Array.from(selectedFiles).sort();
		const playbookDocs = activePlaybook.documents.map((d) => d.filename).sort();
		if (currentDocs.length !== playbookDocs.length) return true;
		if (currentDocs.some((f, i) => f !== playbookDocs[i])) return true;
		if (prompt !== activePlaybook.prompt) return true;
		if (loopEnabled !== activePlaybook.loopEnabled) return true;
		if (loopEnabled && (activePlaybook.maxLoops ?? null) !== maxLoops) return true;
		return false;
	})();

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsVisible(false);
		setTimeout(() => onClose(), 300);
	}, [onClose]);

	// Tracks the session whose `selectedFiles` have already been initialized
	// from a non-empty documents list. Used to distinguish "first-time docs
	// arriving for this session" (auto-select all) from "docs re-fetched"
	// (keep user intent; just intersect stale entries out).
	const initializedForSessionRef = useRef<string | null>(null);

	// Full reset on session change only. If we also gated on `documents`, any
	// parent re-render that produced a new array reference (refresh, file-watcher
	// event, even an identical re-fetch) would silently wipe the user's prompt,
	// loop settings, and the just-loaded playbook id.
	useEffect(() => {
		setPrompt('');
		setLoopEnabled(false);
		setMaxLoops(3);
		setActivePlaybookId(null);
		// Clear selections and the init flag so the next documents effect re-seeds
		// selectedFiles from whatever the *new* session has (matching pre-fix
		// behavior of "switch session → all docs selected by default").
		setSelectedFiles(new Set());
		initializedForSessionRef.current = null;
	}, [sessionId]);

	// Handle documents list changes within a session.
	//   - First non-empty docs arrival for this session: auto-select all docs
	//     (the canonical "launch the whole playbook" default). This covers the
	//     async-load case where the parent initially renders with empty docs.
	//   - Subsequent changes (rename, delete, refresh): intersect current
	//     selections with what still exists. Leave prompt / loop / playbook id
	//     untouched — a new `documents` reference must not wipe a loaded draft.
	useEffect(() => {
		const available = new Set(documents.map((d) => d.path || d.filename));
		if (initializedForSessionRef.current !== sessionId && available.size > 0) {
			initializedForSessionRef.current = sessionId;
			setSelectedFiles(available);
			return;
		}
		setSelectedFiles((prev) => {
			let changed = false;
			const next = new Set<string>();
			for (const key of prev) {
				if (available.has(key)) {
					next.add(key);
				} else {
					changed = true;
				}
			}
			return changed ? next : prev;
		});
	}, [documents, sessionId]);

	// Load saved playbooks once when the sheet opens for this session.
	useEffect(() => {
		void loadPlaybooks(sessionId);
	}, [sessionId, loadPlaybooks]);

	// Animate in on mount
	useEffect(() => {
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	// Escape handling — route to the top-most overlay first so pressing Escape
	// inside the playbook-name prompt or the delete-confirmation dialog only
	// dismisses that modal, not the whole setup sheet. Without this, the
	// document-level listener would unconditionally tear the sheet down.
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key !== 'Escape') return;
			if (playbookNamePromptState) {
				setPlaybookNamePromptState(null);
				return;
			}
			if (confirmDeletePlaybookState) {
				setConfirmDeletePlaybookState(null);
				return;
			}
			handleClose();
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [handleClose, playbookNamePromptState, confirmDeletePlaybookState]);

	const handleBackdropTap = useCallback(
		(e: React.MouseEvent) => {
			if (e.target === e.currentTarget) {
				handleClose();
			}
		},
		[handleClose]
	);

	const handleToggleFile = useCallback((filename: string) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setSelectedFiles((prev) => {
			const next = new Set(prev);
			if (next.has(filename)) {
				next.delete(filename);
			} else {
				next.add(filename);
			}
			return next;
		});
	}, []);

	const handleToggleAll = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		if (selectedFiles.size === documents.length) {
			setSelectedFiles(new Set());
		} else {
			setSelectedFiles(new Set(documents.map((d) => d.path || d.filename)));
		}
	}, [selectedFiles.size, documents]);

	const handleLoopToggle = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setLoopEnabled((prev) => !prev);
	}, []);

	const handleMaxLoopsChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		const value = parseInt(e.target.value, 10);
		if (!isNaN(value)) {
			setMaxLoops(Math.max(1, Math.min(100, value)));
		}
	}, []);

	const handleLaunch = useCallback(() => {
		if (selectedFiles.size === 0) return;
		triggerHaptic(HAPTIC_PATTERNS.success);
		const config: LaunchConfig = {
			documents: Array.from(selectedFiles).map((filename) => ({ filename })),
			prompt: prompt.trim() || undefined,
			loopEnabled: loopEnabled || undefined,
			maxLoops: loopEnabled ? maxLoops : undefined,
		};
		onLaunch(config);
	}, [selectedFiles, prompt, loopEnabled, maxLoops, onLaunch]);

	const handleSelectPlaybook = useCallback(
		(playbook: Playbook) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			setActivePlaybookId(playbook.id);
			// A playbook may reference documents that no longer exist (renamed,
			// deleted, or the user switched sessions). Intersect with the
			// currently-available docs so we never pre-select a stale name and
			// silently launch an Auto Run against a file that isn't there.
			const availableKeys = new Set(documents.map((d) => d.path || d.filename));
			setSelectedFiles(
				new Set(playbook.documents.map((d) => d.filename).filter((f) => availableKeys.has(f)))
			);
			setPrompt(playbook.prompt);
			setLoopEnabled(playbook.loopEnabled);
			setMaxLoops(playbook.maxLoops ?? 3);
		},
		[documents]
	);

	// Open the playbook-name prompt overlay. The actual save fires from
	// handlePlaybookNameSubmit once the user confirms a non-empty name.
	const handleSavePlaybook = useCallback(() => {
		if (selectedFiles.size === 0) return;
		const isUpdate = activePlaybook !== null;
		const proposedName = isUpdate ? activePlaybook!.name : '';
		setPlaybookNameDraft(proposedName);
		setPlaybookNamePromptState({
			initialValue: proposedName,
			title: isUpdate ? `Update "${activePlaybook!.name}"?` : 'Name this playbook',
			submitLabel: isUpdate ? 'Update' : 'Save',
		});
	}, [activePlaybook, selectedFiles.size]);

	const handlePlaybookNamePromptCancel = useCallback(() => {
		setPlaybookNamePromptState(null);
	}, []);

	const handlePlaybookNamePromptSubmit = useCallback(async () => {
		const trimmed = playbookNameDraft.trim();
		if (!trimmed) return;
		setPlaybookNamePromptState(null);
		const isUpdate = activePlaybook !== null;
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsSavingPlaybook(true);
		try {
			const draft = {
				name: trimmed,
				documents: Array.from(selectedFiles).map((filename) => ({
					filename,
					resetOnCompletion: false,
				})),
				loopEnabled,
				maxLoops: loopEnabled ? maxLoops : null,
				prompt: prompt.trim(),
			};
			let saved: Playbook | null;
			if (isUpdate) {
				saved = await updatePlaybook(sessionId, activePlaybook!.id, draft);
			} else {
				saved = await createPlaybook(sessionId, draft);
			}
			if (saved) {
				setActivePlaybookId(saved.id);
				triggerHaptic(HAPTIC_PATTERNS.success);
			} else {
				triggerHaptic(HAPTIC_PATTERNS.error);
				showPlaybookActionError(
					isUpdate ? 'Failed to update playbook.' : 'Failed to save playbook.'
				);
			}
		} finally {
			setIsSavingPlaybook(false);
		}
	}, [
		activePlaybook,
		createPlaybook,
		loopEnabled,
		maxLoops,
		playbookNameDraft,
		prompt,
		selectedFiles,
		sessionId,
		showPlaybookActionError,
		updatePlaybook,
	]);

	// Open the delete-confirmation overlay. Firing the actual delete is deferred
	// to handleConfirmDelete once the user taps Confirm in the in-sheet modal.
	const handleDeletePlaybook = useCallback((playbook: Playbook) => {
		setConfirmDeletePlaybookState(playbook);
	}, []);

	const handleConfirmDeleteCancel = useCallback(() => {
		setConfirmDeletePlaybookState(null);
	}, []);

	const handleConfirmDeleteSubmit = useCallback(async () => {
		const playbook = confirmDeletePlaybookState;
		if (!playbook) return;
		setConfirmDeletePlaybookState(null);
		triggerHaptic(HAPTIC_PATTERNS.tap);
		const success = await deletePlaybook(sessionId, playbook.id);
		if (success) {
			if (activePlaybookId === playbook.id) {
				setActivePlaybookId(null);
			}
		} else {
			triggerHaptic(HAPTIC_PATTERNS.error);
			showPlaybookActionError(`Failed to delete "${playbook.name}".`);
		}
	}, [
		activePlaybookId,
		confirmDeletePlaybookState,
		deletePlaybook,
		sessionId,
		showPlaybookActionError,
	]);

	const allSelected = selectedFiles.size === documents.length && documents.length > 0;

	return (
		<div
			onClick={handleBackdropTap}
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: `rgba(0, 0, 0, ${isVisible ? 0.5 : 0})`,
				zIndex: 220,
				display: 'flex',
				alignItems: 'flex-end',
				transition: 'background-color 0.3s ease-out',
			}}
		>
			{/* Sheet */}
			<div
				ref={sheetRef}
				style={{
					width: '100%',
					maxHeight: '80vh',
					backgroundColor: colors.bgMain,
					borderTopLeftRadius: '16px',
					borderTopRightRadius: '16px',
					display: 'flex',
					flexDirection: 'column',
					transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
					transition: 'transform 0.3s ease-out',
					paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
				}}
			>
				{/* Drag handle */}
				<div
					style={{
						display: 'flex',
						justifyContent: 'center',
						padding: '10px 0 4px',
						flexShrink: 0,
					}}
				>
					<div
						style={{
							width: '36px',
							height: '4px',
							borderRadius: '2px',
							backgroundColor: `${colors.textDim}40`,
						}}
					/>
				</div>

				{/* Header */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '8px 16px 12px',
						flexShrink: 0,
					}}
				>
					<h2
						style={{
							fontSize: '18px',
							fontWeight: 600,
							margin: 0,
							color: colors.textMain,
						}}
					>
						Configure Auto Run
					</h2>
					<button
						onClick={handleClose}
						style={{
							width: '44px',
							height: '44px',
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							borderRadius: '8px',
							backgroundColor: colors.bgSidebar,
							border: `1px solid ${colors.border}`,
							color: colors.textMain,
							cursor: 'pointer',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
						aria-label="Close setup sheet"
					>
						<svg
							width="18"
							height="18"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</svg>
					</button>
				</div>

				{/* Transient error banner for failed save/delete — haptics alone
				    aren't enough feedback on mobile (may be disabled), so surface
				    the failure visibly for a few seconds. */}
				{playbookActionError && (
					<div
						role="alert"
						style={{
							margin: '0 16px 8px',
							padding: '10px 12px',
							borderRadius: '10px',
							backgroundColor: `${colors.error}20`,
							border: `1px solid ${colors.error}`,
							color: colors.error,
							fontSize: '13px',
							fontWeight: 500,
							flexShrink: 0,
						}}
					>
						{playbookActionError}
					</div>
				)}

				{/* Scrollable content */}
				<div
					style={{
						flex: 1,
						overflowY: 'auto',
						overflowX: 'hidden',
						padding: '0 16px',
					}}
				>
					{/* Playbooks section — collapsible. Surfaces saved configurations
					    so the mobile launch flow has parity with the desktop's playbook
					    list (load / save / update / delete). */}
					<div style={{ marginBottom: '20px' }}>
						<button
							onClick={() => {
								triggerHaptic(HAPTIC_PATTERNS.tap);
								setShowPlaybooks((p) => !p);
							}}
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								width: '100%',
								background: 'none',
								border: 'none',
								padding: '4px 0',
								cursor: 'pointer',
								marginBottom: '10px',
							}}
							aria-expanded={showPlaybooks}
							aria-label="Toggle playbooks panel"
						>
							<span
								style={{
									fontSize: '13px',
									fontWeight: 600,
									color: colors.textDim,
									textTransform: 'uppercase',
									letterSpacing: '0.5px',
								}}
							>
								Playbooks
								{playbooks.length > 0 && (
									<span
										style={{
											marginLeft: '6px',
											padding: '2px 6px',
											borderRadius: '10px',
											backgroundColor: `${colors.accent}25`,
											color: colors.accent,
											fontSize: '11px',
											fontWeight: 600,
										}}
									>
										{playbooks.length}
									</span>
								)}
							</span>
							<svg
								width="16"
								height="16"
								viewBox="0 0 24 24"
								fill="none"
								stroke={colors.textDim}
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								style={{
									transform: showPlaybooks ? 'rotate(180deg)' : 'rotate(0deg)',
									transition: 'transform 0.2s ease',
								}}
							>
								<polyline points="6 9 12 15 18 9" />
							</svg>
						</button>

						{showPlaybooks && (
							<>
								{isLoadingPlaybooks ? (
									<div
										style={{
											padding: '12px 14px',
											fontSize: '13px',
											color: colors.textDim,
										}}
									>
										Loading playbooks...
									</div>
								) : playbooks.length === 0 ? (
									<div
										style={{
											padding: '12px 14px',
											borderRadius: '10px',
											border: `1px dashed ${colors.border}`,
											fontSize: '13px',
											color: colors.textDim,
											textAlign: 'center',
										}}
									>
										No saved playbooks. Configure documents below and tap "Save Playbook" to create
										one.
									</div>
								) : (
									<div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
										{playbooks.map((playbook) => {
											const isActive = playbook.id === activePlaybookId;
											return (
												<div
													key={playbook.id}
													style={{
														display: 'flex',
														alignItems: 'center',
														gap: '8px',
														padding: '10px 12px',
														borderRadius: '10px',
														border: `1px solid ${isActive ? colors.accent : colors.border}`,
														backgroundColor: isActive ? `${colors.accent}10` : colors.bgSidebar,
													}}
												>
													<button
														onClick={() => handleSelectPlaybook(playbook)}
														style={{
															flex: 1,
															minWidth: 0,
															display: 'flex',
															flexDirection: 'column',
															alignItems: 'flex-start',
															gap: '2px',
															background: 'none',
															border: 'none',
															padding: 0,
															color: colors.textMain,
															cursor: 'pointer',
															touchAction: 'manipulation',
															WebkitTapHighlightColor: 'transparent',
															textAlign: 'left',
														}}
														aria-label={`Load playbook ${playbook.name}`}
														aria-pressed={isActive}
													>
														<span
															style={{
																fontSize: '14px',
																fontWeight: 600,
																overflow: 'hidden',
																textOverflow: 'ellipsis',
																whiteSpace: 'nowrap',
																maxWidth: '100%',
															}}
														>
															{playbook.name}
														</span>
														<span style={{ fontSize: '11px', color: colors.textDim }}>
															{playbook.documents.length}{' '}
															{playbook.documents.length === 1 ? 'doc' : 'docs'}
															{playbook.loopEnabled
																? ` · loop${
																		playbook.maxLoops != null ? ` ×${playbook.maxLoops}` : ''
																	}`
																: ''}
														</span>
													</button>
													<button
														onClick={() => handleDeletePlaybook(playbook)}
														style={{
															width: '32px',
															height: '32px',
															display: 'flex',
															alignItems: 'center',
															justifyContent: 'center',
															borderRadius: '8px',
															backgroundColor: 'transparent',
															border: `1px solid ${colors.border}`,
															color: colors.textDim,
															cursor: 'pointer',
															flexShrink: 0,
															touchAction: 'manipulation',
															WebkitTapHighlightColor: 'transparent',
														}}
														aria-label={`Delete playbook ${playbook.name}`}
														title="Delete playbook"
													>
														<svg
															width="14"
															height="14"
															viewBox="0 0 24 24"
															fill="none"
															stroke="currentColor"
															strokeWidth="2"
															strokeLinecap="round"
															strokeLinejoin="round"
														>
															<polyline points="3 6 5 6 21 6" />
															<path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
															<path d="M10 11v6" />
															<path d="M14 11v6" />
															<path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
														</svg>
													</button>
												</div>
											);
										})}
									</div>
								)}
								<button
									onClick={handleSavePlaybook}
									disabled={selectedFiles.size === 0 || isSavingPlaybook}
									style={{
										marginTop: '10px',
										width: '100%',
										padding: '10px 14px',
										borderRadius: '10px',
										border: `1px solid ${colors.accent}`,
										backgroundColor: 'transparent',
										color: colors.accent,
										fontSize: '13px',
										fontWeight: 600,
										cursor:
											selectedFiles.size === 0 || isSavingPlaybook ? 'not-allowed' : 'pointer',
										opacity: selectedFiles.size === 0 || isSavingPlaybook ? 0.5 : 1,
										touchAction: 'manipulation',
										WebkitTapHighlightColor: 'transparent',
									}}
									aria-label={
										activePlaybook
											? `Update playbook ${activePlaybook.name}`
											: 'Save current configuration as playbook'
									}
								>
									{isSavingPlaybook
										? 'Saving...'
										: activePlaybook
											? isPlaybookModified
												? `Update "${activePlaybook.name}"`
												: `Saved as "${activePlaybook.name}"`
											: 'Save as Playbook'}
								</button>
							</>
						)}
					</div>

					{/* Document selector section */}
					<div style={{ marginBottom: '20px' }}>
						{/* Section label + Select All toggle */}
						<div
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								marginBottom: '10px',
							}}
						>
							<span
								style={{
									fontSize: '13px',
									fontWeight: 600,
									color: colors.textDim,
									textTransform: 'uppercase',
									letterSpacing: '0.5px',
								}}
							>
								Documents
							</span>
							<button
								onClick={handleToggleAll}
								style={{
									background: 'none',
									border: 'none',
									color: colors.accent,
									fontSize: '13px',
									fontWeight: 500,
									cursor: 'pointer',
									padding: '4px 8px',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
								}}
							>
								{allSelected ? 'Deselect All' : 'Select All'}
							</button>
						</div>

						{/* Document checkbox list */}
						<div
							style={{
								display: 'flex',
								flexDirection: 'column',
								gap: '6px',
							}}
						>
							{documents.map((doc) => {
								const docKey = doc.path || doc.filename;
								const isSelected = selectedFiles.has(docKey);
								return (
									<button
										key={docKey}
										onClick={() => handleToggleFile(docKey)}
										style={{
											display: 'flex',
											alignItems: 'center',
											gap: '12px',
											padding: '12px 14px',
											borderRadius: '10px',
											border: `1px solid ${isSelected ? colors.accent : colors.border}`,
											backgroundColor: isSelected ? `${colors.accent}10` : colors.bgSidebar,
											color: colors.textMain,
											width: '100%',
											textAlign: 'left',
											cursor: 'pointer',
											touchAction: 'manipulation',
											WebkitTapHighlightColor: 'transparent',
											outline: 'none',
											minHeight: '44px',
										}}
										aria-label={`${isSelected ? 'Deselect' : 'Select'} ${doc.filename}`}
										aria-pressed={isSelected}
									>
										{/* Checkbox */}
										<div
											style={{
												width: '22px',
												height: '22px',
												borderRadius: '6px',
												border: `2px solid ${isSelected ? colors.accent : colors.textDim}`,
												backgroundColor: isSelected ? colors.accent : 'transparent',
												display: 'flex',
												alignItems: 'center',
												justifyContent: 'center',
												flexShrink: 0,
												transition: 'all 0.15s ease',
											}}
										>
											{isSelected && (
												<svg
													width="14"
													height="14"
													viewBox="0 0 24 24"
													fill="none"
													stroke="white"
													strokeWidth="3"
													strokeLinecap="round"
													strokeLinejoin="round"
												>
													<polyline points="20 6 9 17 4 12" />
												</svg>
											)}
										</div>

										{/* File info */}
										<div style={{ flex: 1, minWidth: 0 }}>
											<div
												style={{
													fontSize: '14px',
													fontWeight: 500,
													overflow: 'hidden',
													textOverflow: 'ellipsis',
													whiteSpace: 'nowrap',
												}}
											>
												{doc.filename}
											</div>
											<div
												style={{
													fontSize: '12px',
													color: colors.textDim,
													marginTop: '2px',
												}}
											>
												{doc.taskCount} {doc.taskCount === 1 ? 'task' : 'tasks'}
											</div>
										</div>
									</button>
								);
							})}
						</div>
					</div>

					{/* Prompt input section */}
					<div style={{ marginBottom: '20px' }}>
						<label
							style={{
								display: 'block',
								fontSize: '13px',
								fontWeight: 600,
								color: colors.textDim,
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
								marginBottom: '8px',
							}}
						>
							Custom Prompt (optional)
						</label>
						<textarea
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							placeholder="Additional instructions for the agent..."
							rows={3}
							style={{
								width: '100%',
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								color: colors.textMain,
								fontSize: '14px',
								lineHeight: 1.5,
								resize: 'vertical',
								outline: 'none',
								fontFamily: 'inherit',
								WebkitAppearance: 'none',
								boxSizing: 'border-box',
							}}
							onFocus={(e) => {
								(e.target as HTMLTextAreaElement).style.borderColor = colors.accent;
							}}
							onBlur={(e) => {
								(e.target as HTMLTextAreaElement).style.borderColor = colors.border;
							}}
						/>
					</div>

					{/* Loop settings section */}
					<div style={{ marginBottom: '20px' }}>
						<label
							style={{
								display: 'block',
								fontSize: '13px',
								fontWeight: 600,
								color: colors.textDim,
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
								marginBottom: '10px',
							}}
						>
							Loop Settings
						</label>

						{/* Loop toggle */}
						<button
							onClick={handleLoopToggle}
							style={{
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'space-between',
								width: '100%',
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								color: colors.textMain,
								cursor: 'pointer',
								touchAction: 'manipulation',
								WebkitTapHighlightColor: 'transparent',
								outline: 'none',
								minHeight: '44px',
							}}
							role="switch"
							aria-checked={loopEnabled}
							aria-label="Loop on completion"
						>
							<span style={{ fontSize: '14px', fontWeight: 500 }}>Loop on completion</span>
							{/* Toggle switch */}
							<div
								style={{
									width: '44px',
									height: '26px',
									borderRadius: '13px',
									backgroundColor: loopEnabled ? colors.accent : `${colors.textDim}30`,
									padding: '2px',
									transition: 'background-color 0.2s ease',
									flexShrink: 0,
								}}
							>
								<div
									style={{
										width: '22px',
										height: '22px',
										borderRadius: '11px',
										backgroundColor: 'white',
										transition: 'transform 0.2s ease',
										transform: loopEnabled ? 'translateX(18px)' : 'translateX(0)',
										boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
									}}
								/>
							</div>
						</button>

						{/* Max loops input (visible when loop enabled) */}
						{loopEnabled && (
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'space-between',
									padding: '12px 14px',
									borderRadius: '10px',
									border: `1px solid ${colors.border}`,
									backgroundColor: colors.bgSidebar,
									marginTop: '8px',
								}}
							>
								<span
									style={{
										fontSize: '14px',
										color: colors.textMain,
										fontWeight: 500,
									}}
								>
									Max loops
								</span>
								<input
									type="number"
									value={maxLoops}
									onChange={handleMaxLoopsChange}
									min={1}
									max={100}
									style={{
										width: '70px',
										padding: '8px 10px',
										borderRadius: '8px',
										border: `1px solid ${colors.border}`,
										backgroundColor: colors.bgMain,
										color: colors.textMain,
										fontSize: '14px',
										textAlign: 'center',
										outline: 'none',
										WebkitAppearance: 'none',
										MozAppearance: 'textfield' as never,
									}}
								/>
							</div>
						)}
					</div>
				</div>

				{/* Launch button */}
				<div
					style={{
						padding: '12px 16px 0',
						flexShrink: 0,
					}}
				>
					<button
						onClick={handleLaunch}
						disabled={selectedFiles.size === 0}
						style={{
							width: '100%',
							padding: '14px 20px',
							borderRadius: '12px',
							backgroundColor: selectedFiles.size === 0 ? `${colors.accent}40` : colors.accent,
							border: 'none',
							color: 'white',
							fontSize: '16px',
							fontWeight: 600,
							cursor: selectedFiles.size === 0 ? 'not-allowed' : 'pointer',
							opacity: selectedFiles.size === 0 ? 0.5 : 1,
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							minHeight: '50px',
							transition: 'all 0.15s ease',
						}}
						aria-label="Launch Auto Run"
					>
						Launch Auto Run
					</button>
				</div>
			</div>

			{/* Playbook-name prompt overlay. Rendered above the sheet so it
			    covers the whole screen on mobile and doesn't depend on
			    `window.prompt`, which is unreliable in mobile WebViews. */}
			{playbookNamePromptState && (
				<div
					onClick={(e) => {
						if (e.target === e.currentTarget) handlePlaybookNamePromptCancel();
					}}
					style={{
						position: 'fixed',
						top: 0,
						left: 0,
						right: 0,
						bottom: 0,
						backgroundColor: 'rgba(0, 0, 0, 0.6)',
						zIndex: 230,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: '16px',
					}}
					role="presentation"
				>
					<div
						role="dialog"
						aria-modal="true"
						aria-label="Name this playbook"
						style={{
							width: '100%',
							maxWidth: '400px',
							backgroundColor: colors.bgMain,
							borderRadius: '12px',
							padding: '16px',
							display: 'flex',
							flexDirection: 'column',
							gap: '12px',
						}}
					>
						<h3
							style={{
								margin: 0,
								fontSize: '16px',
								fontWeight: 600,
								color: colors.textMain,
							}}
						>
							{playbookNamePromptState.title}
						</h3>
						<input
							type="text"
							autoFocus
							value={playbookNameDraft}
							onChange={(e) => setPlaybookNameDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									void handlePlaybookNamePromptSubmit();
								}
								// Escape is handled by the document-level listener so it can
								// route to the topmost overlay consistently (delete-confirm
								// modal or this prompt) without closing the whole sheet.
							}}
							placeholder="Playbook name"
							style={{
								width: '100%',
								padding: '12px 14px',
								borderRadius: '10px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								color: colors.textMain,
								fontSize: '15px',
								outline: 'none',
								WebkitAppearance: 'none',
								boxSizing: 'border-box',
							}}
						/>
						<div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
							<button
								onClick={handlePlaybookNamePromptCancel}
								style={{
									padding: '10px 16px',
									borderRadius: '10px',
									backgroundColor: 'transparent',
									border: `1px solid ${colors.border}`,
									color: colors.textMain,
									fontSize: '14px',
									fontWeight: 500,
									cursor: 'pointer',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
								}}
							>
								Cancel
							</button>
							<button
								onClick={() => void handlePlaybookNamePromptSubmit()}
								disabled={!playbookNameDraft.trim()}
								style={{
									padding: '10px 16px',
									borderRadius: '10px',
									backgroundColor: playbookNameDraft.trim() ? colors.accent : `${colors.accent}40`,
									border: 'none',
									color: 'white',
									fontSize: '14px',
									fontWeight: 600,
									cursor: playbookNameDraft.trim() ? 'pointer' : 'not-allowed',
									opacity: playbookNameDraft.trim() ? 1 : 0.5,
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
								}}
							>
								{playbookNamePromptState.submitLabel}
							</button>
						</div>
					</div>
				</div>
			)}

			{/* Delete-confirmation overlay. Same rationale as the prompt overlay —
			    avoids `window.confirm`, which gets blocked on iOS Safari after
			    repeated use and is stubbed to a no-op in some embedded WebViews. */}
			{confirmDeletePlaybookState && (
				<div
					onClick={(e) => {
						if (e.target === e.currentTarget) handleConfirmDeleteCancel();
					}}
					style={{
						position: 'fixed',
						top: 0,
						left: 0,
						right: 0,
						bottom: 0,
						backgroundColor: 'rgba(0, 0, 0, 0.6)',
						zIndex: 230,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						padding: '16px',
					}}
					role="presentation"
				>
					<div
						role="dialog"
						aria-modal="true"
						aria-label="Delete playbook"
						style={{
							width: '100%',
							maxWidth: '400px',
							backgroundColor: colors.bgMain,
							borderRadius: '12px',
							padding: '16px',
							display: 'flex',
							flexDirection: 'column',
							gap: '12px',
						}}
					>
						<h3
							style={{
								margin: 0,
								fontSize: '16px',
								fontWeight: 600,
								color: colors.textMain,
							}}
						>
							Delete &quot;{confirmDeletePlaybookState.name}&quot;?
						</h3>
						<p style={{ margin: 0, fontSize: '14px', color: colors.textDim }}>
							This can&apos;t be undone.
						</p>
						<div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
							<button
								onClick={handleConfirmDeleteCancel}
								style={{
									padding: '10px 16px',
									borderRadius: '10px',
									backgroundColor: 'transparent',
									border: `1px solid ${colors.border}`,
									color: colors.textMain,
									fontSize: '14px',
									fontWeight: 500,
									cursor: 'pointer',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
								}}
							>
								Cancel
							</button>
							<button
								onClick={() => void handleConfirmDeleteSubmit()}
								style={{
									padding: '10px 16px',
									borderRadius: '10px',
									backgroundColor: colors.error,
									border: 'none',
									color: 'white',
									fontSize: '14px',
									fontWeight: 600,
									cursor: 'pointer',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
								}}
							>
								Delete
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

export default AutoRunSetupSheet;
