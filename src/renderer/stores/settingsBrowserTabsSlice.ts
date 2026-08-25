/**
 * Browser and tab-behavior settings slice for settingsStore (in-app browser
 * behavior, tab keep-alive, tab naming, and where new tabs of each type get
 * inserted).
 *
 * Part of the same domain-slice decomposition as settingsAnnotatorSlice.ts -
 * see that file for the pattern this follows.
 */

import type { StateCreator } from 'zustand';
import type { SettingsStore } from './settingsStore';
import { DEFAULT_BROWSER_TAB_URL } from '../utils/browserTabPersistence';

export interface BrowserTabsState {
	showBrowserTabDomain: boolean;
	showTabCountBadge: boolean;
	tabBarWheelScroll: boolean;
	useSystemBrowser: boolean;
	browserHomeUrl: string;
	htmlDoubleClickOpensInBrowser: boolean;
	browserTabKeepAlive: 'off' | 'recent' | 'all';
	browserTabKeepAliveLimit: number;
	automaticTabNamingEnabled: boolean;
	newTabPlacement: 'end' | 'after-current';
	newBrowserTabPlacement: 'end' | 'after-current';
	newTerminalPlacement: 'end' | 'after-current';
	openedFilePlacement: 'end' | 'after-current';
	fileTabAutoRefreshEnabled: boolean;
}

export interface BrowserTabsActions {
	setShowBrowserTabDomain: (value: boolean) => void;
	setShowTabCountBadge: (value: boolean) => void;
	setTabBarWheelScroll: (value: boolean) => void;
	setUseSystemBrowser: (value: boolean) => void;
	setBrowserHomeUrl: (value: string) => void;
	setHtmlDoubleClickOpensInBrowser: (value: boolean) => void;
	setBrowserTabKeepAlive: (value: 'off' | 'recent' | 'all') => void;
	setBrowserTabKeepAliveLimit: (value: number) => void;
	setAutomaticTabNamingEnabled: (value: boolean) => void;
	setNewTabPlacement: (value: 'end' | 'after-current') => void;
	setNewBrowserTabPlacement: (value: 'end' | 'after-current') => void;
	setNewTerminalPlacement: (value: 'end' | 'after-current') => void;
	setOpenedFilePlacement: (value: 'end' | 'after-current') => void;
	setFileTabAutoRefreshEnabled: (value: boolean) => void;
}

export type BrowserTabsSlice = BrowserTabsState & BrowserTabsActions;

export const createBrowserTabsSlice: StateCreator<SettingsStore, [], [], BrowserTabsSlice> = (
	set
) => ({
	showBrowserTabDomain: true,
	showTabCountBadge: true,
	tabBarWheelScroll: true,
	useSystemBrowser: false,
	// Blank by default: a new browser tab is opened to go SOMEWHERE, and the caret
	// lands in the address bar ready for it. Loading a page first means waiting for
	// something you did not ask for and then typing over it. Users who do want a
	// landing page set one in Settings.
	browserHomeUrl: DEFAULT_BROWSER_TAB_URL,
	htmlDoubleClickOpensInBrowser: false,
	browserTabKeepAlive: 'off',
	browserTabKeepAliveLimit: 10,
	automaticTabNamingEnabled: true,
	newTabPlacement: 'end',
	newBrowserTabPlacement: 'after-current',
	newTerminalPlacement: 'after-current',
	openedFilePlacement: 'after-current',
	fileTabAutoRefreshEnabled: false,

	setShowBrowserTabDomain: (value) => {
		set({ showBrowserTabDomain: value });
		window.maestro.settings.set('showBrowserTabDomain', value);
	},

	setShowTabCountBadge: (value) => {
		set({ showTabCountBadge: value });
		window.maestro.settings.set('showTabCountBadge', value);
	},

	setTabBarWheelScroll: (value) => {
		set({ tabBarWheelScroll: value });
		window.maestro.settings.set('tabBarWheelScroll', value);
	},

	setUseSystemBrowser: (value) => {
		set({ useSystemBrowser: value });
		window.maestro.settings.set('useSystemBrowser', value);
	},

	setBrowserHomeUrl: (value) => {
		set({ browserHomeUrl: value });
		window.maestro.settings.set('browserHomeUrl', value);
	},

	setHtmlDoubleClickOpensInBrowser: (value) => {
		set({ htmlDoubleClickOpensInBrowser: value });
		window.maestro.settings.set('htmlDoubleClickOpensInBrowser', value);
	},

	setBrowserTabKeepAlive: (value) => {
		set({ browserTabKeepAlive: value });
		window.maestro.settings.set('browserTabKeepAlive', value);
	},

	setBrowserTabKeepAliveLimit: (value) => {
		const clamped = Math.max(1, Math.floor(value) || 1);
		set({ browserTabKeepAliveLimit: clamped });
		window.maestro.settings.set('browserTabKeepAliveLimit', clamped);
	},

	setAutomaticTabNamingEnabled: (value) => {
		set({ automaticTabNamingEnabled: value });
		window.maestro.settings.set('automaticTabNamingEnabled', value);
	},

	setNewTabPlacement: (value) => {
		set({ newTabPlacement: value });
		window.maestro.settings.set('newTabPlacement', value);
	},

	setNewBrowserTabPlacement: (value) => {
		set({ newBrowserTabPlacement: value });
		window.maestro.settings.set('newBrowserTabPlacement', value);
	},

	setNewTerminalPlacement: (value) => {
		set({ newTerminalPlacement: value });
		window.maestro.settings.set('newTerminalPlacement', value);
	},

	setOpenedFilePlacement: (value) => {
		set({ openedFilePlacement: value });
		window.maestro.settings.set('openedFilePlacement', value);
	},

	setFileTabAutoRefreshEnabled: (value) => {
		set({ fileTabAutoRefreshEnabled: value });
		window.maestro.settings.set('fileTabAutoRefreshEnabled', value);
	},
});

/** Mutates `patch` in place with any persisted Browser/Tabs fields found in `allSettings`. */
export function hydrateBrowserTabsSettings(
	allSettings: Record<string, unknown>,
	patch: Partial<BrowserTabsState>
): void {
	if (allSettings['showBrowserTabDomain'] !== undefined)
		patch.showBrowserTabDomain = allSettings['showBrowserTabDomain'] as boolean;

	if (allSettings['showTabCountBadge'] !== undefined)
		patch.showTabCountBadge = allSettings['showTabCountBadge'] as boolean;

	if (typeof allSettings['tabBarWheelScroll'] === 'boolean')
		patch.tabBarWheelScroll = allSettings['tabBarWheelScroll'];

	if (allSettings['useSystemBrowser'] !== undefined)
		patch.useSystemBrowser = allSettings['useSystemBrowser'] as boolean;

	if (allSettings['browserHomeUrl'] !== undefined)
		patch.browserHomeUrl = allSettings['browserHomeUrl'] as string;

	if (allSettings['htmlDoubleClickOpensInBrowser'] !== undefined)
		patch.htmlDoubleClickOpensInBrowser = allSettings['htmlDoubleClickOpensInBrowser'] as boolean;

	if (allSettings['browserTabKeepAlive'] !== undefined)
		patch.browserTabKeepAlive = allSettings['browserTabKeepAlive'] as 'off' | 'recent' | 'all';

	if (allSettings['browserTabKeepAliveLimit'] !== undefined)
		patch.browserTabKeepAliveLimit = allSettings['browserTabKeepAliveLimit'] as number;

	if (allSettings['automaticTabNamingEnabled'] !== undefined)
		patch.automaticTabNamingEnabled = allSettings['automaticTabNamingEnabled'] as boolean;

	if (allSettings['newTabPlacement'] !== undefined) {
		const placement = allSettings['newTabPlacement'];
		if (placement === 'end' || placement === 'after-current') {
			patch.newTabPlacement = placement;
		}
	}

	if (allSettings['newBrowserTabPlacement'] !== undefined) {
		const placement = allSettings['newBrowserTabPlacement'];
		if (placement === 'end' || placement === 'after-current') {
			patch.newBrowserTabPlacement = placement;
		}
	}

	if (allSettings['newTerminalPlacement'] !== undefined) {
		const placement = allSettings['newTerminalPlacement'];
		if (placement === 'end' || placement === 'after-current') {
			patch.newTerminalPlacement = placement;
		}
	}

	if (allSettings['openedFilePlacement'] !== undefined) {
		const placement = allSettings['openedFilePlacement'];
		if (placement === 'end' || placement === 'after-current') {
			patch.openedFilePlacement = placement;
		}
	}

	if (allSettings['fileTabAutoRefreshEnabled'] !== undefined)
		patch.fileTabAutoRefreshEnabled = allSettings['fileTabAutoRefreshEnabled'] as boolean;
}
