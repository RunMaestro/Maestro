/**
 * Marketplace domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: marketplace_get_manifest,
 * marketplace_get_document, marketplace_get_readme, marketplace_import_playbook.
 */

import { captureException } from '../../../utils/sentry';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Reject a `playbookPath` that points at the local filesystem (absolute
 * path or `~`-prefixed) or contains traversal segments / backslashes.
 * Web clients can browse the official + local catalog by id, but they
 * must never be able to coerce the server into reading arbitrary files
 * via the marketplace fetch helpers. Defense-in-depth: downstream
 * resolvers also validate, but rejecting at the entry point keeps
 * future code changes from re-opening the bypass.
 */
function isUntrustedLocalPath(playbookPath: string): boolean {
	if (
		playbookPath.startsWith('/') ||
		playbookPath.startsWith('\\') ||
		playbookPath.startsWith('~/') ||
		playbookPath.startsWith('~\\') ||
		/^[a-zA-Z]:[\\/]/.test(playbookPath)
	) {
		return true;
	}
	// Reject any backslash anywhere - official/local manifest paths use
	// forward slashes, so a backslash is either a Windows-style absolute
	// fragment or a deliberate normalization-bypass attempt.
	if (playbookPath.includes('\\')) {
		return true;
	}
	// Reject `.` / `..` segments. `path.resolve()` collapses these later
	// but checking up front prevents a relative-traversal payload from
	// reaching downstream code at all.
	const segments = playbookPath.split('/');
	for (const segment of segments) {
		if (segment === '.' || segment === '..') {
			return true;
		}
	}
	return false;
}

/**
 * Send a typed `marketplace_*_result` failure rather than a generic
 * `error` frame. Clients that wait on the typed result type would
 * otherwise miss the failure and time out (coderabbit feedback).
 */
function sendMarketplaceFailure(
	ctx: MessageHandlerContext,
	client: WebClient,
	type:
		| 'marketplace_get_manifest_result'
		| 'marketplace_get_document_result'
		| 'marketplace_get_readme_result'
		| 'marketplace_import_playbook_result',
	error: string,
	message: WebClientMessage,
	extra?: Record<string, unknown>
): void {
	ctx.send(client, {
		type,
		success: false,
		error,
		requestId: message.requestId,
		...extra,
	});
}

/**
 * Report an unexpected marketplace-handler exception to Sentry, then
 * send a typed failure to the client. Mirrors `reportHandlerError` but
 * preserves the `marketplace_*_result` typing the mobile client waits
 * on. Without the Sentry capture step, transient production faults in
 * the marketplace flow stay invisible because the client only sees the
 * typed failure.
 */
function reportMarketplaceHandlerError(
	ctx: MessageHandlerContext,
	client: WebClient,
	error: unknown,
	type:
		| 'marketplace_get_manifest_result'
		| 'marketplace_get_document_result'
		| 'marketplace_get_readme_result'
		| 'marketplace_import_playbook_result',
	handler: string,
	message: WebClientMessage,
	userMessagePrefix: string,
	extra?: Record<string, unknown>
): void {
	const err = error instanceof Error ? error : new Error(String(error));
	captureException(err, { extra: { area: 'web-server', handler, ...extra } });
	sendMarketplaceFailure(ctx, client, type, `${userMessagePrefix}: ${err.message}`, message, extra);
}

/**
 * Handle marketplace_get_manifest - return merged official + local catalog.
 */
export function handleMarketplaceGetManifest(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const refresh = message.refresh === true;

	if (!ctx.callbacks.getMarketplaceManifest) {
		ctx.send(client, {
			type: 'marketplace_get_manifest_result',
			success: false,
			error: 'Marketplace not configured',
			requestId: message.requestId,
		});
		return;
	}

	ctx.callbacks
		.getMarketplaceManifest({ refresh })
		.then((result) => {
			if (!result) {
				ctx.send(client, {
					type: 'marketplace_get_manifest_result',
					success: false,
					error: 'No manifest available',
					requestId: message.requestId,
				});
				return;
			}
			ctx.send(client, {
				type: 'marketplace_get_manifest_result',
				success: true,
				manifest: result.manifest,
				fromCache: result.fromCache,
				cacheAge: result.cacheAge,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			reportMarketplaceHandlerError(
				ctx,
				client,
				error,
				'marketplace_get_manifest_result',
				'marketplace_get_manifest',
				message,
				'Failed to load marketplace'
			);
		});
}

/**
 * Handle marketplace_get_document - fetch a single document's content.
 */
export function handleMarketplaceGetDocument(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const playbookPath = message.playbookPath;
	const filename = message.filename;

	if (typeof playbookPath !== 'string' || playbookPath.trim() === '') {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_get_document_result',
			'Missing or invalid playbookPath',
			message
		);
		return;
	}
	if (isUntrustedLocalPath(playbookPath)) {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_get_document_result',
			'Local filesystem paths are not allowed from web clients',
			message
		);
		return;
	}
	if (typeof filename !== 'string' || filename.trim() === '') {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_get_document_result',
			'Missing or invalid filename',
			message
		);
		return;
	}
	if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_get_document_result',
			'Invalid filename',
			message
		);
		return;
	}

	if (!ctx.callbacks.getMarketplaceDocument) {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_get_document_result',
			'Marketplace not configured',
			message
		);
		return;
	}

	ctx.callbacks
		.getMarketplaceDocument(playbookPath, filename)
		.then((result) => {
			if (!result) {
				sendMarketplaceFailure(
					ctx,
					client,
					'marketplace_get_document_result',
					'Marketplace not configured',
					message
				);
				return;
			}
			ctx.send(client, {
				type: 'marketplace_get_document_result',
				success: true,
				content: result.content,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			reportMarketplaceHandlerError(
				ctx,
				client,
				error,
				'marketplace_get_document_result',
				'marketplace_get_document',
				message,
				'Failed to fetch document',
				{ playbookPath, filename }
			);
		});
}

/**
 * Handle marketplace_get_readme - fetch a playbook's README.
 */
export function handleMarketplaceGetReadme(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const playbookPath = message.playbookPath;
	if (typeof playbookPath !== 'string' || playbookPath.trim() === '') {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_get_readme_result',
			'Missing or invalid playbookPath',
			message
		);
		return;
	}
	if (isUntrustedLocalPath(playbookPath)) {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_get_readme_result',
			'Local filesystem paths are not allowed from web clients',
			message
		);
		return;
	}

	if (!ctx.callbacks.getMarketplaceReadme) {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_get_readme_result',
			'Marketplace not configured',
			message
		);
		return;
	}

	ctx.callbacks
		.getMarketplaceReadme(playbookPath)
		.then((result) => {
			if (!result) {
				sendMarketplaceFailure(
					ctx,
					client,
					'marketplace_get_readme_result',
					'Marketplace not configured',
					message
				);
				return;
			}
			ctx.send(client, {
				type: 'marketplace_get_readme_result',
				success: true,
				content: result.content,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			reportMarketplaceHandlerError(
				ctx,
				client,
				error,
				'marketplace_get_readme_result',
				'marketplace_get_readme',
				message,
				'Failed to fetch README',
				{ playbookPath }
			);
		});
}

/**
 * Handle marketplace_import_playbook - import a playbook into the
 * session's Auto Run folder. The server resolves both the folder path
 * and SSH config from the session, so the mobile client doesn't need
 * to send them - and can't lie about them.
 */
export function handleMarketplaceImportPlaybook(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const sessionId = message.sessionId;
	const playbookId = message.playbookId;
	const targetFolderName = message.targetFolderName;

	if (typeof sessionId !== 'string' || sessionId.trim() === '') {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_import_playbook_result',
			'Missing sessionId',
			message
		);
		return;
	}
	if (typeof playbookId !== 'string' || playbookId.trim() === '') {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_import_playbook_result',
			'Missing playbookId',
			message,
			{
				sessionId,
			}
		);
		return;
	}
	if (typeof targetFolderName !== 'string' || targetFolderName.trim() === '') {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_import_playbook_result',
			'Missing targetFolderName',
			message,
			{ sessionId }
		);
		return;
	}
	// Reject path separators and traversal so the import folder cannot
	// escape the session's Auto Run root. The service-layer guard
	// (assertSafeTargetFolderName) is the source of truth, but
	// short-circuiting here returns a cleaner WebSocket error code.
	const trimmedFolder = targetFolderName.trim();
	if (
		trimmedFolder.includes('..') ||
		trimmedFolder.includes('/') ||
		trimmedFolder.includes('\\') ||
		trimmedFolder.startsWith('~') ||
		/^[a-zA-Z]:[\\/]/.test(trimmedFolder)
	) {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_import_playbook_result',
			'targetFolderName must be a single folder name without separators',
			message,
			{ sessionId }
		);
		return;
	}

	if (!ctx.callbacks.importMarketplacePlaybook) {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_import_playbook_result',
			'Marketplace import not configured',
			message,
			{ sessionId }
		);
		return;
	}

	ctx.callbacks
		.importMarketplacePlaybook(sessionId, playbookId, trimmedFolder)
		.then((result) => {
			ctx.send(client, {
				type: 'marketplace_import_playbook_result',
				success: result.success,
				error: result.error,
				playbook: result.playbook,
				importedDocs: result.importedDocs,
				importedAssets: result.importedAssets,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			reportMarketplaceHandlerError(
				ctx,
				client,
				error,
				'marketplace_import_playbook_result',
				'marketplace_import_playbook',
				message,
				'Import failed',
				{ sessionId, playbookId, targetFolderName: trimmedFolder }
			);
		});
}
