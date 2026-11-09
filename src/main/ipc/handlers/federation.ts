/**
 * Federation peer mirror IPC (`federation:*`): the desktop's mirror of its Federation peers
 * (FED-SSH-05), `federation:act`, the input that drives a mirrored agent, and `federation:lift`,
 * the desktop's "Move to Host" (FED-SSH-06).
 *
 * Thin pass-throughs to the one `PeerMirrorService` (`src/main/federation/`); the CLI bridge
 * reaches the same instance. While the Federation Encore Feature is off there is no service:
 * `status` answers `{ enabled: false }`, the reads answer empty, and the calls that need a peer
 * refuse with the feature's own "turned off" message. Pushes go out on `federation:event` and
 * `federation:reset` (see `src/main/federation/index.ts`).
 *
 * DESKTOP-ONLY: no `federation:` channel is on the web-desktop allowlist (`bridgeDenyList.ts`).
 */

import { ipcMain } from 'electron';
import { encoreDisabledMessage } from '../../../shared/encoreFeatureDefaults';
import type { MirrorPeerSummary } from '../../../shared/maestro-lib/client/peer-mirror';
import type { LogEntryRecord } from '../../../shared/maestro-lib/store/transcript';
import { getPeerMirrorService, type PeerMirrorService } from '../../federation';
import { parsePeerAgentAction } from '../../../shared/maestro-lib/client/peer-actions';
import type {
	PeerActionAnswer,
	PeerMirrorSnapshot,
	PeerReconnectResult,
	TranscriptReadOptions,
} from '../../federation/peer-mirror-service';
import {
	buildDesktopLiftDeps,
	liftAgentFromDesktop,
	type DesktopLiftAnswer,
	type DesktopLiftOptions,
	type DesktopLiftRuntime,
} from '../../federation/lift';
import { withIpcErrorLogging } from '../../utils/ipcHandler';

/** What `federation:lift` reads: the stores, the live processes, and the window. */
export type FederationHandlerDeps = Omit<DesktopLiftRuntime, 'service'>;

const LOG_CONTEXT = '[Federation]';

function opts(operation: string) {
	return { context: LOG_CONTEXT, operation };
}

function requireService(): PeerMirrorService {
	const service = getPeerMirrorService();
	if (!service) throw new Error(encoreDisabledMessage('federation'));
	return service;
}

function requireId(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${label}`);
	return value;
}

function readTail(options: unknown): TranscriptReadOptions {
	if (!options || typeof options !== 'object') return {};
	const { tail } = options as { tail?: unknown };
	if (tail === undefined) return {};
	if (typeof tail !== 'number' || !Number.isInteger(tail) || tail < 0) {
		throw new Error('tail must be a whole number of entries');
	}
	return { tail };
}

function readLiftOptions(options: unknown): DesktopLiftOptions {
	if (!options || typeof options !== 'object') return {};
	const { dryRun, withEnv } = options as { dryRun?: unknown; withEnv?: unknown };
	return { dryRun: dryRun === true, withEnv: withEnv === true };
}

export function registerFederationHandlers(deps: FederationHandlerDeps): void {
	const liftDeps = buildDesktopLiftDeps({ ...deps, service: getPeerMirrorService });
	ipcMain.handle(
		'federation:status',
		withIpcErrorLogging(
			opts('status'),
			async (): Promise<{ enabled: boolean }> => ({
				enabled: getPeerMirrorService() !== null,
			})
		)
	);
	ipcMain.handle(
		'federation:peers',
		withIpcErrorLogging(
			opts('peers'),
			async (): Promise<MirrorPeerSummary[]> => getPeerMirrorService()?.peers() ?? []
		)
	);
	ipcMain.handle(
		'federation:snapshot',
		withIpcErrorLogging(
			opts('snapshot'),
			async (): Promise<PeerMirrorSnapshot> => getPeerMirrorService()?.snapshot() ?? { peers: [] }
		)
	);
	ipcMain.handle(
		'federation:transcript',
		withIpcErrorLogging(
			opts('transcript'),
			async (
				peerId: unknown,
				agentId: unknown,
				tabId: unknown,
				options?: unknown
			): Promise<LogEntryRecord[]> =>
				requireService().transcript(
					requireId(peerId, 'peer id'),
					requireId(agentId, 'agent id'),
					requireId(tabId, 'tab id'),
					readTail(options)
				)
		)
	);
	ipcMain.handle(
		'federation:reconnect',
		withIpcErrorLogging(
			opts('reconnect'),
			async (peerId: unknown): Promise<PeerReconnectResult> => {
				const service = getPeerMirrorService();
				if (!service) return { ok: false, error: encoreDisabledMessage('federation') };
				return service.reconnect(requireId(peerId, 'peer id'));
			}
		)
	);
	ipcMain.handle(
		'federation:act',
		withIpcErrorLogging(
			opts('act'),
			async (peerId: unknown, agentId: unknown, action: unknown): Promise<PeerActionAnswer> => {
				const service = getPeerMirrorService();
				if (!service) return { ok: false, error: encoreDisabledMessage('federation') };
				return service.act(
					requireId(peerId, 'peer id'),
					requireId(agentId, 'agent id'),
					parsePeerAgentAction(action)
				);
			}
		)
	);
	ipcMain.handle(
		'federation:lift',
		withIpcErrorLogging(
			opts('lift'),
			async (agentId: unknown, options?: unknown): Promise<DesktopLiftAnswer> =>
				liftAgentFromDesktop(requireId(agentId, 'agent id'), readLiftOptions(options), liftDeps)
		)
	);
}
