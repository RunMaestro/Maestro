// Minimal `process` polyfill for the renderer.
//
// Vite's `define` inlines `process.env.NODE_ENV` at build time, but bundled
// vendor libs (e.g. Sentry, prop-types, scheduler) read other keys at runtime
// - `process.env.SENTRY_RELEASE`, `process.platform`, `typeof process`, etc.
// Without `process` defined, those throw `ReferenceError: process is not
// defined` in the renderer sandbox (MAESTRO-K8). Setting it to a benign stub
// before any module loads lets those reads return `undefined` instead.
//
// `platform: 'browser'` below is a SENTINEL, not a real platform. Never detect
// the OS from it - use `isMacOS()` / `isWindows()` / `isLinux()` from
// `src/shared/platformDetection.ts`, which read the preload bridge first and
// explicitly ignore this value.
//
// Keep this file vanilla JS (no module syntax) so it can be loaded as a
// classic <script> before the ES-module entry point.
(function () {
	if (typeof globalThis.process !== 'undefined') return;
	globalThis.process = {
		env: { NODE_ENV: 'production' },
		platform: 'browser',
		versions: {},
		nextTick: function (fn) {
			setTimeout(fn, 0);
		},
	};
})();
