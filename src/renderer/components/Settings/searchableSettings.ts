/**
 * Searchable Settings Registry
 *
 * Each tab exports its searchable settings entries. The SettingsModal
 * composes them into a single flat list for cross-tab search.
 *
 * When adding or editing an entry, ensure `keywords` covers every visible
 * string a user would type after seeing the section in the UI - section
 * headings, sub-headings, and notable button labels. The DOM-parity test in
 * searchableSettings.test.ts catches missing entries, but it cannot catch
 * keyword drift from rendered text. Add a query to the `it.each` block in
 * that test for any new visible string you want guaranteed-findable.
 */

export interface SearchableSetting {
	/** Unique id used as data-setting-id on the DOM element */
	id: string;
	/** Which tab this setting lives in */
	tab:
		| 'about'
		| 'general'
		| 'display'
		| 'shortcuts'
		| 'theme'
		| 'notifications'
		| 'aicommands'
		| 'ssh'
		| 'environment'
		| 'encore'
		| 'prompts';
	/** Human-readable tab label */
	tabLabel: string;
	/** The setting's visible title */
	label: string;
	/** Optional description text (shown below the title in UI) */
	description?: string;
	/** Extra keywords for search matching (not displayed) */
	keywords?: string[];
}

// ---------------------------------------------------------------------------
// General Tab
// ---------------------------------------------------------------------------
export const GENERAL_SETTINGS: SearchableSetting[] = [
	{
		id: 'general-conductor-profile',
		tab: 'general',
		tabLabel: 'General',
		label: 'Conductor Profile (About Me)',
		description: 'Tell agents about yourself so they know how to work with you',
		keywords: ['profile', 'about me', 'conductor', 'persona', 'bio'],
	},
	{
		id: 'general-global-show-hotkey',
		tab: 'general',
		tabLabel: 'General',
		label: 'Global Hotkey to Show Maestro',
		description: 'System-wide shortcut that summons the Maestro window from any app',
		keywords: [
			'hotkey',
			'global',
			'shortcut',
			'summon',
			'show',
			'focus',
			'foreground',
			'system-wide',
			'systemwide',
			'keyboard',
			'accelerator',
			'bring to front',
		],
	},
	{
		id: 'general-default-shell',
		tab: 'general',
		tabLabel: 'General',
		label: 'Default Terminal Shell',
		description:
			'Choose which shell to use for terminal sessions; configure custom shell path and arguments',
		keywords: [
			'shell',
			'bash',
			'zsh',
			'fish',
			'terminal',
			'powershell',
			'cmd',
			'pwsh',
			'path',
			'args',
			'arguments',
			'custom shell',
			'sh',
			'login shell',
		],
	},
	{
		id: 'general-log-level',
		tab: 'general',
		tabLabel: 'General',
		label: 'System Log Level',
		description: 'Higher levels show fewer logs. Debug shows all logs, Error shows only errors',
		keywords: ['log', 'debug', 'info', 'warn', 'error', 'verbosity', 'logging'],
	},
	{
		id: 'general-gh-path',
		tab: 'general',
		tabLabel: 'General',
		label: 'GitHub CLI (gh) Path',
		description: 'Specify the full path to the gh binary for Auto Run worktree features',
		keywords: ['github', 'gh', 'cli', 'git', 'path', 'worktree', 'binary'],
	},
	{
		id: 'general-maestro-cli',
		tab: 'general',
		tabLabel: 'General',
		label: 'Maestro CLI',
		description: 'Check PATH/version and install or update maestro-cli for the current user',
		keywords: ['maestro-cli', 'cli', 'path', 'version', 'install', 'update'],
	},
	{
		id: 'general-input-behavior',
		tab: 'general',
		tabLabel: 'General',
		label: 'Input Send Behavior',
		description:
			'Configure how to send messages (Enter or Cmd+Enter), AI Interaction Mode, the Expanded Prompt Composer (Shift+Enter), and Forced Parallel Execution',
		keywords: [
			'enter',
			'send',
			'input',
			'submit',
			'keyboard',
			'newline',
			'parallel',
			'forced parallel execution',
			'busy',
			'concurrent',
			'shift',
			'shift+enter',
			'composer',
			'prompt composer',
			'expanded composer',
			'mode',
			'ai interaction mode',
			'cmd+enter',
			'always force send',
			'send trigger',
			'modifier',
		],
	},
	{
		id: 'general-autorun-inactivity-timeout',
		tab: 'general',
		tabLabel: 'General',
		label: 'Auto Run Inactivity Timeout',
		description:
			'Auto Run force-kills a task if the agent produces no output for this many minutes - useful for long refactors, heavy test runs, or web-research tasks',
		keywords: [
			'autorun',
			'auto run',
			'inactivity',
			'timeout',
			'stalled',
			'minutes',
			'watchdog',
			'kill',
			'refactor',
			'test',
			'research',
			'long running',
		],
	},
	{
		id: 'general-autorun-max-task-duration',
		tab: 'general',
		tabLabel: 'General',
		label: 'Auto Run Max Task Duration',
		description:
			'Absolute cap on how long a single Auto Run task may run regardless of output. Catches a stuck-but-chatty agent that keeps emitting yet never finishes and would otherwise hang the whole run',
		keywords: [
			'autorun',
			'auto run',
			'max',
			'maximum',
			'duration',
			'timeout',
			'cap',
			'minutes',
			'watchdog',
			'kill',
			'hang',
			'stuck',
			'long running',
		],
	},
	{
		id: 'general-history',
		tab: 'general',
		tabLabel: 'General',
		label: 'Default History Toggle',
		description:
			'Enable "History" by default for new tabs, saving a synopsis after each completion',
		keywords: ['history', 'synopsis', 'save', 'toggle'],
	},
	{
		id: 'general-synopsis-debounce',
		tab: 'general',
		tabLabel: 'General',
		label: 'Synopsis Debounce',
		description:
			'Idle time to wait before generating a History synopsis; coalesces rapid completions into one',
		keywords: ['synopsis', 'debounce', 'coalesce', 'history', 'delay', 'throttle', 'idle'],
	},
	{
		id: 'general-thinking-mode',
		tab: 'general',
		tabLabel: 'General',
		label: 'Default Thinking Mode',
		description:
			'Show AI thinking/reasoning content for new tabs - Off, On, or Sticky. Off shows only final responses.',
		keywords: [
			'thinking',
			'reasoning',
			'chain of thought',
			'streaming',
			'sticky',
			'off',
			'on',
			'response',
			'final',
		],
	},
	{
		id: 'general-tool-calls',
		tab: 'general',
		tabLabel: 'General',
		label: 'Tool Calls',
		description:
			'Show or hide tool-call activity (tool badges and their input/output) in AI responses.',
		keywords: [
			'tool',
			'tools',
			'tool call',
			'tool calls',
			'tool activity',
			'badge',
			'wrench',
			'hide',
			'show',
			'function call',
		],
	},
	{
		id: 'general-tab-behavior',
		tab: 'general',
		tabLabel: 'General',
		label: 'Tab Behavior',
		description: 'Automatic tab naming and where new tabs are placed in the tab bar',
		keywords: [
			'tab',
			'name',
			'naming',
			'auto',
			'rename',
			'title',
			'placement',
			'new tab',
			'new browser',
			'browser tab',
			'new terminal',
			'opened file',
			'file tab',
			'terminal tab',
			'position',
			'order',
			'right',
			'end',
		],
	},
	{
		id: 'general-spell-check',
		tab: 'general',
		tabLabel: 'General',
		label: 'Enable spell checking',
		description:
			'Show spell check suggestions in input areas (prompt input, group chat, file editor). Disabled by default.',
		keywords: [
			'spell',
			'spell check',
			'spelling',
			'spellcheck',
			'dictionary',
			'autocorrect',
			'suggestions',
			'typo',
			'red underline',
			'input',
			'prompt input',
			'group chat',
			'file editor',
		],
	},
	{
		id: 'general-power',
		tab: 'general',
		tabLabel: 'General',
		label: 'Prevent Sleep While Working',
		description:
			'Keeps your computer awake when AI agents are busy, Auto Run is active, or Cue pipelines are scheduled',
		keywords: [
			'sleep',
			'power',
			'awake',
			'prevent sleep',
			'caffeine',
			'battery',
			'cue',
			'pipeline',
			'idle',
			'wake',
		],
	},
	{
		id: 'general-rendering',
		tab: 'general',
		tabLabel: 'General',
		label: 'Rendering Options',
		description: 'GPU acceleration and confetti animations',
		keywords: ['gpu', 'rendering', 'acceleration', 'confetti', 'animation', 'hardware'],
	},
	{
		id: 'general-auto-resume',
		tab: 'general',
		tabLabel: 'General',
		label: 'Resume Paused Sessions on Limit',
		description:
			'Automatically resume agents that paused on a token, API, or credit limit once the provider window reopens',
		keywords: [
			'resume',
			'limit',
			'credit',
			'token',
			'rate limit',
			'quota',
			'auto resume',
			'exhaustion',
			'paused',
		],
	},
	{
		id: 'general-auto-resume-interval',
		tab: 'general',
		tabLabel: 'General',
		label: 'Auto-Resume Check Interval',
		description:
			'How often to probe for credit/limit availability before resuming paused agents, and how long to keep trying before giving up',
		keywords: [
			'resume',
			'limit',
			'credit',
			'token',
			'rate limit',
			'quota',
			'auto resume',
			'exhaustion',
			'paused',
			'interval',
			'give up',
		],
	},
	{
		id: 'general-updates',
		tab: 'general',
		tabLabel: 'General',
		label: 'Check for Updates on Startup',
		description: 'Automatically check for new Maestro versions when the app starts',
		keywords: ['update', 'check', 'startup', 'version', 'auto update'],
	},
	{
		id: 'general-beta-updates',
		tab: 'general',
		tabLabel: 'General',
		label: 'Pre-release Channel',
		description: 'Include beta and release candidate updates',
		keywords: ['beta', 'pre-release', 'rc', 'release candidate', 'canary'],
	},
	{
		id: 'general-crash-reporting',
		tab: 'general',
		tabLabel: 'General',
		label: 'Send Anonymous Crash Reports',
		description: 'Help improve Maestro by automatically sending crash reports',
		keywords: ['crash', 'reporting', 'privacy', 'telemetry', 'sentry', 'anonymous'],
	},
	{
		id: 'general-browser',
		tab: 'general',
		tabLabel: 'General',
		label: 'Default Browser',
		description:
			'Choose whether links open in the Maestro built-in browser tab or the system browser. Ctrl+click (or right-click context menu) inverts the behavior. Set the default URL for new browser tabs.',
		keywords: [
			'browser',
			'links',
			'external',
			'system',
			'internal',
			'url',
			'open',
			'ctrl',
			'ctrl+click',
			'ctrl-click',
			'right click',
			'context menu',
			'home',
			'homepage',
			'default',
			'leaderboard',
			'webview',
		],
	},
	{
		id: 'general-html-double-click',
		tab: 'general',
		tabLabel: 'General',
		label: 'Open HTML files in Maestro Browser on double-click',
		description:
			'When enabled, double-clicking an HTML file in the file explorer opens it in the Maestro browser tab instead of the file preview.',
		keywords: [
			'html',
			'double click',
			'double-click',
			'dblclick',
			'file explorer',
			'preview',
			'browser',
			'open',
			'render',
			'webview',
			'dashboard',
		],
	},
	{
		id: 'general-browser-keepalive',
		tab: 'general',
		tabLabel: 'General',
		label: 'Background browser tabs',
		description:
			'Control whether inactive browser tabs are unloaded (reloading on return) or kept alive to preserve their in-memory state. Keep the most-recent N tabs alive or keep them all alive.',
		keywords: [
			'browser',
			'background',
			'tab',
			'keep alive',
			'keepalive',
			'keep-alive',
			'unload',
			'reload',
			'webview',
			'memory',
			'persist',
			'persistence',
			'state',
			'suspend',
			'lru',
			'recent',
			'inactive',
		],
	},
	{
		id: 'general-storage',
		tab: 'general',
		tabLabel: 'General',
		label: 'Storage Location',
		description:
			'Choose where Maestro stores settings, sessions, groups, agents, global environment variables, and configuration. Use a synced folder (iCloud Drive, Dropbox, OneDrive) to share across devices. Migrating may require a restart.',
		keywords: [
			'storage',
			'sync',
			'icloud',
			'icloud drive',
			'dropbox',
			'onedrive',
			'folder',
			'path',
			'location',
			'agents',
			'environment variables',
			'configuration',
			'migrate',
			'migration',
			'restart',
			'devices',
			'share',
		],
	},
];

// ---------------------------------------------------------------------------
// Display Tab
// ---------------------------------------------------------------------------
export const DISPLAY_SETTINGS: SearchableSetting[] = [
	{
		id: 'display-font-family',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Font Family',
		description: 'Choose the font for the interface',
		keywords: ['font', 'typeface', 'family', 'monospace', 'custom font'],
	},
	{
		id: 'display-terminal-font-family',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Terminal Font',
		description: 'Choose a font for the command terminal, independent of the UI font',
		keywords: [
			'font',
			'typeface',
			'terminal',
			'command terminal',
			'shell',
			'nerd font',
			'monospace',
			'zsh',
			'prompt',
		],
	},
	{
		id: 'display-font-size',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Font Size',
		description: 'Small, Medium, Large, or X-Large',
		keywords: ['font', 'size', 'text', 'small', 'medium', 'large', 'x-large', 'xl', 'zoom'],
	},
	{
		id: 'display-max-log-buffer',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Maximum Log Buffer',
		description: 'Maximum number of entries to retain for history and system log viewer',
		keywords: ['log', 'buffer', 'history', 'entries', 'limit', 'memory'],
	},
	{
		id: 'display-max-output-lines',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Max Output Lines per Response',
		description: 'Long outputs will be collapsed into a scrollable window',
		keywords: ['output', 'lines', 'collapse', 'truncate', 'scroll'],
	},
	{
		id: 'display-message-alignment',
		tab: 'display',
		tabLabel: 'Display',
		label: 'User Message Alignment',
		description:
			'Position your messages on the left or right side of the chat; AI responses appear on the opposite side',
		keywords: [
			'alignment',
			'left',
			'right',
			'message',
			'chat',
			'position',
			'response',
			'ai response',
		],
	},
	{
		id: 'display-group-chat-auto-scroll',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Group Chat Auto-Scroll',
		description: 'Automatically scroll group chats to the newest message when new messages arrive.',
		keywords: [
			'group chat',
			'auto-scroll',
			'autoscroll',
			'scroll',
			'follow',
			'bottom',
			'newest',
			'messages',
		],
	},
	{
		id: 'display-colorblind-mode',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Color Blind Mode',
		description:
			"Swap red/green/yellow semantics for Wong's colorblind-safe palette across agent status dots, diff add/remove, git status, the activity graph, Usage Dashboard charts, and file extension badges.",
		keywords: [
			'colorblind',
			'color blind',
			'colour blind',
			'colourblind',
			'accessibility',
			'a11y',
			'protanopia',
			'deuteranopia',
			'tritanopia',
			'wong',
			'palette',
			'vision',
			'contrast',
			'red green',
		],
	},
	{
		id: 'display-bionify-reading-mode',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Bionify Emphasis (Reading Mode)',
		description:
			'Apply Bionify-style emphasis (Soft, Default, or Strong intensity) to long-form readers like File Preview and Auto Run. Includes algorithm controls.',
		keywords: [
			'bionify',
			'bionic',
			'reading',
			'reading mode',
			'accessibility',
			'a11y',
			'emphasis',
			'bold',
			'fixation',
			'intensity',
			'algorithm',
			'soft',
			'strong',
			'default',
			'file preview',
			'auto run',
			'long-form',
			'speed reading',
		],
	},
	{
		id: 'display-icon-theme',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Files Pane Icon Theme',
		description: 'Default or Rich (Material Icon Theme style) for the Files pane',
		keywords: ['icon', 'theme', 'files', 'material', 'rich', 'explorer'],
	},
	{
		id: 'display-window-chrome',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Window Chrome',
		description:
			'Native or custom title bar and auto-hide menu bar (press Alt to reveal it temporarily)',
		keywords: [
			'title bar',
			'titlebar',
			'menu bar',
			'menubar',
			'native',
			'custom',
			'chrome',
			'window',
			'auto hide',
			'auto-hide',
			'alt',
			'frameless',
		],
	},
	{
		id: 'display-main-header-panel',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Main Header Panel',
		description:
			'Toggle the agent name, session ID, and session cost pills shown in the main header',
		keywords: [
			'header',
			'main header',
			'panel',
			'agent name',
			'session name',
			'session id',
			'session uuid',
			'uuid',
			'cost',
			'pill',
			'pills',
			'badge',
			'top bar',
			'title bar',
		],
	},
	{
		id: 'display-left-panel-starred-sessions',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Show Starred Sessions section',
		description:
			'Show a Starred Sessions section at the top of the left side bar listing every starred AI tab and named session across all agents',
		keywords: [
			'starred',
			'star',
			'favorite',
			'favourite',
			'bookmark',
			'pinned',
			'left',
			'side',
			'sidebar',
			'side bar',
			'side panel',
			'panel',
			'section',
			'tabs',
			'sessions',
			'agents',
			'jump',
			'navigate',
			'cross-agent',
		],
	},
	{
		id: 'display-left-side-panel',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Left Side Panel',
		description:
			'Configure the left side bar: group member counts, collapsed pills per row, location pills, git change indicator, Cue indicator, worktree badges, and full vs abbreviated group labels on bookmarked agents',
		keywords: [
			'left',
			'side',
			'sidebar',
			'side bar',
			'side panel',
			'panel',
			'group',
			'groups',
			'count',
			'member',
			'members',
			'ungrouped',
			'agents',
			'remote',
			'local',
			'git',
			'pill',
			'pills',
			'per row',
			'row',
			'rows',
			'wrap',
			'density',
			'collapsed',
			'badge',
			'badges',
			'location',
			'change',
			'changes',
			'dirty',
			'cue',
			'indicator',
			'terminal',
			'startup',
			'startup command',
			'sticky',
			'persistent',
			'prompt',
			'worktree',
			'work tree',
			'branch',
			'branch name',
			'agent list',
			'session list',
			'bookmark',
			'bookmarks',
			'bookmarked',
			'full',
			'full name',
			'full label',
			'abbreviated',
			'abbreviation',
			'tag',
			'label',
			'hide',
			'hide group',
			'hide pill',
			'group pill',
		],
	},
	{
		id: 'display-modal-layout',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Modal Layout',
		description: 'Reset saved modal sizes',
		keywords: ['modal', 'dialog', 'resize', 'size', 'reset', 'layout', 'window'],
	},
	{
		id: 'display-file-edit-preview',
		tab: 'display',
		tabLabel: 'Display',
		label: 'File Edit & Preview',
		description:
			'Line numbers, word wrap default, and per-button visibility for the file preview / editor toolbar',
		keywords: [
			'file',
			'edit',
			'editor',
			'preview',
			'line numbers',
			'gutter',
			'word wrap',
			'wrap',
			'soft wrap',
			'horizontal scroll',
			'toolbar',
			'buttons',
			'visibility',
			'deep link',
			'maestro://',
		],
	},
	{
		id: 'display-tab-filtering',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Tab Options',
		description:
			'Show starred and file preview tabs when filtering by unread; Command+0 vs Command+9 last-tab shortcut; browser tab domain pill; scroll tabs with the mouse wheel',
		keywords: [
			'tab',
			'filter',
			'unread',
			'starred',
			'file preview',
			'cmd 0',
			'cmd 9',
			'command 0',
			'command 9',
			'ctrl 0',
			'ctrl 9',
			'last tab',
			'go to last tab',
			'shortcut',
			'keyboard',
			'browser style',
			'browser tab',
			'domain',
			'hostname',
			'url',
			'pill',
			'wheel',
			'mouse wheel',
			'scroll',
			'scroll tabs',
			'pan',
			'tab bar',
			'tab strip',
		],
	},
	{
		id: 'display-document-graph',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Document Graph',
		description: 'External links and maximum nodes for the document graph',
		keywords: [
			'document',
			'graph',
			'nodes',
			'links',
			'external',
			'visualization',
			'mindmap',
			'force',
			'radial',
			'wiki',
			'backlinks',
		],
	},
	{
		id: 'display-context-warnings',
		tab: 'display',
		tabLabel: 'Display',
		label: 'Context Window Warnings',
		description: 'Show warning banners when context window usage reaches configurable thresholds',
		keywords: [
			'context',
			'window',
			'warning',
			'threshold',
			'yellow',
			'red',
			'consumption',
			'banner',
			'percent',
			'percentage',
			'usage',
			'compaction',
		],
	},
	{
		id: 'display-file-indexing',
		tab: 'display',
		tabLabel: 'Display',
		label: 'File Indexing & File Panel Settings',
		description:
			'Local ignore patterns, gitignore handling, max recursion depth, max file entries, and SSH cap reduction for the Files panel',
		keywords: [
			'ignore',
			'patterns',
			'glob',
			'exclude',
			'gitignore',
			'file indexing',
			'file explorer',
			'file panel',
			'files panel',
			'files pane',
			'panel',
			'pane',
			'depth',
			'recursion',
			'max entries',
			'max files',
			'limit',
			'memory',
			'load more',
			'load all',
			'scan',
			'indexer',
			'10k',
			'50k',
			'100k',
			'250k',
			'500k',
			'preset',
			'ssh',
			'remote',
			'reduce',
			'fraction',
			'percent',
			'percentage',
			'cap',
			'budget',
		],
	},
];

// ---------------------------------------------------------------------------
// Shortcuts Tab (the tab itself is searchable, individual shortcuts are not)
// ---------------------------------------------------------------------------
export const SHORTCUTS_SETTINGS: SearchableSetting[] = [
	{
		id: 'shortcuts-tab',
		tab: 'shortcuts',
		tabLabel: 'Shortcuts',
		label: 'Keyboard Shortcuts',
		description: 'Configure keyboard shortcuts for general and AI tab actions',
		keywords: ['keyboard', 'shortcut', 'hotkey', 'keybind', 'binding', 'key'],
	},
];

// ---------------------------------------------------------------------------
// Theme Tab
// ---------------------------------------------------------------------------
export const THEME_SETTINGS: SearchableSetting[] = [
	{
		id: 'theme-picker',
		tab: 'theme',
		tabLabel: 'Themes',
		label: 'Theme Selection',
		description: 'Choose from dark, light, and vibe themes or create a custom theme',
		keywords: ['theme', 'dark', 'light', 'vibe', 'color', 'appearance', 'mode', 'custom'],
	},
];

// ---------------------------------------------------------------------------
// Notifications Tab
// ---------------------------------------------------------------------------
export const NOTIFICATION_SETTINGS: SearchableSetting[] = [
	{
		id: 'notifications-os',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'OS Notifications',
		description: 'Show desktop notifications when tasks complete or require attention',
		keywords: ['notification', 'desktop', 'os', 'alert', 'system'],
	},
	{
		id: 'notifications-custom',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'Custom Notification',
		description:
			'Execute a custom command (text-to-speech, festival, say, espeak, pipe to log) when AI tasks complete. Includes a Test button.',
		keywords: [
			'audio',
			'sound',
			'tts',
			'text to speech',
			'say',
			'espeak',
			'festival',
			'command',
			'custom',
			'pipe',
			'test',
			'feedback',
			'voice',
			'speak',
		],
	},
	{
		id: 'notifications-idle',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'Idle Notification',
		description:
			'Execute a custom command when all agents and Auto Runs finish and Maestro becomes idle. Includes a Test button.',
		keywords: [
			'idle',
			'finish',
			'done',
			'complete',
			'fleet',
			'quiet',
			'all done',
			'command',
			'test',
		],
	},
	{
		id: 'notifications-toast',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'Toast Notification Duration',
		description:
			'How long toast notifications remain on screen before they are auto-dismissed; 0 keeps them until manually dismissed',
		keywords: [
			'toast',
			'duration',
			'timeout',
			'popup',
			'banner',
			'dismiss',
			'auto-dismiss',
			'sticky',
			'persist',
		],
	},
	{
		id: 'notifications-toast-width',
		tab: 'notifications',
		tabLabel: 'Notifications',
		label: 'Toast Notification Width',
		description:
			'Width of toast notifications: Small, Medium, Large, or Dynamic (match the Right Bar)',
		keywords: [
			'toast',
			'notification',
			'width',
			'size',
			'small',
			'medium',
			'large',
			'dynamic',
			'right bar',
			'panel',
		],
	},
];

// ---------------------------------------------------------------------------
// AI Commands Tab
// ---------------------------------------------------------------------------
export const AI_COMMANDS_SETTINGS: SearchableSetting[] = [
	{
		id: 'aicommands-custom',
		tab: 'aicommands',
		tabLabel: 'AI Commands',
		label: 'Custom AI Commands',
		description:
			'Create custom slash commands with configurable prompts and template variables. Available in AI terminal mode alongside built-in commands.',
		keywords: [
			'ai',
			'command',
			'slash',
			'slash command',
			'custom',
			'prompt',
			'template',
			'variable',
			'terminal',
			'built-in',
			'builtin',
		],
	},
	{
		id: 'aicommands-speckit',
		tab: 'aicommands',
		tabLabel: 'AI Commands',
		label: 'Spec-Kit Commands',
		description:
			'Built-in specification toolkit commands. Toggle to hide them from slash command autocomplete.',
		keywords: [
			'speckit',
			'spec',
			'specification',
			'toolkit',
			'enable',
			'disable',
			'hide',
			'show',
			'autocomplete',
			'slash',
		],
	},
	{
		id: 'aicommands-openspec',
		tab: 'aicommands',
		tabLabel: 'AI Commands',
		label: 'OpenSpec Commands',
		description: 'Built-in OpenSpec commands. Toggle to hide them from slash command autocomplete.',
		keywords: [
			'openspec',
			'open',
			'spec',
			'enable',
			'disable',
			'hide',
			'show',
			'autocomplete',
			'slash',
		],
	},
	{
		id: 'aicommands-bmad',
		tab: 'aicommands',
		tabLabel: 'AI Commands',
		label: 'BMAD Commands',
		description: 'Built-in BMAD commands. Toggle to hide them from slash command autocomplete.',
		keywords: ['bmad', 'enable', 'disable', 'hide', 'show', 'autocomplete', 'slash'],
	},
];

// ---------------------------------------------------------------------------
// SSH Hosts Tab
// ---------------------------------------------------------------------------
export const SSH_SETTINGS: SearchableSetting[] = [
	{
		id: 'ssh-remotes',
		tab: 'ssh',
		tabLabel: 'SSH Hosts',
		label: 'SSH Remote Hosts',
		description:
			'Configure SSH hosts for remote agent execution; test connections before assigning them to agents',
		keywords: [
			'ssh',
			'remote',
			'host',
			'server',
			'connection',
			'agent',
			'execute',
			'test',
			'remote execution',
			'tunnel',
		],
	},
	{
		id: 'ssh-ignore-patterns',
		tab: 'ssh',
		tabLabel: 'SSH Hosts',
		label: 'SSH Remote Ignore Patterns',
		description: 'Glob patterns for folders to exclude when indexing remote files',
		keywords: ['ssh', 'ignore', 'patterns', 'remote', 'glob', 'gitignore'],
	},
];

// ---------------------------------------------------------------------------
// Environment Tab
// ---------------------------------------------------------------------------
export const ENVIRONMENT_SETTINGS: SearchableSetting[] = [
	{
		id: 'environment-global-vars',
		tab: 'environment',
		tabLabel: 'Environment',
		label: 'Global Environment Variables',
		description: 'Variables that apply to all terminal sessions and AI agents',
		keywords: ['env', 'environment', 'variable', 'api key', 'proxy', 'path', 'global'],
	},
];

// ---------------------------------------------------------------------------
// Encore Tab
// ---------------------------------------------------------------------------
export const ENCORE_SETTINGS: SearchableSetting[] = [
	{
		id: 'encore-usage-stats',
		tab: 'encore',
		tabLabel: 'Plugins',
		label: 'Usage & Stats',
		description:
			'Track queries, Auto Run sessions, coding activity, and view the Usage Dashboard with a configurable lookback window',
		keywords: [
			'usage',
			'stats',
			'analytics',
			'dashboard',
			'tracking',
			'wakatime',
			'lookback',
			'activity',
			'query',
			'coding',
			'metrics',
			'tokens',
			'cost',
		],
	},
	{
		id: 'encore-symphony',
		tab: 'encore',
		tabLabel: 'Plugins',
		label: 'Maestro Symphony',
		description:
			'Contribute to open source projects through curated repositories and playbook registries',
		keywords: [
			'symphony',
			'open source',
			'oss',
			'contribute',
			'repository',
			'registry',
			'registry sources',
			'sources',
			'playbook',
			'curated',
		],
	},
	{
		id: 'encore-cue',
		tab: 'encore',
		tabLabel: 'Plugins',
		label: 'Maestro Cue',
		description:
			'Event-driven automation (Beta) - trigger agent prompts on timers, file changes, agent completions, GitHub PRs/issues, and pending tasks',
		keywords: [
			'cue',
			'automation',
			'trigger',
			'event',
			'timer',
			'file watch',
			'watcher',
			'pipeline',
			'global cue settings',
			'global settings',
			'subscription',
			'github',
			'pr',
			'issue',
			'beta',
			'cron',
			'schedule',
		],
	},
	{
		id: 'encore-coworking',
		tab: 'encore',
		tabLabel: 'Encore Features',
		label: 'Coworking',
		description:
			'Beta - let agents read terminal scrollback on demand. Installs a per-agent MCP server (Claude Code, Codex, OpenCode, Factory Droid) and adds a `term:N` pill to terminal tabs.',
		keywords: [
			'coworking',
			'mcp',
			'terminal',
			'scrollback',
			'agent',
			'tools',
			'claude code',
			'codex',
			'opencode',
			'factory droid',
			'beta',
			'install',
			'server',
		],
	},
	{
		id: 'coworking-background-browsers',
		tab: 'encore',
		tabLabel: 'Encore Features',
		label: 'Coworking background browsing',
		description:
			'Let agents read and drive their own browser tabs while you are focused on a different agent. Keeps hidden webviews alive off-screen, LRU-capped (1-10).',
		keywords: [
			'coworking',
			'background',
			'browser',
			'browsing',
			'webview',
			'hidden',
			'cross-session',
			'lru',
			'limit',
		],
	},
	{
		id: 'encore-director-notes',
		tab: 'encore',
		tabLabel: 'Plugins',
		label: "Director's Notes",
		description: 'Unified history view and AI-generated synopsis across all sessions (Beta)',
		keywords: [
			'director',
			'notes',
			'synopsis',
			'synopsis provider',
			'provider',
			'history',
			'summary',
			'lookback',
			'beta',
			'fleet',
			'unified',
		],
	},
	{
		id: 'encore-director-notes-default-mode',
		tab: 'encore',
		tabLabel: 'Plugins',
		label: "Director's Notes Default Reading Mode",
		description:
			'Whether the AI Overview opens in Rich (widget dashboard) or Plain (markdown) mode',
		keywords: [
			'director',
			'notes',
			'rich',
			'plain',
			'mode',
			'reading',
			'default',
			'dashboard',
			'widgets',
			'markdown',
		],
	},
	{
		id: 'encore-pianola',
		tab: 'encore',
		tabLabel: 'Plugins',
		label: 'Pianola',
		description:
			'Autonomous manager agent (Beta). Watches your agents, auto-answers low-risk prompts from your rules, and escalates uncertain or high-risk ones. Can send messages to agents on your behalf',
		keywords: [
			'pianola',
			'autonomous',
			'manager',
			'agent',
			'watch',
			'auto-answer',
			'auto answer',
			'escalate',
			'rules',
			'supervise',
			'orchestrate',
			'beta',
		],
	},
	{
		id: 'encore-concerto',
		tab: 'encore',
		tabLabel: 'Plugins',
		label: 'Concerto',
		description:
			'Agent-composed native views. Agents build rich, app-styled data panels (Movements) and small always-on-top cards (Cadenzas) from a fixed block vocabulary, instead of plain chat text',
		keywords: [
			'concerto',
			'movement',
			'cadenza',
			'agent views',
			'views',
			'panel',
			'dashboard',
			'hud',
			'blockview',
			'data view',
			'visualize',
		],
	},
	{
		id: 'encore-groups-plus',
		tab: 'encore',
		tabLabel: 'Plugins',
		label: 'Groups+',
		description:
			'Nested group folders with standard icons and label colors. Turn it on to organize the sidebar without changing stored group data.',
		keywords: [
			'groups',
			'groups plus',
			'folder',
			'nested',
			'hierarchy',
			'icon',
			'color',
			'sidebar',
			'organization',
		],
	},
	{
		id: 'encore-plugins',
		tab: 'encore',
		tabLabel: 'Plugins',
		label: 'Plugins',
		description:
			'Community plugin subsystem (Alpha) - discover, enable, disable, install, and uninstall plugins. Foundation only: plugins are listed and managed but do not execute code yet',
		keywords: [
			'plugin',
			'plugins',
			'extension',
			'extend',
			'addon',
			'add-on',
			'community',
			'marketplace',
			'install',
			'uninstall',
			'alpha',
		],
	},
];

// ---------------------------------------------------------------------------
// Prompts Tab
// ---------------------------------------------------------------------------
export const PROMPTS_SETTINGS: SearchableSetting[] = [
	{
		id: 'prompts-editor',
		tab: 'prompts',
		tabLabel: 'Maestro Prompts',
		label: 'Maestro Prompts',
		description:
			'Edit core system prompts by category - Wizard, Inline Wizard, Auto Run, Group Chat, Context, and other Maestro reference includes',
		keywords: [
			'prompt',
			'system prompt',
			'wizard prompt',
			'autorun prompt',
			'auto run prompt',
			'customize',
			'wizard',
			'inline wizard',
			'group chat',
			'context',
			'category',
			'reference',
			'include',
			'maestro prompts',
		],
	},
];

// ---------------------------------------------------------------------------
// About Tab
// ---------------------------------------------------------------------------
export const ABOUT_SETTINGS: SearchableSetting[] = [
	{
		id: 'about-maestro',
		tab: 'about',
		tabLabel: 'About',
		label: 'About Maestro',
		description: 'Maestro version, tagline, and origin - born on Nov 26, 2025 in Austin, TX',
		keywords: [
			'about',
			'version',
			'maestro',
			'tagline',
			'origin',
			'austin',
			'texas',
			'born',
			'commit',
			'build',
		],
	},
];

// ---------------------------------------------------------------------------
// Composed registry
// ---------------------------------------------------------------------------
export const ALL_SEARCHABLE_SETTINGS: SearchableSetting[] = [
	...ABOUT_SETTINGS,
	...GENERAL_SETTINGS,
	...DISPLAY_SETTINGS,
	...SHORTCUTS_SETTINGS,
	...THEME_SETTINGS,
	...NOTIFICATION_SETTINGS,
	...AI_COMMANDS_SETTINGS,
	...SSH_SETTINGS,
	...ENVIRONMENT_SETTINGS,
	...ENCORE_SETTINGS,
	...PROMPTS_SETTINGS,
];

/**
 * Search settings by query string. Matches against label, description, tab label, and keywords.
 * Returns matching settings sorted by relevance (label match first, then description, then keywords).
 */
export function searchSettings(query: string): SearchableSetting[] {
	if (!query.trim()) return [];
	const q = query.toLowerCase().trim();
	const terms = q.split(/\s+/);

	return ALL_SEARCHABLE_SETTINGS.map((setting) => {
		const label = setting.label.toLowerCase();
		const desc = (setting.description || '').toLowerCase();
		const tabLabel = setting.tabLabel.toLowerCase();
		const keywords = (setting.keywords || []).join(' ').toLowerCase();
		const all = `${label} ${desc} ${tabLabel} ${keywords}`;

		// Every search term must appear somewhere
		const allMatch = terms.every((term) => all.includes(term));
		if (!allMatch) return null;

		// Score: label match is strongest, then description, then keywords
		let score = 0;
		for (const term of terms) {
			if (label.includes(term)) score += 3;
			else if (desc.includes(term)) score += 2;
			else if (tabLabel.includes(term)) score += 1;
			else if (keywords.includes(term)) score += 1;
		}

		return { setting, score };
	})
		.filter(Boolean)
		.sort((a, b) => b!.score - a!.score)
		.map((entry) => entry!.setting);
}
