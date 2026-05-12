/**
 * No-op stand-in for @sentry/electron/renderer in the web build.
 * The renderer's main.tsx imports Sentry for crash reporting; in the browser
 * we don't have the Electron IPC channel Sentry uses, so we just shim it.
 */
export function init(_options: unknown): void {}
export function captureException(_err: unknown, _ctx?: unknown): void {}
export function captureMessage(_msg: unknown, _level?: unknown, _ctx?: unknown): void {}
export function setTag(_key: string, _value: string): void {}
export function setUser(_user: unknown): void {}
export const Severity = {
	Error: 'error',
	Warning: 'warning',
	Info: 'info',
	Debug: 'debug',
};
export default { init, captureException, captureMessage, setTag, setUser, Severity };
