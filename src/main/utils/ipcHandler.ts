/**
 * IPC Handler Utilities
 *
 * Provides utilities for creating consistent IPC handlers with standardized
 * error handling, logging, and response formats.
 *
 * Benefits:
 * - Reduces boilerplate try-catch blocks across 50+ handlers
 * - Standardized error handling and logging
 * - Consistent response format: { success: boolean, data?, error? }
 * - Process manager validation helper
 */

import { ProcessManager } from '../process-manager';
import { logger } from './logger';

/**
 * Standard IPC response format for operations that return data
 */
export interface IpcSuccessResponse<T = unknown> {
	success: true;
	data: T;
}

export interface IpcErrorResponse {
	success: false;
	error: string;
}

export type IpcResponse<T = unknown> = IpcSuccessResponse<T> | IpcErrorResponse;

/**
 * Standard IPC response format for operations with custom result shapes
 * (e.g., { success: true, files: [], tree: [] })
 */
export type IpcCustomResponse<T extends Record<string, unknown>> =
	| (T & { success: true })
	| { success: false; error: string };

/**
 * Options for the IPC handler wrapper
 */
export interface CreateHandlerOptions {
	/** Log context prefix (e.g., '[AutoRun]') */
	context: string;
	/** Operation name for logging (e.g., 'listDocs') */
	operation: string;
	/** Whether to log success (default: true) */
	logSuccess?: boolean;
	/** Additional data to log on success */
	successLogData?: Record<string, unknown>;
}

/**
 * Creates a wrapped IPC handler that standardizes error handling and logging.
 *
 * Usage:
 * ```typescript
 * ipcMain.handle('autorun:listDocs', createHandler(
 *   { context: '[AutoRun]', operation: 'listDocs' },
 *   async (folderPath: string) => {
 *     const files = await scanDirectory(folderPath);
 *     return { files, tree: files }; // Returned as { success: true, files, tree }
 *   }
 * ));
 * ```
 *
 * On error, returns `{ success: false, error: "Error message" }`
 *
 * @param options - Handler options including log context and operation name
 * @param handler - Async handler function that receives IPC arguments
 * @returns Wrapped handler function with error handling
 */
export function createHandler<TArgs extends unknown[], TResult extends Record<string, unknown>>(
	options: CreateHandlerOptions,
	handler: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<IpcCustomResponse<TResult>> {
	const { context, operation, logSuccess = true, successLogData } = options;

	return async (...args: TArgs): Promise<IpcCustomResponse<TResult>> => {
		try {
			const result = await handler(...args);

			if (logSuccess) {
				logger.info(`${operation} success`, context, successLogData);
			}

			return { success: true, ...result };
		} catch (error) {
			logger.error(`${operation} error`, context, error);
			return { success: false, error: String(error) };
		}
	};
}

/**
 * Creates a wrapped IPC handler that returns data in the standard format.
 *
 * Usage:
 * ```typescript
 * ipcMain.handle('myHandler', createDataHandler(
 *   { context: '[MyContext]', operation: 'doSomething' },
 *   async (arg1: string) => {
 *     const data = await processData(arg1);
 *     return data; // Returned as { success: true, data }
 *   }
 * ));
 * ```
 *
 * @param options - Handler options including log context and operation name
 * @param handler - Async handler function
 * @returns Wrapped handler function with { success, data } response
 */
export function createDataHandler<TArgs extends unknown[], TData>(
	options: CreateHandlerOptions,
	handler: (...args: TArgs) => Promise<TData>
): (...args: TArgs) => Promise<IpcResponse<TData>> {
	const { context, operation, logSuccess = true, successLogData } = options;

	return async (...args: TArgs): Promise<IpcResponse<TData>> => {
		try {
			const data = await handler(...args);

			if (logSuccess) {
				logger.info(`${operation} success`, context, successLogData);
			}

			return { success: true, data };
		} catch (error) {
			logger.error(`${operation} error`, context, error);
			return { success: false, error: String(error) };
		}
	};
}

/**
 * Creates a simple handler that just wraps the operation in try-catch
 * and logs errors. Does not transform the return value.
 *
 * Usage:
 * ```typescript
 * ipcMain.handle('process:write', withErrorLogging(
 *   { context: '[ProcessManager]', operation: 'write' },
 *   async (sessionId: string, data: string) => {
 *     return processManager.write(sessionId, data);
 *   }
 * ));
 * ```
 *
 * @param options - Handler options including log context and operation name
 * @param handler - Async handler function
 * @returns Wrapped handler function with error logging
 */
export function withErrorLogging<TArgs extends unknown[], TResult>(
	options: Pick<CreateHandlerOptions, 'context' | 'operation'>,
	handler: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
	const { context, operation } = options;

	return async (...args: TArgs): Promise<TResult> => {
		try {
			return await handler(...args);
		} catch (error) {
			logger.error(`${operation} error`, context, error);
			throw error;
		}
	};
}

/**
 * Creates a simple IPC handler for use with ipcMain.handle() that just wraps
 * the operation in try-catch and logs errors. Does not transform the return value.
 *
 * This is the ipcMain.handle() version of withErrorLogging - it strips the event
 * argument before calling the handler.
 *
 * Usage:
 * ```typescript
 * ipcMain.handle('history:getAll', withIpcErrorLogging(
 *   { context: '[History]', operation: 'getAll' },
 *   async (projectPath?: string) => {
 *     return historyManager.getAllEntries();
 *   }
 * ));
 * ```
 *
 * @param options - Handler options including log context and operation name
 * @param handler - Async handler function that receives IPC arguments (without event)
 * @returns Wrapped handler function compatible with ipcMain.handle
 */
export function withIpcErrorLogging<TArgs extends unknown[], TResult>(
	options: Pick<CreateHandlerOptions, 'context' | 'operation'>,
	handler: (...args: TArgs) => Promise<TResult>
): (_event: unknown, ...args: TArgs) => Promise<TResult> {
	const { context, operation } = options;

	return async (_event: unknown, ...args: TArgs): Promise<TResult> => {
		try {
			return await handler(...args);
		} catch (error) {
			logger.error(`${operation} error`, context, error);
			throw error;
		}
	};
}

/**
 * Creates a wrapped IPC handler for use with ipcMain.handle().
 *
 * This is the same as createHandler but returns a function compatible with
 * ipcMain.handle, which passes (event, ...args) to the callback. The event
 * argument is stripped before calling the handler.
 *
 * Usage:
 * ```typescript
 * ipcMain.handle('autorun:listDocs', createIpcHandler(
 *   { context: '[AutoRun]', operation: 'listDocs' },
 *   async (folderPath: string) => {
 *     const files = await scanDirectory(folderPath);
 *     return { files, tree: files };
 *   }
 * ));
 * ```
 *
 * @param options - Handler options including log context and operation name
 * @param handler - Async handler function that receives IPC arguments (without event)
 * @returns Wrapped handler function compatible with ipcMain.handle
 */
export function createIpcHandler<TArgs extends unknown[], TResult extends Record<string, unknown>>(
	options: CreateHandlerOptions,
	handler: (...args: TArgs) => Promise<TResult>
): (_event: unknown, ...args: TArgs) => Promise<IpcCustomResponse<TResult>> {
	const { context, operation, logSuccess = true, successLogData } = options;

	return async (_event: unknown, ...args: TArgs): Promise<IpcCustomResponse<TResult>> => {
		try {
			const result = await handler(...args);

			if (logSuccess) {
				logger.info(`${operation} success`, context, successLogData);
			}

			return { success: true, ...result };
		} catch (error) {
			logger.error(`${operation} error`, context, error);
			return { success: false, error: String(error) };
		}
	};
}

/**
 * Creates a wrapped IPC handler for use with ipcMain.handle() that returns
 * data in the standard { success, data } format.
 *
 * @param options - Handler options including log context and operation name
 * @param handler - Async handler function that receives IPC arguments (without event)
 * @returns Wrapped handler function compatible with ipcMain.handle
 */
export function createIpcDataHandler<TArgs extends unknown[], TData>(
	options: CreateHandlerOptions,
	handler: (...args: TArgs) => Promise<TData>
): (_event: unknown, ...args: TArgs) => Promise<IpcResponse<TData>> {
	const { context, operation, logSuccess = true, successLogData } = options;

	return async (_event: unknown, ...args: TArgs): Promise<IpcResponse<TData>> => {
		try {
			const data = await handler(...args);

			if (logSuccess) {
				logger.info(`${operation} success`, context, successLogData);
			}

			return { success: true, data };
		} catch (error) {
			logger.error(`${operation} error`, context, error);
			return { success: false, error: String(error) };
		}
	};
}

/**
 * Gets the ProcessManager instance and throws if not initialized.
 *
 * This replaces the repeated pattern:
 * ```typescript
 * const processManager = getProcessManager();
 * if (!processManager) throw new Error('Process manager not initialized');
 * ```
 *
 * Usage:
 * ```typescript
 * const processManager = requireProcessManager(getProcessManager);
 * return processManager.spawn(config);
 * ```
 *
 * @param getProcessManager - Function that returns ProcessManager or null
 * @returns ProcessManager instance
 * @throws Error if ProcessManager is not initialized
 */
export function requireProcessManager(
	getProcessManager: () => ProcessManager | null
): ProcessManager {
	const processManager = getProcessManager();
	if (!processManager) {
		throw new Error('Process manager not initialized');
	}
	return processManager;
}

/**
 * Generic require utility for other manager dependencies.
 *
 * Usage:
 * ```typescript
 * const agentDetector = requireDependency(getAgentDetector, 'Agent detector');
 * ```
 *
 * @param getter - Function that returns the dependency or null
 * @param name - Name of the dependency for error message
 * @returns The dependency instance
 * @throws Error if dependency is not initialized
 */
export function requireDependency<T>(getter: () => T | null, name: string): T {
	const dependency = getter();
	if (!dependency) {
		throw new Error(`${name} not initialized`);
	}
	return dependency;
}
