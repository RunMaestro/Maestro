/**
 * Dispatch for a voice session bound to Quick Chat.
 *
 * Every other dispatch resolves an agent and a tab in main and then drives the
 * renderer through the `remote:*` channels (see `route-executor.ts`). This one
 * does neither. Quick Chat owns its agent and its tab, so the spoken turn is
 * handed to the SAME `send` command the window's Send button and
 * `maestro-cli quick-chat send` use, and the result says where it landed.
 *
 * Three things that path gives a spoken turn for free, and that the ordinary
 * one would get wrong:
 *
 *   - The chat's tab is created by the first sentence, exactly as by the first
 *     typed message.
 *   - An ephemeral chat's tab stays hidden. `remote:focusAiTab` would put it in
 *     front in the main window.
 *   - No app window is raised. The conversation is in the Quick Chat window,
 *     which is where the user is.
 *
 * Quick Chat routes every message on its own, after `send` has returned: it
 * may continue an open tab, reopen a closed conversation, or open a new tab,
 * and it may queue the message behind a turn that tab is still answering. So
 * the address of the reply is not known when `send` answers. It is the ROUTE
 * of this message, which arrives in a later snapshot, and this module waits
 * for it.
 */

import type { QuickChatController } from '../../quick-chat/quick-chat-controller';
import { QUICK_CHAT_VOICE_LABEL } from '../../../shared/acappella/quick-chat-scope';
import type {
	QuickChatMessage,
	QuickChatRoute,
	QuickChatSnapshot,
} from '../../../shared/quickChat';
import { VoiceDispatchError } from '../voice-session-service';
import type { VoiceDispatchResult } from '../voice-session-service';

/**
 * What a voice session needs from Quick Chat: its window as the session's
 * surface, the chat as it stands and as it changes, and the send. The
 * controller satisfies it; a test hands in four functions.
 */
export type QuickChatVoiceHost = Pick<
	QuickChatController,
	'showForVoice' | 'getStatus' | 'runCommand' | 'onSnapshot'
>;

/** What a caller is told when a Quick Chat session is asked for and there is no Quick Chat. */
export const QUICK_CHAT_VOICE_UNAVAILABLE =
	'Quick Chat is turned off. Turn it on in Settings > Plugins to talk to it.';

/**
 * How long a message may stay `searching`. Finding a tab is a word match and,
 * on a close call, one short model call with its own timeout, so a message
 * still searching after this is one whose snapshots stopped arriving.
 */
export const QUICK_CHAT_ROUTE_TIMEOUT_MS = 30_000;

/**
 * How long a message may stay `queued` behind the turn its tab is answering
 * before the voice turn gives up on following it. The message stays queued and
 * still runs; only the spoken reply is given up.
 */
export const QUICK_CHAT_QUEUE_TIMEOUT_MS = 10 * 60_000;

export interface QuickChatDispatchOptions {
	routeTimeoutMs?: number;
	queueTimeoutMs?: number;
}

/** The message a `send` added: the newest one the user sent. */
function sentMessage(snapshot: QuickChatSnapshot, prompt: string): QuickChatMessage | undefined {
	const sent = snapshot.messages.filter((message) => message.role === 'user' && message.route);
	// The text is checked first so a message typed in the window in the same
	// instant is not mistaken for the spoken one.
	return [...sent].reverse().find((message) => message.text === prompt) ?? sent[sent.length - 1];
}

/**
 * A message's route once its tab is answering it (or has answered), null while
 * the wait goes on. Throws for every way the message can end with no reply to
 * follow.
 */
function answeringRoute(snapshot: QuickChatSnapshot, messageId: string): QuickChatRoute | null {
	const message = snapshot.messages.find((m) => m.id === messageId);
	if (!message?.route) {
		// A new chat, or the agent picker, replaced the conversation.
		throw new VoiceDispatchError('Quick Chat started a new chat before the message was sent');
	}
	const { route } = message;
	switch (route.status) {
		case 'searching':
		case 'queued':
			return null;
		case 'running':
		case 'done':
			return route;
		case 'cancelled':
			throw new VoiceDispatchError('The message was withdrawn from Quick Chat before it ran');
		case 'failed': {
			// The engine lists its reason as the error line under the message.
			const reason = snapshot.messages.find((m) => m.id === `${messageId}-error`)?.text;
			throw new VoiceDispatchError(reason ?? 'Quick Chat could not send the message');
		}
	}
}

/**
 * Wait until the tab a message was routed to is answering it.
 *
 * `queued` is waited out, not reported: the session speaks whatever its tab
 * writes from the moment a dispatch is reported, and a tab that is still
 * answering an EARLIER message would have that reply spoken as the answer to
 * this one.
 */
function waitForAnsweringRoute(
	host: QuickChatVoiceHost,
	messageId: string,
	first: QuickChatSnapshot,
	options: QuickChatDispatchOptions
): Promise<QuickChatRoute> {
	const routeTimeoutMs = options.routeTimeoutMs ?? QUICK_CHAT_ROUTE_TIMEOUT_MS;
	const queueTimeoutMs = options.queueTimeoutMs ?? QUICK_CHAT_QUEUE_TIMEOUT_MS;

	return new Promise<QuickChatRoute>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let queued = false;
		let settled = false;
		let stopListening: () => void = () => {};

		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			stopListening();
			settle();
		};
		const arm = (ms: number, message: string) => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => finish(() => reject(new VoiceDispatchError(message))), ms);
		};
		const read = (snapshot: QuickChatSnapshot) => {
			if (settled) return;
			let route: QuickChatRoute | null;
			try {
				route = answeringRoute(snapshot, messageId);
			} catch (error) {
				finish(() => reject(error));
				return;
			}
			if (route) {
				finish(() => resolve(route));
				return;
			}
			// The queue has its own, longer, budget, started when the message
			// first reads as queued.
			const nowQueued =
				snapshot.messages.find((m) => m.id === messageId)?.route?.status === 'queued';
			if (nowQueued && !queued) {
				queued = true;
				arm(
					queueTimeoutMs,
					'Quick Chat is still answering an earlier message. Yours is queued and runs when that one finishes.'
				);
			}
		};

		arm(routeTimeoutMs, 'Quick Chat did not find a tab for the message in time');
		stopListening = host.onSnapshot(read);
		// The snapshot `send` returned, then the one the controller holds now: a
		// route that arrived between the two was announced before anyone listened.
		read(first);
		read(host.getStatus().snapshot);
	});
}

/**
 * Send one spoken turn through Quick Chat and report where it landed.
 *
 * A refusal from the engine (there is no agent to chat with) is the sentence
 * the window shows for a typed message, so it is the sentence the voice session
 * reports too.
 */
export async function dispatchToQuickChat(
	prompt: string,
	host: QuickChatVoiceHost | null | undefined,
	options: QuickChatDispatchOptions = {}
): Promise<VoiceDispatchResult> {
	if (!host) throw new VoiceDispatchError(QUICK_CHAT_VOICE_UNAVAILABLE);
	if (!prompt) throw new VoiceDispatchError('There was nothing to send to Quick Chat');

	const result = await host.runCommand({ type: 'send', text: prompt });
	if (!result.ok) {
		throw new VoiceDispatchError(result.error ?? 'Quick Chat did not take the message');
	}
	const sent = sentMessage(result.snapshot, prompt);
	if (!sent) {
		// `ok` with no message would leave the session waiting on a reply it has
		// no address for.
		throw new VoiceDispatchError('Quick Chat took the message but did not list it');
	}

	const route = await waitForAnsweringRoute(host, sent.id, result.snapshot, options);
	// Read after the wait: the agent is the one the chat is on now.
	const { agentId, agentName } = host.getStatus().snapshot;
	if (!agentId || !route.tabId) {
		throw new VoiceDispatchError('Quick Chat sent the message but reported no tab for it');
	}

	return {
		agentSessionId: agentId,
		agentName: agentName ?? 'Agent',
		tabId: route.tabId,
		tabName: route.tabName ?? QUICK_CHAT_VOICE_LABEL,
		// A tab Quick Chat opened for this message is created; one it continued
		// or reopened is recalled.
		action: route.origin === 'new' ? 'created' : 'recalled',
		promptSent: true,
	};
}
