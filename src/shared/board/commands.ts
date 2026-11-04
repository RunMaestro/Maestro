/** Board commands carried by the existing authenticated desktop/runtime bridge.
 * Authority is never part of the wire contract. Domain validation stays in the host facade.
 */
import { CARD_STATUSES } from './types';
import { parseBoardWorkerOptionsCommand } from './worker-options';
import type { BoardWorkerOptionsCommand, StoredBoardWorker } from './worker-options';
import type {
	Board,
	BoardCaptureCatalog,
	BoardCaptureCommand,
	BoardCaptureResponse,
	BoardRoleRef,
	BoardWorkspaceQuery,
	BoardWorkspaceQueryResult,
	CardStatus,
} from './types';

export interface BoardCommandTarget {
	projectRoot: string;
	sourceKey: string;
	collectionKey: string;
	expectedRevision: number;
}
export interface BoardCardRevision {
	cardId: string;
	cardRevision: number;
}
/** One committed collection transaction, including tombstone revisions and the surviving board. */
export interface BoardDeleteCardsResult {
	sourceKey: string;
	collectionKey: string;
	previousRevision: number;
	revision: number;
	cards: { cardId: string; previousRevision: number; revision: number; deleted: true }[];
	board: Board;
}
export const BOARD_DELETE_CARDS_LIMIT = 500;
export interface BoardRuntimeToken {
	runId: string;
	ownerEpoch: number;
	generation: number;
}
export type BoardRuntimeCommand =
	| { action: 'tick'; target: BoardCommandTarget; operationId: string }
	| {
			action: 'control';
			target: BoardCommandTarget;
			cardId: string;
			cardRevision: number;
			operation: 'hold' | 'resume' | 'approve' | 'accept';
			runToken?: BoardRuntimeToken;
	  };
export interface BoardTickResult {
	cardId: string;
	ok: boolean;
	reason?: string;
	runToken?: BoardRuntimeToken;
}
export type BoardCommand =
	| BoardRuntimeCommand
	| BoardRoleCommand
	| { action: 'source-preview'; sourceKey: string }
	| { action: 'source-export'; sourceKey: string; backupPath: string; expectedRevision: number }
	| {
			action: 'source-suppress';
			sourceKey: string;
			backupPath: string;
			backupSha256: string;
			expectedRevision: number;
	  }
	| { action: 'source-restore'; backupPath: string; receipt: BoardSourceReceipt }
	| { action: 'query'; query: BoardWorkspaceQuery }
	| { action: 'catalog' }
	| { action: 'list-workers' }
	| {
			action: 'worker-lifecycle';
			agentId: string;
			operation: 'register' | 'unregister' | 'pause' | 'resume';
			expected: string | null;
	  }
	| { action: 'set-worker-options'; command: BoardWorkerOptionsCommand }
	| { action: 'initialize' }
	| { action: 'capture'; target: BoardCommandTarget; capture: BoardCaptureCommand }
	| {
			action: 'create';
			projectRoot: string;
			sourceKey: string;
			name: string;
			maxInProgress?: number;
			autoDecompose?: boolean;
	  }
	| { action: 'card-pr'; target: BoardCommandTarget; cardId: string }
	| { action: 'rename'; target: BoardCommandTarget; name: string }
	| { action: 'delete'; target: BoardCommandTarget; force?: boolean }
	| { action: 'delete-card'; target: BoardCommandTarget; cardId: string; cardRevision: number }
	| { action: 'delete-cards'; target: BoardCommandTarget; cards: BoardCardRevision[] }
	| {
			action: 'status';
			target: BoardCommandTarget;
			cardId: string;
			cardRevision: number;
			status: CardStatus;
	  };
export interface BoardSourceReceipt {
	sourceKey: string;
	backupSha256: string;
	archivedCollections: string[];
	revision: number;
}
/** Board-context role creation and a single additive/removal worker grant. */
export type BoardRoleCommand =
	| { action: 'create-role'; name: string }
	| {
			action: 'edit-role';
			sourceKey: string;
			role: BoardRoleRef;
			expected: string;
			profile?: import('../profiles/types').AgentProfile;
	  }
	| { action: 'set-worker-role'; agentId: string; role: BoardRoleRef; enabled: boolean };
export type BoardCommandResult =
	| {
			ok: true;
			value:
				| Record<string, unknown>
				| BoardSourceReceipt
				| BoardDeleteCardsResult
				| BoardWorkspaceQueryResult
				| BoardCaptureCatalog
				| BoardRoleRef
				| StoredBoardWorker[]
				| Board
				| Board[]
				| { success: boolean; prUrl?: string; error?: string }
				| BoardTickResult[]
				| { accepted: true; runToken?: BoardRuntimeToken }
				| null;
			readiness?: Record<string, string[]>;
	  }
	| Extract<BoardCaptureResponse, { ok: false }>;
export type BoardCommandHost = (command: BoardCommand) => Promise<BoardCommandResult>;
export type BoardCommandReply = BoardCommandResult & {
	type: 'board_command_result';
	requestId?: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
	typeof value === 'string' && !!value.trim() && !value.includes('\0');
const revision = (value: unknown): value is number =>
	Number.isSafeInteger(value) && (value as number) >= 0;
const keys = (value: Record<string, unknown>, allowed: string[]) =>
	Object.keys(value).every((key) => allowed.includes(key));

/** Bound the wire payload before deduplication; conflicting duplicate fences are invalid. */
export function parseBoardDeleteCardsSelection(value: unknown): BoardCardRevision[] | undefined {
	if (!Array.isArray(value) || !value.length || value.length > BOARD_DELETE_CARDS_LIMIT) return;
	const selected = new Map<string, BoardCardRevision>();
	for (const entry of value) {
		if (
			!record(entry) ||
			!keys(entry, ['cardId', 'cardRevision']) ||
			!text(entry.cardId) ||
			!revision(entry.cardRevision)
		)
			return;
		const previous = selected.get(entry.cardId);
		if (previous && previous.cardRevision !== entry.cardRevision) return;
		selected.set(entry.cardId, { cardId: entry.cardId, cardRevision: entry.cardRevision });
	}
	return [...selected.values()];
}

export function parseBoardCommand(message: Record<string, unknown>): BoardCommand | undefined {
	const { action, target } = message;
	const fields: Record<string, string[]> = {
		query: ['query'],
		'source-preview': ['sourceKey'],
		'source-export': ['sourceKey', 'backupPath', 'expectedRevision'],
		'source-suppress': ['sourceKey', 'backupPath', 'backupSha256', 'expectedRevision'],
		'source-restore': ['backupPath', 'receipt'],
		catalog: [],
		'list-workers': [],
		'worker-lifecycle': ['agentId', 'operation', 'expected'],
		'set-worker-options': ['command'],
		initialize: [],
		'create-role': ['name'],
		'edit-role': ['sourceKey', 'role', 'expected', 'profile'],
		'set-worker-role': ['agentId', 'role', 'enabled'],
		capture: ['target', 'capture'],
		create: ['projectRoot', 'sourceKey', 'name', 'maxInProgress', 'autoDecompose'],
		'card-pr': ['target', 'cardId'],
		rename: ['target', 'name'],
		delete: ['target', 'force'],
		'delete-card': ['target', 'cardId', 'cardRevision'],
		'delete-cards': ['target', 'cards'],
		status: ['target', 'cardId', 'cardRevision', 'status'],
		tick: ['target', 'operationId'],
		control: ['target', 'cardId', 'cardRevision', 'operation', 'runToken'],
	};
	if (
		typeof action !== 'string' ||
		!Object.prototype.hasOwnProperty.call(fields, action) ||
		!keys(message, ['type', 'requestId', 'action', ...fields[action]])
	)
		return;
	const hash = (value: unknown): value is string =>
		typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
	if (action === 'source-preview')
		return hash(message.sourceKey) ? { action, sourceKey: message.sourceKey } : undefined;
	if (action === 'source-export' || action === 'source-suppress') {
		if (
			!hash(message.sourceKey) ||
			!text(message.backupPath) ||
			!revision(message.expectedRevision)
		)
			return;
		if (action === 'source-export')
			return {
				action,
				sourceKey: message.sourceKey,
				backupPath: message.backupPath,
				expectedRevision: message.expectedRevision as number,
			};
		return hash(message.backupSha256)
			? {
					action,
					sourceKey: message.sourceKey,
					backupPath: message.backupPath,
					backupSha256: message.backupSha256,
					expectedRevision: message.expectedRevision as number,
				}
			: undefined;
	}
	if (action === 'source-restore') {
		const receipt = message.receipt;
		return text(message.backupPath) &&
			record(receipt) &&
			keys(receipt, ['sourceKey', 'backupSha256', 'archivedCollections', 'revision']) &&
			hash(receipt.sourceKey) &&
			hash(receipt.backupSha256) &&
			Array.isArray(receipt.archivedCollections) &&
			receipt.archivedCollections.every(text) &&
			revision(receipt.revision)
			? {
					action,
					backupPath: message.backupPath,
					receipt: receipt as unknown as BoardSourceReceipt,
				}
			: undefined;
	}
	if (action === 'query')
		return record(message.query)
			? { action, query: message.query as BoardWorkspaceQuery }
			: undefined;
	if (action === 'catalog' || action === 'initialize' || action === 'list-workers')
		return { action };
	if (action === 'worker-lifecycle')
		return text(message.agentId) &&
			['register', 'unregister', 'pause', 'resume'].includes(message.operation as string) &&
			(message.expected === null || typeof message.expected === 'string')
			? {
					action,
					agentId: message.agentId,
					operation: message.operation as 'register' | 'unregister' | 'pause' | 'resume',
					expected: message.expected as string | null,
				}
			: undefined;
	if (action === 'set-worker-options') {
		const command = parseBoardWorkerOptionsCommand(message.command);
		return command ? { action, command } : undefined;
	}
	if (action === 'create-role')
		return text(message.name) ? { action, name: message.name } : undefined;
	if (action === 'edit-role')
		return text(message.sourceKey) &&
			record(message.role) &&
			keys(message.role, ['namespace', 'profileId']) &&
			text(message.role.namespace) &&
			text(message.role.profileId) &&
			typeof message.expected === 'string' &&
			(message.profile === undefined || record(message.profile))
			? {
					action,
					sourceKey: message.sourceKey,
					role: { namespace: message.role.namespace, profileId: message.role.profileId },
					expected: message.expected,
					profile: message.profile as import('../profiles/types').AgentProfile | undefined,
				}
			: undefined;
	if (action === 'set-worker-role')
		return text(message.agentId) &&
			record(message.role) &&
			keys(message.role, ['namespace', 'profileId']) &&
			text(message.role.namespace) &&
			text(message.role.profileId) &&
			typeof message.enabled === 'boolean'
			? {
					action,
					agentId: message.agentId,
					role: { namespace: message.role.namespace, profileId: message.role.profileId },
					enabled: message.enabled,
				}
			: undefined;
	if (action === 'create')
		return (message.maxInProgress === undefined ||
			(Number.isSafeInteger(message.maxInProgress) && (message.maxInProgress as number) > 0)) &&
			(message.autoDecompose === undefined || typeof message.autoDecompose === 'boolean') &&
			text(message.projectRoot) &&
			text(message.sourceKey) &&
			text(message.name)
			? {
					action,
					projectRoot: message.projectRoot,
					sourceKey: message.sourceKey,
					name: message.name,
					maxInProgress: message.maxInProgress as number | undefined,
					autoDecompose: message.autoDecompose as boolean | undefined,
				}
			: undefined;
	if (
		!record(target) ||
		!keys(target, ['projectRoot', 'sourceKey', 'collectionKey', 'expectedRevision']) ||
		!text(target.projectRoot) ||
		!text(target.sourceKey) ||
		!text(target.collectionKey) ||
		!revision(target.expectedRevision)
	)
		return;
	if (action === 'delete-cards') {
		const cards = parseBoardDeleteCardsSelection(message.cards);
		return cards ? { action, target: target as unknown as BoardCommandTarget, cards } : undefined;
	}
	if (action === 'tick') {
		if (!text(message.operationId)) return;
	} else if (action === 'control') {
		if (
			!text(message.cardId) ||
			!revision(message.cardRevision) ||
			!['hold', 'resume', 'approve', 'accept'].includes(message.operation as string)
		)
			return;
		if (message.runToken !== undefined) {
			const token = message.runToken;
			if (
				!record(token) ||
				!keys(token, ['runId', 'ownerEpoch', 'generation']) ||
				!text(token.runId) ||
				!revision(token.ownerEpoch) ||
				token.ownerEpoch === 0 ||
				!revision(token.generation) ||
				token.generation === 0
			)
				return;
		}
	} else if (action === 'card-pr') {
		if (!text(message.cardId)) return;
	} else if (action === 'capture') {
		const command = message.capture;
		if (
			!record(command) ||
			!keys(command, [
				'projectRoot',
				'boardId',
				'expectedRevision',
				'card',
				'reviewSource',
				'replaceRole',
			]) ||
			(command.replaceRole !== undefined && command.replaceRole !== true) ||
			command.projectRoot !== target.projectRoot ||
			!text(command.boardId) ||
			command.expectedRevision !== target.expectedRevision ||
			!record(command.card) ||
			['human', 'actorAuthority', 'canRelaxStartPolicy'].some(
				(key) => key in (command.card as Record<string, unknown>)
			)
		)
			return;
	} else if (action === 'rename' && !text(message.name)) return;
	else if (action === 'delete' && message.force !== undefined && typeof message.force !== 'boolean')
		return;
	else if (action === 'delete-card' || action === 'status') {
		if (!text(message.cardId) || !revision(message.cardRevision)) return;
		if (
			action === 'status' &&
			(!(CARD_STATUSES as readonly unknown[]).includes(message.status) ||
				message.status === 'ready' ||
				message.status === 'running')
		)
			return;
	}
	return message as unknown as BoardCommand;
}

/** Called only after the transport's native authentication gate. */
export async function answerBoardCommand(
	message: Record<string, unknown>,
	host?: BoardCommandHost
): Promise<BoardCommandReply> {
	const command = parseBoardCommand(message);
	const result: BoardCommandResult = !command
		? {
				ok: false,
				error: {
					code: 'invalid-input',
					message: 'Invalid Board command; caller authority is not accepted',
				},
			}
		: !host
			? {
					ok: false,
					error: { code: 'runtime-unavailable', message: 'Board host is not configured' },
				}
			: await host(command);
	return {
		type: 'board_command_result',
		...result,
		requestId: typeof message.requestId === 'string' ? message.requestId : undefined,
	};
}
