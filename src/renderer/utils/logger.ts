/**
 * Structured logging utility for the renderer process
 * Sends logs to the main process via IPC
 */

import { type BaseLogLevel } from '../../shared/logger-types';
import { PerformanceMetrics, type PerformanceMetric } from '../../shared/performance-metrics';

// Re-export for backwards compatibility
export type LogLevel = BaseLogLevel;

class RendererLogger {
	debug(message: string, context?: string, data?: unknown): void {
		window.maestro?.logger?.log('debug', message, context, data);
	}

	info(message: string, context?: string, data?: unknown): void {
		window.maestro?.logger?.log('info', message, context, data);
	}

	warn(message: string, context?: string, data?: unknown): void {
		window.maestro?.logger?.log('warn', message, context, data);
	}

	error(message: string, context?: string, data?: unknown): void {
		window.maestro?.logger?.log('error', message, context, data);
	}
}

// Export singleton instance
export const logger = new RendererLogger();

// ============================================================================
// Performance Metrics for Renderer Process
// ============================================================================

/**
 * Renderer process performance metrics instances.
 * Each component/module can get its own metrics instance.
 *
 * All metrics are logged at debug level and sent to the main process.
 */
const rendererPerfInstances = new Map<string, PerformanceMetrics>();

/** Global flag to enable/disable renderer performance metrics */
let rendererPerfEnabled = false;

/**
 * Get or create a performance metrics instance for a renderer component.
 *
 * @param context - Name of the component (e.g., 'DocumentGraph', 'UsageDashboard')
 * @returns PerformanceMetrics instance for the component
 */
export function getRendererPerfMetrics(context: string): PerformanceMetrics {
	let instance = rendererPerfInstances.get(context);
	if (!instance) {
		instance = new PerformanceMetrics(
			context,
			(message, ctx) => logger.debug(message, ctx),
			rendererPerfEnabled
		);
		rendererPerfInstances.set(context, instance);
	}
	return instance;
}

/**
 * Enable or disable performance metrics logging for all renderer components.
 *
 * @param enabled - Whether to enable performance metrics
 */
export function setRendererPerfEnabled(enabled: boolean): void {
	rendererPerfEnabled = enabled;
	for (const instance of rendererPerfInstances.values()) {
		instance.setEnabled(enabled);
	}
	logger.info(`Renderer performance metrics ${enabled ? 'enabled' : 'disabled'}`, '[RendererPerf]');
}

/**
 * Check if renderer performance metrics are enabled.
 */
export function isRendererPerfEnabled(): boolean {
	return rendererPerfEnabled;
}

/**
 * Get all collected performance metrics from all renderer components.
 */
export function getAllRendererPerfMetrics(): PerformanceMetric[] {
	const allMetrics: PerformanceMetric[] = [];
	for (const instance of rendererPerfInstances.values()) {
		allMetrics.push(...instance.getMetrics());
	}
	return allMetrics.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Clear all renderer performance metrics.
 */
export function clearAllRendererPerfMetrics(): void {
	for (const instance of rendererPerfInstances.values()) {
		instance.clearMetrics();
	}
}
