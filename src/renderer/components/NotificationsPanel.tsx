import { useState, useEffect } from 'react';
import { Bell, Volume2, Clock, Square, Check, AlertCircle, Loader2 } from 'lucide-react';
import type { Theme } from '../types';
import { SettingCheckbox } from './SettingCheckbox';
import { ToggleButtonGroup } from './ToggleButtonGroup';

interface NotificationsPanelProps {
	osNotificationsEnabled: boolean;
	setOsNotificationsEnabled: (value: boolean) => void;
	audioFeedbackEnabled: boolean;
	setAudioFeedbackEnabled: (value: boolean) => void;
	audioFeedbackCommand: string;
	setAudioFeedbackCommand: (value: string) => void;
	toastDuration: number;
	setToastDuration: (value: number) => void;
	theme: Theme;
}

type TestStatus = 'idle' | 'running' | 'success' | 'error';

export function NotificationsPanel({
	osNotificationsEnabled,
	setOsNotificationsEnabled,
	audioFeedbackEnabled,
	setAudioFeedbackEnabled,
	audioFeedbackCommand,
	setAudioFeedbackCommand,
	toastDuration,
	setToastDuration,
	theme,
}: NotificationsPanelProps) {
	// Notification command test state
	const [testNotificationId, setTestNotificationId] = useState<number | null>(null);
	const [testStatus, setTestStatus] = useState<TestStatus>('idle');
	const [testError, setTestError] = useState<string | null>(null);

	// Clear success/error status after a delay
	useEffect(() => {
		if (testStatus === 'success' || testStatus === 'error') {
			const timer = setTimeout(() => {
				setTestStatus('idle');
				setTestError(null);
			}, 3000);
			return () => clearTimeout(timer);
		}
	}, [testStatus]);

	// Listen for notification command completion to reset the Stop button
	useEffect(() => {
		if (testNotificationId === null) return;

		const cleanup = window.maestro.notification.onCommandCompleted((completedId) => {
			if (completedId === testNotificationId) {
				console.log('[Notification] Command completed, id:', completedId);
				setTestNotificationId(null);
				setTestStatus('success');
			}
		});

		return cleanup;
	}, [testNotificationId]);

	return (
		<div className="space-y-6">
			{/* OS Notifications */}
			<div>
				<SettingCheckbox
					icon={Bell}
					sectionLabel="Operating System Notifications"
					title="Enable OS Notifications"
					description="Show desktop notifications when tasks complete or require attention"
					checked={osNotificationsEnabled}
					onChange={setOsNotificationsEnabled}
					theme={theme}
				/>
				<button
					onClick={() =>
						window.maestro.notification.show(
							'Maestro',
							'Test notification - notifications are working!'
						)
					}
					className="mt-2 px-3 py-1.5 rounded text-xs font-medium transition-all"
					style={{
						backgroundColor: theme.colors.bgActivity,
						color: theme.colors.textMain,
						border: `1px solid ${theme.colors.border}`,
					}}
				>
					Test Notification
				</button>
			</div>

			{/* Custom Notification */}
			<div>
				<SettingCheckbox
					icon={Volume2}
					sectionLabel="Custom Notification"
					title="Enable Custom Notification"
					description="Execute a custom command when AI tasks complete, such as text-to-speech feedback"
					checked={audioFeedbackEnabled}
					onChange={setAudioFeedbackEnabled}
					theme={theme}
				/>

				{/* Command Chain Configuration */}
				<div className="mt-3">
					<label className="block text-xs font-medium opacity-70 mb-1">Command Chain</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={audioFeedbackCommand}
							onChange={(e) => setAudioFeedbackCommand(e.target.value)}
							placeholder="say"
							className="flex-1 p-2 rounded border bg-transparent outline-none text-sm font-mono"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
						{testNotificationId !== null ? (
							<button
								onClick={async () => {
									console.log('[Notification] Stop test button clicked, id:', testNotificationId);
									try {
										await window.maestro.notification.stopSpeak(testNotificationId);
									} catch (err) {
										console.error('[Notification] Stop error:', err);
									}
									setTestNotificationId(null);
									setTestStatus('idle');
								}}
								className="px-3 py-2 rounded text-xs font-medium transition-all flex items-center gap-1"
								style={{
									backgroundColor: theme.colors.error,
									color: '#fff',
									border: `1px solid ${theme.colors.error}`,
								}}
							>
								<Square className="w-3 h-3" fill="currentColor" />
								Stop
							</button>
						) : (
							<button
								onClick={async () => {
									console.log('[Notification] Test button clicked, command:', audioFeedbackCommand);
									setTestStatus('running');
									setTestError(null);
									try {
										const result = await window.maestro.notification.speak(
											"Howdy, I'm Maestro, here to conduct your agentic tools into a well-tuned symphony.",
											audioFeedbackCommand
										);
										console.log('[Notification] Speak result:', result);
										if (result.success && result.notificationId) {
											setTestNotificationId(result.notificationId);
											// Don't change status to 'success' yet - stay in 'running'
											// and show Stop button while process is active.
											// The onCommandCompleted listener will clear testNotificationId
											// when the process exits, which hides the Stop button.
										} else {
											setTestStatus('error');
											setTestError(result.error || 'Command failed');
										}
									} catch (err) {
										console.error('[Notification] Speak error:', err);
										setTestStatus('error');
										setTestError(String(err));
									}
								}}
								disabled={testStatus === 'running'}
								className="px-3 py-2 rounded text-xs font-medium transition-all flex items-center gap-1.5 min-w-[70px] justify-center"
								style={{
									backgroundColor:
										testStatus === 'success'
											? theme.colors.success + '20'
											: testStatus === 'error'
												? theme.colors.error + '20'
												: theme.colors.bgActivity,
									color:
										testStatus === 'success'
											? theme.colors.success
											: testStatus === 'error'
												? theme.colors.error
												: theme.colors.textMain,
									border: `1px solid ${
										testStatus === 'success'
											? theme.colors.success
											: testStatus === 'error'
												? theme.colors.error
												: theme.colors.border
									}`,
									opacity: testStatus === 'running' ? 0.7 : 1,
								}}
							>
								{testStatus === 'running' ? (
									<>
										<Loader2 className="w-3 h-3 animate-spin" />
										Running
									</>
								) : testStatus === 'success' ? (
									<>
										<Check className="w-3 h-3" />
										Success
									</>
								) : testStatus === 'error' ? (
									<>
										<AlertCircle className="w-3 h-3" />
										Failed
									</>
								) : (
									'Test'
								)}
							</button>
						)}
					</div>
					{/* Error message display */}
					{testError && (
						<p
							className="text-xs mt-2 px-2 py-1 rounded"
							style={{
								color: theme.colors.error,
								backgroundColor: theme.colors.error + '10',
							}}
						>
							{testError}
						</p>
					)}
					<p className="text-xs opacity-50 mt-2" style={{ color: theme.colors.textDim }}>
						Command that accepts text via stdin. Chain multiple commands using pipes (e.g.,{' '}
						<code
							className="px-1 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							cmd1 | cmd2
						</code>
						) to mix and match tools. Default TTS examples:{' '}
						<code
							className="px-1 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							say
						</code>{' '}
						(macOS),{' '}
						<code
							className="px-1 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							espeak
						</code>{' '}
						(Linux),{' '}
						<code
							className="px-1 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							festival --tts
						</code>
						. You can also use non-TTS commands or combine them, e.g.,{' '}
						<code
							className="px-1 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							tee ~/log.txt | say
						</code>{' '}
						to log and speak simultaneously.
					</p>
				</div>
			</div>

			{/* Toast Duration */}
			<div>
				<label className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
					<Clock className="w-3 h-3" />
					Toast Notification Duration
				</label>
				<ToggleButtonGroup
					options={[
						{ value: -1, label: 'Off' },
						{ value: 5, label: '5s' },
						{ value: 10, label: '10s' },
						{ value: 20, label: '20s' },
						{ value: 30, label: '30s' },
						{ value: 0, label: 'Never' },
					]}
					value={toastDuration}
					onChange={setToastDuration}
					theme={theme}
				/>
				<p className="text-xs opacity-50 mt-2">
					How long toast notifications remain on screen. "Off" disables them entirely. "Never" means
					they stay until manually dismissed.
				</p>
			</div>

			{/* Info about when notifications are triggered */}
			<div
				className="p-3 rounded-lg"
				style={{
					backgroundColor: theme.colors.bgActivity,
					border: `1px solid ${theme.colors.border}`,
				}}
			>
				<div className="text-xs font-medium mb-2" style={{ color: theme.colors.textMain }}>
					When are notifications triggered?
				</div>
				<ul className="text-xs opacity-70 space-y-1" style={{ color: theme.colors.textDim }}>
					<li>• When an AI task completes</li>
					<li>• When a long-running command finishes</li>
				</ul>
				<div
					className="text-xs opacity-60 mt-3 pt-3"
					style={{ color: theme.colors.textDim, borderTop: `1px solid ${theme.colors.border}` }}
				>
					<strong>Tip:</strong> The default Command Chain uses TTS (text-to-speech), but you can
					leverage any notification stack you prefer. Chain commands together with pipes to mix and
					match—for example, log to a file while also speaking aloud.
				</div>
			</div>
		</div>
	);
}
