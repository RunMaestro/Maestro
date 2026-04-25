import { useState, useEffect } from 'react';
import { Bell, Volume2, Clock, Square, Check, AlertCircle, Loader2, Coffee } from 'lucide-react';
import { Spinner } from './ui/Spinner';
import type { Theme } from '../types';
import { SettingCheckbox } from './SettingCheckbox';
import { ToggleButtonGroup } from './ToggleButtonGroup';
import { logger } from '../utils/logger';

interface NotificationsPanelProps {
	osNotificationsEnabled: boolean;
	setOsNotificationsEnabled: (value: boolean) => void;
	audioFeedbackEnabled: boolean;
	setAudioFeedbackEnabled: (value: boolean) => void;
	audioFeedbackCommand: string;
	setAudioFeedbackCommand: (value: string) => void;
	toastDuration: number;
	setToastDuration: (value: number) => void;
	idleNotificationEnabled: boolean;
	setIdleNotificationEnabled: (value: boolean) => void;
	idleNotificationCommand: string;
	setIdleNotificationCommand: (value: string) => void;
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
	idleNotificationEnabled,
	setIdleNotificationEnabled,
	idleNotificationCommand,
	setIdleNotificationCommand,
	theme,
}: NotificationsPanelProps) {
	// Custom notification test state
	const [testNotificationId, setTestNotificationId] = useState<number | null>(null);
	const [testStatus, setTestStatus] = useState<TestStatus>('idle');
	const [testError, setTestError] = useState<string | null>(null);

	// Idle notification test state
	const [idleTestNotificationId, setIdleTestNotificationId] = useState<number | null>(null);
	const [idleTestStatus, setIdleTestStatus] = useState<TestStatus>('idle');
	const [idleTestError, setIdleTestError] = useState<string | null>(null);

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
				logger.info('[Notification] Command completed, id:', undefined, completedId);
				setTestNotificationId(null);
				setTestStatus('success');
			}
		});

		return cleanup;
	}, [testNotificationId]);

	// Idle notification: clear success/error status after a delay
	useEffect(() => {
		if (idleTestStatus === 'success' || idleTestStatus === 'error') {
			const timer = setTimeout(() => {
				setIdleTestStatus('idle');
				setIdleTestError(null);
			}, 3000);
			return () => clearTimeout(timer);
		}
	}, [idleTestStatus]);

	// Idle notification: listen for command completion
	useEffect(() => {
		if (idleTestNotificationId === null) return;

		const cleanup = window.maestro.notification.onCommandCompleted((completedId) => {
			if (completedId === idleTestNotificationId) {
				setIdleTestNotificationId(null);
				setIdleTestStatus('success');
			}
		});

		return cleanup;
	}, [idleTestNotificationId]);

	return (
		<div className="space-y-6">
			{/* OS Notifications */}
			<div data-setting-id="notifications-os">
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
			<div data-setting-id="notifications-custom">
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
									logger.info(
										'[Notification] Stop test button clicked, id:',
										undefined,
										testNotificationId
									);
									try {
										await window.maestro.notification.stopSpeak(testNotificationId);
									} catch (err) {
										logger.error('[Notification] Stop error:', undefined, err);
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
									logger.info(
										'[Notification] Test button clicked, command:',
										undefined,
										audioFeedbackCommand
									);
									setTestStatus('running');
									setTestError(null);
									try {
										const result = await window.maestro.notification.speak(
											"Howdy, I'm Maestro, here to conduct your agentic tools into a well-tuned symphony.",
											audioFeedbackCommand
										);
										logger.info('[Notification] Speak result:', undefined, result);
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
										logger.error('[Notification] Speak error:', undefined, err);
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
										<Spinner size={12} />
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

			{/* Idle Notification */}
			<div data-setting-id="notifications-idle">
				<SettingCheckbox
					icon={Coffee}
					sectionLabel="Idle Notification"
					title="Enable Idle Notification"
					description="Execute a custom command when all agents and Auto Runs finish and Maestro becomes idle"
					checked={idleNotificationEnabled}
					onChange={setIdleNotificationEnabled}
					theme={theme}
				/>

				{/* Command Configuration */}
				<div className="mt-3">
					<label className="block text-xs font-medium opacity-70 mb-1">Command</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={idleNotificationCommand}
							onChange={(e) => setIdleNotificationCommand(e.target.value)}
							placeholder="say Maestro is idle"
							className="flex-1 p-2 rounded border bg-transparent outline-none text-sm font-mono"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
						{idleTestNotificationId !== null ? (
							<button
								onClick={async () => {
									try {
										await window.maestro.notification.stopSpeak(idleTestNotificationId);
									} catch (err) {
										console.error('[IdleNotification] Stop error:', err);
									}
									setIdleTestNotificationId(null);
									setIdleTestStatus('idle');
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
									setIdleTestStatus('running');
									setIdleTestError(null);
									try {
										const result = await window.maestro.notification.speak(
											'Maestro is idle',
											idleNotificationCommand
										);
										if (result.success && result.notificationId) {
											setIdleTestNotificationId(result.notificationId);
										} else {
											setIdleTestStatus('error');
											setIdleTestError(result.error || 'Command failed');
										}
									} catch (err) {
										setIdleTestStatus('error');
										setIdleTestError(String(err));
									}
								}}
								disabled={idleTestStatus === 'running'}
								className="px-3 py-2 rounded text-xs font-medium transition-all flex items-center gap-1.5 min-w-[70px] justify-center"
								style={{
									backgroundColor:
										idleTestStatus === 'success'
											? theme.colors.success + '20'
											: idleTestStatus === 'error'
												? theme.colors.error + '20'
												: theme.colors.bgActivity,
									color:
										idleTestStatus === 'success'
											? theme.colors.success
											: idleTestStatus === 'error'
												? theme.colors.error
												: theme.colors.textMain,
									border: `1px solid ${
										idleTestStatus === 'success'
											? theme.colors.success
											: idleTestStatus === 'error'
												? theme.colors.error
												: theme.colors.border
									}`,
									opacity: idleTestStatus === 'running' ? 0.7 : 1,
								}}
							>
								{idleTestStatus === 'running' ? (
									<>
										<Loader2 className="w-3 h-3 animate-spin" />
										Running
									</>
								) : idleTestStatus === 'success' ? (
									<>
										<Check className="w-3 h-3" />
										Success
									</>
								) : idleTestStatus === 'error' ? (
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
					{idleTestError && (
						<p
							className="text-xs mt-2 px-2 py-1 rounded"
							style={{
								color: theme.colors.error,
								backgroundColor: theme.colors.error + '10',
							}}
						>
							{idleTestError}
						</p>
					)}
					<p className="text-xs opacity-50 mt-2" style={{ color: theme.colors.textDim }}>
						Runs when all agents finish and no Auto Run is active. Cue tasks don&apos;t count as
						activity. The command receives &quot;Maestro is idle&quot; via stdin.
					</p>
				</div>
			</div>

			{/* Toast Duration */}
			<div data-setting-id="notifications-toast">
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
					<li>• When an AI task completes (Custom Notification)</li>
					<li>• When all agents and Auto Runs finish (Idle Notification)</li>
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
