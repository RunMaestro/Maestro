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

	// Reinitialize draft when sessionId or documents change.
	// Use the canonical doc path (which includes any subfolder prefix) so
	// duplicates across folders never collide.
	useEffect(() => {
		setSelectedFiles(new Set(documents.map((d) => d.path || d.filename)));
		setPrompt('');
		setLoopEnabled(false);
		setMaxLoops(3);
		setActivePlaybookId(null);
	}, [sessionId, documents]);

	// Load saved playbooks once when the sheet opens for this session.
	useEffect(() => {
		void loadPlaybooks(sessionId);
	}, [sessionId, loadPlaybooks]);

	// Animate in on mount
	useEffect(() => {
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	// Close on escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				handleClose();
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [handleClose]);

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

	const handleSelectPlaybook = useCallback((playbook: Playbook) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setActivePlaybookId(playbook.id);
		setSelectedFiles(new Set(playbook.documents.map((d) => d.filename)));
		setPrompt(playbook.prompt);
		setLoopEnabled(playbook.loopEnabled);
		setMaxLoops(playbook.maxLoops ?? 3);
	}, []);

	const handleSavePlaybook = useCallback(async () => {
		if (selectedFiles.size === 0) return;
		const isUpdate = activePlaybook !== null;
		const proposedName = isUpdate ? activePlaybook!.name : '';
		const name = window.prompt(
			isUpdate ? 'Update this playbook? You can rename it here:' : 'Name this playbook:',
			proposedName
		);
		if (!name || !name.trim()) return;
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsSavingPlaybook(true);
		try {
			const draft = {
				name: name.trim(),
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
			}
		} finally {
			setIsSavingPlaybook(false);
		}
	}, [
		activePlaybook,
		createPlaybook,
		loopEnabled,
		maxLoops,
		prompt,
		selectedFiles,
		sessionId,
		updatePlaybook,
	]);

	const handleDeletePlaybook = useCallback(
		async (playbook: Playbook) => {
			const confirmed = window.confirm(`Delete playbook "${playbook.name}"?`);
			if (!confirmed) return;
			triggerHaptic(HAPTIC_PATTERNS.tap);
			const success = await deletePlaybook(sessionId, playbook.id);
			if (success && activePlaybookId === playbook.id) {
				setActivePlaybookId(null);
			}
		},
		[activePlaybookId, deletePlaybook, sessionId]
	);

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
		</div>
	);
}

export default AutoRunSetupSheet;
