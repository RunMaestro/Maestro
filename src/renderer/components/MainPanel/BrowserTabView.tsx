import React, {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';
import {
	ArrowLeft,
	ArrowRight,
	ChevronDown,
	ChevronUp,
	ExternalLink,
	Eye,
	EyeOff,
	Globe,
	MousePointerClick,
	RotateCw,
	Trash2,
	VenetianMask,
	X,
} from 'lucide-react';
import { Spinner } from '../ui/Spinner';
import { isImeComposing } from '../../utils/ime';
import type { BrowserTab } from '../../../shared/browserPage';
import { BrowserDesignModeLayer } from './BrowserDesignModeLayer';
import { BrowserViewportControl } from './BrowserViewportControl';
import { useDesignModePanelCollapse } from '../../hooks/ui/useDesignModePanelCollapse';
import { useElementSize } from '../../hooks/ui/useElementWidth';
import { shortcutSuffix } from '../ui/ShortcutHint';
import type { Theme } from '../../types';
import {
	DEFAULT_BROWSER_TAB_TITLE,
	DEFAULT_BROWSER_TAB_URL,
	getBrowserTabTitle,
	resolveBrowserTabNavigationTarget,
	toWebviewSrc,
} from '../../utils/browserTabPersistence';
import { isWebDesktop } from '../../utils/runtimeContext';
import { useSettingsStore } from '../../stores/settingsStore';
import { RemoteBrowserTabView } from './RemoteBrowserTabView';
import { useSessionStore } from '../../stores/sessionStore';
import { createHostBrowserPageView } from '../../utils/browserPageView';
import { sanitizeJourneyUrl } from '../../../shared/userJourney';
import { recordJourney } from '../../services/userJourney';
import { computeBrowserViewportBox, type BrowserViewportBox } from '../../utils/browserViewport';
import {
	DEFAULT_BROWSER_VIEWPORT_PRESET,
	type BrowserViewportPreset,
} from '../../../shared/browserViewport';
import {
	captureDesignPick,
	captureDesignRegion,
	designModeGuestCall,
	type DesignModeCapture,
	type DesignModeGuestAccess,
	type DesignModeMiss,
	type DesignModeRect,
	type DesignModeRegionCapture,
	type DesignPickCapture,
} from '../../utils/designModePicker';

/** The agent whose tab bar holds this browser tab, if any. */
function findBrowserTabOwnerId(tabId: string): string | undefined {
	return useSessionStore
		.getState()
		.sessions.find((candidate) => candidate.browserTabs?.some((browser) => browser.id === tabId))
		?.id;
}

type ElectronWebviewElement = HTMLElement & {
	src: string;
	setActive?: (active: boolean) => void;
	canGoBack: () => boolean;
	canGoForward: () => boolean;
	goBack: () => void;
	goForward: () => void;
	reload: () => void;
	stop: () => void;
	getURL: () => string;
	getTitle: () => string;
	isLoading: () => boolean;
	getWebContentsId?: () => number | undefined;
	getZoomFactor?: () => number;
	executeJavaScript: (code: string) => Promise<unknown>;
	insertCSS?: (css: string) => Promise<string>;
	findInPage: (
		text: string,
		options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
	) => number;
	stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
	capturePage?: (rect?: DesignModeRect) => Promise<{ toDataURL: () => string }>;
};

interface BrowserTabViewProps {
	tab: BrowserTab;
	theme: Theme;
	onUpdateTab: (tabId: string, updates: Partial<BrowserTab>) => void;
	/**
	 * Whether this browser tab should hold keyboard focus. True only when the tab
	 * is the visible/active view AND no modal/overlay layer is open above it. When
	 * it flips to false the guest <webview> is blurred so the newly-active surface
	 * (file preview, AI input, terminal, or an open modal like the Tab Switcher)
	 * can claim keyboard focus - an Electron <webview> keeps Chromium input focus
	 * on its guest WebContents even after the host element is hidden or covered,
	 * which otherwise strands keystrokes in the webview.
	 */
	isActive?: boolean;
	/**
	 * Whether this is the tab the user is looking at, even while a dialog is open
	 * over it. `isActive` is this AND no dialog. Design Mode's side-bar collapse
	 * keys on it, so opening the command palette over the page does not bring the
	 * bars back and take them away again. Defaults to `isActive`.
	 */
	isCurrent?: boolean;
	/**
	 * Hands a Design Mode pick to the agent: an element the user clicked or a
	 * region they dragged out, with its cropped screenshot (null when there is
	 * none). `reveal` false means the user keeps picking. Resolves false when it
	 * could not be delivered. The Design Mode toggle is only offered when this is
	 * provided.
	 */
	onDesignPick?: (
		capture: DesignPickCapture & { note: string; reveal: boolean }
	) => Promise<boolean>;
	/**
	 * Queues a pick (an element or a region) as its own message for the agent
	 * instead of adding it to the draft, and the user keeps picking. Resolves the
	 * name of the tab it was queued on, or null when it could not be queued. The
	 * pick card offers Queue only when this is provided.
	 */
	onDesignQueue?: (
		capture: DesignPickCapture & { note: string }
	) => Promise<{ tabName: string } | null>;
}

export interface BrowserTabViewHandle {
	/**
	 * Extract the rendered text of the currently loaded page.
	 * Waits briefly for dom-ready if the guest is still loading so the value is
	 * non-empty when the caller invokes this immediately after activating a tab.
	 * Returns `""` if the webview cannot be reached or the script throws.
	 */
	getContent(): Promise<string>;
	/** The tabId this view is currently rendering - used for ref-to-tab reconciliation. */
	getTabId(): string;
	/** Open the in-page find bar and focus its input. */
	openFind(): void;
	/** Navigate back in the webview history if possible. No-op otherwise. */
	goBack(): void;
	/** Navigate forward in the webview history if possible. No-op otherwise. */
	goForward(): void;
	/** Move focus into the webview guest content (so arrow keys scroll the page). */
	focusWebview(): void;
	/** Extract the page's rendered text or HTML in the requested format. Like
	 *  getContent but format-aware; waits briefly for dom-ready. */
	extract(format: 'text' | 'innerText' | 'html'): Promise<string>;
	/** Current url + title of the loaded page (best-effort: webview-fresh with a
	 *  fallback to the last-known tab metadata). */
	getMeta(): { url: string; title: string };
	/** Navigate the tab to a url/search target. Returns the resolved url; throws
	 *  on an invalid target. Used by the coworking browser_navigate tool. */
	navigate(url: string): string;
	/** Reload the current page. */
	reload(): void;
	/** Stop the in-flight load. */
	stop(): void;
	/** Run JavaScript in the guest page and resolve its result. Used by the
	 *  coworking browser_click / browser_type / browser_eval tools. */
	executeJavaScript(code: string): Promise<unknown>;
	/** Capture a PNG screenshot of the tab as a data URL, or of `rect` (guest
	 *  DIPs, see designPickCropRect) within it. Throws when capture is
	 *  unavailable (e.g. webview not ready). */
	capturePage(rect?: DesignModeRect): Promise<string>;
	/** Turn Design Mode on or off (toolbar button, shortcut, palette). Turning it
	 *  on is a no-op on a tab that cannot offer it (blank page, streamed remote
	 *  page, web build); turning it off always works. */
	toggleDesignMode(): void;
	/** The width this tab shows its page at ('fit' fills the tab). Reads the
	 *  preset a `setViewportPreset` just chose, before the tab store hands it back. */
	getViewportPreset(): BrowserViewportPreset;
	/** Show the page at a preset's width (toolbar control, palette, CLI): laid
	 *  out at that CSS width and scaled down to fit the tab. 'fit' fills the tab. */
	setViewportPreset(preset: BrowserViewportPreset): void;
	/** Describe the first element matching `selector` and crop its screenshot,
	 *  the same payload a click in Design Mode builds (`maestro-cli browser-pick`). */
	inspectElement(selector: string): Promise<DesignModeCapture | DesignModeMiss | null>;
	/** List the elements in `rect` (guest CSS px from the viewport's top-left)
	 *  and crop its screenshot, the same payload a drag in Design Mode builds
	 *  (`maestro-cli browser-pick --rect`). Null when none of it is on screen. */
	inspectRegion(rect: DesignModeRect): Promise<DesignModeRegionCapture | null>;
}

/** Promise-based delay (ES2024 Promise.withResolvers, ambient-typed for the
 *  project's ES2020 lib). Used to poll for dom-ready without busy-waiting. */
function delay(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

/** Poll until the guest webview reports it has stopped loading, or the deadline
 *  passes. An unreachable isLoading() is treated as "not loading" so a read is
 *  best-effort rather than hanging. */
async function waitNotLoading(webview: ElectronWebviewElement, deadline: number): Promise<void> {
	while (Date.now() < deadline) {
		let loading = false;
		try {
			loading = webview.isLoading();
		} catch {
			loading = false;
		}
		if (!loading) return;
		await delay(50);
	}
}

/** Wait for the guest to be dom-ready AND to have finished loading before an
 *  extract, so a read right after a navigation returns the loaded page rather
 *  than a mid-load or pre-navigation snapshot. A short lead delay lets a just
 *  issued navigation flip isLoading before we sample it, and a post-load settle
 *  lets content that renders right after stop-loading (SPAs) appear. Bounded so
 *  a page that never goes network-idle still resolves. */
async function waitForReadyToRead(
	webview: ElectronWebviewElement,
	isDomReadyRef: React.MutableRefObject<boolean>,
	maxMs = 10000
): Promise<void> {
	const deadline = Date.now() + maxMs;
	await delay(150);
	while (!isDomReadyRef.current && Date.now() < deadline) {
		await delay(50);
	}
	await waitNotLoading(webview, deadline);
	await delay(300);
	await waitNotLoading(webview, deadline);
}

/** Extract page text/HTML from the guest webview. Returns "" if unreachable or
 *  the injected script throws. Electron's executeJavaScript queues until the
 *  page is ready, so this is safe to call mid-navigation. */
async function extractFromWebview(
	webview: ElectronWebviewElement,
	isDomReadyRef: React.MutableRefObject<boolean>,
	format: 'text' | 'innerText' | 'html'
): Promise<string> {
	await waitForReadyToRead(webview, isDomReadyRef);
	const expr =
		format === 'html'
			? '(document.documentElement && document.documentElement.outerHTML) || ""'
			: format === 'innerText'
				? '(document.documentElement && document.documentElement.innerText) || ""'
				: '(document.body && document.body.innerText) || ""';
	try {
		const result = await webview.executeJavaScript(expr);
		return typeof result === 'string' ? result : '';
	} catch {
		return '';
	}
}

/**
 * Whether the guest is showing an empty document rather than a real page.
 * A blank guest paints Chromium's default white, which reads as a bright flash
 * against a dark theme, so it is the one document we recolor. Real pages keep
 * their own background: forcing the theme color onto a page that never sets one
 * would leave its default black text on a dark surface.
 */
function isBlankGuestUrl(url: string | undefined): boolean {
	return !url || url === DEFAULT_BROWSER_TAB_URL;
}

/**
 * Guard against a theme color that is not a plain CSS color literal, since the
 * value is interpolated into a stylesheet injected in the guest.
 */
const SAFE_CSS_COLOR = /^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%/]+\)$|^hsla?\([\d\s.,%/]+\)$/i;

function blankPageBackgroundCss(color: string): string | null {
	if (!SAFE_CSS_COLOR.test(color.trim())) return null;
	return `html,body{background-color:${color.trim()} !important;}`;
}

/** Paint an empty guest document in the theme background instead of white. */
function applyBlankGuestBackground(webview: ElectronWebviewElement | null, color: string) {
	if (!webview?.insertCSS) return;
	if (!isBlankGuestUrl(webview.getURL?.())) return;
	const css = blankPageBackgroundCss(color);
	if (!css) return;
	void webview.insertCSS(css).catch(() => {});
}

/**
 * Size the webview inside its stage. With no `box` the page fills the stage. With
 * one, the webview is the preset's CSS size, which is the viewport the page lays
 * itself out for, and a transform scales it down to the stage from its top-left
 * corner (the stage is the scaled box, so nothing else needs to move).
 *
 * This is CSS rather than `webContents.enableDeviceEmulation()` on purpose: the
 * emulation is a main-process call on the guest (a webContentsId round trip for
 * every resize) with a second copy of the size, while the stage already holds
 * the box the overlay needs. The guest still renders at the preset width, so
 * screenshots stay sharp, and Chromium hit-tests pointer events through a
 * transformed guest, so input needs no mapping of ours. If a platform ever maps
 * input wrongly through the transform, switch to emulation.
 */
function syncWebviewLayout(webview: ElectronWebviewElement | null, box: BrowserViewportBox | null) {
	if (!webview) return;

	webview.style.display = 'flex';
	if (box) {
		webview.style.position = 'absolute';
		webview.style.top = '0';
		webview.style.left = '0';
		webview.style.width = `${box.width}px`;
		webview.style.height = `${box.height}px`;
		webview.style.flex = '0 0 auto';
		webview.style.transformOrigin = '0 0';
		webview.style.transform = box.scale === 1 ? '' : `scale(${box.scale})`;
	} else {
		webview.style.position = '';
		webview.style.top = '';
		webview.style.left = '';
		webview.style.width = '100%';
		webview.style.height = '100%';
		webview.style.flex = '1 1 auto';
		webview.style.transformOrigin = '';
		webview.style.transform = '';
	}

	const shadowHost = (webview as HTMLElement & { shadowRoot?: ShadowRoot | null }).shadowRoot;
	const guestElement = shadowHost?.querySelector<HTMLElement>('object, embed, iframe, webview');
	if (guestElement) {
		guestElement.style.width = '100%';
		guestElement.style.height = '100%';
		guestElement.style.display = 'flex';
	}
}

const NativeBrowserTabView = React.memo(
	forwardRef<BrowserTabViewHandle, BrowserTabViewProps>(function BrowserTabView(
		{ tab, theme, onUpdateTab, isActive = true, isCurrent = isActive, onDesignPick, onDesignQueue },
		ref
	) {
		const webviewRef = useRef<ElectronWebviewElement | null>(null);
		const hostRef = useRef<HTMLDivElement | null>(null);
		const isDomReadyRef = useRef(false);
		const latestTabRef = useRef(tab);
		// The <webview> src is set ONCE at mount and never re-driven from React
		// afterward. Both navigation paths (address-bar `navigateToAddress` and the
		// coworking `navigate()` handle) assign `webview.src` imperatively with a
		// `!==` guard, while `did-navigate` writes the live URL into `tab.url` only
		// for the address bar / persistence. Binding `<webview src={tab.url}>` to
		// that mutated value made React re-assign the src attribute on every
		// navigation event, and re-assigning a <webview>'s src reloads it, so a
		// redirecting/canonicalizing site (e.g. google.com to www.google.com/)
		// refreshed forever. Capturing the initial url in a ref breaks the loop.
		// Must go through toWebviewSrc: Electron parses the webview's src attribute
		// with `new URL()` while attaching, and an unparseable value throws
		// mid-commit and crashes the renderer (MAESTRO-QX/QY/QZ).
		const initialSrcRef = useRef(toWebviewSrc(tab.url));
		const isAddressFocusedRef = useRef(false);
		// User Journey: true while the next main-frame commit is a load the user did
		// not ask for (the tab loading its own URL, or an agent's `navigate()`), so
		// it is not recorded as a `browser.navigate`.
		const skipJourneyCommitRef = useRef(false);
		// Track whether the user explicitly clicked into the webview host area.
		// Used to distinguish intentional focus (user click) from programmatic
		// focus-stealing (page autofocus, window.focus(), etc.).
		const userClickedRef = useRef(false);
		const [addressValue, setAddressValue] = useState(tab.url);
		const [addressError, setAddressError] = useState<string | null>(null);
		const [addressBarHidden, setAddressBarHidden] = useState(false);
		const [findOpen, setFindOpen] = useState(false);
		const [findQuery, setFindQuery] = useState('');
		const [findMatches, setFindMatches] = useState({ active: 0, total: 0 });
		const findInputRef = useRef<HTMLInputElement | null>(null);
		const findRequestIdRef = useRef(0);
		// Two-step confirm for the destructive clear-browsing-data action: first
		// click arms the button (auto-disarms after 4s), second click clears.
		const [clearArmed, setClearArmed] = useState(false);
		const clearDisarmTimerRef = useRef<number | null>(null);

		useEffect(() => {
			return () => {
				if (clearDisarmTimerRef.current !== null) {
					window.clearTimeout(clearDisarmTimerRef.current);
				}
			};
		}, []);

		// Only tabs opened remotely without a live native guest use a streamed page.
		// A local tab stays a real webview, including while a remote client captures it.
		useLayoutEffect(() => {
			if (!tab.remotePage) return;
			const host = hostRef.current;
			const sessionId = findBrowserTabOwnerId(tab.id);
			if (!host || !sessionId) return;
			const page = createHostBrowserPageView(
				{ sessionId, tabId: tab.id },
				initialSrcRef.current,
				theme.colors.bgMain
			);
			host.prepend(page);
			webviewRef.current = page;
			return () => {
				webviewRef.current = null;
				page.dispose();
			};
		}, [tab.id, tab.remotePage]);
		useEffect(() => {
			webviewRef.current?.setActive?.(isActive);
		}, [isActive, tab.id, tab.remotePage]);
		// Design Mode needs a live page to pick from: not the blank tab, and not a
		// remotely streamed page, which has no guest to script or capture.
		// This guard only hides the overlay; it never turns Design Mode off, so a
		// load that passes through the blank URL (or a page the address bar cannot
		// show) keeps it on.
		// Read by the imperative toggle, whose handle is built once.
		const designModeAvailableRef = useRef(false);
		const designModeAvailable =
			!!onDesignPick && !tab.remotePage && tab.url !== DEFAULT_BROWSER_TAB_URL;
		designModeAvailableRef.current = designModeAvailable;
		// Design Mode is per-tab state on the tab itself (`tab.designMode`), so it
		// survives page loads, tab switches, keep-alive remounts and restarts.
		// Read by the setter and the imperative toggle through a ref.
		const designMode = tab.designMode === true;
		const designModeRef = useRef(designMode);
		designModeRef.current = designMode;
		// Written through onUpdateTab, which lands in the store's single-tab
		// browser updater (updateBrowserTab). The ref moves ahead of the store
		// round trip, so a second toggle in the same tick flips the new value.
		const setDesignMode = useCallback((on: boolean) => {
			if (designModeRef.current === on) return;
			designModeRef.current = on;
			onUpdateTabRef.current(latestTabRef.current.id, { designMode: on });
		}, []);
		// Viewport preset: the width this tab shows its page at, so a page that
		// picks its layout by width (a laptop with both side bars open can land on
		// the phone layout) can be seen at the width the user cares about. 'fit', the
		// default, fills the tab. Any other preset lays the page out at that CSS
		// width and scales it down to the tab; the stage in the JSX below is the box
		// that scaled page fills, and the Design Mode layer is sized to it. Per-tab
		// state on the tab itself, like Design Mode, written through onUpdateTab.
		const viewportPreset = tab.viewportPreset ?? DEFAULT_BROWSER_VIEWPORT_PRESET;
		const viewportPresetRef = useRef(viewportPreset);
		viewportPresetRef.current = viewportPreset;
		const setViewportPreset = useCallback((preset: BrowserViewportPreset) => {
			if (viewportPresetRef.current === preset) return;
			// The ref moves ahead of the store round trip, so a read right after
			// this write (the handle, the CLI) already sees the new preset.
			viewportPresetRef.current = preset;
			onUpdateTabRef.current(latestTabRef.current.id, { viewportPreset: preset });
		}, []);
		// The tab's size is watched only while a preset needs it.
		const hostSize = useElementSize(
			hostRef,
			viewportPreset !== DEFAULT_BROWSER_VIEWPORT_PRESET && !tab.remotePage
		);
		const viewportBox = useMemo(
			() => computeBrowserViewportBox(viewportPreset, hostSize),
			[viewportPreset, hostSize]
		);
		// The webview listeners below are set up once per tab and read it from here.
		const viewportBoxRef = useRef(viewportBox);
		viewportBoxRef.current = viewportBox;
		useLayoutEffect(() => {
			syncWebviewLayout(webviewRef.current, viewportBox);
		}, [viewportBox]);
		// The overlay is up only while this tab is the active surface. A hidden or
		// covered tab keeps the flag but draws no picker, so it swallows nothing,
		// and showing the tab again re-arms it: a fresh layer that takes focus and
		// probes from the center.
		const designModeArmed = designMode && designModeAvailable && isActive;
		// The side bars fold while Design Mode is up in a tab the user is looking at.
		// Keyed on isCurrent, not isActive: a dialog un-arms the overlay, but the
		// page must not reflow behind it (see useDesignModePanelCollapse).
		useDesignModePanelCollapse(designMode && designModeAvailable && isCurrent);
		const exitDesignMode = useCallback(() => setDesignMode(false), [setDesignMode]);
		const onDesignPickRef = useRef(onDesignPick);
		onDesignPickRef.current = onDesignPick;
		// Design Mode stays on after a pick either way. Without keepPicking the
		// pick reveals the chat, which takes this tab off screen; the picker
		// re-arms when the tab is shown again.
		const handleDesignDeliver = useCallback(
			async (capture: DesignPickCapture, note: string, keepPicking: boolean) => {
				const deliver = onDesignPickRef.current;
				if (!deliver) return false;
				return deliver({ ...capture, note, reveal: !keepPicking });
			},
			[]
		);
		// Queueing never leaves Design Mode: the user is lining up more picks.
		const onDesignQueueRef = useRef(onDesignQueue);
		onDesignQueueRef.current = onDesignQueue;
		const handleDesignQueue = useCallback(
			async (capture: DesignPickCapture, note: string) =>
				(await onDesignQueueRef.current?.({ ...capture, note })) ?? null,
			[]
		);
		// Design Mode: while armed, BrowserDesignModeLayer covers the webview and
		// does the picking (see the trust model in utils/designModePicker.ts).
		const designModeShortcut = useSettingsStore(
			(s) => s.tabShortcuts.toggleBrowserDesignMode?.keys
		);
		// Bumped on every finished page load, so the Design Mode overlay re-probes
		// the new document instead of keeping the old page's outline.
		const [pageLoadCount, setPageLoadCount] = useState(0);

		useEffect(() => {
			latestTabRef.current = tab;
		}, [tab]);

		// The listener effect below is keyed on tab.id alone, so it reads the
		// current theme background through a ref rather than a dependency.
		const blankBackgroundRef = useRef(theme.colors.bgMain);
		useEffect(() => {
			blankBackgroundRef.current = theme.colors.bgMain;
			if (isDomReadyRef.current) {
				applyBlankGuestBackground(webviewRef.current, theme.colors.bgMain);
			}
		}, [theme.colors.bgMain]);

		// Keep the latest onUpdateTab in a ref so the webview-listener effect below
		// can stay keyed on `tab.id` alone. The parent passes a fresh inline
		// callback every render, and navigation events mutate tab.url/tab.title;
		// if any of those were effect deps, every navigation would tear down and
		// re-register all listeners mid-flight (resetting isDomReadyRef), which
		// stranded the loading spinner and made the tab title oscillate.
		const onUpdateTabRef = useRef(onUpdateTab);
		useEffect(() => {
			onUpdateTabRef.current = onUpdateTab;
		}, [onUpdateTab]);

		// Capture the guest frame (or a rect of it). Shared by the Coworking
		// screenshot tool and Design Mode crops; built once, reads only refs.
		const captureGuestRef = useRef(async (rect?: DesignModeRect): Promise<string> => {
			const webview = webviewRef.current;
			if (!webview || !webview.capturePage) {
				throw new Error('Screenshot is not available for this tab');
			}
			// Electron can only capture a PAINTING webview; a kept-alive-but-hidden
			// tab (host visibility:hidden) throws UnknownVizError. If this tab is not
			// on the visible compositor, momentarily force it to paint behind an
			// opaque cover so the capture succeeds without the user ever seeing it -
			// capturePage returns the guest's own frame, not the cover. We trigger
			// only on visibility:hidden (the active-agent kept-alive mount); the
			// off-screen background host paints already and needs no cover.
			const host = hostRef.current;
			const hidden = !!host && getComputedStyle(host).visibility === 'hidden';
			const priorVisibility = host ? host.style.visibility : '';
			let cover: HTMLDivElement | null = null;
			if (host && hidden) {
				cover = document.createElement('div');
				cover.style.cssText = `position:absolute;inset:0;z-index:2147483647;background:${
					blankBackgroundRef.current || '#000'
				};`;
				host.appendChild(cover);
				host.style.visibility = 'visible';
				// Give the compositor a beat to produce a frame for the now-visible guest.
				await delay(180);
			}
			try {
				let dataUrl = (
					await (rect ? webview.capturePage(rect) : webview.capturePage())
				).toDataURL();
				if (dataUrl.length < 64 && hidden) {
					await delay(160);
					dataUrl = (await (rect ? webview.capturePage(rect) : webview.capturePage())).toDataURL();
				}
				return dataUrl;
			} finally {
				if (host && hidden) {
					host.style.visibility = priorVisibility;
					cover?.remove();
				}
			}
		});

		// What Design Mode needs from this webview. Throws when the guest is gone,
		// which the layer reports as "nothing to pick there".
		const designAccessRef = useRef<DesignModeGuestAccess>({
			run: (request) => {
				const webview = webviewRef.current;
				if (!webview) return Promise.reject(new Error('Browser webview is not available'));
				return webview.executeJavaScript(designModeGuestCall(request));
			},
			zoom: () => {
				try {
					return webviewRef.current?.getZoomFactor?.() ?? 1;
				} catch {
					return 1;
				}
			},
			capture: (rect) => captureGuestRef.current(rect),
			// Holding Space lets the user click into the page; picking takes the
			// keys back. A focused guest shows up as the <webview> itself.
			focused: () => !!webviewRef.current && document.activeElement === webviewRef.current,
			blur: () => webviewRef.current?.blur(),
		});

		useImperativeHandle(
			ref,
			(): BrowserTabViewHandle => ({
				async getContent(): Promise<string> {
					const webview = webviewRef.current;
					if (!webview) return '';
					return extractFromWebview(webview, isDomReadyRef, 'text');
				},
				async extract(format: 'text' | 'innerText' | 'html'): Promise<string> {
					const webview = webviewRef.current;
					if (!webview) return '';
					return extractFromWebview(webview, isDomReadyRef, format);
				},
				getMeta(): { url: string; title: string } {
					const tab = latestTabRef.current;
					const webview = webviewRef.current;
					return {
						url: webview?.getURL?.() || tab.url || '',
						title: webview?.getTitle?.() || tab.title || '',
					};
				},
				getTabId(): string {
					return latestTabRef.current.id;
				},
				openFind(): void {
					// State flip; the focus call lives in a useEffect keyed on
					// `findOpen` so it runs after React commits the input to the DOM
					// (requestAnimationFrame fired before commit in practice).
					setFindOpen(true);
				},
				goBack(): void {
					const webview = webviewRef.current;
					if (webview?.canGoBack()) webview.goBack();
				},
				goForward(): void {
					const webview = webviewRef.current;
					if (webview?.canGoForward()) webview.goForward();
				},
				focusWebview(): void {
					// Mark the focus as user-initiated so the host's focus-stealing
					// guard does not immediately blur the webview back out.
					userClickedRef.current = true;
					webviewRef.current?.focus();
				},
				navigate(rawUrl: string): string {
					const webview = webviewRef.current;
					if (!webview) throw new Error('Browser webview is not available');
					const result = resolveBrowserTabNavigationTarget(rawUrl);
					if (result.kind === 'error') throw new Error(result.message);
					if (webview.src !== result.url) {
						// The old page stays loaded until the new src reaches dom-ready;
						// mark not-ready so a follow-up read/waitFor extracts the NEW page.
						isDomReadyRef.current = false;
						skipJourneyCommitRef.current = true;
						webview.src = result.url;
					}
					return result.url;
				},
				reload(): void {
					webviewRef.current?.reload();
				},
				stop(): void {
					webviewRef.current?.stop();
				},
				async executeJavaScript(code: string): Promise<unknown> {
					const webview = webviewRef.current;
					if (!webview) throw new Error('Browser webview is not available');
					return webview.executeJavaScript(code);
				},
				capturePage(rect?: DesignModeRect): Promise<string> {
					return captureGuestRef.current(rect);
				},
				toggleDesignMode(): void {
					if (designModeRef.current) setDesignMode(false);
					else if (designModeAvailableRef.current) setDesignMode(true);
				},
				getViewportPreset(): BrowserViewportPreset {
					return viewportPresetRef.current;
				},
				setViewportPreset(preset: BrowserViewportPreset): void {
					setViewportPreset(preset);
				},
				async inspectElement(selector: string) {
					const webview = webviewRef.current;
					if (!webview) throw new Error('Browser webview is not available');
					await waitForReadyToRead(webview, isDomReadyRef);
					return captureDesignPick(designAccessRef.current, {
						type: 'describeSelector',
						selector,
					});
				},
				async inspectRegion(rect: DesignModeRect) {
					const webview = webviewRef.current;
					if (!webview) throw new Error('Browser webview is not available');
					await waitForReadyToRead(webview, isDomReadyRef);
					// No frame: the box is already guest CSS px, not overlay px. Only
					// the four numbers go to the page.
					return captureDesignRegion(designAccessRef.current, {
						type: 'region',
						x: rect.x,
						y: rect.y,
						width: rect.width,
						height: rect.height,
					});
				},
			}),
			[]
		);

		// Prevent webview from stealing host-page focus when pages auto-focus an
		// element (e.g. search box, login form, window.focus()).  If the webview
		// gains focus without a preceding user click inside the host area, blur
		// it immediately so keyboard shortcuts keep flowing through the window
		// handler.  The user can always click the webview to intentionally focus it.
		useEffect(() => {
			const host = hostRef.current;
			if (!host) return;
			const onPointerDown = () => {
				userClickedRef.current = true;
			};
			const onFocusIn = () => {
				if (!userClickedRef.current) {
					// Focus was not user-initiated - push it back out, but leave the
					// find-bar input and the Design Mode layer alone (Cmd+F and the
					// Design Mode toggle focus them programmatically, and that is
					// exactly the case this guard would otherwise mistakenly reject).
					const active = document.activeElement;
					const isFindInput = active === findInputRef.current;
					const isDesignLayer = !!active?.closest?.('[data-browser-design-mode]');
					if (active && host.contains(active) && !isFindInput && !isDesignLayer) {
						(active as HTMLElement).blur();
					}
				}
				// Reset after each focus event so the next auto-focus is caught.
				userClickedRef.current = false;
			};
			host.addEventListener('pointerdown', onPointerDown, true);
			host.addEventListener('focusin', onFocusIn);
			return () => {
				host.removeEventListener('pointerdown', onPointerDown, true);
				host.removeEventListener('focusin', onFocusIn);
			};
		}, []);

		// Release keyboard focus from the guest webview whenever this tab stops
		// being the active view. visibility:hidden on the host overlay is not
		// enough: an Electron <webview> keeps Chromium input focus on its guest
		// WebContents, so without an explicit blur a switch to a file/AI/terminal
		// tab leaves keystrokes routed into the (now hidden) page. Blurring lets
		// the destination view's own focus call land. Reset the user-click guard
		// so a fresh activation is treated as a clean slate.
		useEffect(() => {
			if (isActive) return;
			const host = hostRef.current;
			const active = document.activeElement;
			if (host && active && host.contains(active)) {
				(active as HTMLElement).blur();
			}
			webviewRef.current?.blur();
			userClickedRef.current = false;
			// Design Mode is not turned off here. The overlay is gated on isActive
			// (designModeArmed), so it unmounts and swallows nothing while the tab
			// is hidden or covered, and the flag on the tab re-arms it on return.
		}, [isActive]);

		// The overlay takes keyboard focus while Design Mode is armed; the guest
		// must not keep it, or Enter and the arrows would reach the page.
		useEffect(() => {
			if (designModeArmed) webviewRef.current?.blur();
		}, [designModeArmed]);

		useEffect(() => {
			if (!isAddressFocusedRef.current) {
				setAddressValue(tab.url);
			}
		}, [tab.id, tab.url]);

		// Explicit requests are separate from observed URLs: redirects must never
		// feed back into webview.src and start a reload loop.
		useEffect(() => {
			const webview = webviewRef.current;
			if (!webview || !tab.requestedUrl) return;
			const target = resolveBrowserTabNavigationTarget(tab.requestedUrl);
			if (target.kind === 'error') throw new Error(target.message);
			if (webview.src !== target.url) {
				isDomReadyRef.current = false;
				webview.src = target.url;
			}
			onUpdateTabRef.current(tab.id, { requestedUrl: undefined });
		}, [tab.id, tab.requestedUrl]);

		// The component instance is reused across tab switches (see the addressValue
		// reset above), so reset the two-step clear-session confirm too: arming Clear
		// on tab A then switching to tab B must not leave B pre-armed, where one click
		// would wipe B's data and skip the guard.
		useEffect(() => {
			setClearArmed(false);
			if (clearDisarmTimerRef.current !== null) {
				window.clearTimeout(clearDisarmTimerRef.current);
				clearDisarmTimerRef.current = null;
			}
		}, [tab.id]);

		useEffect(() => {
			const webview = webviewRef.current;
			if (!webview) return;
			isDomReadyRef.current = false;

			const updateTabState = (updates: Partial<BrowserTab>) => {
				onUpdateTabRef.current(latestTabRef.current.id, updates);
			};

			// User Journey: the first main-frame commit after these listeners attach
			// is the tab loading its own URL, either a new tab (`browser.open`
			// already recorded it, under the URL before any redirect) or a remount
			// reloading it. Neither is the user navigating, so it is skipped. The
			// last target is kept so a duplicate event or a fragment-only change
			// records nothing.
			skipJourneyCommitRef.current = latestTabRef.current.url !== DEFAULT_BROWSER_TAB_URL;
			let lastJourneyTarget = sanitizeJourneyUrl(latestTabRef.current.url);
			const recordNavigation = (url: string, isCommit: boolean) => {
				const target = sanitizeJourneyUrl(url);
				if (skipJourneyCommitRef.current && isCommit) {
					skipJourneyCommitRef.current = false;
					lastJourneyTarget = target;
					return;
				}
				if (target === DEFAULT_BROWSER_TAB_URL || target === lastJourneyTarget) return;
				lastJourneyTarget = target;
				const { id: tabId, ephemeral } = latestTabRef.current;
				const agentId = findBrowserTabOwnerId(tabId);
				// A private (ephemeral) tab leaves no journey.
				if (!agentId || ephemeral) return;
				// At commit Chromium reports the URL as the title until the page sets
				// one. getTitle throws on a guest that never reached dom-ready; the
				// entry is then recorded without a title.
				let title: string | undefined;
				try {
					title = webview.getTitle?.();
				} catch {
					title = undefined;
				}
				recordJourney(agentId, {
					kind: 'browser.navigate',
					target,
					tabId,
					...(title && title !== url ? { title } : {}),
				});
			};

			const readWebviewState = (): Partial<BrowserTab> | null => {
				if (!isDomReadyRef.current) return null;

				const nextUrl = webview.getURL?.() || latestTabRef.current.url || DEFAULT_BROWSER_TAB_URL;
				return {
					url: nextUrl,
					title: getBrowserTabTitle(nextUrl, webview.getTitle?.() || latestTabRef.current.title),
					canGoBack: webview.canGoBack(),
					canGoForward: webview.canGoForward(),
					isLoading: webview.isLoading(),
					webContentsId: webview.getWebContentsId?.(),
				};
			};

			const updateNavigationState = () => {
				const nextState = readWebviewState();
				if (!nextState) return;

				if (!isAddressFocusedRef.current) {
					setAddressValue(nextState.url || DEFAULT_BROWSER_TAB_URL);
				}
				setAddressError(null);
				updateTabState(nextState);
			};

			const handleStartLoading = () => updateTabState({ isLoading: true });
			const handleStopLoading = () => {
				// did-stop-loading is a strictly later signal than dom-ready: the guest
				// has finished loading, so the page is committed and readable. Re-affirm
				// readiness here because handleNavigationStart clears isDomReadyRef on
				// every main-frame nav; if dom-ready does not fire again before
				// stop-loading, readWebviewState would bail and leave the spinner stuck.
				isDomReadyRef.current = true;
				// The skipped load ended, committed or not; whatever commits next is
				// the user's navigation.
				skipJourneyCommitRef.current = false;
				syncWebviewLayout(webview, viewportBoxRef.current);
				updateNavigationState();
			};
			const handleNavigate = (event: Event) => {
				const nextUrl =
					(event as Event & { url?: string }).url ||
					webview.getURL?.() ||
					latestTabRef.current.url ||
					DEFAULT_BROWSER_TAB_URL;
				if (!isAddressFocusedRef.current) {
					setAddressValue(nextUrl);
				}
				setAddressError(null);
				updateTabState({
					url: nextUrl,
					title: getBrowserTabTitle(nextUrl, latestTabRef.current.title),
				});
				updateNavigationState();
				if ((event as Event & { isMainFrame?: boolean }).isMainFrame !== false) {
					recordNavigation(nextUrl, event.type === 'did-navigate');
				}
			};
			const handleNavigationStart = (event: Event) => {
				if ((event as Event & { isMainFrame?: boolean }).isMainFrame === false) return;
				// Any main-frame navigation (link click, redirect, or imperative
				// navigate) invalidates the loaded page, so mark not-ready; a coworking
				// read then waits for the NEW document instead of sampling the old one.
				// handleStopLoading re-affirms readiness on stop-loading so the spinner
				// never sticks even when dom-ready does not fire again.
				isDomReadyRef.current = false;
				const nextUrl =
					(event as Event & { url?: string }).url ||
					webview.getURL?.() ||
					latestTabRef.current.url ||
					DEFAULT_BROWSER_TAB_URL;
				if (!isAddressFocusedRef.current) {
					setAddressValue(nextUrl);
				}
				setAddressError(null);
				updateTabState({
					url: nextUrl,
					// Keep the last known page title while the navigation loads (mirrors
					// handleNavigate). Without the fallback, a cold reload - e.g. when a
					// grouped browser pane remounts after switching away and back - would
					// clobber the real page title with the bare URL host, so the tab label
					// appears to vanish until the page re-fires page-title-updated.
					title: getBrowserTabTitle(nextUrl, latestTabRef.current.title),
					isLoading: true,
					favicon: null,
				});
			};
			const handleTitleUpdated = (event: Event) => {
				const nextTitle = getBrowserTabTitle(
					webview.getURL?.() || latestTabRef.current.url,
					(event as Event & { title?: string }).title || webview.getTitle?.()
				);
				updateTabState({ title: nextTitle });
			};
			const handleFaviconUpdated = (event: Event) => {
				const favicons = (event as Event & { favicons?: string[] }).favicons;
				if (!Array.isArray(favicons)) return;
				updateTabState({ favicon: favicons[0] || null });
			};
			const handleDidFailLoad = (event: Event) => {
				if ((event as Event & { isMainFrame?: boolean }).isMainFrame === false) return;
				const nextUrl =
					(event as Event & { validatedURL?: string; url?: string }).validatedURL ||
					(event as Event & { validatedURL?: string; url?: string }).url ||
					webview.getURL?.() ||
					latestTabRef.current.url ||
					DEFAULT_BROWSER_TAB_URL;
				if (!isAddressFocusedRef.current) {
					setAddressValue(nextUrl);
				}
				setAddressError(null);
				updateTabState({
					url: nextUrl,
					title: getBrowserTabTitle(nextUrl),
					canGoBack: isDomReadyRef.current ? webview.canGoBack() : latestTabRef.current.canGoBack,
					canGoForward: isDomReadyRef.current
						? webview.canGoForward()
						: latestTabRef.current.canGoForward,
					isLoading: false,
					webContentsId: webview.getWebContentsId?.(),
				});
			};
			// Scroll-triggered address bar auto-hide: inject a scroll listener into the
			// guest page that reports scroll direction via console.log. When the user
			// scrolls down the address bar collapses; scrolling up or reaching the top
			// reveals it again.
			//
			// The listener MUST ignore scroll events that its own toggle caused, or it
			// oscillates. Collapsing the bar grows the guest viewport by the bar's
			// height; at the bottom of a page that shrinks the maximum scroll offset,
			// so Chromium clamps scrollY downward and fires a scroll event that looks
			// exactly like the user scrolling up. Revealing the bar shrinks the
			// viewport again and scroll anchoring pushes the offset back down, which
			// looks like scrolling down. The bar then flickers open/closed for as long
			// as the page sits at the bottom. Guard by re-baselining (and starting a
			// cooldown) whenever the viewport height changes, so only post-resize,
			// same-height deltas can move the bar.
			const scrollInjection = `(function(){
			if(window.__maestroScrollListenerInstalled)return;
			window.__maestroScrollListenerInstalled=true;
			var lastY=window.scrollY,lastH=window.innerHeight,hidden=false,ticking=false,settleUntil=0;
			window.addEventListener('resize',function(){
				lastH=window.innerHeight;lastY=window.scrollY;settleUntil=Date.now()+400;
			},{passive:true});
			window.addEventListener('scroll',function(){
				if(ticking)return;
				ticking=true;
				requestAnimationFrame(function(){
					ticking=false;
					var y=window.scrollY,h=window.innerHeight;
					if(h!==lastH){lastH=h;lastY=y;settleUntil=Date.now()+400;return;}
					if(Date.now()<settleUntil){lastY=y;return;}
					if(y<=0&&hidden){hidden=false;console.log('__MAESTRO_SCROLL__0');}
					else if(y-lastY>10&&!hidden){hidden=true;console.log('__MAESTRO_SCROLL__1');}
					else if(lastY-y>10&&hidden){hidden=false;console.log('__MAESTRO_SCROLL__0');}
					lastY=y;
				});
			},{passive:true});
		})();`;
			// Capture-phase keyboard interceptor: intercepts app shortcuts
			// BEFORE the page can handle them, then forwards via console.log.
			// Uses stopImmediatePropagation to prevent any other listener
			// (including the main-process-injected bubble-phase one) from
			// double-firing.
			// `f` and `v` are intentionally NOT in the text-editing pass-through
			// list. Cmd+F must reach the app so the in-page find bar can open, and
			// Cmd/Ctrl+V is handled separately via the privileged paste path
			// (guest.paste()) so paste works inside the webview. The remaining
			// letters (a/c/x/z) keep their native text-editing behavior inside
			// page inputs.
			const keyboardInjection = `(function(){
			if(window.__maestroShortcutCaptureInstalled)return;
			window.__maestroShortcutCaptureInstalled=true;
			document.addEventListener('keydown',function(e){
				var hasMod=e.metaKey||e.ctrlKey;
				var hasAlt=e.altKey;
				if((!hasMod&&!hasAlt)||/^(Meta|Control|Alt|Shift)$/.test(e.key))return;
				var k=e.key.toLowerCase();
				var te=hasMod&&!hasAlt&&!e.shiftKey&&'acxz'.indexOf(k)!==-1;
				var re=hasMod&&!hasAlt&&e.shiftKey&&k==='z';
				if(te||re)return;
				e.preventDefault();
				e.stopImmediatePropagation();
				console.log('__MAESTRO_KEY__'+JSON.stringify({
					key:e.key,code:e.code,
					meta:e.metaKey,control:e.ctrlKey,
					alt:e.altKey,shift:e.shiftKey
				}));
			},true);
		})();`;
			const injectGuestListeners = () => {
				webview.executeJavaScript(scrollInjection).catch(() => {});
				webview.executeJavaScript(keyboardInjection).catch(() => {});
			};
			const handleConsoleMessage = (event: Event) => {
				const msg = (event as Event & { message?: string }).message;
				if (msg === '__MAESTRO_SCROLL__1') setAddressBarHidden(true);
				else if (msg === '__MAESTRO_SCROLL__0') setAddressBarHidden(false);
				// __MAESTRO_KEY__ shortcuts are forwarded by the main process
				// (via before-input-event and console-message → IPC) and handled
				// by the onBrowserTabShortcutKey listener in useMainKeyboardHandler.
			};

			const handleDomReady = () => {
				isDomReadyRef.current = true;
				syncWebviewLayout(webview, viewportBoxRef.current);
				updateNavigationState();
				setAddressBarHidden(false);
				injectGuestListeners();
				applyBlankGuestBackground(webview, blankBackgroundRef.current);
			};
			// Re-inject guest listeners on navigation (page JS state resets)
			const handleDidNavigateForInjection = () => injectGuestListeners();
			// A new document is loaded: Design Mode stays on and re-probes it.
			const handleFinishLoadForDesignMode = () => setPageLoadCount((count) => count + 1);
			// Find-in-page result reporting. Chromium fires `found-in-page` with
			// `requestId`, `activeMatchOrdinal`, and `matches`. Stale results from a
			// prior query can arrive after a newer findInPage() call; we ignore them
			// by comparing against the latest requestId we issued.
			const handleFoundInPage = (event: Event) => {
				const result = (
					event as Event & {
						result?: { requestId?: number; activeMatchOrdinal?: number; matches?: number };
					}
				).result;
				if (!result) return;
				if (typeof result.requestId === 'number' && result.requestId < findRequestIdRef.current)
					return;
				setFindMatches({
					active: result.activeMatchOrdinal ?? 0,
					total: result.matches ?? 0,
				});
			};
			webview.addEventListener('console-message', handleConsoleMessage);
			webview.addEventListener('did-start-loading', handleStartLoading);
			webview.addEventListener('did-stop-loading', handleStopLoading);
			webview.addEventListener('did-start-navigation', handleNavigationStart);
			webview.addEventListener('did-redirect-navigation', handleNavigationStart);
			webview.addEventListener('did-navigate', handleNavigate);
			webview.addEventListener('did-navigate', handleDidNavigateForInjection);
			webview.addEventListener('did-navigate-in-page', handleNavigate);
			webview.addEventListener('did-fail-load', handleDidFailLoad);
			webview.addEventListener('did-finish-load', updateNavigationState);
			webview.addEventListener('did-finish-load', handleFinishLoadForDesignMode);
			webview.addEventListener('page-title-updated', handleTitleUpdated);
			webview.addEventListener('page-favicon-updated', handleFaviconUpdated);
			webview.addEventListener('dom-ready', handleDomReady);
			webview.addEventListener('found-in-page', handleFoundInPage);

			const resizeObserver =
				typeof ResizeObserver === 'undefined'
					? null
					: new ResizeObserver(() => syncWebviewLayout(webview, viewportBoxRef.current));
			if (resizeObserver && hostRef.current) {
				resizeObserver.observe(hostRef.current);
			}

			syncWebviewLayout(webview, viewportBoxRef.current);

			return () => {
				isDomReadyRef.current = false;
				resizeObserver?.disconnect();
				webview.removeEventListener('console-message', handleConsoleMessage);
				webview.removeEventListener('did-start-loading', handleStartLoading);
				webview.removeEventListener('did-stop-loading', handleStopLoading);
				webview.removeEventListener('did-start-navigation', handleNavigationStart);
				webview.removeEventListener('did-redirect-navigation', handleNavigationStart);
				webview.removeEventListener('did-navigate', handleNavigate);
				webview.removeEventListener('did-navigate', handleDidNavigateForInjection);
				webview.removeEventListener('did-navigate-in-page', handleNavigate);
				webview.removeEventListener('did-fail-load', handleDidFailLoad);
				webview.removeEventListener('did-finish-load', updateNavigationState);
				webview.removeEventListener('did-finish-load', handleFinishLoadForDesignMode);
				webview.removeEventListener('page-title-updated', handleTitleUpdated);
				webview.removeEventListener('page-favicon-updated', handleFaviconUpdated);
				webview.removeEventListener('dom-ready', handleDomReady);
				webview.removeEventListener('found-in-page', handleFoundInPage);
			};
		}, [tab.id]);

		// Focus the find-bar input whenever it opens. Runs after React commits
		// the input to the DOM. We focus three times across two animation
		// frames: once synchronously, and once per frame after, to outlast any
		// stray focus-stealing on the same tick (host-level guards, page
		// autofocus that bounces off the recently-blurred webview, etc.).
		useEffect(() => {
			if (!findOpen) return;
			const focusInput = () => {
				const el = findInputRef.current;
				if (!el) return;
				el.focus();
				el.select();
			};
			focusInput();
			let frame2 = 0;
			const frame1 = requestAnimationFrame(() => {
				focusInput();
				frame2 = requestAnimationFrame(focusInput);
			});
			return () => {
				cancelAnimationFrame(frame1);
				if (frame2) cancelAnimationFrame(frame2);
			};
		}, [findOpen]);

		// Drive findInPage / stopFindInPage off the find-bar state.
		// Each query change starts a fresh search; an empty query clears highlights.
		useEffect(() => {
			const webview = webviewRef.current;
			if (!webview) return;
			if (!findOpen || findQuery.length === 0) {
				try {
					webview.stopFindInPage('clearSelection');
				} catch {
					// webview not ready or already stopped
				}
				if (!findOpen) setFindMatches({ active: 0, total: 0 });
				return;
			}
			try {
				findRequestIdRef.current = webview.findInPage(findQuery);
			} catch {
				// webview not ready
			}
		}, [findOpen, findQuery]);

		// Stop find when navigating away (page-level state is gone anyway, but this
		// also prevents leftover match counts from a previous page from being shown).
		useEffect(() => {
			if (!findOpen) return;
			setFindMatches({ active: 0, total: 0 });
		}, [tab.url, findOpen]);

		const handleFindNext = useCallback(
			(forward: boolean) => {
				const webview = webviewRef.current;
				if (!webview || findQuery.length === 0) return;
				try {
					findRequestIdRef.current = webview.findInPage(findQuery, { forward, findNext: true });
				} catch {
					// webview not ready
				}
			},
			[findQuery]
		);

		const closeFind = useCallback(() => {
			setFindOpen(false);
			setFindQuery('');
		}, []);

		const navigateToAddress = useCallback(
			(rawValue: string) => {
				const result = resolveBrowserTabNavigationTarget(rawValue);
				if (result.kind === 'error') {
					setAddressError(result.message);
					return;
				}

				const nextUrl = result.url;
				setAddressValue(nextUrl);
				setAddressError(null);
				onUpdateTab(tab.id, {
					url: nextUrl,
					title:
						nextUrl === DEFAULT_BROWSER_TAB_URL
							? DEFAULT_BROWSER_TAB_TITLE
							: getBrowserTabTitle(nextUrl),
					isLoading: nextUrl !== DEFAULT_BROWSER_TAB_URL,
				});

				const webview = webviewRef.current;
				if (webview && webview.src !== nextUrl) {
					webview.src = nextUrl;
				}
			},
			[onUpdateTab, tab.id, tab.title]
		);

		const handleSubmit = useCallback(
			(event: React.FormEvent<HTMLFormElement>) => {
				event.preventDefault();
				navigateToAddress(addressValue);
			},
			[addressValue, navigateToAddress]
		);

		const handleAddressFocus = useCallback((event: React.FocusEvent<HTMLInputElement>) => {
			isAddressFocusedRef.current = true;
			setAddressBarHidden(false);
			event.currentTarget.select();
		}, []);

		const handleAddressBlur = useCallback(() => {
			isAddressFocusedRef.current = false;
		}, []);

		const handleBack = useCallback(() => {
			const webview = webviewRef.current;
			if (webview?.canGoBack()) {
				webview.goBack();
			}
		}, []);

		const handleForward = useCallback(() => {
			const webview = webviewRef.current;
			if (webview?.canGoForward()) {
				webview.goForward();
			}
		}, []);

		const handleReload = useCallback(() => {
			const webview = webviewRef.current;
			if (!webview) return;
			if (tab.isLoading) {
				webview.stop();
				onUpdateTab(tab.id, { isLoading: false });
				return;
			}
			webview.reload();
		}, [onUpdateTab, tab.id, tab.isLoading]);

		const handleOpenExternal = useCallback(() => {
			if (tab.url === DEFAULT_BROWSER_TAB_URL) return;
			void window.maestro.shell.openExternal(tab.url);
		}, [tab.url]);

		// Only coworking agents read browser tabs, so the visibility toggle
		// exists only while the Coworking Encore Feature is on.
		const coworkingEnabled = useSettingsStore((s) => s.encoreFeatures.coworking === true);

		const handleToggleHiddenFromAgent = useCallback(() => {
			onUpdateTab(tab.id, { hiddenFromAgent: !tab.hiddenFromAgent });
		}, [onUpdateTab, tab.id, tab.hiddenFromAgent]);

		const handleClearSessionData = useCallback(() => {
			const partition = tab.partition;
			if (!partition) return;
			if (!clearArmed) {
				setClearArmed(true);
				if (clearDisarmTimerRef.current !== null) {
					window.clearTimeout(clearDisarmTimerRef.current);
				}
				clearDisarmTimerRef.current = window.setTimeout(() => setClearArmed(false), 4000);
				return;
			}
			if (clearDisarmTimerRef.current !== null) {
				window.clearTimeout(clearDisarmTimerRef.current);
				clearDisarmTimerRef.current = null;
			}
			setClearArmed(false);
			void (async () => {
				try {
					// Optional-chain the namespace: older preload bundles / test mocks may
					// not expose browserSession, and that must degrade to a visible error
					// instead of an unhandled rejection.
					const res = await window.maestro.browserSession?.clearSessionData(partition);
					if (res?.ok) {
						webviewRef.current?.reload();
					} else {
						setAddressError(
							`Could not clear browsing data: ${res?.error ?? 'not supported by this build'}`
						);
					}
				} catch (err) {
					setAddressError(
						`Could not clear browsing data: ${err instanceof Error ? err.message : String(err)}`
					);
				}
			})();
		}, [clearArmed, tab.partition]);

		return (
			<div className="flex-1 min-h-0 flex flex-col" data-testid="browser-tab-view">
				<div
					className="shrink-0 overflow-hidden"
					style={{
						maxHeight: addressBarHidden ? 0 : 200,
						opacity: addressBarHidden ? 0 : 1,
						transition: 'max-height 0.2s ease-out, opacity 0.15s ease-out',
					}}
				>
					<div
						className="flex items-center gap-2 px-3 py-2 border-b"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							borderColor: theme.colors.border,
						}}
					>
						<button
							type="button"
							onClick={handleBack}
							disabled={!tab.canGoBack}
							className="flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-40"
							style={{ color: theme.colors.textMain }}
							title="Back"
						>
							<ArrowLeft className="w-4 h-4" />
						</button>
						<button
							type="button"
							onClick={handleForward}
							disabled={!tab.canGoForward}
							className="flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-40"
							style={{ color: theme.colors.textMain }}
							title="Forward"
						>
							<ArrowRight className="w-4 h-4" />
						</button>
						<button
							type="button"
							onClick={handleReload}
							className="flex items-center justify-center w-8 h-8 rounded transition-colors"
							style={{ color: theme.colors.textMain }}
							title={tab.isLoading ? 'Stop' : 'Reload'}
						>
							{tab.isLoading ? <Spinner size={16} /> : <RotateCw className="w-4 h-4" />}
						</button>
						<form className="flex-1 min-w-0" onSubmit={handleSubmit}>
							<label className="sr-only" htmlFor={`browser-tab-address-${tab.id}`}>
								Browser URL
							</label>
							<div className="flex flex-col gap-1">
								<div
									className="flex items-center gap-2 rounded-md border px-3 py-1.5"
									style={{
										backgroundColor: theme.colors.bgMain,
										borderColor: theme.colors.border,
									}}
								>
									{tab.ephemeral ? (
										<VenetianMask
											aria-label="Incognito tab"
											className="w-4 h-4 shrink-0"
											style={{ color: theme.colors.textDim }}
											data-testid="browser-tab-incognito-badge"
										>
											<title>Incognito tab - browsing data is kept in memory only</title>
										</VenetianMask>
									) : null}
									{tab.favicon ? (
										<img alt="" className="w-4 h-4 shrink-0" src={tab.favicon} />
									) : (
										<Globe className="w-4 h-4 shrink-0" style={{ color: theme.colors.textDim }} />
									)}
									<input
										id={`browser-tab-address-${tab.id}`}
										aria-label="Browser URL"
										aria-invalid={addressError ? 'true' : 'false'}
										value={addressValue}
										onChange={(event) => {
											setAddressValue(event.target.value);
											if (addressError) setAddressError(null);
										}}
										onFocus={handleAddressFocus}
										onBlur={handleAddressBlur}
										onKeyDown={(event) => {
											if (event.key === 'Escape' && !isImeComposing(event)) {
												// Revert any edits, then hand focus to the webview so
												// the user can immediately use arrow keys to scroll.
												event.preventDefault();
												event.stopPropagation();
												setAddressValue(latestTabRef.current.url);
												setAddressError(null);
												event.currentTarget.blur();
												userClickedRef.current = true;
												webviewRef.current?.focus();
											}
										}}
										className="w-full bg-transparent outline-none text-sm"
										style={{ color: theme.colors.textMain }}
										placeholder="Enter a URL or search term"
									/>
								</div>
								{addressError ? (
									<p role="alert" className="px-1 text-xs" style={{ color: '#f87171' }}>
										{addressError}
									</p>
								) : null}
							</div>
						</form>
						{!tab.remotePage ? (
							<BrowserViewportControl
								theme={theme}
								value={viewportPreset}
								onChange={setViewportPreset}
							/>
						) : null}
						{onDesignPick && !tab.remotePage ? (
							<button
								type="button"
								onClick={() => setDesignMode(!designMode)}
								// Off is always allowed: a sticky flag must never be stuck on a
								// tab that cannot show the picker (the blank page).
								disabled={!designModeAvailable && !designMode}
								aria-pressed={designMode}
								aria-label="Design Mode"
								className="flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-40"
								style={{
									color: designMode ? theme.colors.accent : theme.colors.textDim,
									backgroundColor: designMode
										? `color-mix(in srgb, ${theme.colors.accent} 16%, transparent)`
										: undefined,
								}}
								title={
									designMode
										? 'Exit Design Mode (Esc)'
										: `Design Mode: pick an element and send it to the agent${shortcutSuffix(designModeShortcut)}`
								}
								data-testid="browser-tab-design-mode-toggle"
							>
								<MousePointerClick className="w-4 h-4" />
							</button>
						) : null}
						<button
							type="button"
							onClick={handleOpenExternal}
							disabled={tab.url === DEFAULT_BROWSER_TAB_URL}
							className="flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-40"
							style={{ color: theme.colors.textMain }}
							title="Open in External Browser"
						>
							<ExternalLink className="w-4 h-4" />
						</button>
						{coworkingEnabled && (
							<button
								type="button"
								onClick={handleToggleHiddenFromAgent}
								className="flex items-center justify-center w-8 h-8 rounded transition-colors"
								style={{
									color: tab.hiddenFromAgent ? theme.colors.warning : theme.colors.textDim,
								}}
								title={
									tab.hiddenFromAgent
										? 'Hidden from agents - click to expose this tab to coworking agents'
										: 'Visible to agents - click to hide this tab from coworking agents'
								}
								aria-pressed={tab.hiddenFromAgent === true}
							>
								{tab.hiddenFromAgent ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
							</button>
						)}
						<button
							type="button"
							onClick={handleClearSessionData}
							disabled={!tab.partition}
							className="flex items-center justify-center w-8 h-8 rounded transition-colors disabled:opacity-40"
							style={{
								color: clearArmed ? theme.colors.error : theme.colors.textDim,
							}}
							title={
								clearArmed
									? 'Click again to clear ALL browsing data (cookies, storage, logins) for this agent\u2019s browser session'
									: 'Clear browsing data for this agent\u2019s browser session (cookies, storage, logins - shared by all its tabs)'
							}
							aria-pressed={clearArmed}
							data-testid="browser-tab-clear-session-data"
						>
							<Trash2 className="w-4 h-4" />
						</button>
					</div>
				</div>

				<div
					ref={hostRef}
					className="relative flex-1 min-h-0 overflow-hidden"
					style={{ backgroundColor: theme.colors.bgMain }}
					data-testid="browser-tab-host"
				>
					{!tab.remotePage && (
						// The stage is the box the page is shown in. At Fit it is the whole
						// tab; at a preset it is the scaled page, centered, with the tab's
						// own background on both sides. The Design Mode layer lives in it,
						// beside the scaled webview rather than inside any transform, so the
						// layer is exactly as big as the page looks and its pointer math
						// (overlay px over viewport px) comes out as the page's scale.
						<div
							className="absolute top-0 bottom-0 overflow-hidden"
							style={
								viewportBox
									? {
											left: viewportBox.frame.left,
											width: viewportBox.frame.width,
											boxShadow: `0 0 0 1px ${theme.colors.border}`,
										}
									: { left: 0, right: 0 }
							}
							data-testid="browser-tab-stage"
							data-viewport-preset={viewportPreset}
						>
							<webview
								ref={(element) => {
									webviewRef.current = element as unknown as ElectronWebviewElement | null;
								}}
								// The element paints this until the guest produces its first frame,
								// so a loading or empty tab matches the theme instead of flashing
								// Chromium's white.
								style={{ backgroundColor: theme.colors.bgMain }}
								className="w-full h-full border-0"
								data-maestro-browser-tab={tab.id}
								partition={tab.partition}
								src={initialSrcRef.current}
							/>
							{designModeArmed ? (
								<BrowserDesignModeLayer
									theme={theme}
									access={designAccessRef.current}
									pageLoadCount={pageLoadCount}
									layoutKey={viewportPreset}
									onExit={exitDesignMode}
									onDeliver={handleDesignDeliver}
									onQueue={onDesignQueue ? handleDesignQueue : undefined}
								/>
							) : null}
						</div>
					)}
					{findOpen ? (
						<div
							className="absolute top-2 right-3 z-10 flex items-center gap-1 rounded-md border px-2 py-1 shadow-md"
							style={{
								backgroundColor: theme.colors.bgMain,
								borderColor: theme.colors.border,
							}}
							data-testid="browser-tab-find-bar"
							role="search"
						>
							<input
								ref={findInputRef}
								type="text"
								aria-label="Find in page"
								value={findQuery}
								onChange={(event) => setFindQuery(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Escape' && !isImeComposing(event)) {
										event.preventDefault();
										event.stopPropagation();
										closeFind();
									} else if (event.key === 'Enter') {
										event.stopPropagation();
										if (!isImeComposing(event)) {
											event.preventDefault();
											handleFindNext(!event.shiftKey);
										}
									} else if (
										event.key === 'g' &&
										(event.metaKey || event.ctrlKey) &&
										!event.altKey
									) {
										// Cmd+G / Cmd+Shift+G - next/prev match (standard browser shortcut)
										event.preventDefault();
										event.stopPropagation();
										handleFindNext(!event.shiftKey);
									} else if (
										event.key === 'f' &&
										(event.metaKey || event.ctrlKey) &&
										!event.altKey &&
										!event.shiftKey
									) {
										// Cmd+F while find bar is open - re-focus and select the query
										event.preventDefault();
										event.stopPropagation();
										event.currentTarget.select();
									}
								}}
								className="bg-transparent outline-none text-sm min-w-[180px]"
								style={{ color: theme.colors.textMain }}
								placeholder="Find in page"
							/>
							<span
								className="text-xs tabular-nums px-1"
								style={{ color: theme.colors.textDim }}
								aria-live="polite"
							>
								{findQuery.length === 0
									? ''
									: findMatches.total === 0
										? '0/0'
										: `${findMatches.active}/${findMatches.total}`}
							</span>
							<button
								type="button"
								onClick={() => handleFindNext(false)}
								disabled={findMatches.total === 0}
								className="flex items-center justify-center w-6 h-6 rounded transition-colors disabled:opacity-40"
								style={{ color: theme.colors.textMain }}
								title="Previous match (Shift+Enter)"
								aria-label="Previous match"
							>
								<ChevronUp className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={() => handleFindNext(true)}
								disabled={findMatches.total === 0}
								className="flex items-center justify-center w-6 h-6 rounded transition-colors disabled:opacity-40"
								style={{ color: theme.colors.textMain }}
								title="Next match (Enter)"
								aria-label="Next match"
							>
								<ChevronDown className="w-4 h-4" />
							</button>
							<button
								type="button"
								onClick={closeFind}
								className="flex items-center justify-center w-6 h-6 rounded transition-colors"
								style={{ color: theme.colors.textMain }}
								title="Close (Esc)"
								aria-label="Close find bar"
							>
								<X className="w-4 h-4" />
							</button>
						</div>
					) : null}
				</div>
			</div>
		);
	})
);

export const BrowserTabView = React.memo(
	forwardRef<BrowserTabViewHandle, BrowserTabViewProps>(function BrowserTabView(props, ref) {
		return isWebDesktop() ? (
			<RemoteBrowserTabView {...props} ref={ref} />
		) : (
			<NativeBrowserTabView
				key={`${props.tab.id}:${!!props.tab.remotePage}`}
				{...props}
				ref={ref}
			/>
		);
	})
);
