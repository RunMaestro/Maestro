/**
 * CueYamlEditor — Modal for editing .maestro/cue.yaml configuration.
 *
 * Thin shell: load/save, validation, modal coordination.
 * Sub-components handle YAML editing, AI chat, and pattern browsing.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, XCircle, Zap, LayoutDashboard, GitFork, X } from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
import type { CuePattern } from '../../constants/cuePatterns';
import { Modal, ModalFooter } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useSessionStore, selectSessionById } from '../../stores/sessionStore';
import { useModalStore, selectModalOpen, getModalActions } from '../../stores/modalStore';
import type { Theme } from '../../types';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { CUE_YAML_TEMPLATE } from '../../constants/cueYamlDefaults';
import { useCueAiChat } from '../../hooks/cue/useCueAiChat';
import { PatternPicker } from './PatternPicker';
import { PatternPreviewModal } from './PatternPreviewModal';
import { CueAiChat } from './CueAiChat';
import { YamlTextEditor } from './YamlTextEditor';
import { cueService } from '../../services/cue';
import { captureException } from '../../utils/sentry';

interface CueYamlEditorProps {
	isOpen: boolean;
	onClose: () => void;
	projectRoot: string;
	sessionId: string;
	theme: Theme;
}

export function CueYamlEditor({
	isOpen,
	onClose,
	projectRoot,
	sessionId,
	theme,
}: CueYamlEditorProps) {
	const [yamlContent, setYamlContent] = useState('');
	const [originalContent, setOriginalContent] = useState('');
	const [validationErrors, setValidationErrors] = useState<string[]>([]);
	const [isValid, setIsValid] = useState(true);
	const [loading, setLoading] = useState(true);

	const validateTimerRef = useRef<ReturnType<typeof setTimeout>>();

	const session = useSessionStore(selectSessionById(sessionId));

	// If the CueModal dashboard is NOT open, we were opened directly (e.g., from agent context menu).
	// In that case, show nav buttons to jump to Dashboard or Pipeline Editor.
	const cueModalOpen = useModalStore(selectModalOpen('cueModal'));
	const openedDirectly = !cueModalOpen;

	// Load existing YAML on mount
	useEffect(() => {
		if (!isOpen) return;
		let cancelled = false;

		async function loadYaml() {
			setLoading(true);
			try {
				const content = await cueService.readYaml(projectRoot);
				if (cancelled) return;
				const initial = content ?? CUE_YAML_TEMPLATE;
				setYamlContent(initial);
				setOriginalContent(initial);
				try {
					const validationResult = await cueService.validateYaml(initial);
					if (!cancelled) {
						setIsValid(validationResult.valid);
						setValidationErrors(validationResult.errors);
					}
				} catch (err: unknown) {
					// Gate the Save button when validation fails to actually run —
					// otherwise isValid keeps its initial `true` and the user
					// could save unvalidated YAML. Surface the error to telemetry
					// AND to the user via setValidationErrors so they know what
					// happened. Not re-thrown: the outer catch handles readYaml
					// failures, not validateYaml; consolidating recovery here.
					captureException(err, {
						extra: { operation: 'cueYamlEditor.loadValidate', projectRoot },
					});
					if (!cancelled) {
						setIsValid(false);
						setValidationErrors([
							`Failed to validate YAML: ${err instanceof Error ? err.message : String(err)}`,
						]);
					}
				}
			} catch (err: unknown) {
				if (cancelled) return;
				captureException(err, { extra: { operation: 'cueYamlEditor.loadRead', projectRoot } });
				setYamlContent(CUE_YAML_TEMPLATE);
				setOriginalContent(CUE_YAML_TEMPLATE);
			} finally {
				if (!cancelled) setLoading(false);
			}
		}

		loadYaml();
		return () => {
			cancelled = true;
		};
	}, [isOpen, projectRoot]);

	// Debounced validation
	const validateYaml = useCallback((content: string) => {
		if (validateTimerRef.current) {
			clearTimeout(validateTimerRef.current);
		}
		validateTimerRef.current = setTimeout(async () => {
			try {
				const result = await cueService.validateYaml(content);
				setIsValid(result.valid);
				setValidationErrors(result.errors);
			} catch {
				setIsValid(false);
				setValidationErrors(['Failed to validate YAML']);
			}
		}, 500);
	}, []);

	// Cleanup validation timer
	useEffect(() => {
		return () => {
			if (validateTimerRef.current) {
				clearTimeout(validateTimerRef.current);
			}
		};
	}, []);

	const handleYamlChange = useCallback(
		(value: string) => {
			setYamlContent(value);
			validateYaml(value);
		},
		[validateYaml]
	);

	const handleSave = useCallback(async () => {
		if (!isValid) return;
		await cueService.writeYaml(projectRoot, yamlContent);
		await cueService.refreshSession(sessionId, projectRoot);
		onClose();
	}, [isValid, projectRoot, yamlContent, sessionId, onClose]);

	// Pattern preview state
	const [previewPattern, setPreviewPattern] = useState<CuePattern | null>(null);

	const refreshYamlFromDisk = useCallback(async () => {
		try {
			const content = await cueService.readYaml(projectRoot);
			// `if (content)` would skip an intentionally empty YAML — an empty
			// string is a legitimate result (e.g. user cleared the file) and
			// should still trigger state updates and revalidation. Only skip
			// when the read returned null (no file on disk).
			if (content != null) {
				setYamlContent(content);
				setOriginalContent(content);
				try {
					const result = await cueService.validateYaml(content);
					setIsValid(result.valid);
					setValidationErrors(result.errors);
				} catch (err: unknown) {
					// Same gating as loadValidate: don't leave isValid=true after
					// a validation failure or the user could save unvalidated
					// content from a refresh.
					captureException(err, {
						extra: { operation: 'cueYamlEditor.refreshValidate', projectRoot },
					});
					setIsValid(false);
					setValidationErrors([
						`Failed to validate YAML: ${err instanceof Error ? err.message : String(err)}`,
					]);
				}
			}
		} catch (err: unknown) {
			captureException(err, { extra: { operation: 'cueYamlEditor.refreshRead', projectRoot } });
		}
	}, [projectRoot]);

	// AI chat hook
	const {
		chatMessages,
		chatInput,
		setChatInput,
		chatBusy,
		chatEndRef,
		handleChatSend,
		handleChatKeyDown,
	} = useCueAiChat({
		sessionId,
		projectRoot,
		isOpen,
		onYamlRefresh: refreshYamlFromDisk,
	});

	const handleNavigateToCueModal = useCallback(
		(tab: 'dashboard' | 'pipeline') => {
			if (chatBusy) {
				const confirmed = window.confirm(
					'AI assist is still working. Leave and cancel the operation?'
				);
				if (!confirmed) return;
			}
			const isDirty = yamlContent !== originalContent;
			if (isDirty) {
				const confirmed = window.confirm('You have unsaved changes. Discard them?');
				if (!confirmed) return;
			}
			onClose();
			getModalActions().openCueModalWithTab(tab);
		},
		[onClose, chatBusy, yamlContent, originalContent]
	);

	const handleClose = useCallback(() => {
		if (chatBusy) {
			const confirmed = window.confirm(
				'AI assist is still working. Close and cancel the operation?'
			);
			if (!confirmed) return;
		}
		const isDirty = yamlContent !== originalContent;
		if (isDirty) {
			const confirmed = window.confirm('You have unsaved changes. Discard them?');
			if (!confirmed) return;
		}
		onClose();
	}, [yamlContent, originalContent, chatBusy, onClose]);

	if (!isOpen) return null;

	const isDirty = yamlContent !== originalContent;
	const modalTitle = `Edit .maestro/cue.yaml${session?.name ? ` — ${session.name}` : ''}`;

	// Custom header with nav buttons when opened directly (not from CueModal)
	const directNavHeader = openedDirectly ? (
		<div
			className="p-4 border-b flex items-center justify-between shrink-0"
			style={{ borderColor: theme.colors.border }}
		>
			<div className="flex items-center gap-2">
				<Zap className="w-4 h-4" style={{ color: CUE_COLOR }} />
				<h2 className="text-sm font-bold" style={{ color: theme.colors.textMain }}>
					{modalTitle}
				</h2>

				{/* Nav buttons to jump to CueModal views */}
				<div
					className="flex items-center gap-1 ml-3 rounded-md p-0.5"
					style={{ backgroundColor: theme.colors.bgActivity }}
				>
					<button
						onClick={() => handleNavigateToCueModal('dashboard')}
						className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors hover:opacity-80"
						style={{ color: theme.colors.textDim }}
					>
						<LayoutDashboard className="w-3.5 h-3.5" />
						Dashboard
					</button>
					<button
						onClick={() => handleNavigateToCueModal('pipeline')}
						className="flex items-center gap-1.5 px-3 py-1 rounded text-xs font-medium transition-colors hover:opacity-80"
						style={{ color: theme.colors.textDim }}
					>
						<GitFork className="w-3.5 h-3.5" />
						Pipeline Editor
					</button>
				</div>
			</div>
			<GhostIconButton onClick={handleClose} ariaLabel="Close modal" color={theme.colors.textDim}>
				<X className="w-4 h-4" />
			</GhostIconButton>
		</div>
	) : undefined;

	return (
		<>
			<Modal
				theme={theme}
				title={modalTitle}
				priority={MODAL_PRIORITIES.CUE_YAML_EDITOR}
				onClose={handleClose}
				width={1200}
				maxHeight="85vh"
				closeOnBackdropClick={false}
				headerIcon={<Zap className="w-4 h-4" style={{ color: CUE_COLOR }} />}
				customHeader={directNavHeader}
				testId="cue-yaml-editor"
				footer={
					<div className="flex items-center justify-between w-full">
						<div className="flex items-center gap-2 text-xs">
							{isValid ? (
								<>
									<CheckCircle className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />
									<span style={{ color: theme.colors.success }}>Valid YAML</span>
								</>
							) : (
								<>
									<XCircle className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />
									<span style={{ color: theme.colors.error }}>
										{validationErrors.length} error{validationErrors.length !== 1 ? 's' : ''}
									</span>
								</>
							)}
						</div>
						<ModalFooter
							theme={theme}
							onCancel={handleClose}
							cancelLabel="Exit"
							onConfirm={handleSave}
							confirmLabel="Save"
							confirmDisabled={!isValid || !isDirty || chatBusy}
						/>
					</div>
				}
			>
				{loading ? (
					<div className="text-center py-12 text-sm" style={{ color: theme.colors.textDim }}>
						Loading YAML...
					</div>
				) : (
					<div className="flex gap-4" style={{ height: 'calc(85vh - 140px)', maxHeight: 600 }}>
						{/* Left side: Patterns + AI Chat (35%) */}
						<div className="flex flex-col gap-3 overflow-hidden" style={{ width: '35%' }}>
							<h3
								className="text-xs font-bold uppercase tracking-wider shrink-0"
								style={{ color: theme.colors.textDim }}
							>
								Start from a pattern
							</h3>
							<PatternPicker
								theme={theme}
								disabled={chatBusy}
								onSelect={(pattern) => setPreviewPattern(pattern)}
							/>

							<div
								className="w-full border-t shrink-0"
								style={{ borderColor: theme.colors.border }}
							/>

							<CueAiChat
								theme={theme}
								chatMessages={chatMessages}
								chatInput={chatInput}
								onChatInputChange={setChatInput}
								chatBusy={chatBusy}
								chatEndRef={chatEndRef}
								onSend={handleChatSend}
								onKeyDown={handleChatKeyDown}
							/>
						</div>

						{/* Divider */}
						<div
							className="w-px self-stretch shrink-0"
							style={{ backgroundColor: theme.colors.border }}
						/>

						{/* Right side: YAML editor (65%) */}
						<YamlTextEditor
							theme={theme}
							yamlContent={yamlContent}
							onYamlChange={handleYamlChange}
							readOnly={chatBusy}
							isValid={isValid}
							validationErrors={validationErrors}
						/>
					</div>
				)}
			</Modal>

			{/* Pattern preview modal */}
			{previewPattern && (
				<PatternPreviewModal
					pattern={previewPattern}
					theme={theme}
					onClose={() => setPreviewPattern(null)}
				/>
			)}
		</>
	);
}
