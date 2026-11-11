/**
 * Federation peer mirror IPC (`federation:*`): the desktop's mirror of its Federation peers
 * (FED-SSH-05), `federation:act`, the input that drives a mirrored agent, and `federation:lift`,
 * the desktop's "Move to Host" (FED-SSH-06), and `federation:history*`, the History panel of a
 * mirrored agent (paged, filtered, and graphed here by `src/main/federation/peer-history.ts`).
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
import { isHistoryEntryType, type PaginatedResult } from '../../../shared/history';
import type { HistoryEntry, HistoryEntryType } from '../../../shared/types';
import {
	pagePeerHistory,
	peerHistoryGraph,
	peerHistoryOffset,
	type PeerHistoryPageQuery,
} from '../../federation/peer-history';
import type { HistoryGraphData } from '../../utils/history-bucket-builder';

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

/** A lookback in hours, or null for all time. Anything else is all time. */
function readLookback(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** The entry types a History read keeps. Absent: every type; unknown names are dropped. */
function readTypes(value: unknown): HistoryEntryType[] | undefined {
	return Array.isArray(value) ? value.filter(isHistoryEntryType) : undefined;
}

function readHistoryQuery(query: unknown): PeerHistoryPageQuery {
	if (!query || typeof query !== 'object') return {};
	const raw = query as Record<string, unknown>;
	const pagination = raw.pagination as { offset?: unknown; limit?: unknown } | undefined;
	const whole = (value: unknown) =>
		typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
	const offset = whole(pagination?.offset);
	const limit = whole(pagination?.limit);
	const types = readTypes(raw.types);
	return {
		lookbackHours: readLookback(raw.lookbackHours),
		...(types ? { types } : {}),
		hostKey: typeof raw.hostKey === 'string' && raw.hostKey ? raw.hostKey : null,
		...(offset !== undefined || limit !== undefined
			? {
					pagination: {
						...(offset !== undefined ? { offset } : {}),
						...(limit !== undefined ? { limit } : {}),
					},
				}
			: {}),
	};
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
		'federation:historyPage',
		withIpcErrorLogging(
			opts('historyPage'),
			async (
				peerId: unknown,
				agentId: unknown,
				query?: unknown
			): Promise<PaginatedResult<HistoryEntry>> => {
				const entries = await requireService().history(
					requireId(peerId, 'peer id'),
					requireId(agentId, 'agent id')
				);
				return pagePeerHistory(entries, readHistoryQuery(query));
			}
		)
	);
	ipcMain.handle(
		'federation:historyGraph',
		withIpcErrorLogging(
			opts('historyGraph'),
			async (
				peerId: unknown,
				agentId: unknown,
				bucketCount: unknown,
				lookbackHours: unknown
			): Promise<HistoryGraphData> => {
				const entries = await requireService().history(
					requireId(peerId, 'peer id'),
					requireId(agentId, 'agent id')
				);
				const buckets = typeof bucketCount === 'number' ? bucketCount : 24;
				return peerHistoryGraph(entries, buckets, readLookback(lookbackHours));
			}
		)
	);
	ipcMain.handle(
		'federation:historyOffset',
		withIpcErrorLogging(
			opts('historyOffset'),
			async (
				peerId: unknown,
				agentId: unknown,
				timestamp: unknown,
				lookbackHours: unknown,
				types: unknown
			): Promise<number> => {
				if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
					throw new Error('timestamp must be a number');
				}
				const entries = await requireService().history(
					requireId(peerId, 'peer id'),
					requireId(agentId, 'agent id')
				);
				return peerHistoryOffset(entries, timestamp, readLookback(lookbackHours), readTypes(types));
			}
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
