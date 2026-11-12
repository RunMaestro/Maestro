/**
 * Marketplace domain WebSocket message handlers.
 *
 * Extracted from WebSocketMessageHandler.ts. Handles: marketplace_get_manifest,
 * marketplace_get_document, marketplace_get_readme, marketplace_import_playbook,
 * and Playbook Launch: marketplace_launch, marketplace_complete_launch,
 * marketplace_get_launch, marketplace_list_launches.
 */

import { captureException } from '../../../utils/sentry';
import type {
	PlaybookLaunchCompletion,
	PlaybookLaunchValues,
} from '../../../../shared/marketplace-types';
import { isLaunchValuesObject } from '../../../../shared/playbookLaunch';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/** The typed result every marketplace request is answered with. */
type MarketplaceResultType =
	| 'marketplace_get_manifest_result'
	| 'marketplace_get_document_result'
	| 'marketplace_get_readme_result'
	| 'marketplace_import_playbook_result'
	| 'marketplace_launch_result'
	| 'marketplace_complete_launch_result'
	| 'marketplace_get_launch_result'
	| 'marketplace_list_launches_result';

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
	type: MarketplaceResultType,
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
	type: MarketplaceResultType,
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
 * to send them - and can't lie about them. An optional `launchValues`
 * object (answers keyed by input name) makes the import a Launch.
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
	// Only the shape is checked here. The service resolves the answers
	// against the playbook's launch spec and validates every value
	// before anything touches the disk.
	const launchValues = message.launchValues ?? undefined;
	if (launchValues !== undefined && !isLaunchValuesObject(launchValues)) {
		sendMarketplaceFailure(
			ctx,
			client,
			'marketplace_import_playbook_result',
			'launchValues must be an object keyed by input name',
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
		.importMarketplacePlaybook(
			sessionId,
			playbookId,
			trimmedFolder,
			launchValues as PlaybookLaunchValues | undefined
		)
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

/** A launch id from a message: any string that is not blank, else `undefined`. */
function launchIdOf(message: WebClientMessage): string | undefined {
	const launchId = message.launchId;
	return typeof launchId === 'string' && launchId.trim() !== '' ? launchId : undefined;
}

/**
 * Handle marketplace_launch - launch a playbook on an agent: import it with the answers into a
 * launch folder of its own, record the launch and start its Auto Run. As for an import, the server
 * takes the agent's Auto Run folder and SSH remote from the stored agent, so the client names
 * neither. `values` (answers keyed by input name) may be left out when every input has a default.
 */
export function handleMarketplaceLaunch(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const type = 'marketplace_launch_result';
	const sessionId = message.sessionId;
	const playbookId = message.playbookId;

	if (typeof sessionId !== 'string' || sessionId.trim() === '') {
		sendMarketplaceFailure(ctx, client, type, 'Missing sessionId', message);
		return;
	}
	if (typeof playbookId !== 'string' || playbookId.trim() === '') {
		sendMarketplaceFailure(ctx, client, type, 'Missing playbookId', message, { sessionId });
		return;
	}
	// Only the shape is checked here. The service resolves the answers against the playbook's
	// launch spec and validates every value before anything touches the disk.
	const values = message.values ?? {};
	if (!isLaunchValuesObject(values)) {
		sendMarketplaceFailure(
			ctx,
			client,
			type,
			'values must be an object keyed by input name',
			message,
			{ sessionId }
		);
		return;
	}
	const keepSavedPlaybook = message.keepSavedPlaybook ?? false;
	if (typeof keepSavedPlaybook !== 'boolean') {
		sendMarketplaceFailure(ctx, client, type, 'keepSavedPlaybook must be true or false', message, {
			sessionId,
		});
		return;
	}
	if (!ctx.callbacks.launchMarketplacePlaybook) {
		sendMarketplaceFailure(ctx, client, type, 'Marketplace launch not configured', message, {
			sessionId,
		});
		return;
	}

	ctx.callbacks
		.launchMarketplacePlaybook({
			sessionId,
			playbookId,
			values: values as PlaybookLaunchValues,
			keepSavedPlaybook,
		})
		.then((result) => {
			ctx.send(client, {
				type,
				success: result.success,
				error: result.error,
				launchId: result.launchId,
				folderRelativePath: result.folderRelativePath,
				sessionId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			reportMarketplaceHandlerError(
				ctx,
				client,
				error,
				type,
				'marketplace_launch',
				message,
				'Launch failed',
				{ sessionId, playbookId }
			);
		});
}

/**
 * Handle marketplace_complete_launch - report that a launched Auto Run has ended. Main ends the
 * launch record, cleans up after the run and broadcasts `marketplace:launchChanged`. The service
 * checks every field of `completion`.
 */
export function handleMarketplaceCompleteLaunch(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const type = 'marketplace_complete_launch_result';
	const launchId = launchIdOf(message);
	if (!launchId) {
		sendMarketplaceFailure(ctx, client, type, 'Missing launchId', message);
		return;
	}
	if (!ctx.callbacks.completeMarketplaceLaunch) {
		sendMarketplaceFailure(ctx, client, type, 'Marketplace launch not configured', message, {
			launchId,
		});
		return;
	}

	ctx.callbacks
		.completeMarketplaceLaunch(launchId, message.completion as PlaybookLaunchCompletion)
		.then((result) => {
			ctx.send(client, {
				type,
				success: result.success,
				error: result.error,
				launch: result.launch,
				launchId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			reportMarketplaceHandlerError(
				ctx,
				client,
				error,
				type,
				'marketplace_complete_launch',
				message,
				'Completing the launch failed',
				{ launchId }
			);
		});
}

/** Handle marketplace_get_launch - one launch record (`maestro-cli marketplace launch-status`). */
export function handleMarketplaceGetLaunch(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const type = 'marketplace_get_launch_result';
	const launchId = launchIdOf(message);
	if (!launchId) {
		sendMarketplaceFailure(ctx, client, type, 'Missing launchId', message);
		return;
	}
	if (!ctx.callbacks.getMarketplaceLaunch) {
		sendMarketplaceFailure(ctx, client, type, 'Marketplace launch not configured', message, {
			launchId,
		});
		return;
	}

	ctx.callbacks
		.getMarketplaceLaunch(launchId)
		.then((result) => {
			ctx.send(client, {
				type,
				success: result.success,
				error: result.error,
				launch: result.launch,
				launchId,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			reportMarketplaceHandlerError(
				ctx,
				client,
				error,
				type,
				'marketplace_get_launch',
				message,
				'Failed to read the launch',
				{ launchId }
			);
		});
}

/**
 * Handle marketplace_list_launches - launch records, newest first (`maestro-cli marketplace
 * launches`). `sessionId` keeps one agent's launches and `limit` caps the list; the service checks
 * both.
 */
export function handleMarketplaceListLaunches(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): void {
	const type = 'marketplace_list_launches_result';
	if (!ctx.callbacks.listMarketplaceLaunches) {
		sendMarketplaceFailure(ctx, client, type, 'Marketplace launch not configured', message);
		return;
	}

	ctx.callbacks
		.listMarketplaceLaunches({
			sessionId: message.sessionId,
			limit: message.limit as number | undefined,
		})
		.then((result) => {
			ctx.send(client, {
				type,
				success: result.success,
				error: result.error,
				launches: result.launches,
				requestId: message.requestId,
			});
		})
		.catch((error) => {
			reportMarketplaceHandlerError(
				ctx,
				client,
				error,
				type,
				'marketplace_list_launches',
				message,
				'Failed to list launches'
			);
		});
}
