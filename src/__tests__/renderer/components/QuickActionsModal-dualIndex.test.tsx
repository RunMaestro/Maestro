/**
 * Tests for dual-index search in the command palette.
 * Verifies that when the UI is in a non-English locale, users can search
 * commands using either the translated label or the English name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { Session, Group, Theme, Shortcut } from '../../../renderer/types';
import { useUIStore } from '../../../renderer/stores/uiStore';
import { useFileExplorerStore } from '../../../renderer/stores/fileExplorerStore';

// Use vi.hoisted so the variable is available inside the vi.mock factory
const { testLocale } = vi.hoisted(() => ({
	testLocale: { current: 'es' as string },
}));

// Override the global react-i18next mock with one that supports dual-locale resolution.
// When testLocale.current is 'es', t(key) returns Spanish; t(key, { lng: 'en' }) returns English.
vi.mock('react-i18next', async () => {
	const menusEn = (await import('../../../shared/i18n/locales/en/menus.json')).default;
	const menusEs = (await import('../../../shared/i18n/locales/es/menus.json')).default;
	const commonEn = (await import('../../../shared/i18n/locales/en/common.json')).default;
	const commonEs = (await import('../../../shared/i18n/locales/es/common.json')).default;
	const settingsEn = (await import('../../../shared/i18n/locales/en/settings.json')).default;
	const modalsEn = (await import('../../../shared/i18n/locales/en/modals.json')).default;
	const notificationsEn = (await import('../../../shared/i18n/locales/en/notifications.json'))
		.default;
	const accessibilityEn = (await import('../../../shared/i18n/locales/en/accessibility.json'))
		.default;
	const shortcutsEn = (await import('../../../shared/i18n/locales/en/shortcuts.json')).default;

	const locales: Record<string, Record<string, Record<string, unknown>>> = {
		en: {
			menus: menusEn,
			common: commonEn,
			settings: settingsEn,
			modals: modalsEn,
			notifications: notificationsEn,
			accessibility: accessibilityEn,
			shortcuts: shortcutsEn,
		},
		es: {
			menus: menusEs,
			common: commonEs,
			// Fall back to English for namespaces without Spanish translations
			settings: settingsEn,
			modals: modalsEn,
			notifications: notificationsEn,
			accessibility: accessibilityEn,
			shortcuts: shortcutsEn,
		},
	};

	function resolveNested(obj: Record<string, unknown>, key: string): string | null {
		const parts = key.split('.');
		let value: unknown = obj;
		for (const part of parts) {
			if (value && typeof value === 'object' && part in (value as Record<string, unknown>)) {
				value = (value as Record<string, unknown>)[part];
			} else {
				return null;
			}
		}
		return typeof value === 'string' ? value : null;
	}

	function interpolate(str: string, opts?: Record<string, unknown>): string {
		if (!opts) return str;
		let out = str;
		for (const [k, v] of Object.entries(opts)) {
			if (k !== 'defaultValue' && k !== 'lng') {
				out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
			}
		}
		return out;
	}

	function resolve(
		lang: string,
		key: string,
		ns?: string | string[],
		opts?: Record<string, unknown>
	): string {
		let bareKey = key;
		let explicitNs: string | undefined;
		if (key.includes(':')) {
			const [nsPfx, ...rest] = key.split(':');
			explicitNs = nsPfx;
			bareKey = rest.join(':');
		}
		const namespacesToTry: string[] = [];
		if (explicitNs) namespacesToTry.push(explicitNs);
		else if (Array.isArray(ns)) namespacesToTry.push(...ns);
		else if (ns) namespacesToTry.push(ns);
		else namespacesToTry.push('common');

		const locale = locales[lang] || locales['en'];
		for (const namespace of namespacesToTry) {
			const translations = locale[namespace];
			if (!translations) continue;
			const result = resolveNested(translations, bareKey);
			if (result !== null) {
				let out = result;
				if (opts) {
					if (opts.defaultValue && out === key) out = String(opts.defaultValue);
					out = interpolate(out, opts);
				}
				return out;
			}
		}
		// Fall back to English if key not found in target language
		if (lang !== 'en') {
			return resolve('en', key, ns, opts);
		}
		if (opts?.defaultValue) return interpolate(String(opts.defaultValue), opts);
		return interpolate(key, opts);
	}

	return {
		useTranslation: (ns?: string | string[]) => ({
			t: (key: string, opts?: Record<string, unknown>) => {
				const lang = opts?.lng === 'en' ? 'en' : testLocale.current;
				return resolve(lang, key, ns, opts);
			},
			i18n: {
				get language() {
					return testLocale.current;
				},
				dir: () => 'ltr',
			},
			ready: true,
		}),
		Trans: ({ children }: { children: React.ReactNode }) => children,
		initReactI18next: { type: '3rdParty', init: () => {} },
	};
});

vi.mock('../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: vi.fn(() => 'layer-123'),
		unregisterLayer: vi.fn(),
		updateLayerHandler: vi.fn(),
	}),
}));

vi.mock('../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual<typeof import('../../../renderer/stores/notificationStore')>(
		'../../../renderer/stores/notificationStore'
	);
	return {
		...actual,
		notifyToast: vi.fn(),
	};
});

vi.mock('../../../renderer/constants/modalPriorities', () => ({
	MODAL_PRIORITIES: {
		QUICK_ACTION: 100,
	},
}));

vi.mock('../../../renderer/services/git', () => ({
	gitService: {
		getDiff: vi.fn().mockResolvedValue({ diff: 'mock diff content' }),
		getRemoteBrowserUrl: vi.fn().mockResolvedValue('https://github.com/test/repo'),
	},
}));

// Import the component AFTER mocks are set up
import { QuickActionsModal } from '../../../renderer/components/QuickActionsModal';

const mockTheme: Theme = {
	id: 'dark',
	name: 'Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a2e',
		bgSidebar: '#16213e',
		bgActivity: '#0f3460',
		bgTerminal: '#1a1a2e',
		textMain: '#eaeaea',
		textDim: '#888',
		accent: '#e94560',
		accentForeground: '#ffffff',
		error: '#ff6b6b',
		border: '#333',
		success: '#4ecdc4',
		warning: '#ffd93d',
		terminalCursor: '#e94560',
	},
};

const mockShortcuts: Record<string, Shortcut> = {
	newInstance: { id: 'newInstance', keys: ['Cmd', 'N'], enabled: true },
	toggleMode: { id: 'toggleMode', keys: ['Cmd', 'J'], enabled: true },
	toggleSidebar: { id: 'toggleSidebar', keys: ['Cmd', 'B'], enabled: true },
	toggleRightPanel: { id: 'toggleRightPanel', keys: ['Cmd', 'R'], enabled: true },
	killInstance: { id: 'killInstance', keys: ['Cmd', 'W'], enabled: true },
	settings: { id: 'settings', keys: ['Cmd', ','], enabled: true },
	help: { id: 'help', keys: ['Cmd', '/'], enabled: true },
	systemLogs: { id: 'systemLogs', keys: ['Cmd', 'L'], enabled: true },
	processMonitor: { id: 'processMonitor', keys: ['Cmd', 'P'], enabled: true },
};

const createMockSession = (overrides: Partial<Session> = {}): Session => ({
	id: 'session-1',
	name: 'Test Session',
	toolType: 'claude-code',
	state: 'idle',
	inputMode: 'ai',
	cwd: '/home/user/project',
	projectRoot: '/home/user/project',
	aiPid: 1234,
	terminalPid: 5678,
	aiLogs: [],
	shellLogs: [],
	isGitRepo: true,
	fileTree: [],
	fileExplorerExpanded: [],
	messageQueue: [],
	aiTabs: [{ id: 'tab-1', name: 'Tab 1', logs: [] }],
	activeTabId: 'tab-1',
	closedTabHistory: [],
	...overrides,
});

const createDefaultProps = (
	overrides: Partial<React.ComponentProps<typeof QuickActionsModal>> = {}
) => ({
	theme: mockTheme,
	sessions: [createMockSession()],
	setSessions: vi.fn(),
	activeSessionId: 'session-1',
	groups: [],
	setGroups: vi.fn(),
	shortcuts: mockShortcuts,
	setQuickActionOpen: vi.fn(),
	setActiveSessionId: vi.fn(),
	setRenameInstanceModalOpen: vi.fn(),
	setRenameInstanceValue: vi.fn(),
	setRenameGroupModalOpen: vi.fn(),
	setRenameGroupId: vi.fn(),
	setRenameGroupValue: vi.fn(),
	setRenameGroupEmoji: vi.fn(),
	setCreateGroupModalOpen: vi.fn(),
	setLeftSidebarOpen: vi.fn(),
	setRightPanelOpen: vi.fn(),
	setActiveRightTab: vi.fn(),
	toggleInputMode: vi.fn(),
	deleteSession: vi.fn(),
	addNewSession: vi.fn(),
	setSettingsModalOpen: vi.fn(),
	setSettingsTab: vi.fn(),
	setShortcutsHelpOpen: vi.fn(),
	setAboutModalOpen: vi.fn(),
	setLogViewerOpen: vi.fn(),
	setProcessMonitorOpen: vi.fn(),
	setAgentSessionsOpen: vi.fn(),
	setActiveAgentSessionId: vi.fn(),
	setGitDiffPreview: vi.fn(),
	setGitLogOpen: vi.fn(),
	...overrides,
});

describe('QuickActionsModal dual-index search', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		testLocale.current = 'es';
		useUIStore.setState({
			sessionFilterOpen: false,
			historySearchFilterOpen: false,
			outputSearchOpen: false,
			activeFocus: 'main',
		});
		useFileExplorerStore.setState({
			fileTreeFilterOpen: false,
		});
	});

	afterEach(() => {
		testLocale.current = 'en';
		vi.restoreAllMocks();
	});

	it('renders commands in Spanish when locale is es', () => {
		const props = createDefaultProps();
		render(<QuickActionsModal {...props} />);

		// "Settings" in Spanish is "Configuracion"
		expect(screen.getByText('Configuracion')).toBeInTheDocument();
	});

	it('finds commands by English name when UI is in Spanish', () => {
		const props = createDefaultProps();
		render(<QuickActionsModal {...props} />);

		const input = screen.getByRole('textbox');
		fireEvent.change(input, { target: { value: 'Settings' } });

		// Should find the Spanish-labeled command via English fallback
		expect(screen.getByText('Configuracion')).toBeInTheDocument();
	});

	it('finds "Create New Agent" by English name in Spanish mode', () => {
		const props = createDefaultProps();
		render(<QuickActionsModal {...props} />);

		const input = screen.getByRole('textbox');
		fireEvent.change(input, { target: { value: 'New Agent' } });

		// Spanish: "Crear nuevo agente"
		expect(screen.getByText('Crear nuevo agente')).toBeInTheDocument();
	});

	it('still finds commands by translated name in Spanish locale', () => {
		const props = createDefaultProps();
		render(<QuickActionsModal {...props} />);

		const input = screen.getByRole('textbox');
		fireEvent.change(input, { target: { value: 'Configuracion' } });

		expect(screen.getByText('Configuracion')).toBeInTheDocument();
	});

	it('English search is case insensitive in non-English locale', () => {
		const props = createDefaultProps();
		render(<QuickActionsModal {...props} />);

		const input = screen.getByRole('textbox');
		fireEvent.change(input, { target: { value: 'settings' } });

		expect(screen.getByText('Configuracion')).toBeInTheDocument();
	});

	it('does not match unrelated English terms', () => {
		const props = createDefaultProps();
		render(<QuickActionsModal {...props} />);

		const input = screen.getByRole('textbox');
		fireEvent.change(input, { target: { value: 'zzzznonexistent' } });

		expect(screen.queryByText('Configuracion')).not.toBeInTheDocument();
	});

	it('works normally in English locale (no dual-index overhead)', () => {
		testLocale.current = 'en';
		const props = createDefaultProps();
		render(<QuickActionsModal {...props} />);

		const input = screen.getByRole('textbox');
		fireEvent.change(input, { target: { value: 'Settings' } });

		expect(screen.getByText('Settings')).toBeInTheDocument();
	});
});
