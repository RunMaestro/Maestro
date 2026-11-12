/**
 * Main-window subframe navigation guard (pure, shared).
 *
 * Every main-window iframe is a `srcDoc` frame (the file-preview HTML
 * renderer); none load a real-URL `src`. A meta CSP cannot stop such a frame
 * from navigating ITSELF (e.g. `window.location = remote`), which would leak
 * previewed content through the URL. Top-frame navigation is already blocked
 * (no `allow-top-navigation`, and the main window's `will-navigate` guard pins
 * the top frame to the app entry); this adds a main-process backstop for
 * subframe self-navigation via `will-frame-navigate`. NOTE: sandboxed-srcdoc
 * self-navigation does not reliably surface through `will-frame-navigate`, so
 * this is defense in depth behind the sandbox, the SPA frame CSP, and each
 * frame's own gating - not the sole barrier.
 *
 * Plugin panels no longer render as subframes: they are per-plugin-partition
 * `<webview>` guests with their own webContents (see
 * `src/main/plugins/plugin-panel-host.ts`), where navigation is denied
 * outright in `attachPluginPanelGuestSecurity` and egress is cancelled at the
 * session's webRequest layer. Browser tabs are separate guest WebContents
 * governed elsewhere. So a main-window subframe navigating ANYWHERE other
 * than its initial `about:srcdoc`/`about:blank` document is always an escape
 * and is blocked. `data:` is included: navigating `srcdoc` -> `data:` would
 * drop the injected CSP while keeping the opaque `null` origin. The guard
 * keys off the navigation TARGET, never a mutable frame identifier
 * (`window.name` can be cleared by content before navigating).
 */

/**
 * True when a frame navigation must be blocked: a subframe (never the top frame,
 * which `will-navigate` owns) is navigating away from its initial
 * `about:srcdoc`/`about:blank`/empty document to any other target.
 */
export function blocksSubframeNavigation(isMainFrame: boolean, targetUrl: string): boolean {
	if (isMainFrame) return false;
	const lower = targetUrl.trim().toLowerCase();
	if (lower === '' || lower === 'about:blank' || lower === 'about:srcdoc') return false;
	return true;
}
