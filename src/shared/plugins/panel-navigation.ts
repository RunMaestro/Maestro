/**
 * Main-window subframe navigation guard (pure, shared).
 *
 * A plugin panel renders from a sandboxed `srcDoc` iframe whose only intended
 * egress is the brokered `maestro:invokeCommand` postMessage bridge. A meta CSP
 * cannot stop the frame from navigating ITSELF (e.g. `window.location = remote`),
 * which would leak data the panel obtained via its granted capabilities through
 * the URL. Top-frame navigation is already blocked (the iframe has no
 * `allow-top-navigation`, and the main window's `will-navigate` guard pins the top
 * frame to the app entry); this adds a main-process backstop for subframe
 * self-navigation via `will-frame-navigate`. NOTE: sandboxed-srcdoc self-navigation
 * does not reliably surface through `will-frame-navigate`, so this is defense in
 * depth behind the sandbox, the SPA frame CSP, and the origin-gated bridge - not
 * the sole barrier.
 *
 * Every main-window iframe is a `srcDoc` frame (plugin panels and the file-preview
 * HTML renderer); none load a real-URL `src`, and browser tabs are separate guest
 * WebContents governed elsewhere. So a subframe navigating ANYWHERE other than its
 * initial `about:srcdoc`/`about:blank` document is always an escape (a panel
 * leaking via the URL, or previewed file content trying to exfiltrate) and is
 * blocked. `data:` is included: navigating `srcdoc` -> `data:` would drop the
 * injected CSP while keeping the opaque `null` origin, re-opening img/beacon
 * egress and the bridge. The guard keys off the navigation TARGET, never a mutable
 * frame identifier (`window.name` can be cleared by plugin code before navigating).
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
