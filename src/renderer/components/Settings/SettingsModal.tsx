import { useState, useEffect, useLayoutEffect, useRef, useCallback, memo } from 'react';
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
	Wand2,
	Info,
} from 'lucide-react';
import { useSettings } from '../../hooks';
import type { Theme, LLMProvider } from '../../types';
import { useModalLayer } from '../../hooks/ui/useModalLayer';
import { MODAL_PRIORITIES } from '../../constants/modalPriorities';
import { AICommandsPanel } from '../AICommandsPanel';
import { MaestroPromptsTab } from './tabs/MaestroPromptsTab';
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
import { AboutTab } from './tabs/AboutTab';
import { useSettingsSearch, SettingsSearchInput, SettingsSearchResults } from './SettingsSearch';
import type { SearchableSetting } from './searchableSettings';

// Feature flags - set to true to enable dormant features
const FEATURE_FLAGS = {
	LLM_SETTINGS: false, // LLM provider configuration (OpenRouter, Anthropic, Ollama)
};

type SettingsTabId =
	| 'about'
	| 'general'
	| 'display'
	| 'llm'
	| 'shortcuts'
	| 'theme'
	| 'notifications'
	| 'aicommands'
	| 'ssh'
	| 'environment'
	| 'encore'
	| 'prompts';

// Alphabetized by label (case-insensitive) so the sidebar reads predictably
// regardless of which tabs ship. Mount-time default is still 'general'  -
// that's enforced by the useState init below, not by list position.
const TAB_ITEMS: Array<{
	id: SettingsTabId;
	label: string;
	icon: typeof Settings;
}> = [
	{ id: 'about', label: 'About', icon: Info },
	{ id: 'aicommands', label: 'AI Commands', icon: Cpu },
	{ id: 'display', label: 'Display', icon: Monitor },
	{ id: 'encore', label: 'Encore Features', icon: FlaskConical },
	{ id: 'environment', label: 'Environment', icon: Globe },
	{ id: 'general', label: 'General', icon: Settings },
	{ id: 'prompts', label: 'Maestro Prompts', icon: Wand2 },
	{ id: 'notifications', label: 'Notifications', icon: Bell },
	{ id: 'shortcuts', label: 'Shortcuts', icon: Keyboard },
	{ id: 'ssh', label: 'SSH Hosts', icon: Server },
	{ id: 'theme', label: 'Themes', icon: Palette },
];

const LLM_TAB_ITEM = { id: 'llm' as const, label: 'LLM', icon: Key };

function getTabItems(llmSettingsEnabled: boolean): typeof TAB_ITEMS {
	if (!llmSettingsEnabled) return TAB_ITEMS;
	return [...TAB_ITEMS.slice(0, 6), LLM_TAB_ITEM, ...TAB_ITEMS.slice(6)];
}

// In-memory only - last tab the user was on. Resets on app restart, so the
// modal still defaults to General on a fresh launch. Honors any explicit
// `initialTab` prop (e.g. when a caller deep-links into a specific tab).
let lastOpenSettingsTab: SettingsTabId | null = null;

// In-memory only - last vertical scroll position per tab. Pairs with
// lastOpenSettingsTab so the user can reopen Settings (or flip between tabs)
// and land exactly where they were, instead of having to re-find the control
// they were tweaking. Resets on app restart.
const lastTabScrollPositions = new Map<SettingsTabId, number>();

// Test-only: reset the remembered tab so suites that assume a fresh open
// (e.g. "modal opens to General") aren't polluted by prior tests in the file.
export function __resetLastOpenSettingsTabForTests(): void {
	lastOpenSettingsTab = null;
	lastTabScrollPositions.clear();
}

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
		| 'environment'
		| 'encore'
		| 'prompts';
	initialSelectedPromptId?: string;
	hasNoAgents?: boolean;
	featureFlags?: {
		llmSettings?: boolean;
	};
	onThemeImportError?: (message: string) => void;
	onThemeImportSuccess?: (message: string) => void;
}

export async function testSettingsLlmConnection({
	llmProvider,
	apiKey,
	modelSlug,
	fetchImpl = fetch,
}: {
	llmProvider: LLMProvider;
	apiKey: string;
	modelSlug: string;
	fetchImpl?: typeof fetch;
}): Promise<{ status: 'success' | 'error'; message: string }> {
	try {
		const testPrompt = 'Respond with exactly: "Connection successful"';

		if (llmProvider === 'openrouter') {
			if (!apiKey) throw new Error('API key is required for OpenRouter');

			const response = await fetchImpl('https://openrouter.ai/api/v1/chat/completions', {
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

			return { status: 'success', message: 'Successfully connected to OpenRouter!' };
		}

		if (llmProvider === 'anthropic') {
			if (!apiKey) throw new Error('API key is required for Anthropic');

			const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
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

			return { status: 'success', message: 'Successfully connected to Anthropic!' };
		}

		if (llmProvider === 'ollama') {
			const response = await fetchImpl('http://localhost:11434/api/generate', {
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

			return { status: 'success', message: 'Successfully connected to Ollama!' };
		}

		return { status: 'error', message: 'Unsupported LLM provider' };
	} catch (error: any) {
		return {
			status: 'error',
			message: error.message || 'Connection failed',
		};
	}
}

export const SettingsModal = memo(function SettingsModal(props: SettingsModalProps) {
	const {
		isOpen,
		onClose,
		theme,
		themes,
		initialTab,
		initialSelectedPromptId,
		hasNoAgents,
		featureFlags,
		onThemeImportError,
		onThemeImportSuccess,
	} = props;
	const llmSettingsEnabled = featureFlags?.llmSettings ?? FEATURE_FLAGS.LLM_SETTINGS;
	const tabItems = getTabItems(llmSettingsEnabled);

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
		toastWidth,
		setToastWidth,
		idleNotificationEnabled,
		setIdleNotificationEnabled,
		idleNotificationCommand,
		setIdleNotificationCommand,
		// AI Commands
		customAICommands,
		setCustomAICommands,
		speckitEnabled,
		setSpeckitEnabled,
		openspecEnabled,
		setOpenspecEnabled,
		bmadEnabled,
		setBmadEnabled,
		// SSH Remote file indexing settings
		sshRemoteIgnorePatterns,
		setSshRemoteIgnorePatterns,
		sshRemoteHonorGitignore,
		setSshRemoteHonorGitignore,
	} = useSettings();

	// Lazy init reads the remembered tab on mount. Doing this in useState (rather
	// than a restore effect) avoids racing with the persist effect below - under
	// React StrictMode a restore-via-effect double-fires and clobbers the saved
	// value with the initial 'general' before the restored value lands.
	const [activeTab, setActiveTab] = useState<SettingsTabId>(
		() => initialTab || lastOpenSettingsTab || 'general'
	);
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

	// Hold setQuery in a ref so handleSearchNavigate doesn't depend on `search`
	// (which is created below and itself takes onNavigate as input).
	const setQueryRef = useRef<(q: string) => void>(() => {});

	// Stash theme accent in a ref so handleSearchNavigate stays stable across renders
	const jumpAccentRef = useRef(theme.colors.accent);
	jumpAccentRef.current = theme.colors.accent;

	// Pending scroll target - set when the user picks a search result, consumed
	// by the effect below once the content panel is actually visible and the
	// target tab has rendered. Doing this via state-driven effect (not RAF
	// chains) avoids a race where scrollIntoView fires while the content div
	// still has `hidden` / display:none from search mode, silently no-opping.
	const pendingScrollIdRef = useRef<string | null>(null);

	const handleSearchNavigate = useCallback((tab: SearchableSetting['tab'], settingId: string) => {
		pendingScrollIdRef.current = settingId;
		setQueryRef.current('');
		setActiveTab(tab);
	}, []);

	useEffect(() => {
		const targetId = pendingScrollIdRef.current;
		if (!targetId || searchActive) return;

		let cancelled = false;
		let attempts = 0;
		const MAX_ATTEMPTS = 30; // ~500ms at 60fps - enough for tab content + lazy renders

		const tryScroll = () => {
			if (cancelled) return;
			const el = contentRef.current?.querySelector<HTMLElement>(`[data-setting-id="${targetId}"]`);
			// offsetParent is null while any ancestor is display:none - the most
			// common reason scroll fails right after exiting search mode.
			if (el && el.offsetParent !== null) {
				pendingScrollIdRef.current = null;
				el.scrollIntoView({ behavior: 'smooth', block: 'center' });
				// Themed arrow indicator + outline flash; duration must match the
				// 3s animations in .settings-search-highlight / ::before.
				el.style.setProperty('--settings-search-jump-color', jumpAccentRef.current);
				el.classList.add('settings-search-highlight');
				setTimeout(() => {
					el.classList.remove('settings-search-highlight');
					el.style.removeProperty('--settings-search-jump-color');
				}, 3000);
				return;
			}
			if (attempts++ < MAX_ATTEMPTS) {
				requestAnimationFrame(tryScroll);
			} else {
				pendingScrollIdRef.current = null;
			}
		};
		requestAnimationFrame(tryScroll);
		return () => {
			cancelled = true;
		};
	}, [searchActive, activeTab]);

	const search = useSettingsSearch({
		isOpen,
		onSearchActiveChange: handleSearchActiveChange,
		onNavigate: handleSearchNavigate,
	});
	setQueryRef.current = search.setQuery;

	// Layer stack integration
	const isRecordingShortcutRef = useRef(false);
	const promptsEscapeHandlerRef = useRef<(() => boolean) | null>(null);

	// Honor a deep-link initialTab change while the modal is already mounted
	// (e.g. caller switches tab without closing). Mount-time restoration is
	// handled by the lazy useState init above, not here.
	useEffect(() => {
		if (isOpen && initialTab) {
			setActiveTab(initialTab);
		}
	}, [isOpen, initialTab]);

	// Persist the current tab in module memory so the next open lands here.
	// In-memory only - resets on app restart by design.
	useEffect(() => {
		lastOpenSettingsTab = activeTab;
	}, [activeTab]);

	// Restore the per-tab scroll position whenever the active tab changes (or
	// the modal reopens on a remembered tab). useLayoutEffect runs after the
	// new tab's content has committed to the DOM but before paint, so the
	// scroll lands without a visible flash at the top. `behavior: 'auto'` is
	// intentional - smooth-scrolling on tab switch reads as sluggish.
	useLayoutEffect(() => {
		if (!isOpen) return;
		const el = contentRef.current;
		if (!el) return;
		const saved = lastTabScrollPositions.get(activeTab) ?? 0;
		el.scrollTop = saved;
	}, [activeTab, isOpen]);

	// Save scroll position for the currently active tab on every scroll event.
	// Direct map write is cheap; no throttling needed. Pairs with the restore
	// effect above so the user can tweak a setting low in a long panel, flip
	// to another tab to verify the effect, and come back to exactly the same
	// position.
	const handleContentScroll = useCallback(
		(e: React.UIEvent<HTMLDivElement>) => {
			lastTabScrollPositions.set(activeTab, e.currentTarget.scrollTop);
		},
		[activeTab]
	);

	// Store onClose in a ref to avoid re-registering layer when onClose changes
	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;

	// Register layer when modal opens
	useModalLayer(
		MODAL_PRIORITIES.SETTINGS,
		'Settings',
		() => {
			// If recording a shortcut, ShortcutsTab handles its own escape via onKeyDownCapture
			if (isRecordingShortcutRef.current) return;
			// Let prompts tab handle layered escape (help -> expanded -> list -> close)
			if (promptsEscapeHandlerRef.current?.()) return;
			onCloseRef.current();
		},
		{ enabled: isOpen }
	);

	// Tab navigation with Cmd+Shift+[ and ]
	useEffect(() => {
		if (!isOpen) return;

		const handleTabNavigation = (e: KeyboardEvent) => {
			const tabs = tabItems.map((t) => t.id);
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
	}, [isOpen, activeTab, tabItems]);

	const testLLMConnection = async () => {
		setTestingLLM(true);
		setTestResult({ status: null, message: '' });

		try {
			const result = await testSettingsLlmConnection({
				llmProvider,
				apiKey,
				modelSlug,
			});
			setTestResult(result);
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
			aria-label="Settings"
		>
			<div
				className="h-[900px] rounded-xl border shadow-2xl overflow-hidden flex flex-col select-none"
				style={{
					width: 'min(calc(980px * var(--font-scale, 1)), 95vw)',
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
				}}
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
					<button onClick={onClose} className="cursor-pointer pl-4 pr-6">
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
						selectedIndex={search.selectedIndex}
						setSelectedIndex={search.setSelectedIndex}
					/>
				)}

				{/* Body: Sidebar + Content */}
				<div className={`flex flex-1 overflow-hidden ${searchActive ? 'hidden' : ''}`}>
					{/* Left Sidebar Tabs */}
					<nav
						className="w-[248px] flex-shrink-0 border-r py-2 overflow-y-auto scrollbar-thin"
						style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
						aria-label="Settings tabs"
					>
						{tabItems.map((tab) => {
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
									<span className="whitespace-nowrap">{tab.label}</span>
								</button>
							);
						})}
					</nav>

					{/* Content Area */}
					<div
						ref={contentRef}
						onScroll={handleContentScroll}
						className="flex-1 p-6 overflow-y-auto scrollbar-thin"
					>
						{activeTab === 'general' && <GeneralTab theme={theme} isOpen={isOpen} />}

						{activeTab === 'display' && <DisplayTab theme={theme} />}

						{activeTab === 'llm' && llmSettingsEnabled && (
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
								toastWidth={toastWidth}
								setToastWidth={setToastWidth}
								idleNotificationEnabled={idleNotificationEnabled}
								setIdleNotificationEnabled={setIdleNotificationEnabled}
								idleNotificationCommand={idleNotificationCommand}
								setIdleNotificationCommand={setIdleNotificationCommand}
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
									<SpecKitCommandsPanel
										theme={theme}
										enabled={speckitEnabled}
										onEnabledChange={setSpeckitEnabled}
									/>
								</div>

								{/* Divider */}
								<div className="border-t" style={{ borderColor: theme.colors.border }} />

								{/* OpenSpec Commands Section */}
								<div data-setting-id="aicommands-openspec">
									<OpenSpecCommandsPanel
										theme={theme}
										enabled={openspecEnabled}
										onEnabledChange={setOpenspecEnabled}
									/>
								</div>

								{/* Divider */}
								<div className="border-t" style={{ borderColor: theme.colors.border }} />

								{/* BMAD Commands Section */}
								<div data-setting-id="aicommands-bmad">
									<BmadCommandsPanel
										theme={theme}
										enabled={bmadEnabled}
										onEnabledChange={setBmadEnabled}
									/>
								</div>
							</div>
						)}

						{activeTab === 'prompts' && (
							<div data-setting-id="prompts-editor" className="prompts-editor-wrapper">
								<MaestroPromptsTab
									theme={theme}
									initialSelectedPromptId={initialSelectedPromptId}
									onEscapeHandled={(handler) => {
										promptsEscapeHandlerRef.current = handler;
									}}
								/>
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

						{activeTab === 'about' && <AboutTab theme={theme} />}
					</div>
				</div>
			</div>
		</div>
	);
});
