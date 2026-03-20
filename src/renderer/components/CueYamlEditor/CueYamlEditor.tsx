/**
 * CueYamlEditor — Modal for editing .maestro/cue.yaml configuration.
 *
 * Thin shell: load/save, validation, modal coordination.
 * Sub-components handle YAML editing, AI chat, and pattern browsing.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle, XCircle, Zap } from 'lucide-react';
import type { CuePattern } from '../../constants/cuePatterns';
import { Modal, ModalFooter } from '../ui/Modal';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { useSessionStore, selectSessionById } from '../../stores/sessionStore';
import type { Theme } from '../../types';
import { CUE_COLOR } from '../../../shared/cue-pipeline-types';
import { CUE_YAML_TEMPLATE } from '../../constants/cueYamlDefaults';
import { useCueAiChat } from '../../hooks/cue/useCueAiChat';
import { PatternPicker } from './PatternPicker';
import { PatternPreviewModal } from './PatternPreviewModal';
import { CueAiChat } from './CueAiChat';
import { YamlTextEditor } from './YamlTextEditor';

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

	// Load existing YAML on mount
	useEffect(() => {
		if (!isOpen) return;
		let cancelled = false;

		async function loadYaml() {
			setLoading(true);
			try {
				const content = await window.maestro.cue.readYaml(projectRoot);
				if (cancelled) return;
				const initial = content ?? CUE_YAML_TEMPLATE;
				setYamlContent(initial);
				setOriginalContent(initial);
				try {
					const validationResult = await window.maestro.cue.validateYaml(initial);
					if (!cancelled) {
						setIsValid(validationResult.valid);
						setValidationErrors(validationResult.errors);
					}
				} catch {
					// Validation failure on load is non-fatal
				}
			} catch {
				if (cancelled) return;
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
				const result = await window.maestro.cue.validateYaml(content);
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
		try {
			await window.maestro.cue.writeYaml(projectRoot, yamlContent);
			await window.maestro.cue.refreshSession(sessionId, projectRoot);
			onClose();
		} catch {
			// Let Sentry capture unexpected errors
		}
	}, [isValid, projectRoot, yamlContent, sessionId, onClose]);

	const handleClose = useCallback(() => {
		const isDirty = yamlContent !== originalContent;
		if (isDirty) {
			const confirmed = window.confirm('You have unsaved changes. Discard them?');
			if (!confirmed) return;
		}
		onClose();
	}, [yamlContent, originalContent, onClose]);

	// Pattern preview state
	const [previewPattern, setPreviewPattern] = useState<CuePattern | null>(null);

	const refreshYamlFromDisk = useCallback(async () => {
		try {
			const content = await window.maestro.cue.readYaml(projectRoot);
			if (content) {
				setYamlContent(content);
				setOriginalContent(content);
				try {
					const result = await window.maestro.cue.validateYaml(content);
					setIsValid(result.valid);
					setValidationErrors(result.errors);
				} catch {
					// non-fatal
				}
			}
		} catch {
			// non-fatal
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

	if (!isOpen) return null;

	const isDirty = yamlContent !== originalContent;

	return (
		<>
			<Modal
				theme={theme}
				title={`Edit .maestro/cue.yaml${session?.name ? ` — ${session.name}` : ''}`}
				priority={MODAL_PRIORITIES.CUE_YAML_EDITOR}
				onClose={handleClose}
				width={1200}
				maxHeight="85vh"
				closeOnBackdropClick={false}
				headerIcon={<Zap className="w-4 h-4" style={{ color: CUE_COLOR }} />}
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
