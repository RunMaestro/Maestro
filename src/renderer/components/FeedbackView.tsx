import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
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

const MAX_FEEDBACK_LENGTH = 5000;
const CHAR_COUNT_WARNING_THRESHOLD = 4000;

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

export function FeedbackView({ theme, sessions, onCancel, onSubmitSuccess }: FeedbackViewProps) {
	const [feedbackText, setFeedbackText] = useState('');
	const [selectedSessionId, setSelectedSessionId] = useState('');
	const [submitting, setSubmitting] = useState(false);
	const [authState, setAuthState] = useState<FeedbackAuthState>({
		checking: true,
		authenticated: false,
	});
	const [submitError, setSubmitError] = useState('');

	const runningSessions = useMemo(() => {
		return sessions.filter(isRunningSession);
	}, [sessions]);

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

	const canSubmit =
		!submitting &&
		selectedSessionId.length > 0 &&
		feedbackText.trim().length > 0 &&
		runningSessions.length > 0 &&
		authState.authenticated;

	useEffect(() => {
		void authCheck();
	}, [authCheck]);

	useEffect(() => {
		if (runningSessions.length === 0) {
			setSelectedSessionId('');
			return;
		}

		if (!runningSessions.find((session) => session.id === selectedSessionId)) {
			setSelectedSessionId(runningSessions[0].id);
		}
	}, [runningSessions, selectedSessionId]);

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
				setSubmitting(false);
				return;
			}

			const result = await window.maestro.feedback.submit(selectedSessionId, feedbackText.trim());

			if (!result.success) {
				setSubmitError(
					result.error || 'The selected agent is no longer running. Please select another agent.'
				);
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
	}, [canSubmit, selectedSessionId, feedbackText, onSubmitSuccess]);

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
				{runningSessions.length === 0 ? (
					<div className="text-sm" style={{ color: theme.colors.textDim }}>
						No running agents available. Start an agent first, then try again.
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
								{runningSessions.map((session) => (
									<option key={session.id} value={session.id}>
										{session.name} ({session.toolType})
									</option>
								))}
							</select>
						</div>

						<div className="space-y-2">
							<label
								htmlFor="feedback-text"
								className="text-sm font-medium"
								style={{ color: theme.colors.textMain }}
							>
								Feedback
							</label>
							<textarea
								id="feedback-text"
								value={feedbackText}
								onChange={(event) =>
									setFeedbackText(event.target.value.slice(0, MAX_FEEDBACK_LENGTH))
								}
								onKeyDown={handleTextareaKeyDown}
								disabled={isFormDisabled}
								placeholder="Describe the bug, feature request, or feedback..."
								className="w-full rounded border px-2 py-2 text-sm outline-none focus:ring-2 min-h-[120px] resize-y"
								style={{
									borderColor: theme.colors.border,
									color: theme.colors.textMain,
									backgroundColor: 'transparent',
									boxShadow: `0 0 0 2px ${theme.colors.accent}10`,
								}}
								maxLength={MAX_FEEDBACK_LENGTH}
							/>
							{feedbackText.length > CHAR_COUNT_WARNING_THRESHOLD && (
								<p
									className="text-xs text-right"
									style={{
										color:
											feedbackText.length === MAX_FEEDBACK_LENGTH
												? theme.colors.error
												: theme.colors.textDim,
									}}
								>
									{feedbackText.length.toLocaleString()}/{MAX_FEEDBACK_LENGTH.toLocaleString()}
								</p>
							)}

							{submitError && (
								<p className="text-sm" style={{ color: theme.colors.error }}>
									{submitError}
								</p>
							)}
						</div>
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
