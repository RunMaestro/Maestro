import '@testing-library/jest-dom';
import { afterEach, vi } from 'vitest';
import React from 'react';
import { clearCachedResources } from '../renderer/hooks/utils/useCachedResource';
import { emptyTokenSpeedSummary } from '../shared/tokenSpeed';

// Create a mock icon component factory
const createMockIcon = (name: string) => {
	const defaultTestId = `${name
		.toLowerCase()
		.replace(/([A-Z])/g, '-$1')
		.toLowerCase()
		.replace(/^-/, '')}-icon`;
	const MockIcon = function (props: Record<string, unknown>) {
		const { 'data-testid': dataTestId, ...rest } = props;
		return React.createElement('svg', {
			...rest,
			'data-testid': dataTestId ?? defaultTestId,
		});
	};
	MockIcon.displayName = name;
	return MockIcon;
};

// Global mock for lucide-react using Proxy to auto-generate mock icons
// This ensures any icon import works without explicitly listing every icon
vi.mock('lucide-react', () => {
	const iconCache = new Map<string, ReturnType<typeof createMockIcon>>();

	return new Proxy(
		{},
		{
			get(_target, prop: string) {
				// Ignore internal properties
				if (
					prop === '__esModule' ||
					prop === 'default' ||
					prop === 'then' ||
					typeof prop === 'symbol'
				) {
					return undefined;
				}

				// Return cached icon or create new one
				if (!iconCache.has(prop)) {
					iconCache.set(prop, createMockIcon(prop));
				}
				return iconCache.get(prop);
			},
			has(_target, prop: string) {
				if (
					prop === '__esModule' ||
					prop === 'default' ||
					prop === 'then' ||
					typeof prop === 'symbol'
				) {
					return false;
				}
				return true;
			},
			getOwnPropertyDescriptor(_target, prop: string) {
				if (
					prop === '__esModule' ||
					prop === 'default' ||
					prop === 'then' ||
					typeof prop === 'symbol'
				) {
					return undefined;
				}
				return {
					configurable: true,
					enumerable: true,
					writable: false,
					value: this.get?.(_target, prop),
				};
			},
		}
	);
});

// Global mock for shortcutFormatter to ensure platform-independent test output.
// Without this, shortcutFormatter detects the platform via window.maestro.platform, producing
// different output on macOS vs Linux CI. This mock always uses the non-Mac format (Ctrl+, Shift+, etc.)
// so tests are deterministic regardless of where they run. Individual test files can override
// this with their own vi.mock() if they need custom behavior.
const SHORTCUT_KEY_MAP: Record<string, string> = {
	Meta: 'Ctrl',
	Alt: 'Alt',
	Shift: 'Shift',
	Control: 'Ctrl',
	Ctrl: 'Ctrl',
	ArrowUp: '↑',
	ArrowDown: '↓',
	ArrowLeft: '←',
	ArrowRight: '→',
	Backspace: 'Backspace',
	Delete: 'Delete',
	Enter: 'Enter',
	Return: 'Enter',
	Escape: 'Esc',
	Tab: 'Tab',
	Space: 'Space',
};
const mockFormatKey = (key: string): string => {
	if (SHORTCUT_KEY_MAP[key]) return SHORTCUT_KEY_MAP[key];
	if (key.length === 1) return key.toUpperCase();
	return key;
};
vi.mock('../renderer/utils/shortcutFormatter', () => ({
	formatKey: vi.fn((key: string) => mockFormatKey(key)),
	formatShortcutKeys: vi.fn((keys: string[], separator?: string) => {
		const sep = separator ?? '+';
		return keys.map(mockFormatKey).join(sep);
	}),
	formatMetaKey: vi.fn(() => 'Ctrl'),
	formatMetaKeyName: vi.fn(() => 'Ctrl'),
	formatAltKeyName: vi.fn(() => 'Alt'),
	formatEnterToSend: vi.fn((enterToSend: boolean) => (enterToSend ? 'Enter' : 'Ctrl + Enter')),
	formatEnterToSendTooltip: vi.fn((enterToSend: boolean) =>
		enterToSend ? 'Switch to Ctrl+Enter to send' : 'Switch to Enter to send'
	),
	isMacOS: vi.fn(() => false),
}));

// Set browser APIs from the JSDOM environment.
// Only mock if window exists (jsdom environment)
if (typeof window !== 'undefined') {
	// Node 25 exposes native Web Storage globals; each DOM suite must use its own storage.
	const jsdomWindow = (globalThis as typeof globalThis & { jsdom: { window: Window } }).jsdom
		.window;
	for (const name of ['localStorage', 'sessionStorage'] as const) {
		Object.defineProperty(window, name, {
			configurable: true,
			writable: true,
			value: jsdomWindow[name],
		});
	}

	Object.defineProperty(window, 'matchMedia', {
		writable: true,
		value: vi.fn().mockImplementation((query: string) => ({
			matches: false,
			media: query,
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: vi.fn(),
		})),
	});
}

// Mock ResizeObserver using a proper class-like constructor
// Simulates a 1000px width by default which ensures all responsive UI elements are visible
class MockResizeObserver {
	callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
	}
	observe = vi.fn((target: Element) => {
		// Immediately call callback with a reasonable width to simulate layout
		// This ensures responsive breakpoints work correctly in tests
		const entry: ResizeObserverEntry = {
			target,
			contentRect: {
				width: 1000,
				height: 500,
				top: 0,
				left: 0,
				bottom: 500,
				right: 1000,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			},
			borderBoxSize: [{ blockSize: 500, inlineSize: 1000 }],
			contentBoxSize: [{ blockSize: 500, inlineSize: 1000 }],
			devicePixelContentBoxSize: [{ blockSize: 500, inlineSize: 1000 }],
		};
		// Use setTimeout to simulate async behavior like the real ResizeObserver
		setTimeout(() => this.callback([entry], this as unknown as ResizeObserver), 0);
	});
	unobserve = vi.fn();
	disconnect = vi.fn();
}
// Only set browser globals if window exists (jsdom environment)
if (typeof window !== 'undefined') {
	global.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

	// Mock offsetWidth to return reasonable values for responsive breakpoint tests
	// This ensures components that check element dimensions work correctly in jsdom
	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
		configurable: true,
		get() {
			return 1000; // Default to wide enough for all responsive features to show
		},
	});

	// Mock IntersectionObserver as a proper class so `new IntersectionObserver(...)`
	// works for components that construct one (e.g. JumpToMessageTopButton).
	// vi.fn().mockImplementation(arrow) is not callable as a constructor here.
	class MockIntersectionObserver {
		constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
		observe = vi.fn();
		unobserve = vi.fn();
		disconnect = vi.fn();
		takeRecords = vi.fn(() => []);
		root = null;
		rootMargin = '';
		thresholds: ReadonlyArray<number> = [];
	}
	global.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;

	// Mock Element.prototype.scrollTo - needed for components that use scrollTo
	Element.prototype.scrollTo = vi.fn();

	// Mock Element.prototype.scrollIntoView - needed for components that scroll elements into view
	Element.prototype.scrollIntoView = vi.fn();
}

// Mock window.maestro API (Electron IPC bridge)
const mockMaestro = {
	settings: {
		get: vi.fn().mockResolvedValue(undefined),
		set: vi.fn().mockResolvedValue(undefined),
		getAll: vi.fn().mockResolvedValue({}),
		onExternalChange: vi.fn().mockReturnValue(() => {}),
	},
	sessions: {
		get: vi.fn().mockResolvedValue([]),
		save: vi.fn().mockResolvedValue(undefined),
		setAll: vi.fn().mockResolvedValue(undefined),
		setMany: vi.fn().mockResolvedValue(undefined),
		getActiveSessionId: vi.fn().mockResolvedValue(''),
		setActiveSessionId: vi.fn().mockResolvedValue(undefined),
	},
	groups: {
		get: vi.fn().mockResolvedValue([]),
		getAll: vi.fn().mockResolvedValue([]),
		save: vi.fn().mockResolvedValue(undefined),
		setAll: vi.fn().mockResolvedValue(undefined),
	},
	process: {
		spawn: vi.fn().mockResolvedValue({ pid: 12345 }),
		releaseConcertoHtmlDocument: vi.fn(),
		restoreConcertoHtmlDocument: vi.fn().mockResolvedValue(1),
		write: vi.fn().mockResolvedValue(undefined),
		kill: vi.fn().mockResolvedValue(undefined),
		resize: vi.fn().mockResolvedValue(undefined),
		getActiveProcesses: vi.fn().mockResolvedValue([]),
		isTerminalBusy: vi.fn().mockResolvedValue(false),
		broadcastUserInput: vi.fn().mockResolvedValue(undefined),
		onOutput: vi.fn().mockReturnValue(() => {}),
		onExit: vi.fn().mockReturnValue(() => {}),
		onUserInput: vi.fn().mockReturnValue(() => {}),
		sendRemoteCommandReceipt: vi.fn(),
	},
	debug: {
		createPackage: vi.fn().mockResolvedValue({ success: true }),
		previewPackage: vi.fn().mockResolvedValue({}),
		getAppStats: vi.fn().mockResolvedValue({}),
		getProfilingStatus: vi.fn().mockResolvedValue({
			success: true,
			active: false,
			startedAt: 0,
			elapsedMs: 0,
			categories: [],
		}),
		startProfiling: vi.fn().mockResolvedValue({
			success: true,
			active: true,
			startedAt: 0,
			elapsedMs: 0,
			categories: [],
		}),
		stopProfiling: vi.fn().mockResolvedValue({
			success: true,
			path: null,
			cancelled: true,
			bundleSizeBytes: 0,
			traceSizeBytes: 0,
			durationMs: 0,
		}),
		stopProfilingToFile: vi.fn().mockResolvedValue({
			success: true,
			path: '/tmp/maestro-profile-test.zip',
			bundleSizeBytes: 2048,
			traceSizeBytes: 4096,
			durationMs: 1000,
		}),
		discardTrace: vi.fn().mockResolvedValue({ success: true }),
		onProfilingProgress: vi.fn(() => () => {}),
	},
	feedback: {
		checkGhAuth: vi.fn().mockResolvedValue({ authenticated: true }),
		submit: vi.fn().mockResolvedValue({ success: true }),
		composePrompt: vi.fn().mockResolvedValue({ prompt: 'composed feedback prompt' }),
		getConversationPrompt: vi.fn().mockResolvedValue({
			prompt: 'system prompt',
			environment: '- Maestro version: test',
			cwd: '/home/test',
		}),
		submitConversation: vi.fn().mockResolvedValue({ success: true }),
		searchIssues: vi.fn().mockResolvedValue({ issues: [] }),
		subscribeIssue: vi.fn().mockResolvedValue({ success: true }),
		drafts: {
			list: vi.fn().mockResolvedValue({ drafts: [] }),
			save: vi.fn((draft: unknown) => Promise.resolve({ draft })),
			delete: vi.fn().mockResolvedValue({}),
		},
		issues: {
			list: vi.fn().mockResolvedValue({ issues: [] }),
			delete: vi.fn().mockResolvedValue({}),
			refreshStates: vi.fn().mockResolvedValue({ issues: [] }),
		},
		listAccounts: vi.fn().mockResolvedValue({ accounts: [], lastWorkingKey: null }),
		rememberAccount: vi.fn().mockResolvedValue(undefined),
	},
	git: {
		branch: vi.fn().mockResolvedValue({ stdout: 'main' }),
		status: vi.fn().mockResolvedValue({ files: [], branch: 'main', stdout: '' }),
		diff: vi.fn().mockResolvedValue(''),
		isRepo: vi.fn().mockResolvedValue(true),
		commitAll: vi.fn().mockResolvedValue({ success: true, committed: true, commitHash: 'abc1234' }),
		numstat: vi.fn().mockResolvedValue([]),
		getStatus: vi.fn().mockResolvedValue({ branch: 'main', status: [] }),
		worktreeSetup: vi.fn().mockResolvedValue({ success: true }),
		worktreeCheckout: vi.fn().mockResolvedValue({ success: true }),
		getDefaultBranch: vi.fn().mockResolvedValue({ success: true, branch: 'main' }),
		createPR: vi.fn().mockResolvedValue({ success: true, prUrl: 'https://github.com/test/pr/1' }),
		branches: vi.fn().mockResolvedValue({ branches: ['main', 'develop'] }),
		checkGhCli: vi.fn().mockResolvedValue({ installed: true, authenticated: true }),
		worktreeInfo: vi.fn().mockResolvedValue({ success: true, exists: false, isWorktree: false }),
		getRepoRoot: vi.fn().mockResolvedValue({ success: true, root: '/path/to/project' }),
		log: vi.fn().mockResolvedValue({ entries: [], error: undefined }),
		graph: vi.fn().mockResolvedValue({ nodes: [], error: undefined }),
		commitCount: vi.fn().mockResolvedValue({ count: 0, error: null }),
		show: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
		getRemoteUrl: vi.fn().mockResolvedValue(null),
		scanWorktreeDirectory: vi.fn().mockResolvedValue({ gitSubdirs: [] }),
		info: vi.fn().mockResolvedValue({
			branch: 'main',
			remote: '',
			behind: 0,
			ahead: 0,
			uncommittedChanges: 0,
		}),
	},
	attachments: {
		// Mirrors userData/attachments/{sessionId}/{filename} on the host.
		save: vi.fn((sessionId: string, _base64: string, filename: string) =>
			Promise.resolve({ success: true, path: `/userData/attachments/${sessionId}/${filename}` })
		),
		load: vi.fn().mockResolvedValue({ success: true, dataUrl: '' }),
		delete: vi.fn().mockResolvedValue({ success: true }),
		list: vi.fn().mockResolvedValue({ success: true, files: [] }),
		getPath: vi.fn().mockResolvedValue({ success: true, path: '/userData/attachments' }),
	},
	fs: {
		readDir: vi.fn().mockResolvedValue([]),
		readDirTree: vi
			.fn()
			.mockResolvedValue({ tree: [], truncated: false, filesFound: 0, directoriesScanned: 0 }),
		readFile: vi.fn().mockResolvedValue(''),
		// Mirrors the preload webUtils bridge: returns the dropped file's absolute
		// path. Test fixtures set `.path` on their fake File objects.
		getPathForFile: vi.fn((file?: { path?: string }) => file?.path ?? ''),
		writeFile: vi.fn().mockResolvedValue({ success: true }),
		writeImageFile: vi.fn().mockResolvedValue({ success: true }),
		mkdir: vi.fn().mockResolvedValue({ success: true }),
		stat: vi.fn().mockResolvedValue({
			size: 1024,
			createdAt: '2024-01-01T00:00:00.000Z',
			modifiedAt: '2024-01-15T12:30:00.000Z',
		}),
		directorySize: vi.fn().mockResolvedValue({
			totalSize: 1024000,
			fileCount: 50,
			folderCount: 10,
		}),
		homeDir: vi.fn().mockResolvedValue('/home/testuser'),
	},
	// Tab lifecycle notifications (renderer -> main); fire-and-forget
	tabs: {
		notifyAiTabClosed: vi.fn(),
	},
	agents: {
		detect: vi.fn().mockResolvedValue([]),
		get: vi.fn().mockResolvedValue(null),
		config: vi.fn().mockResolvedValue({}),
		getConfig: vi.fn().mockResolvedValue({}),
		setConfig: vi.fn().mockResolvedValue(undefined),
		getAllCustomPaths: vi.fn().mockResolvedValue({}),
		getCustomPath: vi.fn().mockResolvedValue(null),
		setCustomPath: vi.fn().mockResolvedValue(undefined),
		getAllCustomArgs: vi.fn().mockResolvedValue({}),
		getCustomArgs: vi.fn().mockResolvedValue(null),
		setCustomArgs: vi.fn().mockResolvedValue(undefined),
		getAllCustomEnvVars: vi.fn().mockResolvedValue({}),
		getKnownEnvVarKeys: vi.fn().mockResolvedValue({ byProvider: {}, global: [] }),
		getCustomEnvVars: vi.fn().mockResolvedValue(null),
		setCustomEnvVars: vi.fn().mockResolvedValue(undefined),
		refresh: vi.fn().mockResolvedValue({ agents: [], debugInfo: null }),
		// Model discovery for agents that support model selection
		getModels: vi.fn().mockResolvedValue([]),
		// Config options discovery (effort levels, reasoning, etc.)
		getConfigOptions: vi.fn().mockResolvedValue([]),
		// Capabilities for gating UI features based on agent type
		getCapabilities: vi.fn().mockResolvedValue({
			supportsResume: true,
			supportsReadOnlyMode: true,
			supportsJsonOutput: true,
			supportsSessionId: true,
			supportsImageInput: true,
			supportsImageInputOnResume: true,
			supportsSlashCommands: true,
			supportsSessionStorage: true,
			supportsCostTracking: true,
			supportsUsageStats: true,
			supportsBatchMode: true,
			requiresPromptToStart: false,
			supportsStreaming: true,
			supportsResultMessages: true,
			supportsModelSelection: false,
			supportsStreamJsonInput: true,
			supportsContextMerge: false,
			supportsContextExport: false,
		}),
		// Bulk capabilities used to prime the renderer capability cache
		getAllCapabilities: vi.fn().mockResolvedValue({}),
		getMaestroPDetectedPath: vi.fn().mockResolvedValue(null),
		getRemoteMaestroPAvailable: vi.fn().mockResolvedValue(null),
		getClaudeUsageSnapshots: vi.fn().mockResolvedValue({}),
		getClaudeUsageAccountKeys: vi.fn().mockResolvedValue([]),
		getCodexUsageSnapshots: vi.fn().mockResolvedValue({}),
		getCodexUsageAccountKeys: vi.fn().mockResolvedValue([]),
		getKnownAuthDirs: vi.fn().mockResolvedValue({ claudeConfigDirs: [], codexHomes: [] }),
		refreshClaudeUsageSnapshots: vi.fn().mockResolvedValue({ refreshed: 0 }),
		refreshCodexUsageSnapshots: vi.fn().mockResolvedValue({ refreshed: 0 }),
	},
	fonts: {
		detect: vi.fn().mockResolvedValue([]),
	},
	claude: {
		listSessions: vi.fn().mockResolvedValue([]),
		listSessionsPaginated: vi.fn().mockResolvedValue({
			sessions: [],
			hasMore: false,
			totalCount: 0,
			nextCursor: null,
		}),
		readSession: vi.fn().mockResolvedValue(null),
		readSessionMessages: vi.fn().mockResolvedValue({
			messages: [],
			total: 0,
			hasMore: false,
		}),
		searchSessions: vi.fn().mockResolvedValue([]),
		getGlobalStats: vi.fn().mockResolvedValue(null),
		getProjectStats: vi.fn().mockResolvedValue(undefined),
		onGlobalStatsUpdate: vi.fn().mockReturnValue(() => {}),
		onProjectStatsUpdate: vi.fn().mockReturnValue(() => {}),
		getAllNamedSessions: vi.fn().mockResolvedValue([]),
		getSessionOrigins: vi.fn().mockResolvedValue({}),
		updateSessionName: vi.fn().mockResolvedValue(undefined),
		updateSessionStarred: vi.fn().mockResolvedValue(undefined),
		registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
	},
	// Generic agent sessions API (preferred over claude.*)
	agentSessions: {
		list: vi.fn().mockResolvedValue([]),
		listPaginated: vi.fn().mockResolvedValue({
			sessions: [],
			hasMore: false,
			totalCount: 0,
			nextCursor: null,
		}),
		read: vi.fn().mockResolvedValue({
			messages: [],
			total: 0,
			hasMore: false,
		}),
		search: vi.fn().mockResolvedValue([]),
		searchSessions: vi.fn().mockResolvedValue([]),
		getPath: vi.fn().mockResolvedValue(null),
		deleteMessagePair: vi.fn().mockResolvedValue({ success: true }),
		hasStorage: vi.fn().mockResolvedValue(true),
		getAvailableStorages: vi.fn().mockResolvedValue(['claude-code']),
		// Global stats methods for AboutModal
		getGlobalStats: vi.fn().mockResolvedValue(null),
		getProjectStats: vi.fn().mockResolvedValue(undefined),
		onGlobalStatsUpdate: vi.fn().mockReturnValue(() => {}),
		onProjectStatsUpdate: vi.fn().mockReturnValue(() => {}),
		// Session management methods (for TabSwitcherModal and RenameSessionModal)
		getAllNamedSessions: vi.fn().mockResolvedValue([]),
		getSessionOrigins: vi.fn().mockResolvedValue({}),
		getOrigins: vi.fn().mockResolvedValue({}),
		setSessionName: vi.fn().mockResolvedValue(undefined),
		updateSessionName: vi.fn().mockResolvedValue(undefined),
		updateSessionStarred: vi.fn().mockResolvedValue(undefined),
		registerSessionOrigin: vi.fn().mockResolvedValue(undefined),
		// Transcript mirror (starred + snoozed retention)
		snapshotStarredTranscript: vi.fn().mockResolvedValue(undefined),
		releaseSnoozedTranscript: vi.fn().mockResolvedValue(undefined),
	},
	autorun: {
		readDoc: vi.fn().mockResolvedValue({ success: true, content: '' }),
		writeDoc: vi.fn().mockResolvedValue({ success: true }),
		saveImage: vi.fn().mockResolvedValue({ success: true, path: 'images/test.png' }),
		deleteImage: vi.fn().mockResolvedValue({ success: true }),
		watchFolder: vi.fn().mockReturnValue(() => {}),
		unwatchFolder: vi.fn(),
		readFolder: vi.fn().mockResolvedValue({ success: true, files: [] }),
		listDocs: vi.fn().mockResolvedValue({ success: true, files: [] }),
	},
	playbooks: {
		list: vi.fn().mockResolvedValue({ success: true, playbooks: [] }),
		create: vi.fn().mockResolvedValue({ success: true, playbook: {} }),
		update: vi.fn().mockResolvedValue({ success: true, playbook: {} }),
		delete: vi.fn().mockResolvedValue({ success: true }),
		export: vi.fn().mockResolvedValue({ success: true }),
		import: vi.fn().mockResolvedValue({ success: true, playbook: {} }),
	},
	plugins: {
		list: vi.fn().mockResolvedValue({ plugins: [] }),
		setEnabled: vi.fn().mockResolvedValue({ plugins: [] }),
		install: vi.fn().mockResolvedValue({ success: true }),
		update: vi.fn().mockResolvedValue({ plugins: [] }),
		uninstall: vi.fn().mockResolvedValue({ success: true }),
		contributions: vi.fn().mockResolvedValue({
			themes: [],
			iconPacks: [],
			prompts: [],
			settings: [],
			commandMacros: [],
			cueTriggers: [],
			commands: [],
			panels: [],
			agents: [],
			tools: [],
			keybindings: [],
			uiItems: [],
			groupings: [],
			errorsByPlugin: {},
		}),
		getGrants: vi.fn().mockResolvedValue({ requested: [], granted: [] }),
		requestConsent: vi.fn().mockResolvedValue({ opened: true }),
		revokeGrants: vi.fn().mockResolvedValue({ requested: [], granted: [] }),
		setAgentAllowlist: vi.fn().mockResolvedValue({ requested: [], granted: [] }),
		invokeCommand: vi.fn().mockResolvedValue({ dispatched: true }),
		invokeTool: vi.fn().mockResolvedValue({ result: null }),
		getActivity: vi.fn().mockResolvedValue({}),
		getGroupings: vi.fn().mockResolvedValue([]),
		onChanged: vi.fn().mockReturnValue(() => {}),
		onPanelData: vi.fn().mockReturnValue(() => {}),
		onGroupingsChanged: vi.fn().mockReturnValue(() => {}),
		onRunUiCommand: vi.fn().mockReturnValue(() => {}),
	},
	agentRun: {
		list: vi.fn().mockResolvedValue({ success: true, runs: [] }),
		record: vi.fn().mockResolvedValue({ success: true, run: null }),
		show: vi.fn().mockResolvedValue({ success: true, run: null }),
		events: vi.fn().mockResolvedValue({ success: true, events: [] }),
		appendEvent: vi.fn().mockResolvedValue({ success: true, event: null }),
		campaigns: {
			list: vi.fn().mockResolvedValue({ success: true, campaigns: [] }),
			record: vi.fn().mockResolvedValue({ success: true, campaign: null }),
			show: vi.fn().mockResolvedValue({ success: true, campaign: null }),
		},
	},
	marketplace: {
		getManifest: vi.fn().mockResolvedValue({
			success: true,
			manifest: { lastUpdated: '2025-01-01', playbooks: [] },
			fromCache: false,
		}),
		refreshManifest: vi.fn().mockResolvedValue({
			success: true,
			manifest: { lastUpdated: '2025-01-01', playbooks: [] },
			fromCache: false,
		}),
		getDocument: vi.fn().mockResolvedValue({ success: true, content: '' }),
		getReadme: vi.fn().mockResolvedValue({ success: true, content: null }),
		importPlaybook: vi.fn().mockResolvedValue({ success: true, playbook: {}, importedDocs: [] }),
		onManifestChanged: vi.fn().mockReturnValue(() => {}),
	},
	live: {
		toggle: vi.fn().mockResolvedValue({ live: false, url: null }),
		getStatus: vi.fn().mockResolvedValue({ live: false, url: null }),
		getDashboardUrl: vi.fn().mockResolvedValue(null),
		getLiveSessions: vi.fn().mockResolvedValue([]),
		broadcastActiveSession: vi.fn().mockResolvedValue(undefined),
		startServer: vi.fn().mockResolvedValue({ success: true, url: 'http://localhost:3000' }),
		stopServer: vi.fn().mockResolvedValue({ success: true }),
		persistCurrentToken: vi.fn().mockResolvedValue({ success: true }),
		clearPersistentToken: vi.fn().mockResolvedValue({ success: true }),
		disableAll: vi.fn().mockResolvedValue({ success: true, count: 0 }),
	},
	browserSession: {
		onRelayRequest: vi.fn(() => () => {}),
		onCreateTabRequest: vi.fn(() => () => {}),
		onPageEvent: vi.fn(() => () => {}),
		relayReady: vi.fn().mockResolvedValue(undefined),
		relayRespond: vi.fn(),
		pageClose: vi.fn().mockResolvedValue(undefined),
	},
	web: {
		onLiteReady: vi.fn(() => () => {}),
		claimAutoRunStart: vi.fn().mockResolvedValue(true),
		releaseAutoRunStartClaim: vi.fn().mockResolvedValue(true),
		takeOrphanedAutoRuns: vi.fn().mockResolvedValue([]),
		abandonAutoRunReclaim: vi.fn().mockResolvedValue(true),
		broadcastAutoRunState: vi.fn(),
		broadcastSessionState: vi.fn(),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		getStatus: vi.fn().mockResolvedValue({ running: false }),
	},
	logger: {
		log: vi.fn(),
		error: vi.fn(),
		toast: vi.fn(),
		autorun: vi.fn(),
		getLogLevel: vi.fn().mockResolvedValue('info'),
		setLogLevel: vi.fn().mockResolvedValue(undefined),
		getMaxLogBuffer: vi.fn().mockResolvedValue(5000),
		setMaxLogBuffer: vi.fn().mockResolvedValue(undefined),
	},
	notification: {
		speak: vi.fn().mockResolvedValue({ success: true, notificationId: 1 }),
		stopSpeak: vi.fn().mockResolvedValue({ success: true }),
		onCommandCompleted: vi.fn().mockReturnValue(() => {}),
		onTtsCompleted: vi.fn().mockReturnValue(() => {}), // Legacy alias
		show: vi.fn().mockResolvedValue(undefined),
	},
	voice: {
		start: vi.fn().mockResolvedValue({
			snapshot: {
				sessionId: 'voice-1',
				state: 'listening',
				scope: { kind: 'conductor' },
				seq: 2,
				startedAt: 0,
				providerIds: { stt: 'mock-stt', tts: 'mock-tts', brain: 'mock-brain' },
			},
			substitutions: [],
		}),
		stop: vi.fn().mockResolvedValue(undefined),
		submitUtterance: vi.fn().mockResolvedValue(true),
		interrupt: vi.fn().mockResolvedValue(true),
		endUtterance: vi.fn().mockResolvedValue(undefined),
		setScope: vi.fn().mockResolvedValue(true),
		// True means "there was a live session to gate". A test that wants the
		// start-a-session branch overrides it with false.
		setListening: vi.fn().mockResolvedValue(true),
		getSendWait: vi.fn().mockResolvedValue({
			waitMs: 900,
			defaultMs: 900,
			overridden: false,
			sendPhrases: ['go maestro'],
		}),
		setSendWait: vi.fn().mockImplementation(async (waitMs: number | null) => ({
			waitMs: waitMs ?? 900,
			defaultMs: 900,
			overridden: waitMs !== null,
			sendPhrases: ['go maestro'],
		})),
		stopWord: vi.fn().mockResolvedValue(undefined),
		// The microphone picker. `system-default` is the shipped state: no explicit
		// choice, follow the OS.
		inputDevices: vi.fn().mockResolvedValue({ devices: [], selectedId: 'system-default' }),
		setInputDevice: vi.fn().mockResolvedValue(true),
		onInputDevices: vi.fn().mockReturnValue(() => {}),
		submitAgentReply: vi.fn().mockResolvedValue(true),
		getRoster: vi.fn().mockResolvedValue([]),
		getState: vi.fn().mockResolvedValue(null),
		openMicSettings: vi.fn().mockResolvedValue(true),
		onEvent: vi.fn().mockReturnValue(() => {}),
		applyProviders: vi.fn().mockResolvedValue({ status: 'swapped' }),
		lastTurn: vi.fn().mockResolvedValue(null),
		listVoices: vi.fn().mockResolvedValue([]),
		previewVoice: vi.fn().mockResolvedValue(true),
		setVolume: vi.fn().mockResolvedValue(true),
		// Bound by default, because that is what a fresh install really does: main
		// falls back to `defaultGlobalHotkeyKeys(id)` whenever the stored shortcuts
		// map has no entry. A mock that reported nothing registered would let the
		// settings row drift back to claiming an unbound hotkey.
		hotkeyStatus: vi.fn().mockResolvedValue({
			statuses: [
				{
					id: 'voiceConductor',
					keys: ['Meta', 'Alt', 'v'],
					accelerator: 'Command+Alt+V',
					registered: true,
				},
				{
					id: 'voiceCurrentAgent',
					keys: ['Meta', 'Alt', 'a'],
					accelerator: 'Command+Alt+A',
					registered: true,
				},
			],
			capability: 'tap-only',
			note: 'Tap to toggle the microphone.',
		}),
		wakeTest: vi.fn().mockResolvedValue({ started: true }),
		wakeTestStop: vi.fn().mockResolvedValue(undefined),
		onWakeTest: vi.fn().mockReturnValue(() => {}),
		wakeEnrollment: vi.fn().mockResolvedValue({ ok: true, status: null }),
		onWakeEnrollment: vi.fn().mockReturnValue(() => {}),
		credentials: {
			list: vi.fn().mockResolvedValue([]),
			set: vi.fn().mockResolvedValue({ ok: true }),
			validate: vi.fn().mockResolvedValue({ service: 'openai', status: 'valid', message: 'ok' }),
		},
		models: {
			list: vi.fn().mockResolvedValue([]),
			download: vi.fn().mockResolvedValue({ modelId: '', status: 'complete' }),
			pause: vi.fn().mockResolvedValue(true),
			resume: vi.fn().mockResolvedValue({ modelId: '', status: 'complete' }),
			cancel: vi.fn().mockResolvedValue(true),
			verify: vi.fn().mockResolvedValue({ modelId: '', ok: true, status: 'installed' }),
			remove: vi.fn().mockResolvedValue(0),
			removeAll: vi.fn().mockResolvedValue(0),
			footprint: vi.fn().mockResolvedValue({ bytes: 0, models: [] }),
			readiness: vi.fn().mockResolvedValue({
				canStartSession: true,
				canRunHandsFree: true,
				slots: [],
				blocking: [],
			}),
			onProgress: vi.fn().mockReturnValue(() => {}),
		},
		// The native engines the local tier runs on. Present here for the same
		// reason `models` is: any surface offering to make voice work has to fetch
		// BOTH, so a component that lists models and omits the runtime mock throws
		// on mount rather than rendering. Empty by default - a test that cares
		// about a runtime says which one.
		runtimes: {
			list: vi.fn().mockResolvedValue([]),
			install: vi.fn().mockResolvedValue(true),
			footprint: vi.fn().mockResolvedValue(0),
			removeAll: vi.fn().mockResolvedValue(undefined),
			onProgress: vi.fn().mockReturnValue(() => {}),
		},
	},
	// The core Local Models service (ungated). Same shape as `voice.models` and
	// `voice.runtimes`, which front the same main-process service.
	localModels: {
		list: vi.fn().mockResolvedValue([]),
		download: vi.fn().mockResolvedValue({ modelId: '', status: 'complete' }),
		pause: vi.fn().mockResolvedValue(true),
		resume: vi.fn().mockResolvedValue({ modelId: '', status: 'complete' }),
		cancel: vi.fn().mockResolvedValue(true),
		verify: vi.fn().mockResolvedValue({ modelId: '', ok: true, status: 'installed' }),
		remove: vi.fn().mockResolvedValue(0),
		removeAll: vi.fn().mockResolvedValue(0),
		footprint: vi.fn().mockResolvedValue({ bytes: 0, models: [] }),
		onProgress: vi.fn().mockReturnValue(() => {}),
		// A machine every catalog model fits on, so a surface that hides what is
		// too large shows the whole catalog unless a test says otherwise.
		hardware: vi.fn().mockResolvedValue({
			platform: 'darwin',
			arch: 'arm64',
			totalMemoryBytes: 128 * 1024 ** 3,
			unifiedMemory: true,
			gpus: [],
		}),
		huggingFace: {
			preview: vi.fn().mockResolvedValue({ ok: false, message: 'not mocked' }),
			add: vi.fn().mockResolvedValue({ ok: false, message: 'not mocked' }),
			remove: vi.fn().mockResolvedValue({ ok: false, message: 'not mocked' }),
			list: vi.fn().mockResolvedValue([]),
			onChanged: vi.fn().mockReturnValue(() => {}),
		},
		runtimes: {
			list: vi.fn().mockResolvedValue([]),
			install: vi.fn().mockResolvedValue(true),
			footprint: vi.fn().mockResolvedValue(0),
			removeAll: vi.fn().mockResolvedValue(undefined),
			onProgress: vi.fn().mockReturnValue(() => {}),
		},
		endpoints: {
			detect: vi.fn().mockResolvedValue([]),
			listModels: vi.fn().mockResolvedValue({ ok: true, models: [] }),
			test: vi.fn().mockResolvedValue({ ok: true, model: '', latencyMs: 0 }),
		},
		runOn: {
			test: vi.fn().mockResolvedValue({
				ok: false,
				code: 'run-on-test-not-startable',
				message: 'not mocked',
			}),
		},
		tiers: {
			options: vi.fn().mockResolvedValue([]),
		},
		taskReadiness: vi.fn().mockResolvedValue([]),
		search: vi.fn().mockResolvedValue({ status: 'off' }),
		// Model routing is off unless a test assigns it a router: a turn on the
		// Auto model then gets no decision and runs on the agent's default.
		routeTurn: vi.fn().mockResolvedValue({
			skipped: 'off',
			detail: 'Model routing is off.',
			latencyMs: 0,
		}),
		proxy: {
			report: vi.fn().mockResolvedValue({
				status: { port: null, running: false, agentIds: [], lastError: null, gatewayUrls: null },
				agents: [],
				usage: null,
				recentCompressions: [],
			}),
			ensurePort: vi.fn().mockResolvedValue(48123),
			block: vi.fn().mockResolvedValue(null),
		},
		server: {
			report: vi.fn().mockResolvedValue({
				status: {
					state: 'stopped',
					port: null,
					bind: 'local',
					host: '127.0.0.1',
					baseUrl: null,
					maxModels: 1,
					pid: null,
					startedAt: null,
					restarts: 0,
					lastError: null,
					models: [],
					loadedModels: [],
					keyStorage: null,
					logPath: '/tmp/maestro-test/logs/model-server.log',
				},
				engine: {
					installed: false,
					stale: false,
					release: null,
					choice: null,
					label: null,
					kind: null,
					accelerator: null,
					bytes: 0,
					builds: [],
				},
				loaded: [],
				installing: null,
			}),
			start: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
			set: vi.fn().mockResolvedValue(undefined),
			key: vi.fn().mockResolvedValue('sk-maestro-test'),
			installEngine: vi.fn().mockResolvedValue(undefined),
			onChanged: vi.fn().mockReturnValue(() => {}),
			onProgress: vi.fn().mockReturnValue(() => {}),
		},
		systemOne: {
			report: vi.fn().mockResolvedValue({
				settings: {
					engine: 'off',
					openJevUrl: null,
					timeoutMs: 1500,
					models: {},
					failPolicies: {},
					keepInputs: false,
					agents: { enabled: true, dailyBudgetUsd: 1, perAgentBudgetUsd: null },
				},
				engineLabel: 'Off',
				disclosure: 'System One is off. No task text is sent to an engine.',
				baseUrl: null,
				model: null,
				modelLabel: null,
				timeoutMs: null,
				calibrated: null,
				keys: { 'jev-cloud': { source: 'none' }, openjev: { source: 'none' } },
				problem: null,
				testPassedAt: null,
				failPolicies: [
					{ taskId: 'cue-gate', label: 'Cue gate', policy: 'open', defaultPolicy: 'open' },
					{
						taskId: 'injection-screen',
						label: 'Prompt-injection screen',
						policy: 'closed',
						defaultPolicy: 'closed',
					},
				],
			}),
			set: vi.fn(),
			setKey: vi.fn(),
			clearKey: vi.fn(),
			test: vi.fn(),
			ledger: vi.fn().mockResolvedValue({
				entries: [],
				total: 0,
				retentionDays: 30,
				notice: null,
			}),
			// Off by default, so no spawn in a test carries the System One section
			// unless the test turns it on.
			agentAccess: vi.fn().mockResolvedValue({
				allowed: false,
				gate: 'engine-off',
				message: 'System One is off: no engine is chosen. Continue without System One.',
				reason: 'System One is off: no engine is chosen.',
				engine: 'off',
				engineLabel: 'Off',
				calibrated: null,
				budget: {
					dayStartedAt: 0,
					dailyBudgetUsd: 1,
					spentTodayUsd: 0,
					remainingTodayUsd: 1,
				},
			}),
			usage: vi.fn().mockResolvedValue({
				since: 0,
				retentionDays: 30,
				rows: [],
				totals: { requests: 0, cachedRequests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 },
				budget: {
					dayStartedAt: 0,
					dailyBudgetUsd: 1,
					spentTodayUsd: 0,
					remainingTodayUsd: 1,
				},
				engine: 'off',
				engineLabel: 'Off',
				notice: null,
			}),
			onChanged: vi.fn().mockReturnValue(() => {}),
		},
		semanticIndex: {
			status: vi.fn().mockResolvedValue({
				state: 'off',
				indexed: 0,
				total: 0,
				bySourceType: {
					history: { indexed: 0, total: 0 },
					'directors-notes': { indexed: 0, total: 0 },
					transcript: { indexed: 0, total: 0 },
				},
			}),
			onProgress: vi.fn().mockReturnValue(() => {}),
		},
		draftPullRequest: vi.fn().mockResolvedValue({
			success: false,
			status: 'off',
			error: 'Git drafts is off.',
		}),
		suggestTabCleanup: vi.fn().mockResolvedValue({
			success: false,
			status: 'off',
			error: 'Tab cleanup suggestions is off.',
		}),
		spokenNotices: {
			agentFinished: vi.fn().mockResolvedValue({
				spoken: false,
				code: 'setting-off',
				message: 'Speak when an agent finishes is off.',
			}),
			speak: vi.fn().mockResolvedValue({ spoken: true, text: 'Test', lineSource: 'given' }),
		},
		dictation: {
			start: vi.fn().mockResolvedValue({
				started: false,
				code: 'task-off',
				message: 'Dictation is off.',
			}),
			stop: vi.fn().mockResolvedValue({ status: 'idle' }),
			cancel: vi.fn().mockResolvedValue(undefined),
			onInterrupted: vi.fn().mockReturnValue(() => {}),
		},
	},
	dialog: {
		selectFolder: vi.fn().mockResolvedValue(null),
		saveFile: vi.fn().mockResolvedValue(null),
	},
	shells: {
		detect: vi.fn().mockResolvedValue([]),
	},
	shell: {
		openExternal: vi.fn().mockResolvedValue(undefined),
		openPath: vi.fn().mockResolvedValue(undefined),
		trashItem: vi.fn().mockResolvedValue(undefined),
		showItemInFolder: vi.fn().mockResolvedValue(undefined),
	},
	sync: {
		getDefaultPath: vi.fn().mockResolvedValue('/default/path'),
		getSettings: vi.fn().mockResolvedValue({ customSyncPath: undefined }),
		getCurrentStoragePath: vi.fn().mockResolvedValue('/current/path'),
		setCustomPath: vi.fn().mockResolvedValue(undefined),
		migrateStorage: vi.fn().mockResolvedValue({ success: true, migratedCount: 0 }),
		resetToDefault: vi.fn().mockResolvedValue({ success: true }),
		selectSyncFolder: vi.fn().mockResolvedValue(null),
	},
	stats: {
		recordQuery: vi.fn().mockResolvedValue({ success: true }),
		getTokenUsage: vi.fn().mockResolvedValue({
			totals: {
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0,
				costEstimated: false,
				sessionCount: 0,
			},
			byAgent: [],
			byModel: [],
			byProject: [],
			byAccount: [],
			timeline: [],
			series: {
				byDay: {},
				byHour: {},
				byAgentByDay: {},
				bySessionByDay: {},
				bySource: { user: 0, auto: 0 },
			},
			speed: emptyTokenSpeedSummary(),
			coverageByAgent: {},
			generatedAtMs: 0,
		}),
		getAggregation: vi.fn().mockResolvedValue({
			totalQueries: 0,
			totalDuration: 0,
			avgDuration: 0,
			byAgent: {},
			bySource: { user: 0, auto: 0 },
			byDay: [],
		}),
		// The Models tab's record. Empty, so the tab renders its empty state.
		getModelUsage: vi.fn().mockResolvedValue({
			range: 'week',
			since: 0,
			totals: {
				requests: 0,
				otherModelRequests: 0,
				onDeviceRequests: 0,
				errors: 0,
				tokensIn: 0,
				tokensOut: 0,
				onDeviceTokens: 0,
			},
			sources: [],
			byTask: [],
			byAgent: [],
			systemOne: {
				decisions: 0,
				cached: 0,
				outcomes: { ok: 0, 'failed-open': 0, 'failed-closed': 0, unavailable: 0, cancelled: 0 },
				timeouts: 0,
				tokensIn: 0,
				tokensOut: 0,
				costUsd: 0,
				byTask: [],
				byEngine: [],
				routedTiers: { low: 0, medium: 0, high: 0 },
				retentionDays: 30,
				coversRange: true,
			},
			proxy: {
				totals: {
					requests: 0,
					compressRequests: 0,
					originalTokens: 0,
					sentTokens: 0,
					tokensSaved: 0,
					avgAddedLatencyMs: 0,
				},
				routedRequests: 0,
				byAgent: [],
			},
		}),
		// Interactive vs autonomous split (delegation surfaces). Zeroed so the
		// dashboard renders the "nothing tracked yet" state rather than throwing.
		getDelegationTotals: vi.fn().mockResolvedValue({
			interactive: { count: 0, durationMs: 0 },
			autoRun: { count: 0, durationMs: 0 },
			cue: { count: 0, durationMs: 0 },
		}),
		getDelegationByDay: vi.fn().mockResolvedValue([]),
		getStats: vi.fn().mockResolvedValue([]),
		startAutoRun: vi.fn().mockResolvedValue('auto-run-id'),
		endAutoRun: vi.fn().mockResolvedValue(true),
		recordAutoTask: vi.fn().mockResolvedValue('task-id'),
		getAutoRunSessions: vi.fn().mockResolvedValue([]),
		getAutoRunTasks: vi.fn().mockResolvedValue([]),
		exportUsage: vi.fn().mockResolvedValue({ path: '', format: 'json', rowCounts: {}, notes: [] }),
		onStatsUpdate: vi.fn().mockReturnValue(() => {}),
		recordResilience: vi.fn().mockResolvedValue('outage-id'),
		getResilience: vi.fn().mockResolvedValue([]),
		// Auto Run wizard usage tracking
		recordWizardRun: vi.fn().mockResolvedValue('wizard-run-id'),
		getWizardRuns: vi.fn().mockResolvedValue([]),
		getDatabaseSize: vi.fn().mockResolvedValue(1024 * 1024), // 1MB mock
		getEarliestTimestamp: vi.fn().mockResolvedValue(null),
		clearOldData: vi.fn().mockResolvedValue({
			success: true,
			deletedQueryEvents: 0,
			deletedAutoRunSessions: 0,
			deletedAutoRunTasks: 0,
		}),
		// Session lifecycle tracking
		recordSessionCreated: vi.fn().mockResolvedValue('lifecycle-id'),
		recordSessionClosed: vi.fn().mockResolvedValue(true),
		getSessionLifecycle: vi.fn().mockResolvedValue([]),
		// Shortcut usage tracking (Usage Dashboard daily bar chart)
		recordShortcutUsage: vi.fn().mockResolvedValue(null),
		getShortcutUsageByDay: vi.fn().mockResolvedValue([]),
		getShortcutUsageTotal: vi.fn().mockResolvedValue(0),
	},
	sshRemote: {
		getConfigs: vi.fn().mockResolvedValue({ success: true, configs: [] }),
		getDefaultId: vi.fn().mockResolvedValue({ success: true, id: null }),
		setConfigs: vi.fn().mockResolvedValue({ success: true }),
		setDefaultId: vi.fn().mockResolvedValue({ success: true }),
		testConnection: vi.fn().mockResolvedValue({ success: true }),
		getSshConfigHosts: vi.fn().mockResolvedValue({
			success: true,
			hosts: [],
			configPath: '~/.ssh/config',
		}),
	},
	crossAgent: {
		// Cross-agent @mention dispatch bridge. `onChunk` returns an unsubscribe fn,
		// mirroring the preload contract so useCrossAgentDispatch's mount effect
		// (window.maestro.crossAgent.onChunk) doesn't throw under test.
		send: vi.fn().mockResolvedValue({ requestId: 'test-cross-agent-request' }),
		// Stop calls this for every interrupt in AI mode, so it has to exist or
		// handleInterrupt throws before it ever signals a process.
		cancel: vi.fn().mockResolvedValue({ canceled: 0 }),
		// Asked by prepareMaestroSystemPrompt for an agent that has peers. `null`
		// is "cannot say", which leaves the budget sentence out.
		consultBudget: vi.fn().mockResolvedValue(null),
		onChunk: vi.fn().mockReturnValue(() => {}),
	},
	leaderboard: {
		submit: vi.fn().mockResolvedValue({ success: true, rank: 1 }),
		pollAuthStatus: vi.fn().mockResolvedValue({ status: 'confirmed', authToken: 'test-token' }),
		resendConfirmation: vi.fn().mockResolvedValue({ success: true }),
		sync: vi.fn().mockResolvedValue({ success: true }),
		getInstallationId: vi.fn().mockResolvedValue('test-installation-id'),
	},
	symphony: {
		getRegistry: vi.fn().mockResolvedValue({
			success: true,
			registry: { schemaVersion: '1.0', lastUpdated: '2025-01-01T00:00:00Z', repositories: [] },
			fromCache: false,
		}),
		getIssues: vi.fn().mockResolvedValue({ success: true, issues: [], fromCache: false }),
		getState: vi.fn().mockResolvedValue({
			success: true,
			state: { active: [], history: [], stats: {} },
		}),
		getActive: vi.fn().mockResolvedValue({ success: true, contributions: [] }),
		getCompleted: vi.fn().mockResolvedValue({ success: true, contributions: [] }),
		getStats: vi.fn().mockResolvedValue({ success: true, stats: {} }),
		start: vi.fn().mockResolvedValue({ success: true, contributionId: 'test-id' }),
		registerActive: vi.fn().mockResolvedValue({ success: true }),
		updateStatus: vi.fn().mockResolvedValue({ success: true, updated: true }),
		complete: vi.fn().mockResolvedValue({ success: true }),
		cancel: vi.fn().mockResolvedValue({ success: true, cancelled: true }),
		checkPRStatuses: vi.fn().mockResolvedValue({ success: true, checked: 0, merged: 0, closed: 0 }),
		clearCache: vi.fn().mockResolvedValue({ success: true, cleared: true }),
		cloneRepo: vi.fn().mockResolvedValue({ success: true }),
		startContribution: vi.fn().mockResolvedValue({ success: true, branchName: 'test-branch' }),
		createDraftPR: vi.fn().mockResolvedValue({ success: true }),
		fetchDocumentContent: vi.fn().mockResolvedValue({ success: true, content: '# Test' }),
		onUpdated: vi.fn().mockReturnValue(() => {}),
		onContributionStarted: vi.fn().mockReturnValue(() => {}),
	},
	app: {
		onQuitConfirmationRequest: vi.fn().mockReturnValue(() => {}),
		confirmQuit: vi.fn(),
		cancelQuit: vi.fn(),
		onSystemResume: vi.fn().mockReturnValue(() => {}),
		onBrowserTabShortcutKey: vi.fn().mockReturnValue(() => {}),
	},
	wakatime: {
		checkCli: vi.fn().mockResolvedValue({ available: false }),
		validateApiKey: vi.fn().mockResolvedValue({ valid: false }),
	},
	cue: {
		getSettings: vi.fn().mockResolvedValue({
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 512,
		}),
		saveSettings: vi.fn().mockResolvedValue({ writtenRoots: [] }),
		getStatus: vi.fn().mockResolvedValue([]),
		getActiveRuns: vi.fn().mockResolvedValue([]),
		getActivityLog: vi.fn().mockResolvedValue([]),
		getEventCount: vi.fn().mockResolvedValue(0),
		enable: vi.fn().mockResolvedValue(undefined),
		disable: vi.fn().mockResolvedValue(undefined),
		setActive: vi.fn().mockResolvedValue(undefined),
		stopRun: vi.fn().mockResolvedValue(false),
		stopAll: vi.fn().mockResolvedValue(undefined),
		refreshSession: vi.fn().mockResolvedValue(undefined),
		readYaml: vi.fn().mockResolvedValue(null),
		writeYaml: vi.fn().mockResolvedValue(undefined),
		validateYaml: vi.fn().mockResolvedValue({ valid: true, errors: [] }),
		onActivityUpdate: vi.fn().mockReturnValue(() => {}),
	},
	// Pianola API (autonomous manager: rules + decision log)
	pianola: {
		getRules: vi.fn().mockResolvedValue({ rules: [], malformed: false }),
		saveRules: vi.fn().mockImplementation((rules: unknown) => Promise.resolve(rules)),
		getDecisions: vi.fn().mockResolvedValue([]),
		getSuggestions: vi.fn().mockResolvedValue({
			generatedAt: 0,
			pairCount: 0,
			proposals: [],
			proposedProfile: '',
			previousProfile: '',
		}),
		applySuggestion: vi.fn().mockImplementation(() => Promise.resolve({ rules: [] })),
	},
	// Core Prompts API (disk-based prompts loaded at runtime)
	prompts: {
		get: vi.fn().mockResolvedValue({ success: true, content: '' }),
		getAll: vi.fn().mockResolvedValue({ success: true, prompts: [] }),
		getAllIds: vi.fn().mockResolvedValue({ success: true, ids: [] }),
		save: vi.fn().mockResolvedValue({ success: true }),
		reset: vi.fn().mockResolvedValue({ success: true, content: '' }),
		getPath: vi.fn().mockResolvedValue({ success: true, path: '/mock/prompts/core' }),
		getSystemPromptPaths: vi
			.fn()
			.mockResolvedValue({ success: true, computerHistoryDir: '/mock/userData/computer-history' }),
		listFiles: vi.fn().mockResolvedValue({ success: true, files: [] }),
	},
	// Multi-window API (window<->session ownership). Defaults model a single
	// primary window that owns no agents; window tests override per-case.
	windows: {
		create: vi.fn().mockResolvedValue(null),
		close: vi.fn().mockResolvedValue({ closed: true }),
		list: vi.fn().mockResolvedValue([]),
		getForSession: vi.fn().mockResolvedValue(null),
		moveSession: vi.fn().mockResolvedValue({ moved: true }),
		focusWindow: vi.fn().mockResolvedValue({ focused: true }),
		getState: vi.fn().mockResolvedValue(null),
		registerSession: vi.fn().mockResolvedValue({ registered: true }),
		setPanelState: vi.fn().mockResolvedValue(undefined),
		getBounds: vi.fn().mockResolvedValue(null),
		findWindowAtPoint: vi.fn().mockResolvedValue(null),
		highlightDropZone: vi.fn().mockResolvedValue(undefined),
		// Returns an unsubscribe fn (default no-op) so WindowProvider's effect can
		// clean up. Window tests capture the registered callback to fire broadcasts.
		onSessionMoved: vi.fn(() => () => {}),
		onHighlightDropZone: vi.fn(() => () => {}),
		onRemoteCommand: vi.fn(() => () => {}),
		sendRemoteCommandResponse: vi.fn(),
	},
	// MaestroRun (macOS launcher install + Full Disk Access walkthrough). Not
	// ready by default, so no spawn test picks up its system-prompt section.
	maestroRun: {
		status: vi.fn().mockResolvedValue(null),
		refresh: vi.fn().mockResolvedValue(null),
		install: vi.fn().mockResolvedValue(null),
		requestAccess: vi.fn().mockResolvedValue(null),
		readyPath: vi.fn().mockResolvedValue(null),
		onStatusChanged: vi.fn(() => () => {}),
	},
	// Quick Chat (floating window + its engine). Subscriptions return a no-op
	// unsubscribe so App's engine hook mounts and cleans up in every render test.
	quickChat: {
		command: vi.fn().mockResolvedValue({ ok: true, snapshot: null }),
		window: vi.fn().mockResolvedValue(null),
		getSnapshot: vi.fn().mockResolvedValue(null),
		setLayout: vi.fn(),
		setCompactHeight: vi.fn(),
		setFullView: vi.fn(),
		getPinned: vi.fn().mockResolvedValue(true),
		setPinned: vi.fn((pinned: boolean) => Promise.resolve(pinned)),
		onPinned: vi.fn(() => () => {}),
		getFontScale: vi.fn().mockResolvedValue(1),
		setFontScale: vi.fn().mockResolvedValue(1),
		onFontScale: vi.fn(() => () => {}),
		getRecents: vi.fn().mockResolvedValue([]),
		getRecent: vi.fn().mockResolvedValue(null),
		saveRecent: vi.fn(),
		onSnapshot: vi.fn(() => () => {}),
		onFocusInput: vi.fn(() => () => {}),
		onCommand: vi.fn(() => () => {}),
		pushSnapshot: vi.fn(),
		onHotkeyFailed: vi.fn(() => () => {}),
	},
	// Automatic tab naming (ephemeral namer spawn). Returns null by default so a
	// test that sends a message doesn't accidentally rename tabs; tests that care
	// override this with their own resolved value.
	tabNaming: {
		generateTabName: vi.fn().mockResolvedValue(null),
	},
	// Synchronous platform string (replaces async os.getPlatform IPC)
	platform: 'darwin',
};

// Only mock window.maestro if window exists (jsdom environment)
if (typeof window !== 'undefined') {
	Object.defineProperty(window, 'maestro', {
		writable: true,
		value: mockMaestro,
	});
}

// `useCachedResource` keeps results at module scope so a remounted surface
// renders instantly. Within one test file that would hand one test's fetched
// data to the next, so every test starts from an empty cache.
afterEach(() => {
	clearCachedResources();
});
