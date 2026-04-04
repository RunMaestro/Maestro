import { useState, useEffect, useRef, useCallback, memo } from 'react';
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
	Globe,
	Users,
} from 'lucide-react';
import { useSettings } from '../../hooks';
import type { Theme, LLMProvider } from '../../types';
import { useLayerStack } from '../../contexts/LayerStackContext';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { AICommandsPanel } from '../AICommandsPanel';
import { SpecKitCommandsPanel } from '../SpecKitCommandsPanel';
import { OpenSpecCommandsPanel } from '../OpenSpecCommandsPanel';
import { BmadCommandsPanel } from '../BmadCommandsPanel';
import { NotificationsPanel } from '../NotificationsPanel';
import { SshRemotesSection } from './SshRemotesSection';
import { SshRemoteIgnoreSection } from './SshRemoteIgnoreSection';
import { GeneralTab } from './tabs/GeneralTab';
import { DisplayTab } from './tabs/DisplayTab';
import { EncoreTab } from './tabs/EncoreTab';
import { ShortcutsTab } from './tabs/ShortcutsTab';
import { ThemeTab } from './tabs/ThemeTab';
import { EnvironmentTab } from './tabs/EnvironmentTab';
import { useSettingsSearch, SettingsSearchInput, SettingsSearchResults } from './SettingsSearch';
import type { SearchableSetting } from './searchableSettings';

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
		| 'groupchat'
		| 'ssh'
		| 'environment'
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
		// Group Chat settings
		moderatorStandingInstructions,
		setModeratorStandingInstructions,
	} = useSettings();

	const [activeTab, setActiveTab] = useState<
		| 'general'
		| 'display'
		| 'llm'
		| 'shortcuts'
		| 'theme'
		| 'notifications'
		| 'aicommands'
		| 'groupchat'
		| 'ssh'
		| 'environment'
		| 'encore'
	>('general');
	const [testingLLM, setTestingLLM] = useState(false);
	const [testResult, setTestResult] = useState<{
		status: 'success' | 'error' | null;
		message: string;
	}>({ status: null, message: '' });
	// Search state
	const [searchActive, setSearchActive] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);

	const handleSearchActiveChange = useCallback((active: boolean) => {
		setSearchActive(active);
	}, []);

	const search = useSettingsSearch({ isOpen, onSearchActiveChange: handleSearchActiveChange });

	const handleSearchNavigate = useCallback(
		(tab: SearchableSetting['tab'], settingId: string) => {
			search.setQuery('');
			setActiveTab(tab);
			// Double-RAF to ensure DOM has rendered the new tab content before scrolling
			requestAnimationFrame(() => {
				requestAnimationFrame(() => {
					const el = contentRef.current?.querySelector(`[data-setting-id="${settingId}"]`);
					if (el) {
						el.scrollIntoView({ behavior: 'smooth', block: 'center' });
						// Brief highlight flash
						el.classList.add('settings-search-highlight');
						setTimeout(() => el.classList.remove('settings-search-highlight'), 1500);
					}
				});
			});
		},
		[search]
	);

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
			ariaLabel: 'Settings',
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
				| 'groupchat'
				| 'ssh'
				| 'environment'
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
						'groupchat',
						'ssh',
						'environment',
						'encore',
					]
				: [
						'general',
						'display',
						'shortcuts',
						'theme',
						'notifications',
						'aicommands',
						'groupchat',
						'ssh',
						'environment',
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
					throw new Error('API key is required for OpenRouter');
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
					throw new Error(error.error?.message || `OpenRouter API error: ${response.status}`);
				}

				const data = await response.json();
				if (!data.choices?.[0]?.message?.content) {
					throw new Error('Invalid response from OpenRouter');
				}

				setTestResult({
					status: 'success',
					message: 'Successfully connected to OpenRouter!',
				});
			} else if (llmProvider === 'anthropic') {
				if (!apiKey) {
					throw new Error('API key is required for Anthropic');
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
					throw new Error(error.error?.message || `Anthropic API error: ${response.status}`);
				}

				const data = await response.json();
				if (!data.content?.[0]?.text) {
					throw new Error('Invalid response from Anthropic');
				}

				setTestResult({
					status: 'success',
					message: 'Successfully connected to Anthropic!',
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
					throw new Error(
						`Ollama API error: ${response.status}. Make sure Ollama is running locally.`
					);
				}

				const data = await response.json();
				if (!data.response) {
					throw new Error('Invalid response from Ollama');
				}

				setTestResult({
					status: 'success',
					message: 'Successfully connected to Ollama!',
				});
			}
		} catch (error: any) {
			setTestResult({
				status: 'error',
				message: error.message || 'Connection failed',
			});
		} finally {
			setTestingLLM(false);
		}
	};

	if (!isOpen) return null;

	const TAB_ITEMS: Array<{
		id: typeof activeTab;
		label: string;
		icon: typeof Settings;
		featureFlag?: boolean;
	}> = [
		{ id: 'general', label: 'General', icon: Settings },
		{ id: 'display', label: 'Display', icon: Monitor },
		...(FEATURE_FLAGS.LLM_SETTINGS ? [{ id: 'llm' as const, label: 'LLM', icon: Key }] : []),
		{ id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
		{ id: 'theme', label: 'Themes', icon: Palette },
		{ id: 'notifications', label: 'Notifications', icon: Bell },
		{ id: 'aicommands', label: 'AI Commands', icon: Cpu },
		{ id: 'groupchat', label: 'Group Chat', icon: Users },
		{ id: 'ssh', label: 'SSH Hosts', icon: Server },
		{ id: 'environment', label: 'Environment', icon: Globe },
		{ id: 'encore', label: 'Encore Features', icon: FlaskConical },
	];

	return (
		<div
			className="fixed inset-0 modal-overlay flex items-center justify-center z-[9999]"
			role="dialog"
			aria-modal="true"
			aria-label="Settings"
		>
			<div
				className="w-[960px] h-[720px] rounded-xl border shadow-2xl overflow-hidden flex flex-col"
				style={{ backgroundColor: theme.colors.bgSidebar, borderColor: theme.colors.border }}
			>
				{/* Search Bar + Close Button */}
				<div className="flex items-center border-b" style={{ borderColor: theme.colors.border }}>
					<div className="flex-1">
						<SettingsSearchInput
							theme={theme}
							query={search.query}
							setQuery={search.setQuery}
							inputRef={search.inputRef}
							isActive={search.isActive}
							results={search.results}
							onClear={search.clear}
						/>
					</div>
					<button onClick={onClose} className="cursor-pointer px-4">
						<X className="w-5 h-5 opacity-50 hover:opacity-100" />
					</button>
				</div>

				{/* Search Results (replaces sidebar+content when active) */}
				{searchActive && (
					<SettingsSearchResults
						theme={theme}
						query={search.query}
						results={search.results}
						onNavigate={handleSearchNavigate}
					/>
				)}

				{/* Body: Sidebar + Content */}
				<div className={`flex flex-1 overflow-hidden ${searchActive ? 'hidden' : ''}`}>
					{/* Left Sidebar Tabs */}
					<nav
						className="w-[180px] flex-shrink-0 border-r py-2 overflow-y-auto scrollbar-thin"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
						aria-label="Settings tabs"
					>
						{TAB_ITEMS.map((tab) => {
							const Icon = tab.icon;
							const isActive = activeTab === tab.id;
							return (
								<button
									key={tab.id}
									onClick={() => setActiveTab(tab.id)}
									className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm text-left transition-colors cursor-pointer ${isActive ? 'font-bold' : 'opacity-70 hover:opacity-100'}`}
									style={{
										backgroundColor: isActive ? theme.colors.bgActivity : 'transparent',
										color: isActive ? theme.colors.accent : theme.colors.textMain,
										borderRight: isActive
											? `2px solid ${theme.colors.accent}`
											: '2px solid transparent',
									}}
									title={tab.label}
								>
									<Icon className="w-4 h-4 flex-shrink-0" />
									<span className="truncate">{tab.label}</span>
								</button>
							);
						})}
					</nav>

					{/* Content Area */}
					<div ref={contentRef} className="flex-1 p-6 overflow-y-auto scrollbar-thin">
						{activeTab === 'general' && <GeneralTab theme={theme} isOpen={isOpen} />}

						{activeTab === 'display' && <DisplayTab theme={theme} />}

						{activeTab === 'llm' && FEATURE_FLAGS.LLM_SETTINGS && (
							<div className="space-y-5">
								<div>
									<div className="block text-xs font-bold opacity-70 uppercase mb-2">
										LLM Provider
									</div>
									<select
										value={llmProvider}
										onChange={(e) => setLlmProvider(e.target.value as LLMProvider)}
										className="w-full p-2 rounded border bg-transparent outline-none"
										style={{ borderColor: theme.colors.border }}
									>
										<option value="openrouter">OpenRouter</option>
										<option value="anthropic">Anthropic</option>
										<option value="ollama">Ollama (Local)</option>
									</select>
								</div>

								<div>
									<div className="block text-xs font-bold opacity-70 uppercase mb-2">
										Model Slug
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
										<div className="block text-xs font-bold opacity-70 uppercase mb-2">API Key</div>
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
										<p className="text-[10px] mt-2 opacity-50">
											Keys are stored locally in ~/.maestro/settings.json
										</p>
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
										{testingLLM ? 'Testing Connection...' : 'Test Connection'}
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
													testResult.status === 'success'
														? theme.colors.success
														: theme.colors.error,
												border: `1px solid ${testResult.status === 'success' ? theme.colors.success : theme.colors.error}`,
											}}
										>
											{testResult.message}
										</div>
									)}

									<p className="text-[10px] mt-3 opacity-50 text-center">
										Test sends a simple prompt to verify connectivity and configuration
									</p>
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
								<div data-setting-id="aicommands-custom">
									<AICommandsPanel
										theme={theme}
										customAICommands={customAICommands}
										setCustomAICommands={setCustomAICommands}
									/>
								</div>

								{/* Divider */}
								<div className="border-t" style={{ borderColor: theme.colors.border }} />

								{/* Spec Kit Commands Section */}
								<div data-setting-id="aicommands-speckit">
									<SpecKitCommandsPanel theme={theme} />
								</div>

								{/* Divider */}
								<div className="border-t" style={{ borderColor: theme.colors.border }} />

								{/* OpenSpec Commands Section */}
								<div data-setting-id="aicommands-openspec">
									<OpenSpecCommandsPanel theme={theme} />
								</div>

								{/* Divider */}
								<div className="border-t" style={{ borderColor: theme.colors.border }} />

								{/* BMAD Commands Section */}
								<div data-setting-id="aicommands-bmad">
									<BmadCommandsPanel theme={theme} />
								</div>
							</div>
						)}

						{activeTab === 'groupchat' && (
							<div className="space-y-5">
								<div>
									<h3
										className="text-sm font-bold uppercase tracking-wider mb-1"
										style={{ color: theme.colors.textMain }}
									>
										Moderator Standing Instructions
									</h3>
									<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
										These instructions are included in every group chat moderator prompt. Use them
										for standing practices like branch workflows, autorun setup, or coding
										standards.
									</p>
									<textarea
										value={moderatorStandingInstructions}
										onChange={(e) => setModeratorStandingInstructions(e.target.value)}
										placeholder={`Example:\n- Always instruct agents to work in git branches, not directly on main\n- When delegating tasks, tell agents to enable autorun with: /autorun on\n- Prefer TypeScript strict mode in all new files`}
										className="w-full p-3 rounded border bg-transparent outline-none resize-vertical text-sm font-mono"
										style={{
											borderColor: theme.colors.border,
											color: theme.colors.textMain,
											minHeight: '150px',
										}}
										maxLength={2000}
										rows={8}
									/>
									<div className="text-xs mt-1 text-right" style={{ color: theme.colors.textDim }}>
										{moderatorStandingInstructions.length} / 2000
									</div>
								</div>
							</div>
						)}

						{activeTab === 'ssh' && (
							<div className="space-y-5">
								<div data-setting-id="ssh-remotes">
									<SshRemotesSection theme={theme} />
								</div>
								<div data-setting-id="ssh-ignore-patterns">
									<SshRemoteIgnoreSection
										theme={theme}
										ignorePatterns={sshRemoteIgnorePatterns}
										onIgnorePatternsChange={setSshRemoteIgnorePatterns}
										honorGitignore={sshRemoteHonorGitignore}
										onHonorGitignoreChange={setSshRemoteHonorGitignore}
									/>
								</div>
							</div>
						)}

						{activeTab === 'environment' && <EnvironmentTab theme={theme} />}

						{activeTab === 'encore' && <EncoreTab theme={theme} isOpen={isOpen} />}
					</div>
				</div>
			</div>
		</div>
	);
});
