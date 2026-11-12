/**
 * Playbooks domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: list_playbooks,
 * create_playbook, update_playbook, delete_playbook.
 */

import type { WebPlaybookDocument } from '../../types';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Validate and normalize the `documents` field of a playbook payload.
 * Returns the parsed array on success, or null on any validation failure.
 *
 * Filenames may contain forward-slash subdirectories (e.g. `loop/step-1`)
 * but must not:
 *   - contain `..` path-traversal segments
 *   - contain backslashes (we only persist POSIX separators)
 *   - be absolute (POSIX `/foo` or Windows drive-letter `C:/foo`)
 *
 * `resetOnCompletion` is validated strictly as a boolean when present;
 * any other type is rejected rather than coerced, so a stray truthy
 * value from a buggy client can't silently flip the flag on.
 */
function parsePlaybookDocuments(input: unknown): WebPlaybookDocument[] | null {
	if (!Array.isArray(input)) return null;
	const out: WebPlaybookDocument[] = [];
	for (const entry of input) {
		if (!entry || typeof entry !== 'object') return null;
		const e = entry as { filename?: unknown; resetOnCompletion?: unknown };
		if (typeof e.filename !== 'string' || e.filename.trim() === '') return null;
		if (e.filename.includes('..') || e.filename.includes('\\')) return null;
		if (e.filename.startsWith('/')) return null;
		if (/^[A-Za-z]:[\\/]/.test(e.filename)) return null;
		let resetOnCompletion = false;
		if (e.resetOnCompletion !== undefined) {
			if (typeof e.resetOnCompletion !== 'boolean') return null;
			resetOnCompletion = e.resetOnCompletion;
		}
		out.push({
			filename: e.filename,
			resetOnCompletion,
		});
	}
	return out;
}

/**
 * Handle list_playbooks message - return the saved playbooks for a session.
 */
export function handleListPlaybooks(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}
	if (!ctx.callbacks.listPlaybooks) {
		ctx.sendError(client, 'Playbook listing not configured');
		return;
	}
	ctx.callbacks
		.listPlaybooks(sessionId)
		.then((playbooks) => {
			ctx.send(client, {
				type: 'playbooks_list',
				sessionId,
				playbooks,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.reportHandlerError(
				client,
				error,
				'list_playbooks',
				{ sessionId, requestId: message.requestId },
				'Failed to list playbooks'
			);
		});
}

/**
 * Handle create_playbook message - persist a new playbook with the given config.
 */
export function handleCreatePlaybook(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const playbook = message.playbook as
		| {
				name?: unknown;
				documents?: unknown;
				loopEnabled?: unknown;
				maxLoops?: unknown;
				prompt?: unknown;
		  }
		| undefined;

	if (!sessionId) {
		ctx.sendError(client, 'Missing sessionId');
		return;
	}
	if (!playbook || typeof playbook !== 'object') {
		ctx.sendError(client, 'Missing playbook payload');
		return;
	}
	if (typeof playbook.name !== 'string' || playbook.name.trim() === '') {
		ctx.sendError(client, 'Playbook name must be a non-empty string');
		return;
	}
	const documents = parsePlaybookDocuments(playbook.documents);
	if (documents === null) {
		ctx.sendError(client, 'Invalid playbook documents');
		return;
	}
	if (playbook.loopEnabled !== undefined && typeof playbook.loopEnabled !== 'boolean') {
		ctx.sendError(client, 'loopEnabled must be a boolean');
		return;
	}
	if (
		playbook.maxLoops !== undefined &&
		playbook.maxLoops !== null &&
		(typeof playbook.maxLoops !== 'number' ||
			!Number.isFinite(playbook.maxLoops) ||
			playbook.maxLoops < 0)
	) {
		ctx.sendError(client, 'maxLoops must be a finite non-negative number');
		return;
	}
	if (playbook.prompt !== undefined && typeof playbook.prompt !== 'string') {
		ctx.sendError(client, 'prompt must be a string');
		return;
	}

	if (!ctx.callbacks.createPlaybook) {
		ctx.sendError(client, 'Playbook creation not configured');
		return;
	}

	ctx.callbacks
		.createPlaybook(sessionId, {
			name: playbook.name.trim(),
			documents,
			loopEnabled: Boolean(playbook.loopEnabled),
			maxLoops: (playbook.maxLoops as number | null | undefined) ?? null,
			prompt: typeof playbook.prompt === 'string' ? playbook.prompt : '',
		})
		.then((created) => {
			ctx.send(client, {
				type: 'create_playbook_result',
				success: created !== null,
				sessionId,
				playbook: created,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.reportHandlerError(
				client,
				error,
				'create_playbook',
				{ sessionId, requestId: message.requestId },
				'Failed to create playbook'
			);
		});
}

/**
 * Handle update_playbook message - apply partial updates to an existing playbook.
 */
export function handleUpdatePlaybook(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const playbookId = message.playbookId as string;
	const updates = message.updates as
		| {
				name?: unknown;
				documents?: unknown;
				loopEnabled?: unknown;
				maxLoops?: unknown;
				prompt?: unknown;
		  }
		| undefined;

	if (!sessionId || !playbookId) {
		ctx.sendError(client, 'Missing sessionId or playbookId');
		return;
	}
	if (!updates || typeof updates !== 'object') {
		ctx.sendError(client, 'Missing updates payload');
		return;
	}

	const sanitized: Partial<{
		name: string;
		documents: WebPlaybookDocument[];
		loopEnabled: boolean;
		maxLoops: number | null;
		prompt: string;
	}> = {};

	if (updates.name !== undefined) {
		if (typeof updates.name !== 'string' || updates.name.trim() === '') {
			ctx.sendError(client, 'Playbook name must be a non-empty string');
			return;
		}
		sanitized.name = updates.name.trim();
	}
	if (updates.documents !== undefined) {
		const docs = parsePlaybookDocuments(updates.documents);
		if (docs === null) {
			ctx.sendError(client, 'Invalid playbook documents');
			return;
		}
		sanitized.documents = docs;
	}
	if (updates.loopEnabled !== undefined) {
		if (typeof updates.loopEnabled !== 'boolean') {
			ctx.sendError(client, 'loopEnabled must be a boolean');
			return;
		}
		sanitized.loopEnabled = updates.loopEnabled;
	}
	if (updates.maxLoops !== undefined) {
		if (
			updates.maxLoops !== null &&
			(typeof updates.maxLoops !== 'number' ||
				!Number.isFinite(updates.maxLoops) ||
				updates.maxLoops < 0)
		) {
			ctx.sendError(client, 'maxLoops must be a finite non-negative number');
			return;
		}
		sanitized.maxLoops = updates.maxLoops as number | null;
	}
	if (updates.prompt !== undefined) {
		if (typeof updates.prompt !== 'string') {
			ctx.sendError(client, 'prompt must be a string');
			return;
		}
		sanitized.prompt = updates.prompt;
	}

	if (!ctx.callbacks.updatePlaybook) {
		ctx.sendError(client, 'Playbook updates not configured');
		return;
	}

	ctx.callbacks
		.updatePlaybook(sessionId, playbookId, sanitized)
		.then((updated) => {
			ctx.send(client, {
				type: 'update_playbook_result',
				success: updated !== null,
				sessionId,
				playbook: updated,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.reportHandlerError(
				client,
				error,
				'update_playbook',
				{ sessionId, playbookId, requestId: message.requestId },
				'Failed to update playbook'
			);
		});
}

/**
 * Handle delete_playbook message - remove a playbook.
 */
export function handleDeletePlaybook(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId as string;
	const playbookId = message.playbookId as string;
	if (!sessionId || !playbookId) {
		ctx.sendError(client, 'Missing sessionId or playbookId');
		return;
	}
	if (!ctx.callbacks.deletePlaybook) {
		ctx.sendError(client, 'Playbook deletion not configured');
		return;
	}
	ctx.callbacks
		.deletePlaybook(sessionId, playbookId)
		.then((success) => {
			ctx.send(client, {
				type: 'delete_playbook_result',
				success,
				sessionId,
				playbookId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			ctx.reportHandlerError(
				client,
				error,
				'delete_playbook',
				{ sessionId, playbookId, requestId: message.requestId },
				'Failed to delete playbook'
			);
		});
}
