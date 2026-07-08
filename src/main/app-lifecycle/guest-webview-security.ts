import path from 'path';
import type { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { isAllowedBrowserTabPartition } from '../../shared/browserTabPartition';
import {
	isPluginPanelPartition,
	isAllowedPluginPanelAttachment,
} from '../../shared/plugins/panel-host';
import {
	hardenPluginPanelWebPreferences,
	hardenPluginPanelSession,
	attachPluginPanelGuestSecurity,
	isPluginPanelSession,
	type PluginPanelGuestContents,
} from '../plugins/plugin-panel-host';

// `file:` is allowed so users can open local HTML they just generated
// (Plotly dashboards, etc.) inside Maestro instead of bouncing to the system
// browser. The webview is still hardened (sandbox, no node, webSecurity true)
// and only renders content the user explicitly opens.
const ALLOWED_BROWSER_TAB_EMBED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
const ALLOWED_BROWSER_TAB_ABOUT_URLS = new Set(['about:blank']);

type BrowserTabWebPreferences = Record<string, unknown> & {
	partition?: string;
	preload?: string;
	nodeIntegration?: boolean;
	nodeIntegrationInSubFrames?: boolean;
	contextIsolation?: boolean;
	sandbox?: boolean;
	webSecurity?: boolean;
	allowRunningInsecureContent?: boolean;
};

interface BrowserTabGuestContents {
	getType?: () => string;
	setWindowOpenHandler: (
		handler: ({ url }: { url: string }) => { action: 'deny' | 'allow' }
	) => void;
	on(
		event: 'will-navigate' | 'will-redirect',
		handler: (event: { preventDefault: () => void }, url: string) => void
	): void;
	on(
		event: 'before-input-event',
		handler: (
			event: { preventDefault: () => void },
			input: {
				meta: boolean;
				control: boolean;
				alt: boolean;
				shift: boolean;
				type: string;
				key: string;
				code: string;
			}
		) => void
	): void;
	on(event: string, handler: (...args: unknown[]) => void): void;
	executeJavaScript(code: string): Promise<unknown>;
	// Privileged Electron paste: bypasses the web-facing `clipboard-read`
	// permission that the permission handler denies to webviews (issue #1063).
	paste(): void;
}

function isAllowedBrowserTabUrl(rawUrl: string): boolean {
	if (ALLOWED_BROWSER_TAB_ABOUT_URLS.has(rawUrl)) return true;

	try {
		return ALLOWED_BROWSER_TAB_EMBED_PROTOCOLS.has(new URL(rawUrl).protocol);
	} catch {
		return false;
	}
}

function hardenBrowserTabWebPreferences(webPreferences: BrowserTabWebPreferences): void {
	delete webPreferences.preload;
	delete (webPreferences as Record<string, unknown>).preloadURL;

	webPreferences.nodeIntegration = false;
	webPreferences.nodeIntegrationInSubFrames = false;
	webPreferences.contextIsolation = true;
	webPreferences.sandbox = true;
	webPreferences.webSecurity = true;
	webPreferences.allowRunningInsecureContent = false;
}

function attachBrowserTabGuestSecurity(guestContents: BrowserTabGuestContents): void {
	const denyBrowserTabNavigation = (
		eventName: 'will-navigate' | 'will-redirect',
		event: { preventDefault: () => void },
		url: string
	) => {
		if (isAllowedBrowserTabUrl(url)) return;

		event.preventDefault();
		logger.warn(`Blocked browser-tab ${eventName}: ${url}`, 'Window', {
			url,
			type: guestContents.getType?.() ?? 'unknown',
		});
	};

	guestContents.setWindowOpenHandler(({ url }) => {
		logger.warn(`Blocked browser-tab popup: ${url}`, 'Window', {
			url,
			type: guestContents.getType?.() ?? 'unknown',
		});
		return { action: 'deny' };
	});

	guestContents.on('will-navigate', (event, url) => {
		denyBrowserTabNavigation('will-navigate', event, url);
	});

	guestContents.on('will-redirect', (event, url) => {
		denyBrowserTabNavigation('will-redirect', event, url);
	});
}

/**
 * Restrict renderer-created webviews to the two sanctioned surfaces:
 * browser tabs (persist:maestro-browser-session-*) and plugin panels
 * (plugin:<id>, hardened by the plugin panel host). Anything else is
 * blocked before the guest exists.
 */
export function attachGuestWebviewSecurity(
	browserWindow: BrowserWindow,
	preloadPath: string
): void {
	// The plugin-panel preload lives next to the main preload bundle
	// (dist/main/plugin-panel-preload.js, built by scripts/build-preload.mjs).
	const pluginPanelPreloadPath = path.join(path.dirname(preloadPath), 'plugin-panel-preload.js');

	browserWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
		const src = typeof params.src === 'string' ? params.src : '';
		const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : '';

		if (isPluginPanelPartition(partition)) {
			// Per-plugin isolated surface: partition and document must belong
			// to the SAME plugin, web prefs are forced (no Node, isolation,
			// sandbox, broker-only preload), and the per-plugin session gets
			// its protocol handler + egress/permission denial installed.
			if (!isAllowedPluginPanelAttachment(partition, src)) {
				event.preventDefault();
				logger.warn(`Blocked unsafe plugin panel attachment: ${src || '<empty src>'}`, 'Window', {
					src,
					partition,
				});
				return;
			}
			hardenPluginPanelWebPreferences(
				webPreferences as Record<string, unknown>,
				pluginPanelPreloadPath
			);
			hardenPluginPanelSession(partition);
			return;
		}

		hardenBrowserTabWebPreferences(webPreferences as BrowserTabWebPreferences);

		if (!isAllowedBrowserTabUrl(src) || !isAllowedBrowserTabPartition(partition)) {
			event.preventDefault();
			logger.warn(`Blocked unsafe webview attachment: ${src || '<empty src>'}`, 'Window', {
				src,
				partition,
			});
		}
	});

	browserWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
		// Plugin panel guests get the panel lockdown ONLY: no popups, no
		// navigation — and none of the browser-tab conveniences (shortcut
		// forwarding, JS injection, privileged paste) may ever run inside
		// plugin-controlled content.
		const panelGuest = guestContents as unknown as PluginPanelGuestContents;
		if (isPluginPanelSession(panelGuest.session)) {
			attachPluginPanelGuestSecurity(panelGuest);
			return;
		}

		attachBrowserTabGuestSecurity(guestContents as BrowserTabGuestContents);

		// Forward app shortcuts from the webview guest process to the renderer.
		// When a <webview> has focus, keyboard events are trapped in its guest
		// Chromium process and never reach the renderer's window keydown handler.
		//
		// Strategy: inject a bubble-phase keydown listener into the guest page.
		// After all page handlers have run, if the page did NOT call preventDefault
		// on a Meta/Ctrl keystroke, it means the page doesn't use that shortcut —
		// so we forward it to the app. If the page DID preventDefault, the page's
		// shortcut takes precedence and we leave it alone.
		const guest = guestContents as BrowserTabGuestContents;

		// Intercept app shortcuts BEFORE Chromium's built-in handlers consume them.
		// Some keys (e.g. Cmd+L for address bar focus) are handled by Chromium
		// internally and never reach the injected JS listener below.
		guest.on('before-input-event', (event, input) => {
			if (!input.meta && !input.control && !input.alt) return;
			if (input.type !== 'keyDown') return;
			const k = input.key.toLowerCase();
			// Cmd/Ctrl+V: drive paste through the trusted guest webContents API.
			// Chromium's native paste needs the `clipboard-read` permission, which
			// the permission handler denies to webviews as a security boundary, so
			// native paste silently fails inside browser-tab form fields (issue
			// #1063). guest.paste() is a privileged Electron call that bypasses
			// that web-facing permission, mirroring the right-click Paste menu
			// item (issue #1065).
			const isPaste = (input.meta || input.control) && !input.alt && !input.shift && k === 'v';
			if (isPaste) {
				event.preventDefault();
				guest.paste();
				return;
			}
			// Let the remaining standard text-editing shortcuts pass through to
			// the page. `f` is intentionally NOT in this list: Cmd+F must reach
			// the renderer so the in-page find bar can open.
			const isTextEditing =
				(input.meta || input.control) && !input.alt && !input.shift && 'acxz'.includes(k);
			const isRedo = (input.meta || input.control) && !input.alt && input.shift && k === 'z';
			if (isTextEditing || isRedo) return;
			event.preventDefault();
			browserWindow.webContents.send('browser-tab:shortcutKey', {
				key: input.key,
				code: input.code,
				meta: input.meta,
				control: input.control,
				alt: input.alt,
				shift: input.shift,
			});
		});

		// Capture-phase listener: intercepts app shortcuts BEFORE the page
		// can handle them.  We preventDefault+stopPropagation so the page
		// never sees the event, then forward it to the app via console.log.
		const shortcutInjection = `(function(){
			if(window.__maestroShortcutListenerInstalled)return;
			window.__maestroShortcutListenerInstalled=true;
			document.addEventListener('keydown',function(e){
				var hasMod=e.metaKey||e.ctrlKey;
				var hasAlt=e.altKey;
				if(!hasMod&&!hasAlt)return;
				var k=e.key.toLowerCase();
				var te=hasMod&&!hasAlt&&!e.shiftKey&&'acxz'.indexOf(k)!==-1;
				var re=hasMod&&!hasAlt&&e.shiftKey&&k==='z';
				if(te||re)return;
				e.preventDefault();
				e.stopPropagation();
				console.log('__MAESTRO_KEY__'+JSON.stringify({
					key:e.key,code:e.code,
					meta:e.metaKey,control:e.ctrlKey,
					alt:e.altKey,shift:e.shiftKey
				}));
			},true);
		})();`;
		const injectShortcutListener = () => {
			guest.executeJavaScript(shortcutInjection).catch(() => {});
		};
		guest.on('dom-ready', injectShortcutListener);
		guest.on('did-navigate', injectShortcutListener);
		// console-message args: (event, level, message, line, sourceId)
		guest.on('console-message', (...args: unknown[]) => {
			const message = typeof args[2] === 'string' ? args[2] : String(args[2] ?? '');
			const prefix = '__MAESTRO_KEY__';
			if (!message.startsWith(prefix)) return;
			try {
				const input = JSON.parse(message.slice(prefix.length));
				browserWindow.webContents.send('browser-tab:shortcutKey', input);
			} catch {
				// Malformed message, ignore
			}
		});
	});
}
