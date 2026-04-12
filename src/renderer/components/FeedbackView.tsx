import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Loader2 } from 'lucide-react';
import type { Theme, Session } from '../types';
import { captureException } from '../utils/sentry';

interface FeedbackViewProps {
	theme: Theme;
	sessions: Session[];
	onCancel: () => void;
	onSubmitSuccess: (sessionId: string) => void;
}

export function FeedbackView({ theme, sessions, onCancel, onSubmitSuccess }: FeedbackViewProps) {
	const [authChecking, setAuthChecking] = useState(true);
	const [authError, setAuthError] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState('');
	const [feedbackText, setFeedbackText] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);

	// Sessions that have an active agent process
	const runningSessions = useMemo(
		() =>
			sessions.filter(
				(s) => s.state === 'idle' || s.state === 'busy' || s.state === 'waiting_input'
			),
		[sessions]
	);

	useEffect(() => {
		// Auto-select the first running session
		if (runningSessions.length > 0 && !selectedSessionId) {
			setSelectedSessionId(runningSessions[0].id);
		}
	}, [runningSessions, selectedSessionId]);

	const checkAuth = useCallback(async (): Promise<boolean> => {
		try {
			const result = await window.maestro.feedback.checkGhAuth();
			if (!result.authenticated) {
				setAuthError(result.message ?? 'GitHub CLI authentication required.');
				return false;
			}
			setAuthError(null);
			return true;
		} catch (error) {
			captureException(error, { extra: { context: 'FeedbackView.checkAuth' } });
			setAuthError('Unable to verify GitHub CLI authentication. Please try again.');
			return false;
		}
	}, []);

	useEffect(() => {
		setAuthChecking(true);
		checkAuth().finally(() => setAuthChecking(false));
	}, [checkAuth]);

	const handleSubmit = useCallback(async () => {
		if (!selectedSessionId || !feedbackText.trim()) return;

		setSubmitting(true);
		setSubmitError(null);

		try {
			// Pre-submit auth re-check
			const stillAuthed = await checkAuth();
			if (!stillAuthed) return;

			const result = await window.maestro.feedback.submit(selectedSessionId, feedbackText.trim());
			if (result.success) {
				onSubmitSuccess(selectedSessionId);
				return;
			}
			setSubmitError(
				result.error ?? 'The selected agent is no longer running. Please select another agent.'
			);
		} catch (error) {
			captureException(error, { extra: { context: 'FeedbackView.handleSubmit' } });
			setSubmitError('Unable to send feedback. Please try again.');
		} finally {
			setSubmitting(false);
		}
	}, [selectedSessionId, feedbackText, checkAuth, onSubmitSuccess]);

	const handleTextareaKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
				e.preventDefault();
				handleSubmit();
			}
		},
		[handleSubmit]
	);

	if (authChecking) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="w-4 h-4 animate-spin" style={{ color: theme.colors.textDim }} />
			</div>
		);
	}

	// No running agents — show placeholder message instead of form
	if (runningSessions.length === 0) {
		return (
			<div className="space-y-4">
				<div
					className="text-xs px-3 py-3 rounded border text-center"
					style={{
						color: theme.colors.textDim,
						borderColor: theme.colors.border,
					}}
				>
					No running agents available. Start an agent first, then try again.
				</div>
				<div className="flex justify-end gap-2 pt-1">
					<button
						type="button"
						onClick={onCancel}
						className="px-3 py-1.5 rounded text-xs border transition-colors hover:bg-white/5"
						style={{
							color: theme.colors.textDim,
							borderColor: theme.colors.border,
						}}
					>
						Cancel
					</button>
					<button
						type="button"
						disabled
						className="px-3 py-1.5 rounded text-xs flex items-center gap-1.5 transition-colors"
						style={{
							color: theme.colors.textDim,
							backgroundColor: theme.colors.border,
							cursor: 'not-allowed',
						}}
					>
						Send Feedback
					</button>
				</div>
			</div>
		);
	}

	const isDisabled = !!authError;
	const canSubmit =
		!isDisabled && !submitting && feedbackText.trim().length > 0 && selectedSessionId.length > 0;

	const charCount = feedbackText.length;
	const formattedCount = charCount.toLocaleString();

	return (
		<div className="space-y-4">
			{/* Auth error banner */}
			{authError && (
				<div
					className="text-xs px-3 py-2 rounded border"
					style={{
						color: theme.colors.warning,
						borderColor: theme.colors.warning,
						backgroundColor: `${theme.colors.warning}15`,
					}}
				>
					{authError}
				</div>
			)}

			{/* Form fields — ghosted when auth fails */}
			<div className={isDisabled ? 'opacity-40 pointer-events-none' : ''}>
				{/* Agent selector */}
				<div className="mb-3">
					<label className="block text-xs font-medium mb-1" style={{ color: theme.colors.textDim }}>
						Agent to file feedback from
					</label>
					<select
						value={selectedSessionId}
						onChange={(e) => setSelectedSessionId(e.target.value)}
						disabled={submitting}
						className="w-full px-2 py-1.5 rounded text-xs border bg-transparent outline-none"
						style={{
							color: theme.colors.textMain,
							borderColor: theme.colors.border,
							backgroundColor: 'transparent',
						}}
					>
						{runningSessions.map((s) => (
							<option key={s.id} value={s.id} style={{ backgroundColor: theme.colors.bgActivity }}>
								{s.name} ({s.toolType})
							</option>
						))}
					</select>
				</div>

				{/* Feedback textarea */}
				<div className="mb-1">
					<label className="block text-xs font-medium mb-1" style={{ color: theme.colors.textDim }}>
						Feedback
					</label>
					<textarea
						value={feedbackText}
						onChange={(e) => {
							if (e.target.value.length <= 5000) {
								setFeedbackText(e.target.value);
							}
						}}
						onKeyDown={handleTextareaKeyDown}
						disabled={submitting}
						placeholder="Describe the bug, feature request, or feedback..."
						className="w-full px-3 py-2 rounded text-xs border bg-transparent outline-none resize-none"
						style={{
							color: theme.colors.textMain,
							borderColor: theme.colors.border,
							backgroundColor: 'transparent',
							minHeight: '120px',
						}}
					/>
					{charCount > 4000 && (
						<div
							className="text-xs text-right mt-0.5"
							style={{
								color: charCount >= 5000 ? theme.colors.error : theme.colors.textDim,
							}}
						>
							{formattedCount} / 5,000
						</div>
					)}
				</div>
			</div>

			{/* Submit error */}
			{submitError && (
				<div
					className="text-xs px-3 py-2 rounded border"
					style={{
						color: theme.colors.error,
						borderColor: theme.colors.error,
						backgroundColor: `${theme.colors.error}15`,
					}}
				>
					{submitError}
				</div>
			)}

			{/* Footer */}
			<div className="flex justify-end gap-2 pt-1">
				<button
					type="button"
					onClick={onCancel}
					disabled={submitting}
					className="px-3 py-1.5 rounded text-xs border transition-colors hover:bg-white/5"
					style={{
						color: theme.colors.textDim,
						borderColor: theme.colors.border,
					}}
				>
					Cancel
				</button>
				<button
					type="button"
					onClick={handleSubmit}
					disabled={!canSubmit}
					className="px-3 py-1.5 rounded text-xs flex items-center gap-1.5 transition-colors"
					style={{
						color: canSubmit ? theme.colors.bgActivity : theme.colors.textDim,
						backgroundColor: canSubmit ? theme.colors.accent : theme.colors.border,
						cursor: canSubmit ? 'pointer' : 'not-allowed',
					}}
				>
					{submitting && <Loader2 className="w-4 h-4 animate-spin" />}
					Send Feedback
				</button>
			</div>
		</div>
	);
}
