/**
 * Preload API for the coworking subsystem.
 *
 * Exposes:
 *  - install / uninstall / install-status (Settings UI)
 *  - registry sync (renderer pushes terminal state to main)
 *  - buffer-request listener (main asks renderer for a tab's scrollback)
 */

import { ipcRenderer } from 'electron';
import type {
	BrowserConfirmPolicy,
	BrowserOp,
	BrowserOpResult,
	CoworkingBrowserInput,
} from '../../shared/coworkingBrowser';
import {
	isCoworkingResponseChannel,
	type CoworkingResponseChannel,
} from '../../shared/coworkingResponseChannel';
import { subscribeIpc } from './ipcSubscription';

export interface CoworkingTerminalEntry {
	id: string;
	cwd: string;
	title: string;
}

export interface CoworkingTerminalRecord extends CoworkingTerminalEntry {
	tabUuid: string;
	sessionId: string;
}

export interface CoworkingInstallStatus {
	agentId: string;
	configPath: string;
	installed: boolean;
}

export interface CoworkingApi {
	// ---- Settings panel ----
	getInstallStatus(): Promise<CoworkingInstallStatus[]>;
	install(agentId: string): Promise<void>;
	uninstall(agentId: string): Promise<void>;
	installAll(): Promise<Array<{ agentId: string; ok: boolean; error?: string }>>;

	// ---- Registry sync (renderer → main) ----
	//
	// The renderer pushes terminal state for *every* Maestro session, not just the
	// focused one. There is no setActiveSession - scoping happens via the MCP
	// subprocess's bridge handshake (see coworking-bridge.ts) so an agent only
	// ever sees its own session's terminals.
	syncSessionTerminals(sessionId: string, records: CoworkingTerminalRecord[]): Promise<void>;
	removeSession(sessionId: string): Promise<void>;

	// ---- Buffer request (main → renderer) ----
	/**
	 * Subscribe to "give me the scrollback of <tabUuid> in <sessionId>" requests from main.
	 * The renderer must send the buffer back via the supplied responseChannel. `sessionId`
	 * is the owning session id (used to pick the correct TerminalView ref) - always set,
	 * because the bridge enforces per-connection session binding at handshake.
	 */
	onRequestBuffer(
		callback: (
			tabUuid: string,
			sessionId: string,
			responseChannel: CoworkingResponseChannel<'buffer'>
		) => void
	): () => void;
	sendBufferResponse(
		responseChannel: CoworkingResponseChannel<'buffer'>,
		content: string,
		ok?: boolean
	): void;

	// ---- Browser registry sync (renderer → main) ----
	syncSessionBrowsers(
		sessionId: string,
		inputs: CoworkingBrowserInput[],
		interactionEnabled: boolean,
		agentType?: string,
		confirmPolicy?: BrowserConfirmPolicy
	): Promise<void>;

	// ---- Browser op (main → renderer) ----
	/**
	 * Subscribe to browser-op requests from main (read / navigate / click / ... /
	 * screenshot) for <tabUuid> in <sessionId>. The renderer resolves the live
	 * webview and sends the BrowserOpResult back via the supplied responseChannel.
	 * `needsConfirm` is main's own approval-requirement computation (from the
	 * mirrored per-agent policy); the renderer ORs it with its local policy.
	 */
	onRequestBrowserOp(
		callback: (
			tabUuid: string,
			sessionId: string,
			op: BrowserOp,
			responseChannel: CoworkingResponseChannel<'browser-op'>,
			needsConfirm?: boolean
		) => void
	): () => void;
	sendBrowserOpResponse(
		responseChannel: CoworkingResponseChannel<'browser-op'>,
		result: BrowserOpResult
	): void;
}

export function createCoworkingApi(): CoworkingApi {
	const pendingBufferResponses = new Set<CoworkingResponseChannel<'buffer'>>();
	const pendingBrowserOpResponses = new Set<CoworkingResponseChannel<'browser-op'>>();

	return {
		getInstallStatus: () => ipcRenderer.invoke('coworking:getInstallStatus'),
		install: (agentId) => ipcRenderer.invoke('coworking:install', agentId),
		uninstall: (agentId) => ipcRenderer.invoke('coworking:uninstall', agentId),
		installAll: () => ipcRenderer.invoke('coworking:installAll'),

		syncSessionTerminals: (sessionId, records) =>
			ipcRenderer.invoke('coworking:syncSessionTerminals', sessionId, records),
		removeSession: (sessionId) => ipcRenderer.invoke('coworking:removeSession', sessionId),

		onRequestBuffer: (callback) => {
			const unsubscribe = subscribeIpc<[string, string, unknown]>(
				'coworking:requestBuffer',
				(tabUuid, sessionId, responseChannel) => {
					if (!isCoworkingResponseChannel(responseChannel, 'buffer')) return;
					pendingBufferResponses.add(responseChannel);
					callback(tabUuid, sessionId, responseChannel);
				}
			);
			return () => {
				pendingBufferResponses.clear();
				unsubscribe();
			};
		},
		sendBufferResponse: (responseChannel, content, ok) => {
			if (!pendingBufferResponses.delete(responseChannel)) return;
			ipcRenderer.send(responseChannel, content, ok);
		},

		syncSessionBrowsers: (sessionId, inputs, interactionEnabled, agentType, confirmPolicy) =>
			ipcRenderer.invoke(
				'coworking:syncSessionBrowsers',
				sessionId,
				inputs,
				interactionEnabled,
				agentType,
				confirmPolicy
			),

		onRequestBrowserOp: (callback) => {
			const unsubscribe = subscribeIpc<[string, string, BrowserOp, unknown, boolean | undefined]>(
				'coworking:requestBrowserOp',
				(tabUuid, sessionId, op, responseChannel, needsConfirm) => {
					if (!isCoworkingResponseChannel(responseChannel, 'browser-op')) return;
					pendingBrowserOpResponses.add(responseChannel);
					callback(tabUuid, sessionId, op, responseChannel, needsConfirm);
				}
			);
			return () => {
				pendingBrowserOpResponses.clear();
				unsubscribe();
			};
		},
		sendBrowserOpResponse: (responseChannel, result) => {
			if (!pendingBrowserOpResponses.delete(responseChannel)) return;
			ipcRenderer.send(responseChannel, result);
		},
	};
}
