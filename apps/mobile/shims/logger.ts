/**
 * Platform substitute for src/web/utils/logger.ts
 *
 * Uses console for native. Provides the same method signatures as webLogger
 * so cross-tree imports (e.g., useWebSocket) work unchanged on mobile.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const PREFIX = '[Mobile]';

function formatMessage(message: string, context?: string): string {
	const contextStr = context ? ` [${context}]` : '';
	return `${PREFIX}${contextStr} ${message}`;
}

export const webLogger = {
	debug(message: string, context?: string, data?: unknown): void {
		const formatted = formatMessage(message, context);
		if (data !== undefined) {
			console.debug(formatted, data);
		} else {
			console.debug(formatted);
		}
	},

	info(message: string, context?: string, data?: unknown): void {
		const formatted = formatMessage(message, context);
		if (data !== undefined) {
			console.info(formatted, data);
		} else {
			console.info(formatted);
		}
	},

	warn(message: string, context?: string, data?: unknown): void {
		const formatted = formatMessage(message, context);
		if (data !== undefined) {
			console.warn(formatted, data);
		} else {
			console.warn(formatted);
		}
	},

	error(message: string, context?: string, data?: unknown): void {
		const formatted = formatMessage(message, context);
		if (data !== undefined) {
			console.error(formatted, data);
		} else {
			console.error(formatted);
		}
	},

	setLevel(_level: LogLevel): void {
		// No-op on native - always log everything
	},

	getLevel(): LogLevel {
		return 'debug';
	},

	setEnabled(_enabled: boolean): void {
		// No-op on native
	},

	isEnabled(): boolean {
		return true;
	},

	enableDebug(): void {
		// No-op on native
	},

	reset(): void {
		// No-op on native
	},
};

export default webLogger;
