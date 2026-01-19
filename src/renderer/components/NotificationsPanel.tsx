import React, { useState } from 'react';
import { Bell, Volume2, Clock, Square } from 'lucide-react';
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
	// TTS test state
	const [testTtsId, setTestTtsId] = useState<number | null>(null);

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

			{/* Audio Feedback */}
			<div>
				<SettingCheckbox
					icon={Volume2}
					sectionLabel="Audio Feedback"
					title="Enable Audio Feedback"
					description="Speak the one-sentence feedback synopsis from LLM analysis using text-to-speech"
					checked={audioFeedbackEnabled}
					onChange={setAudioFeedbackEnabled}
					theme={theme}
				/>

				{/* Audio Command Configuration */}
				<div className="mt-3">
					<label className="block text-xs font-medium opacity-70 mb-1">TTS Command</label>
					<div className="flex gap-2">
						<input
							type="text"
							value={audioFeedbackCommand}
							onChange={(e) => setAudioFeedbackCommand(e.target.value)}
							placeholder="say"
							className="flex-1 p-2 rounded border bg-transparent outline-none text-sm font-mono"
							style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
						/>
						{testTtsId !== null ? (
							<button
								onClick={async () => {
									console.log('[TTS] Stop test button clicked, ttsId:', testTtsId);
									try {
										await window.maestro.notification.stopSpeak(testTtsId);
									} catch (err) {
										console.error('[TTS] Stop error:', err);
									}
									setTestTtsId(null);
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
									console.log('[TTS] Test button clicked, command:', audioFeedbackCommand);
									try {
										const result = await window.maestro.notification.speak(
											"Howdy, I'm Maestro, here to conduct your agentic tools into a well-tuned symphony.",
											audioFeedbackCommand
										);
										console.log('[TTS] Speak result:', result);
										if (result.success && result.ttsId) {
											setTestTtsId(result.ttsId);
											// Auto-clear after the message should be done (about 5 seconds for this phrase)
											setTimeout(() => setTestTtsId(null), 8000);
										}
									} catch (err) {
										console.error('[TTS] Speak error:', err);
									}
								}}
								className="px-3 py-2 rounded text-xs font-medium transition-all"
								style={{
									backgroundColor: theme.colors.bgActivity,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								Test
							</button>
						)}
					</div>
					<p className="text-xs opacity-50 mt-2" style={{ color: theme.colors.textDim }}>
						Command that accepts text via stdin. Pipes are supported (e.g.,{' '}
						<code
							className="px-1 py-0.5 rounded"
							style={{ backgroundColor: theme.colors.bgActivity }}
						>
							cmd1 | cmd2
						</code>
						). Examples:{' '}
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
					<li>• When the LLM analysis generates a feedback synopsis (audio only, if configured)</li>
				</ul>
			</div>
		</div>
	);
}
