import { useState, useEffect, useRef, memo } from 'react';
import { useTranslation } from 'react-i18next';
import {
	X,
	Key,
	Keyboard,
	Bell,
	Cpu,
	Settings,
	Palette,
	FlaskConical,
	Server,
	Monitor,
} from 'lucide-react';
import { useSettings } from '../../hooks';
import type { Theme, LLMProvider } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { AICommandsPanel } from '../AICommandsPanel';
import { SpecKitCommandsPanel } from '../SpecKitCommandsPanel';
import { OpenSpecCommandsPanel } from '../OpenSpecCommandsPanel';
import { NotificationsPanel } from '../NotificationsPanel';
import { SshRemotesSection } from './SshRemotesSection';
import { SshRemoteIgnoreSection } from './SshRemoteIgnoreSection';
import { GeneralTab } from './tabs/GeneralTab';
import { DisplayTab } from './tabs/DisplayTab';
import { EncoreTab } from './tabs/EncoreTab';
import { ShortcutsTab } from './tabs/ShortcutsTab';
import { ThemeTab } from './tabs/ThemeTab';

// Feature flags - set to true to enable dormant features
const FEATURE_FLAGS = {
	LLM_SETTINGS: false, // LLM provider configuration (OpenRouter, Anthropic, Ollama)
};

interface SettingsModalProps {
	isOpen: boolean;
	onClose: () => void;
	theme: Theme;
	themes: Record<string, Theme>;
	initialTab?:
		| 'general'
		| 'display'
		| 'llm'
		| 'shortcuts'
		| 'theme'
		| 'notifications'
		| 'aicommands'
		| 'ssh'
		| 'encore';
	hasNoAgents?: boolean;
	onThemeImportError?: (message: string) => void;
	onThemeImportSuccess?: (message: string) => void;
}

export const SettingsModal = memo(function SettingsModal(props: SettingsModalProps) {
	const {
		isOpen,
		onClose,
		theme,
		themes,
		initialTab,
		hasNoAgents,
		onThemeImportError,
		onThemeImportSuccess,
	} = props;

	// All settings from useSettings hook (self-sourced, Tier 1B)
	// General tab settings are now self-sourced by GeneralTab
	// Display tab settings are now self-sourced by DisplayTab
	const {
		// LLM settings
		llmProvider,
		setLlmProvider,
		modelSlug,
		setModelSlug,
		apiKey,
		setApiKey,
		// Notification settings
		osNotificationsEnabled,
		setOsNotificationsEnabled,
		audioFeedbackEnabled,
		setAudioFeedbackEnabled,
		audioFeedbackCommand,
		setAudioFeedbackCommand,
		toastDuration,
		setToastDuration,
		// AI Commands
		customAICommands,
		setCustomAICommands,
		// SSH Remote file indexing settings
		sshRemoteIgnorePatterns,
		setSshRemoteIgnorePatterns,
		sshRemoteHonorGitignore,
		setSshRemoteHonorGitignore,
	} = useSettings();

	const { t } = useTranslation('settings');

	const [activeTab, setActiveTab] = useState<
		| 'general'
		| 'display'
		| 'llm'
		| 'shortcuts'
		| 'theme'
		| 'notifications'
		| 'aicommands'
		| 'ssh'
		| 'encore'
	>('general');
	const [testingLLM, setTestingLLM] = useState(false);
	const [testResult, setTestResult] = useState<{
		status: 'success' | 'error' | null;
		message: string;
	}>({ status: null, message: '' });
	// Layer stack integration
	const { registerLayer, unregisterLayer } = useLayerStack();
	const layerIdRef = useRef<string>();
	const isRecordingShortcutRef = useRef(false);

	useEffect(() => {
		if (isOpen) {
			// Set initial tab if provided, otherwise default to 'general'
			setActiveTab(initialTab || 'general');
		}
	}, [isOpen, initialTab]);

	// Store onClose in a ref to avoid re-registering layer when onClose changes
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Register layer when modal opens
	useEffect(() => {
		if (!isOpen) return;

		const id = registerLayer({
			type: 'modal',
			priority: MODAL_PRIORITIES.SETTINGS,
			blocksLowerLayers: true,
			capturesFocus: true,
			focusTrap: 'strict',
			ariaLabel: t('modal.aria_label'),
			onEscape: () => {
				// If recording a shortcut, ShortcutsTab handles its own escape via onKeyDownCapture
				if (isRecordingShortcutRef.current) return;
				onCloseRef.current();
			},
		});

		layerIdRef.current = id;

		return () => {
			if (layerIdRef.current) {
				unregisterLayer(layerIdRef.current);
			}
		};
	}, [isOpen, registerLayer, unregisterLayer]); // Removed onClose from deps

	// Tab navigation with Cmd+Shift+[ and ]
	useEffect(() => {
		if (!isOpen) return;

		const handleTabNavigation = (e: KeyboardEvent) => {
			const tabs: Array<
				| 'general'
				| 'display'
				| 'llm'
				| 'shortcuts'
				| 'theme'
				| 'notifications'
				| 'aicommands'
				| 'ssh'
				| 'encore'
			> = FEATURE_FLAGS.LLM_SETTINGS
				? [
						'general',
						'display',
						'llm',
						'shortcuts',
						'theme',
						'notifications',
						'aicommands',
						'ssh',
						'encore',
					]
				: [
						'general',
						'display',
						'shortcuts',
						'theme',
						'notifications',
						'aicommands',
						'ssh',
						'encore',
					];
			const currentIndex = tabs.indexOf(activeTab);

			if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === '[') {
				e.preventDefault();
				const prevIndex = currentIndex === 0 ? tabs.length - 1 : currentIndex - 1;
				setActiveTab(tabs[prevIndex]);
			} else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === ']') {
				e.preventDefault();
				const nextIndex = (currentIndex + 1) % tabs.length;
				setActiveTab(tabs[nextIndex]);
			}
		};

		window.addEventListener('keydown', handleTabNavigation);
		return () => window.removeEventListener('keydown', handleTabNavigation);
	}, [isOpen, activeTab]);

	const testLLMConnection = async () => {
		setTestingLLM(true);
		setTestResult({ status: null, message: '' });

		try {
			let response;
			const testPrompt = 'Respond with exactly: "Connection successful"';

			if (llmProvider === 'openrouter') {
				if (!apiKey) {
					throw new Error(t('llm.api_key_required_error', { provider: 'OpenRouter' }));
				}

				response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'Content-Type': 'application/json',
						'HTTP-Referer': 'https://maestro.local',
					},
					body: JSON.stringify({
						model: modelSlug || 'anthropic/claude-3.5-sonnet',
						messages: [{ role: 'user', content: testPrompt }],
						max_tokens: 50,
					}),
				});

				if (!response.ok) {
					const error = await response.json();
					throw new Error(
						error.error?.message ||
							t('llm.api_error', { provider: 'OpenRouter', status: response.status })
					);
				}

				const data = await response.json();
				if (!data.choices?.[0]?.message?.content) {
					throw new Error(t('llm.invalid_response_error', { provider: 'OpenRouter' }));
				}

				setTestResult({
					status: 'success',
					message: t('llm.connection_success', { provider: 'OpenRouter' }),
				});
			} else if (llmProvider === 'anthropic') {
				if (!apiKey) {
					throw new Error(t('llm.api_key_required_error', { provider: 'Anthropic' }));
				}

				response = await fetch('https://api.anthropic.com/v1/messages', {
					method: 'POST',
					headers: {
						'x-api-key': apiKey,
						'anthropic-version': '2023-06-01',
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						model: modelSlug || 'claude-3-5-sonnet-20241022',
						max_tokens: 50,
						messages: [{ role: 'user', content: testPrompt }],
					}),
				});

				if (!response.ok) {
					const error = await response.json();
					throw new Error(
						error.error?.message ||
							t('llm.api_error', { provider: 'Anthropic', status: response.status })
					);
				}

				const data = await response.json();
				if (!data.content?.[0]?.text) {
					throw new Error(t('llm.invalid_response_error', { provider: 'Anthropic' }));
				}

				setTestResult({
					status: 'success',
					message: t('llm.connection_success', { provider: 'Anthropic' }),
				});
			} else if (llmProvider === 'ollama') {
				response = await fetch('http://localhost:11434/api/generate', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
					},
					body: JSON.stringify({
						model: modelSlug || 'llama3:latest',
						prompt: testPrompt,
						stream: false,
					}),
				});

				if (!response.ok) {
					throw new Error(t('llm.ollama_api_error', { status: response.status }));
				}

				const data = await response.json();
				if (!data.response) {
					throw new Error(t('llm.invalid_response_error', { provider: 'Ollama' }));
				}

				setTestResult({
					status: 'success',
					message: t('llm.connection_success', { provider: 'Ollama' }),
				});
			}
		} catch (error: any) {
			setTestResult({
				status: 'error',
				message: error.message || t('llm.connection_failed_error'),
			});
		} finally {
			setTestingLLM(false);
		}
	};

	if (!isOpen) return null;

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999]"
			role="dialog"
			aria-modal="true"
			aria-label={t('modal.aria_label')}
		>
			<div
				className="w-[780px] h-[720px] rounded-xl border shadow-2xl overflow-hidden flex flex-col"
				style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
			>
				<div className="flex border-b" style={{ borderColor: theme.colors.border }}>
					<button
						onClick={() => setActiveTab('general')}
						className={`px-4 py-4 text-sm font-bold border-b-2 cursor-pointer ${activeTab === 'general' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`}
						title={t('tabs.general')}
					>
						<Settings className="w-4 h-4" />
						{activeTab === 'general' && <span>{t('tabs.general')}</span>}
					</button>
					<button
						onClick={() => setActiveTab('display')}
						className={`px-4 py-4 text-sm font-bold border-b-2 cursor-pointer ${activeTab === 'display' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`}
						title={t('tabs.display')}
					>
						<Monitor className="w-4 h-4" />
						{activeTab === 'display' && <span>{t('tabs.display')}</span>}
					</button>
					{FEATURE_FLAGS.LLM_SETTINGS && (
						<button
							onClick={() => setActiveTab('llm')}
							className={`px-4 py-4 text-sm font-bold border-b-2 cursor-pointer ${activeTab === 'llm' ? 'border-indigo-500' : 'border-transparent'}`}
							title={t('tabs.llm')}
						>
							{t('tabs.llm')}
						</button>
					)}
					<button
						onClick={() => setActiveTab('shortcuts')}
						className={`px-4 py-4 text-sm font-bold border-b-2 cursor-pointer ${activeTab === 'shortcuts' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`}
						title={t('tabs.shortcuts')}
					>
						<Keyboard className="w-4 h-4" />
						{activeTab === 'shortcuts' && <span>{t('tabs.shortcuts')}</span>}
					</button>
					<button
						onClick={() => setActiveTab('theme')}
						className={`px-4 py-4 text-sm font-bold border-b-2 cursor-pointer ${activeTab === 'theme' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`}
						title={t('tabs.themes')}
					>
						<Palette className="w-4 h-4" />
						{activeTab === 'theme' && <span>{t('tabs.themes')}</span>}
					</button>
					<button
						onClick={() => setActiveTab('notifications')}
						className={`px-4 py-4 text-sm font-bold border-b-2 cursor-pointer ${activeTab === 'notifications' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`}
						title={t('tabs.notifications')}
					>
						<Bell className="w-4 h-4" />
						{activeTab === 'notifications' && <span>{t('tabs.notifications_short')}</span>}
					</button>
					<button
						onClick={() => setActiveTab('aicommands')}
						className={`px-4 py-4 text-sm font-bold border-b-2 cursor-pointer ${activeTab === 'aicommands' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`}
						title={t('tabs.ai_commands')}
					>
						<Cpu className="w-4 h-4" />
						{activeTab === 'aicommands' && <span>{t('tabs.ai_commands')}</span>}
					</button>
					<button
						onClick={() => setActiveTab('ssh')}
						className={`px-4 py-4 text-sm font-bold border-b-2 cursor-pointer ${activeTab === 'ssh' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`}
						title={t('tabs.ssh_hosts')}
					>
						<Server className="w-4 h-4" />
						{activeTab === 'ssh' && <span>{t('tabs.ssh_hosts')}</span>}
					</button>
					<button
						onClick={() => setActiveTab('encore')}
						className={`px-4 py-4 text-sm font-bold border-b-2 cursor-pointer ${activeTab === 'encore' ? 'border-indigo-500' : 'border-transparent'} flex items-center gap-2`}
						style={{
							color: activeTab === 'encore' ? theme.colors.textMain : theme.colors.textDim,
						}}
						title={t('tabs.encore_features')}
					>
						<FlaskConical className="w-4 h-4" />
						{activeTab === 'encore' && <span>{t('tabs.encore_features')}</span>}
					</button>
					<div className="flex-1 flex justify-end items-center pr-4">
						<button onClick={onClose} className="cursor-pointer">
							<X className="w-5 h-5 opacity-50 hover:opacity-100" />
						</button>
					</div>
				</div>

				<div className="flex-1 p-6 overflow-y-auto scrollbar-thin">
					{activeTab === 'general' && <GeneralTab theme={theme} isOpen={isOpen} />}

					{activeTab === 'display' && <DisplayTab theme={theme} />}

					{activeTab === 'llm' && FEATURE_FLAGS.LLM_SETTINGS && (
						<div className="space-y-5">
							<div>
								<div className="block text-xs font-bold opacity-70 uppercase mb-2">
									{t('llm.provider_label')}
								</div>
								<select
									value={llmProvider}
									onChange={(e) => setLlmProvider(e.target.value as LLMProvider)}
									className="w-full p-2 rounded border bg-transparent outline-none"
									style={{ borderColor: theme.colors.border }}
								>
									<option value="openrouter">{t('llm.provider_openrouter')}</option>
									<option value="anthropic">{t('llm.provider_anthropic')}</option>
									<option value="ollama">{t('llm.provider_ollama')}</option>
								</select>
							</div>

							<div>
								<div className="block text-xs font-bold opacity-70 uppercase mb-2">
									{t('llm.model_slug_label')}
								</div>
								<input
									value={modelSlug}
									onChange={(e) => setModelSlug(e.target.value)}
									className="w-full p-2 rounded border bg-transparent outline-none"
									style={{ borderColor: theme.colors.border }}
									placeholder={
										llmProvider === 'ollama' ? 'llama3:latest' : 'anthropic/claude-3.5-sonnet'
									}
								/>
							</div>

							{llmProvider !== 'ollama' && (
								<div>
									<div className="block text-xs font-bold opacity-70 uppercase mb-2">
										{t('llm.api_key_label')}
									</div>
									<div
										className="flex items-center border rounded px-3 py-2"
										style={{
											backgroundColor: theme.colors.bgMain,
											borderColor: theme.colors.border,
										}}
									>
										<Key className="w-4 h-4 mr-2 opacity-50" />
										<input
											type="password"
											value={apiKey}
											onChange={(e) => setApiKey(e.target.value)}
											className="bg-transparent flex-1 text-sm outline-none"
											placeholder="sk-..."
										/>
									</div>
									<p className="text-[10px] mt-2 opacity-50">{t('llm.api_key_help')}</p>
								</div>
							)}

							{/* Test Connection */}
							<div className="pt-4 border-t" style={{ borderColor: theme.colors.border }}>
								<button
									onClick={testLLMConnection}
									disabled={testingLLM || (llmProvider !== 'ollama' && !apiKey)}
									className="w-full py-3 rounded-lg font-bold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
									style={{
										backgroundColor: theme.colors.accent,
										color: theme.colors.accentForeground,
									}}
								>
									{testingLLM
										? t('llm.testing_connection_button')
										: t('llm.test_connection_button')}
								</button>

								{testResult.status && (
									<div
										className="mt-3 p-3 rounded-lg text-sm"
										style={{
											backgroundColor:
												testResult.status === 'success'
													? theme.colors.success + '20'
													: theme.colors.error + '20',
											color:
												testResult.status === 'success' ? theme.colors.success : theme.colors.error,
											border: `1px solid ${testResult.status === 'success' ? theme.colors.success : theme.colors.error}`,
										}}
									>
										{testResult.message}
									</div>
								)}

								<p className="text-[10px] mt-3 opacity-50 text-center">{t('llm.test_help')}</p>
							</div>
						</div>
					)}

					{activeTab === 'shortcuts' && (
						<ShortcutsTab
							theme={theme}
							hasNoAgents={hasNoAgents}
							onRecordingChange={(isRecording) => {
								isRecordingShortcutRef.current = isRecording;
							}}
						/>
					)}

					{activeTab === 'theme' && (
						<ThemeTab
							theme={theme}
							themes={themes}
							onThemeImportError={onThemeImportError}
							onThemeImportSuccess={onThemeImportSuccess}
						/>
					)}

					{activeTab === 'notifications' && (
						<NotificationsPanel
							osNotificationsEnabled={osNotificationsEnabled}
							setOsNotificationsEnabled={setOsNotificationsEnabled}
							audioFeedbackEnabled={audioFeedbackEnabled}
							setAudioFeedbackEnabled={setAudioFeedbackEnabled}
							audioFeedbackCommand={audioFeedbackCommand}
							setAudioFeedbackCommand={setAudioFeedbackCommand}
							toastDuration={toastDuration}
							setToastDuration={setToastDuration}
							theme={theme}
						/>
					)}

					{activeTab === 'aicommands' && (
						<div className="space-y-8">
							<AICommandsPanel
								theme={theme}
								customAICommands={customAICommands}
								setCustomAICommands={setCustomAICommands}
							/>

							{/* Divider */}
							<div className="border-t" style={{ borderColor: theme.colors.border }} />

							{/* Spec Kit Commands Section */}
							<SpecKitCommandsPanel theme={theme} />

							{/* Divider */}
							<div className="border-t" style={{ borderColor: theme.colors.border }} />

							{/* OpenSpec Commands Section */}
							<OpenSpecCommandsPanel theme={theme} />

							{/* System prompts note */}
							<p className="text-xs opacity-50 italic" style={{ color: theme.colors.textDim }}>
								{t('ai_commands.system_prompts_note')}
							</p>
						</div>
					)}

					{activeTab === 'ssh' && (
						<div className="space-y-5">
							<SshRemotesSection theme={theme} />
							<SshRemoteIgnoreSection
								theme={theme}
								ignorePatterns={sshRemoteIgnorePatterns}
								onIgnorePatternsChange={setSshRemoteIgnorePatterns}
								honorGitignore={sshRemoteHonorGitignore}
								onHonorGitignoreChange={setSshRemoteHonorGitignore}
							/>
						</div>
					)}

					{activeTab === 'encore' && <EncoreTab theme={theme} isOpen={isOpen} />}
				</div>
			</div>
		</div>
	);
});
