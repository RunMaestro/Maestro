import { randomUUID } from 'node:crypto';
import { ipcMain } from 'electron';
import type { WebContents } from 'electron';
import {
	createCoworkingResponseChannel,
	type CoworkingResponseChannel,
	type CoworkingResponseKind,
} from '../../shared/coworkingResponseChannel';
import type { BrowserOpResult } from '../../shared/coworkingBrowser';

export type CoworkingResponseOutcome<Value> =
	| { kind: 'resolve'; value: Value }
	| { kind: 'reject'; error: Error };

export interface CoworkingRendererRoundTripOptions<Value, Kind extends CoworkingResponseKind> {
	webContents: WebContents;
	requestChannel: string;
	requestArgs: readonly unknown[];
	responseArgsAfterChannel?: readonly unknown[];
	responseKind: Kind;
	timeoutMs: number;
	timeoutError: () => Error;
	destroyedError: () => Error;
	parseResponse: (args: readonly unknown[]) => CoworkingResponseOutcome<Value> | null;
}

/**
 * Sends one coworking renderer request and owns its request-specific response listener.
 * Cleanup is centralized so timeout, renderer destruction, send failure, and a valid
 * response all remove the exact listener and timer once.
 */
export function createCoworkingRendererRoundTrip<Value, Kind extends CoworkingResponseKind>(
	options: CoworkingRendererRoundTripOptions<Value, Kind>
): Promise<Value> {
	const { webContents } = options;
	if (webContents.isDestroyed()) {
		return Promise.reject(options.destroyedError());
	}

	const responseChannel = createCoworkingResponseChannel(options.responseKind, randomUUID());
	const expectedSenderId = webContents.id;
	let settled = false;
	let timeout: NodeJS.Timeout | undefined;
	const { promise, resolve, reject } = Promise.withResolvers<Value>();

	const cleanup = (): void => {
		if (timeout !== undefined) {
			clearTimeout(timeout);
			timeout = undefined;
		}
		ipcMain.removeListener(responseChannel, onResponse);
		webContents.removeListener('destroyed', onDestroyed);
	};

	const settle = (outcome: CoworkingResponseOutcome<Value>): void => {
		if (settled) return;
		settled = true;
		cleanup();
		if (outcome.kind === 'resolve') {
			resolve(outcome.value);
		} else {
			reject(outcome.error);
		}
	};

	const onResponse = (event: Electron.IpcMainEvent, ...args: unknown[]): void => {
		if (settled || event.sender.id !== expectedSenderId) return;

		let outcome: CoworkingResponseOutcome<Value> | null;
		try {
			outcome = options.parseResponse(args);
		} catch {
			return;
		}
		if (outcome) settle(outcome);
	};

	const onDestroyed = (): void => {
		settle({ kind: 'reject', error: options.destroyedError() });
	};

	ipcMain.on(responseChannel, onResponse);
	webContents.once('destroyed', onDestroyed);
	timeout = setTimeout(() => {
		settle({ kind: 'reject', error: options.timeoutError() });
	}, options.timeoutMs);

	try {
		webContents.send(
			options.requestChannel,
			...options.requestArgs,
			responseChannel,
			...(options.responseArgsAfterChannel ?? [])
		);
	} catch (error) {
		settle({
			kind: 'reject',
			error: error instanceof Error ? error : new Error(String(error)),
		});
	}

	return promise;
}

export function parseTerminalBufferResponse(
	args: readonly unknown[]
): CoworkingResponseOutcome<string> | null {
	if (
		(args.length !== 1 && args.length !== 2) ||
		typeof args[0] !== 'string' ||
		(args.length === 2 && args[1] !== undefined && typeof args[1] !== 'boolean')
	) {
		return null;
	}
	if (args[1] === false) {
		return {
			kind: 'reject',
			error: new Error('Coworking: terminal is not live in the renderer (its view is not mounted)'),
		};
	}
	return { kind: 'resolve', value: args[0] };
}

export function parseBrowserOpResponse(
	args: readonly unknown[]
): CoworkingResponseOutcome<BrowserOpResult> | null {
	if (args.length !== 1 || !isBrowserOpResult(args[0])) return null;
	if (!args[0].ok) {
		return {
			kind: 'reject',
			error: new Error(args[0].content || 'Coworking: browser op failed'),
		};
	}
	return { kind: 'resolve', value: args[0] };
}

function isBrowserOpResult(value: unknown): value is BrowserOpResult {
	if (!value || typeof value !== 'object') return false;
	const result = value as Record<string, unknown>;
	return (
		typeof result.ok === 'boolean' &&
		(result.content === undefined || typeof result.content === 'string') &&
		(result.dataUrl === undefined || typeof result.dataUrl === 'string') &&
		(result.url === undefined || typeof result.url === 'string') &&
		(result.title === undefined || typeof result.title === 'string')
	);
}

export type { CoworkingResponseChannel };
