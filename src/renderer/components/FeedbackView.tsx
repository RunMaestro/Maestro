import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Loader2, X } from 'lucide-react';
import type { Theme, Session } from '../types';

interface FeedbackViewProps {
	theme: Theme;
	sessions: Session[];
	onCancel: () => void;
	onSubmitSuccess: (sessionId: string) => void;
}

interface FeedbackAuthState {
	checking: boolean;
	authenticated: boolean;
	message?: string;
}

interface FeedbackAttachment {
	id: string;
	name: string;
	dataUrl: string;
	sizeBytes: number;
}

type FeedbackCategory = 'bug_report' | 'feature_request' | 'improvement' | 'general_feedback';

const FEEDBACK_CATEGORY_OPTIONS: Array<{ value: FeedbackCategory; label: string }> = [
	{ value: 'bug_report', label: 'Bug report' },
	{ value: 'feature_request', label: 'Feature request' },
	{ value: 'improvement', label: 'Improvement' },
	{ value: 'general_feedback', label: 'General feedback' },
];

const MAX_SUMMARY_LENGTH = 120;
const MAX_FEEDBACK_LENGTH = 5000;
const CHAR_COUNT_WARNING_THRESHOLD = 4000;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function isRunningSession(session: Session): boolean {
	if (session.toolType === 'terminal') {
		return false;
	}

	return (
		session.state === 'idle' ||
		session.state === 'busy' ||
		session.state === 'waiting_input' ||
		session.state === 'connecting'
	);
}

function getSessionAgentSessionId(session: Session): string | null {
	const activeTab =
		session.aiTabs?.find((tab) => tab.id === session.activeTabId) ?? session.aiTabs?.[0];
	return activeTab?.agentSessionId || session.agentSessionId || null;
}

function formatAttachmentSize(sizeBytes: number): string {
	if (sizeBytes >= 1024 * 1024) {
		return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

function readFileAsDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result === 'string') {
				resolve(reader.result);
				return;
			}

			reject(new Error(`Unable to read ${file.name}.`));
		};
		reader.onerror = () => reject(new Error(`Unable to read ${file.name}.`));
		reader.readAsDataURL(file);
	});
}

export function FeedbackView({ theme, sessions, onCancel, onSubmitSuccess }: FeedbackViewProps) {
	const [category, setCategory] = useState<FeedbackCategory>('bug_report');
	const [summary, setSummary] = useState('');
	const [expectedBehavior, setExpectedBehavior] = useState('');
	const [details, setDetails] = useState('');
	const [reproductionSteps, setReproductionSteps] = useState('');
	const [additionalContext, setAdditionalContext] = useState('');
	const [selectedSessionId, setSelectedSessionId] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [activeProcessIds, setActiveProcessIds] = useState<Set<string>>(new Set());
	const [authState, setAuthState] = useState<FeedbackAuthState>({
		checking: true,
		authenticated: false,
	});
	const [submitError, setSubmitError] = useState('');
	const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);
	const [isDraggingAttachments, setIsDraggingAttachments] = useState(false);
	const fileInputRef = useRef<HTMLInputElement>(null);

	const feedbackTargets = useMemo(() => {
		return sessions
			.filter((session) => session.toolType !== 'terminal')
			.map((session) => ({
				session,
				isLive: activeProcessIds.has(session.id) && isRunningSession(session),
				agentSessionId: getSessionAgentSessionId(session),
			}))
			.filter((target) => target.isLive || Boolean(target.agentSessionId));
	}, [activeProcessIds, sessions]);

	const selectedTarget = useMemo(
		() => feedbackTargets.find((target) => target.session.id === selectedSessionId) ?? null,
		[feedbackTargets, selectedSessionId]
	);

	const refreshActiveProcesses = useCallback(async (): Promise<Set<string>> => {
		try {
			const processes = await window.maestro.process.getActiveProcesses();
			const nextIds = new Set(processes.map((process) => process.sessionId));
			setActiveProcessIds(nextIds);
			return nextIds;
		} catch {
			setActiveProcessIds(new Set());
			return new Set();
		}
	}, []);

	const authCheck = useCallback(async () => {
		setAuthState((prev) => ({ ...prev, checking: true, authenticated: false }));

		try {
			const result = await window.maestro.feedback.checkGhAuth();

			setAuthState({
				checking: false,
				authenticated: result.authenticated,
				message: result.message,
			});
		} catch (error) {
			setAuthState({
				checking: false,
				authenticated: false,
				message: error instanceof Error ? error.message : 'Unable to verify GitHub authentication.',
			});
		}
	}, []);

	const isSubmittingDisabled = submitting || authState.checking;
	const isFormDisabled = isSubmittingDisabled || !authState.authenticated;
	const isBugReport = category === 'bug_report';
	const expectedBehaviorLabel = isBugReport ? 'Expected Behavior' : 'Desired Outcome';
	const detailsLabel = isBugReport ? 'Actual Behavior' : 'Details';

	const canSubmit =
		!submitting &&
		selectedSessionId.length > 0 &&
		summary.trim().length > 0 &&
		expectedBehavior.trim().length > 0 &&
		details.trim().length > 0 &&
		(!isBugReport || reproductionSteps.trim().length > 0) &&
		Boolean(selectedTarget) &&
		authState.authenticated;

	useEffect(() => {
		void authCheck();
	}, [authCheck]);

	useEffect(() => {
		void refreshActiveProcesses();
	}, [refreshActiveProcesses, sessions]);

	useEffect(() => {
		if (feedbackTargets.length === 0) {
			setSelectedSessionId('');
			return;
		}

		if (!feedbackTargets.find((target) => target.session.id === selectedSessionId)) {
			setSelectedSessionId(feedbackTargets[0].session.id);
		}
	}, [feedbackTargets, selectedSessionId]);

	const addAttachmentFiles = useCallback(
		async (files: File[]) => {
			if (files.length === 0) {
				return;
			}

			const availableSlots = MAX_ATTACHMENTS - attachments.length;
			if (availableSlots <= 0) {
				setSubmitError(`You can attach up to ${MAX_ATTACHMENTS} screenshots.`);
				return;
			}

			const imageFiles = files
				.filter((file) => file.type.startsWith('image/'))
				.slice(0, availableSlots);
			if (imageFiles.length === 0) {
				setSubmitError('Only image files can be attached to feedback.');
				return;
			}

			const validFiles: File[] = [];
			for (const file of imageFiles) {
				if (file.size > MAX_ATTACHMENT_BYTES) {
					setSubmitError(`${file.name} is larger than 10 MB.`);
					continue;
				}

				validFiles.push(file);
			}

			if (validFiles.length === 0) {
				return;
			}

			try {
				const nextAttachments = await Promise.all(
					validFiles.map(async (file) => ({
						id: `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						name: file.name,
						dataUrl: await readFileAsDataUrl(file),
						sizeBytes: file.size,
					}))
				);

				setAttachments((prev) => [...prev, ...nextAttachments]);
				setSubmitError('');
			} catch (error) {
				setSubmitError(
					error instanceof Error ? error.message : 'Unable to read one or more screenshots.'
				);
			}
		},
		[attachments.length]
	);

	const handleAttachmentBrowse = useCallback(
		async (event: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(event.target.files || []);
			await addAttachmentFiles(files);
			event.target.value = '';
		},
		[addAttachmentFiles]
	);

	const handleAttachmentDrop = useCallback(
		async (event: React.DragEvent<HTMLDivElement>) => {
			event.preventDefault();
			setIsDraggingAttachments(false);

			if (isFormDisabled) {
				return;
			}

			await addAttachmentFiles(Array.from(event.dataTransfer.files));
		},
		[addAttachmentFiles, isFormDisabled]
	);

	const handleAttachmentDragOver = useCallback(
		(event: React.DragEvent<HTMLDivElement>) => {
			event.preventDefault();
			if (!isFormDisabled) {
				setIsDraggingAttachments(true);
			}
		},
		[isFormDisabled]
	);

	const handleAttachmentDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
		if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
			setIsDraggingAttachments(false);
		}
	}, []);

	const handleRemoveAttachment = useCallback((attachmentId: string) => {
		setAttachments((prev) => prev.filter((attachment) => attachment.id !== attachmentId));
	}, []);

	const handleSubmit = useCallback(async () => {
		if (!canSubmit) {
			return;
		}

		setSubmitError('');
		setSubmitting(true);

		try {
			const authResult = await window.maestro.feedback.checkGhAuth();
			setAuthState((prev) => ({
				...prev,
				checking: false,
				authenticated: authResult.authenticated,
				message: authResult.message,
			}));

			if (!authResult.authenticated) {
				setSubmitError(authResult.message || 'GitHub authentication is required to send feedback.');
				setSubmitting(false);
				return;
			}

			const latestTarget =
				feedbackTargets.find((target) => target.session.id === selectedSessionId) ?? selectedTarget;
			if (!latestTarget) {
				setSubmitError('The selected agent is no longer available.');
				setSubmitting(false);
				return;
			}

			const result = await window.maestro.feedback.submit({
				sessionId: selectedSessionId,
				category,
				summary: summary.trim(),
				expectedBehavior: expectedBehavior.trim(),
				details: details.trim(),
				reproductionSteps: isBugReport ? reproductionSteps.trim() : undefined,
				additionalContext: additionalContext.trim() || undefined,
				agentProvider: latestTarget.session.toolType,
				sshRemoteEnabled: Boolean(
					latestTarget.session.sessionSshRemoteConfig?.enabled ||
					latestTarget.session.sshRemoteId ||
					latestTarget.session.sshRemote
				),
				attachments: attachments.map(({ name, dataUrl }) => ({ name, dataUrl })),
			});

			if (!result.success) {
				setSubmitError(result.error || 'Failed to create GitHub issue from feedback.');
				setSubmitting(false);
				return;
			}

			onSubmitSuccess(selectedSessionId);
		} catch (error) {
			setSubmitError(
				error instanceof Error
					? error.message
					: 'An unexpected error occurred while sending feedback.'
			);
			setSubmitting(false);
		}
	}, [
		attachments,
		canSubmit,
		additionalContext,
		category,
		details,
		expectedBehavior,
		feedbackTargets,
		isBugReport,
		onSubmitSuccess,
		reproductionSteps,
		selectedSessionId,
		selectedTarget,
		summary,
	]);

	const handleTextareaKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && canSubmit) {
				event.preventDefault();
				void handleSubmit();
			}
		},
		[canSubmit, handleSubmit]
	);

	if (authState.checking) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
			</div>
		);
	}

	return (
		<div className="space-y-4">
			{!authState.authenticated && (
				<p className="text-sm font-medium" style={{ color: theme.colors.warning }}>
					{authState.message || 'GitHub authentication is required to send feedback.'}
				</p>
			)}

			<div
				className={!authState.authenticated ? 'opacity-40 pointer-events-none' : ''}
				aria-disabled={!authState.authenticated}
			>
				{feedbackTargets.length === 0 ? (
					<div className="text-sm" style={{ color: theme.colors.textDim }}>
						No live or resumable AI sessions are available yet. Start a session and send its first
						prompt, or use an existing session that already has conversation history.
					</div>
				) : (
					<>
						<div className="space-y-2">
							<label
								htmlFor="feedback-target-agent"
								className="text-sm font-medium"
								style={{ color: theme.colors.textMain }}
							>
								Target Agent
							</label>
							<select
								id="feedback-target-agent"
								value={selectedSessionId}
								onChange={(event) => setSelectedSessionId(event.target.value)}
								disabled={isFormDisabled}
								className="w-full rounded border bg-transparent px-2 py-2 text-sm outline-none focus:ring-2"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									boxShadow: `0 0 0 2px ${theme.colors.accent}10`,
								}}
							>
								{feedbackTargets.map((target) => (
									<option key={target.session.id} value={target.session.id}>
										{target.session.name} ({target.session.toolType}
										{target.isLive ? ', live' : ', will resume'})
									</option>
								))}
							</select>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="feedback-category"
								className="text-sm font-medium"
								style={{ color: theme.colors.textMain }}
							>
								Issue Type
							</label>
							<select
								id="feedback-category"
								value={category}
								onChange={(event) => setCategory(event.target.value as FeedbackCategory)}
								disabled={isFormDisabled}
								className="w-full rounded border bg-transparent px-2 py-2 text-sm outline-none focus:ring-2"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									boxShadow: `0 0 0 2px ${theme.colors.accent}10`,
								}}
							>
								{FEEDBACK_CATEGORY_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						</div>

						<div className="space-y-2">
							<div className="flex items-center justify-between gap-4">
								<label
									htmlFor="feedback-summary"
									className="text-sm font-medium"
									style={{ color: theme.colors.textMain }}
								>
									Summary
								</label>
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									{summary.length.toLocaleString()}/{MAX_SUMMARY_LENGTH.toLocaleString()}
								</span>
							</div>
							<input
								id="feedback-summary"
								type="text"
								value={summary}
								onChange={(event) => setSummary(event.target.value.slice(0, MAX_SUMMARY_LENGTH))}
								disabled={isFormDisabled}
								placeholder="Short issue title for GitHub"
								className="w-full rounded border bg-transparent px-2 py-2 text-sm outline-none focus:ring-2"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									boxShadow: `0 0 0 2px ${theme.colors.accent}10`,
								}}
								maxLength={MAX_SUMMARY_LENGTH}
							/>
						</div>

						{isBugReport && (
							<div className="space-y-2">
								<label
									htmlFor="feedback-reproduction-steps"
									className="text-sm font-medium"
									style={{ color: theme.colors.textMain }}
								>
									Steps to Reproduce
								</label>
								<textarea
									id="feedback-reproduction-steps"
									value={reproductionSteps}
									onChange={(event) =>
										setReproductionSteps(event.target.value.slice(0, MAX_FEEDBACK_LENGTH))
									}
									disabled={isFormDisabled}
									placeholder={'1. Open Maestro\n2. Click ...\n3. Observe ...'}
									className="w-full rounded border px-2 py-2 text-sm outline-none focus:ring-2 min-h-[110px] resize-y"
									style={{
										borderColor: theme.colors.border,
										color: theme.colors.textMain,
										backgroundColor: 'transparent',
										boxShadow: `0 0 0 2px ${theme.colors.accent}10`,
									}}
									maxLength={MAX_FEEDBACK_LENGTH}
								/>
							</div>
						)}

						<div className="space-y-2">
							<label
								htmlFor="feedback-expected-behavior"
								className="text-sm font-medium"
								style={{ color: theme.colors.textMain }}
							>
								{expectedBehaviorLabel}
							</label>
							<textarea
								id="feedback-expected-behavior"
								value={expectedBehavior}
								onChange={(event) =>
									setExpectedBehavior(event.target.value.slice(0, MAX_FEEDBACK_LENGTH))
								}
								disabled={isFormDisabled}
								placeholder={
									isBugReport
										? 'Describe what should have happened.'
										: 'Describe the outcome you want.'
								}
								className="w-full rounded border px-2 py-2 text-sm outline-none focus:ring-2 min-h-[110px] resize-y"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									backgroundColor: 'transparent',
									boxShadow: `0 0 0 2px ${theme.colors.accent}10`,
								}}
								maxLength={MAX_FEEDBACK_LENGTH}
							/>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="feedback-details"
								className="text-sm font-medium"
								style={{ color: theme.colors.textMain }}
							>
								{detailsLabel}
							</label>
							<textarea
								id="feedback-details"
								value={details}
								onChange={(event) => setDetails(event.target.value.slice(0, MAX_FEEDBACK_LENGTH))}
								onKeyDown={handleTextareaKeyDown}
								disabled={isFormDisabled}
								placeholder={
									isBugReport
										? 'Describe what happened instead.'
										: 'Describe the request, idea, or problem in more detail.'
								}
								className="w-full rounded border px-2 py-2 text-sm outline-none focus:ring-2 min-h-[120px] resize-y"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									backgroundColor: 'transparent',
									boxShadow: `0 0 0 2px ${theme.colors.accent}10`,
								}}
								maxLength={MAX_FEEDBACK_LENGTH}
							/>
							{details.length > CHAR_COUNT_WARNING_THRESHOLD && (
								<p
									className="text-xs text-right"
									style={{
										color:
											details.length === MAX_FEEDBACK_LENGTH
												? theme.colors.error
												: theme.colors.textDim,
									}}
								>
									{details.length.toLocaleString()}/{MAX_FEEDBACK_LENGTH.toLocaleString()}
								</p>
							)}
						</div>

						<div className="space-y-2">
							<label
								htmlFor="feedback-additional-context"
								className="text-sm font-medium"
								style={{ color: theme.colors.textMain }}
							>
								Logs / Additional Context
							</label>
							<textarea
								id="feedback-additional-context"
								value={additionalContext}
								onChange={(event) =>
									setAdditionalContext(event.target.value.slice(0, MAX_FEEDBACK_LENGTH))
								}
								disabled={isFormDisabled}
								placeholder="Paste errors, worktree context, or anything else that helps triage."
								className="w-full rounded border px-2 py-2 text-sm outline-none focus:ring-2 min-h-[110px] resize-y"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									backgroundColor: 'transparent',
									boxShadow: `0 0 0 2px ${theme.colors.accent}10`,
								}}
								maxLength={MAX_FEEDBACK_LENGTH}
							/>
						</div>

						<div className="space-y-2">
							<div className="flex items-center justify-between">
								<span className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
									Screenshots
								</span>
								<span className="text-xs" style={{ color: theme.colors.textDim }}>
									{attachments.length}/{MAX_ATTACHMENTS}
								</span>
							</div>

							<div
								data-testid="feedback-attachment-dropzone"
								role="button"
								tabIndex={isFormDisabled ? -1 : 0}
								onClick={() => !isFormDisabled && fileInputRef.current?.click()}
								onDragOver={handleAttachmentDragOver}
								onDragLeave={handleAttachmentDragLeave}
								onDrop={(event) => void handleAttachmentDrop(event)}
								onKeyDown={(event) => {
									if (!isFormDisabled && (event.key === 'Enter' || event.key === ' ')) {
										event.preventDefault();
										fileInputRef.current?.click();
									}
								}}
								className="rounded-lg border border-dashed p-4 transition-colors cursor-pointer"
								style={{
									borderColor: isDraggingAttachments ? theme.colors.accent : theme.colors.border,
									backgroundColor: isDraggingAttachments
										? `${theme.colors.accent}12`
										: theme.colors.bgActivity,
									color: theme.colors.textMain,
								}}
								aria-label="Add screenshots"
							>
								<input
									ref={fileInputRef}
									type="file"
									accept="image/*"
									multiple
									className="hidden"
									onChange={(event) => void handleAttachmentBrowse(event)}
									disabled={isFormDisabled}
								/>

								<div className="flex items-start gap-3">
									<div
										className="rounded-full p-2 shrink-0"
										style={{
											backgroundColor: `${theme.colors.accent}1A`,
											color: theme.colors.accent,
										}}
									>
										<ImagePlus className="w-4 h-4" />
									</div>
									<div className="space-y-1">
										<p className="text-sm font-medium">Drag screenshots here or click to browse</p>
										<p className="text-xs" style={{ color: theme.colors.textDim }}>
											PNG, JPG, GIF, or WebP. Up to {MAX_ATTACHMENTS} images, 10 MB each.
										</p>
									</div>
								</div>
							</div>

							{attachments.length > 0 && (
								<div className="grid grid-cols-2 gap-2">
									{attachments.map((attachment) => (
										<div
											key={attachment.id}
											className="rounded border overflow-hidden"
											style={{
												borderColor: theme.colors.border,
												backgroundColor: theme.colors.bgActivity,
											}}
										>
											<img
												src={attachment.dataUrl}
												alt={attachment.name}
												className="w-full h-24 object-cover"
											/>
											<div className="flex items-start justify-between gap-2 p-2">
												<div className="min-w-0">
													<p
														className="text-xs font-medium truncate"
														style={{ color: theme.colors.textMain }}
													>
														{attachment.name}
													</p>
													<p className="text-[11px]" style={{ color: theme.colors.textDim }}>
														{formatAttachmentSize(attachment.sizeBytes)}
													</p>
												</div>
												<button
													type="button"
													onClick={() => handleRemoveAttachment(attachment.id)}
													className="rounded p-1 transition-colors hover:bg-white/5"
													style={{ color: theme.colors.textDim }}
													aria-label={`Remove ${attachment.name}`}
												>
													<X className="w-3 h-3" />
												</button>
											</div>
										</div>
									))}
								</div>
							)}
						</div>

						{submitError && (
							<p className="text-sm" style={{ color: theme.colors.error }}>
								{submitError}
							</p>
						)}
					</>
				)}
			</div>

			<div className="flex justify-end gap-2">
				<button
					type="button"
					onClick={onCancel}
					className="px-4 py-2 rounded text-sm border transition-colors hover:bg-white/5"
					style={{
						borderColor: theme.colors.border,
						color: theme.colors.textMain,
					}}
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={handleSubmit}
					disabled={!canSubmit || isSubmittingDisabled}
					aria-busy={submitting}
					className="px-4 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
					style={{
						backgroundColor: theme.colors.accent,
						color: theme.colors.accentForeground,
					}}
				>
					{submitting ? (
						<>
							<Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
							Sending...
						</>
					) : (
						'Send Feedback'
					)}
				</button>
			</div>
		</div>
	);
}
