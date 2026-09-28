/**
 * Feedback and support-package WebSocket message handlers.
 *
 * Handles: support_package_create, feedback_check_auth, feedback_search,
 * feedback_submit, feedback_subscribe. These are the CLI's route to the same
 * service functions the Send Feedback modal and Create Debug Package use, so
 * the CLI files the byte-identical issue and zip.
 */

import path from 'path';
import { generateDebugPackage } from '../../../debug-package';
import {
	checkFeedbackGhAuth,
	searchFeedbackIssues,
	submitFeedbackConversation,
	subscribeFeedbackIssue,
} from '../../../feedback';
import {
	MAX_FEEDBACK_ATTACHMENTS,
	type FeedbackConversationSubmitPayload,
} from '../../../../shared/feedback';
import type { DebugPackageOptions } from '../../../../shared/debugPackage';
import type { WebClient, WebClientMessage, MessageHandlerContext } from './types';

/**
 * Handle support_package_create - write a support (debug) package zip into
 * `outputDir`. The desktop's Create Debug Package raises a save dialog; the
 * CLI names the directory instead so it works unattended.
 *
 * Auto Run live state lives only in the renderer's batch store, so a package
 * built here reports that section as unavailable rather than claiming no
 * runs were active.
 */
export async function handleSupportPackageCreate(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const sendResult = (success: boolean, extra?: Record<string, unknown>) => {
		ctx.send(client, {
			type: 'support_package_create_result',
			success,
			...extra,
			requestId: message.requestId,
		});
	};

	const outputDir = typeof message.outputDir === 'string' ? message.outputDir : '';
	if (!outputDir || !path.isAbsolute(outputDir)) {
		sendResult(false, {
			error: `outputDir must be an absolute path, got: ${outputDir || '(none)'}`,
		});
		return;
	}
	const deps = ctx.callbacks.getDebugPackageDeps?.() ?? null;
	if (!deps) {
		sendResult(false, { error: 'Support packages are not configured in this build' });
		return;
	}

	// Only the section toggles cross the wire. Anything else on the message is
	// ignored rather than spread into the generator's options.
	const raw = (message.options ?? {}) as Record<string, unknown>;
	const options: DebugPackageOptions = {};
	for (const key of [
		'includeLogs',
		'includeErrors',
		'includeSessions',
		'includeGroupChats',
		'includeBatchState',
	] as const) {
		if (typeof raw[key] === 'boolean') options[key] = raw[key];
	}

	try {
		const result = await generateDebugPackage(outputDir, deps, options);
		if (!result.success) {
			sendResult(false, { error: result.error || 'Failed to generate support package' });
			return;
		}
		sendResult(true, {
			path: result.path,
			filesIncluded: result.filesIncluded,
			totalSizeBytes: result.totalSizeBytes,
		});
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		sendResult(false, { error: `Failed to generate support package: ${errMsg}` });
	}
}

/**
 * Run one feedback-service call and answer with `<type>_result`. The service
 * functions already return `{ success, error }` shapes for expected failures;
 * a throw here is a `gh` or filesystem fault and is reported the same way.
 */
async function answerFeedback(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage,
	run: () => Promise<Record<string, unknown>>
): Promise<void> {
	const type = `${message.type}_result`;
	try {
		const result = await run();
		ctx.send(client, {
			success: true,
			...result,
			type,
			requestId: message.requestId,
		});
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		ctx.send(client, { type, success: false, error: errMsg, requestId: message.requestId });
	}
}

/** Handle feedback_check_auth - is `gh` installed and logged in. */
export function handleFeedbackCheckAuth(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	return answerFeedback(ctx, client, message, async () => ({ ...(await checkFeedbackGhAuth()) }));
}

/** Handle feedback_search - possible duplicate issues for a query. */
export function handleFeedbackSearch(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const query = typeof message.query === 'string' ? message.query : '';
	return answerFeedback(ctx, client, message, async () => ({
		...(await searchFeedbackIssues({ query })),
	}));
}

/**
 * Handle feedback_submit - file a GitHub issue exactly as the Feedback
 * modal's Submit does, including the optional support package.
 */
export function handleFeedbackSubmit(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const payload = (message.payload ?? {}) as FeedbackConversationSubmitPayload;
	return answerFeedback(ctx, client, message, async () => {
		if (
			Array.isArray(payload.attachments) &&
			payload.attachments.length > MAX_FEEDBACK_ATTACHMENTS
		) {
			return {
				success: false,
				error: `At most ${MAX_FEEDBACK_ATTACHMENTS} screenshots can be attached.`,
			};
		}
		const deps = payload.includeDebugPackage
			? (ctx.callbacks.getDebugPackageDeps?.() ?? undefined)
			: undefined;
		if (payload.includeDebugPackage && !deps) {
			return { success: false, error: 'Support packages are not configured in this build' };
		}
		return { ...(await submitFeedbackConversation(payload, deps)) };
	});
}

/** Handle feedback_subscribe - +1 an existing issue, optionally commenting. */
export function handleFeedbackSubscribe(
	ctx: MessageHandlerContext,
	client: WebClient,
	message: WebClientMessage
): Promise<void> {
	const issueNumber = typeof message.issueNumber === 'number' ? message.issueNumber : NaN;
	const comment = typeof message.comment === 'string' ? message.comment : undefined;
	return answerFeedback(ctx, client, message, async () => ({
		...(await subscribeFeedbackIssue({ issueNumber, comment })),
	}));
}
