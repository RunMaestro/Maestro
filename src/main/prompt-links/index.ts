/**
 * Prompt Links service: the one implementation every surface calls.
 *
 *   - The Prompt Links window and the Encore tile reach it through the
 *     `promptLinks:*` IPC channels (desktop only; refused over the bridge).
 *   - `maestro-cli prompt-link` reaches it through the CLI-only
 *     `prompt_link_command` WebSocket message.
 *   - A clicked `maestro://run/<token>` reaches `firePromptLink` from the
 *     deep-link handler.
 *
 * Creating and firing both require the Encore Feature. Listing and revoking do
 * not: removing a link must stay possible after the feature is switched off.
 */

import type { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { createSafeSend } from '../utils/safe-send';
import {
	NEW_AI_TAB_NO_WINDOW_ERROR,
	NEW_AI_TAB_TIMEOUT_ERROR,
	requestNewAITabWithPrompt,
} from '../utils/new-ai-tab-request';
import { getSessionsStore, getSettingsStore } from '../stores/getters';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import {
	describePromptLinkRefusal,
	type PromptLinkCreateInput,
	type PromptLinkCreated,
	type PromptLinkPublic,
	type PromptLinkRefusal,
} from '../../shared/promptLinks';
import { getPromptLinkStore } from './prompt-link-store';
import type { ToastClickAction } from '../../shared/toastClickAction';

const LOG_CONTEXT = 'PromptLinks';

/**
 * How long a link clicked while Maestro was closed waits for the renderer to
 * restore its agents before giving up. A cold start on a slow machine can take
 * a while; past this, the link is released untouched and the user is told.
 */
export const PROMPT_LINK_READY_TIMEOUT_MS = 90_000;

export function isPromptLinksEnabled(): boolean {
	try {
		return resolveEncoreFeatures(getSettingsStore().get('encoreFeatures')).promptLinks === true;
	} catch {
		// Stores not initialized (tests, very early boot): treat as off.
		return false;
	}
}

interface AgentRef {
	id: string;
	name: string;
}

function findAgent(agentId: string): AgentRef | null {
	try {
		const sessions = getSessionsStore().get('sessions', []) as Array<{ id: string; name: string }>;
		const match = sessions.find((s) => s.id === agentId);
		return match ? { id: match.id, name: match.name } : null;
	} catch {
		return null;
	}
}

// ============================================================================
// Renderer readiness
// ============================================================================

// A link clicked while Maestro was closed arrives before the window exists, and
// the renderer cannot open a tab on an agent it has not restored yet. The
// renderer signals once its agents are loaded; firing waits for that.
let rendererReady = false;
let resolveRendererReady: (() => void) | null = null;
let rendererReadyPromise = new Promise<void>((resolve) => {
	resolveRendererReady = resolve;
});

export function markPromptLinksRendererReady(): void {
	if (rendererReady) return;
	rendererReady = true;
	resolveRendererReady?.();
}

function waitForRendererReady(timeoutMs: number): Promise<boolean> {
	if (rendererReady) return Promise.resolve(true);
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		void rendererReadyPromise.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** Test seam. */
export function resetPromptLinksRendererReadyForTests(): void {
	rendererReady = false;
	rendererReadyPromise = new Promise<void>((resolve) => {
		resolveRendererReady = resolve;
	});
}

// ============================================================================
// Create / list / revoke
// ============================================================================

export async function createPromptLink(input: PromptLinkCreateInput): Promise<PromptLinkCreated> {
	if (!isPromptLinksEnabled()) throw new Error(describePromptLinkRefusal('disabled'));
	if (!findAgent(input.agentId)) throw new Error(`Agent not found: ${input.agentId}`);
	const created = await getPromptLinkStore().create(input);
	logger.info('Created prompt link', LOG_CONTEXT, {
		id: created.link.id,
		agentId: created.link.agentId,
		maxUses: created.link.maxUses,
		expiresAt: created.link.expiresAt,
	});
	return created;
}

export function listPromptLinks(): PromptLinkPublic[] {
	return getPromptLinkStore().list();
}

export async function revokePromptLink(idOrPrefix: string): Promise<PromptLinkPublic> {
	const link = await getPromptLinkStore().revoke(idOrPrefix);
	logger.info('Revoked prompt link', LOG_CONTEXT, { id: link.id });
	return link;
}

// ============================================================================
// Fire
// ============================================================================

export type PromptLinkFireResult =
	| { ok: true; link: PromptLinkPublic; tabId?: string; uncertain?: boolean }
	| { ok: false; reason: PromptLinkRefusal | 'delivery-failed'; error: string };

function toast(
	getMainWindow: () => BrowserWindow | null,
	params: {
		title: string;
		message: string;
		color: 'green' | 'yellow' | 'red' | 'theme';
		sessionId?: string;
		clickAction?: ToastClickAction;
	}
): void {
	try {
		createSafeSend(getMainWindow)('remote:notifyToast', {
			title: params.title,
			message: params.message,
			color: params.color,
			// A refusal is a security event the user should see, not a passing ping.
			dismissible: params.color === 'red',
			...(params.sessionId ? { sessionId: params.sessionId } : {}),
			...(params.clickAction ? { clickAction: params.clickAction } : {}),
		});
	} catch (err) {
		logger.warn('Failed to send prompt link toast', LOG_CONTEXT, err);
	}
}

function refuse(
	getMainWindow: () => BrowserWindow | null,
	reason: PromptLinkRefusal | 'delivery-failed',
	error: string
): PromptLinkFireResult {
	logger.warn(`Prompt link refused: ${reason}`, LOG_CONTEXT);
	toast(getMainWindow, {
		title: 'Prompt link did not run',
		message: error,
		color: reason === 'disabled' || reason === 'not-ready' ? 'yellow' : 'red',
	});
	return { ok: false, reason, error };
}

function bringToFront(win: BrowserWindow | null): void {
	if (!win) return;
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

/**
 * Run the prompt a link names, once. Every outcome raises a toast: in
 * background mode it is the only sign the link did anything.
 */
export async function firePromptLink(
	token: string,
	getMainWindow: () => BrowserWindow | null,
	options: { readyTimeoutMs?: number } = {}
): Promise<PromptLinkFireResult> {
	if (!isPromptLinksEnabled()) {
		return refuse(getMainWindow, 'disabled', describePromptLinkRefusal('disabled'));
	}

	const reservation = getPromptLinkStore().reserve(token);
	if (!reservation.ok) {
		return refuse(getMainWindow, reservation.reason, describePromptLinkRefusal(reservation.reason));
	}
	const { link } = reservation;

	const agent = findAgent(link.agentId);
	if (!agent) {
		reservation.release();
		return refuse(getMainWindow, 'agent-missing', describePromptLinkRefusal('agent-missing'));
	}

	const ready = await waitForRendererReady(options.readyTimeoutMs ?? PROMPT_LINK_READY_TIMEOUT_MS);
	if (!ready) {
		reservation.release();
		return refuse(getMainWindow, 'not-ready', describePromptLinkRefusal('not-ready'));
	}

	const foreground = link.open === 'foreground';
	if (foreground) bringToFront(getMainWindow());

	const result = await requestNewAITabWithPrompt(
		getMainWindow,
		link.agentId,
		link.prompt,
		!foreground
	);
	const name = link.label ? `"${link.label}"` : 'A prompt link';

	if (result.success) {
		reservation.commit();
		logger.info('Prompt link ran', LOG_CONTEXT, { id: link.id, tabId: result.tabId });
		toast(getMainWindow, {
			title: 'Prompt link ran',
			message: `${name} opened a new tab in ${agent.name}.`,
			color: 'green',
			sessionId: agent.id,
			clickAction: {
				kind: 'jump-session',
				sessionId: agent.id,
				...(result.tabId ? { tabId: result.tabId } : {}),
			},
		});
		return { ok: true, link, ...(result.tabId ? { tabId: result.tabId } : {}) };
	}

	if (result.error === NEW_AI_TAB_TIMEOUT_ERROR) {
		// The renderer may have run it and only the answer was lost. Count the use:
		// running a one-shot prompt twice is the worse mistake.
		reservation.commit();
		toast(getMainWindow, {
			title: 'Prompt link may have run',
			message: `${name} was sent to ${agent.name}, but Maestro did not confirm it. Check the agent before using the link again.`,
			color: 'yellow',
			sessionId: agent.id,
			clickAction: { kind: 'jump-session', sessionId: agent.id },
		});
		return { ok: true, link, uncertain: true };
	}

	// A definite refusal (no window, agent gone in the renderer, tab not
	// created): nothing ran, so the use is kept.
	reservation.release();
	return refuse(
		getMainWindow,
		'delivery-failed',
		result.error === NEW_AI_TAB_NO_WINDOW_ERROR
			? `${NEW_AI_TAB_NO_WINDOW_ERROR}. The link was not used.`
			: `${result.error ?? 'Maestro could not open the tab'}. The link was not used.`
	);
}
