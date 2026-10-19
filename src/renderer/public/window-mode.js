// Tag <html> with the window mode before the body parses.
//
// The Quick Chat panel (`?quickChat`), the cadenza HUD (`?cadenzaHud`), and a
// tab window (`?tabWindow=<id>`) load the same index.html as the app window. main.tsx tags them too, but it is an
// ES module that runs only after the first frame, and these windows are shown
// on that first frame (`ready-to-show`). Without this the static loading splash
// painted inside them for as long as the bundle took to load. The inline CSS in
// index.html keys on these classes to hide the splash and keep the window
// transparent from the very first paint.
//
// Keep this file vanilla JS (no module syntax): it is a classic <script> in
// <head>, external because the CSP allows no inline scripts.
(function () {
	var params = new URLSearchParams(window.location.search);
	if (params.has('quickChat')) document.documentElement.classList.add('quick-chat-window');
	else if (params.has('cadenzaHud')) document.documentElement.classList.add('cadenza-hud');
	else if (params.get('tabWindow')) document.documentElement.classList.add('tab-window');
})();
