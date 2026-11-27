import { randomUUID } from 'node:crypto';
import type { GroupChatMessage, GroupChatState } from '../../../shared/group-chat-types';
import type { GroupChatVoiceScope } from '../../../shared/acappella/protocol';
import { groupChatEvents } from '../../group-chat/emitters';
import { loadGroupChat } from '../../group-chat/group-chat-storage';
import { submitMessage } from '../../group-chat/group-chat-queue';
import { VoiceDispatchError, type VoiceDispatchResult } from '../voice-session-service';

/** Send through the same queue as typed messages. Only the moderator's final round is spoken. */
export async function dispatchToGroupChat(
	scope: GroupChatVoiceScope,
	prompt: string,
	signal?: AbortSignal,
	onAccepted?: () => void
): Promise<VoiceDispatchResult> {
	const chat = await loadGroupChat(scope.groupChatId);
	if (!chat) throw new VoiceDispatchError('This group chat no longer exists.');
	if (!prompt) throw new VoiceDispatchError('There was nothing to send to the group chat.');
	if (signal?.aborted) throw new VoiceDispatchError('Voice session ended.');
	return new Promise<VoiceDispatchResult>((resolve, reject) => {
		const itemId = randomUUID();
		let sending = false;
		let delivered = false;
		let reply = '';
		const cleanup = () => {
			clearTimeout(timeout);
			groupChatEvents.off('message', onMessage);
			groupChatEvents.off('submission', onSubmission);
			groupChatEvents.off('state', onState);
			signal?.removeEventListener('abort', onAbort);
		};
		const fail = (message: string) => {
			cleanup();
			reject(new VoiceDispatchError(message));
		};
		const onAbort = () =>
			fail('Voice session ended. The submitted group chat message stays in its queue.');
		const onSubmission = (id: string, submittedId: string) => {
			if (id === chat.id && submittedId === itemId) sending = true;
		};
		const onMessage = (id: string, message: GroupChatMessage) => {
			if (id !== chat.id) return;
			if (sending && !delivered && message.from === 'user' && message.content === prompt)
				delivered = true;
			if (delivered && message.from === 'moderator') reply = message.content;
		};
		const onState = (id: string, state: GroupChatState) => {
			if (id !== chat.id || !delivered) return;
			// A delegation message is not the round's answer. Stop All must not read it as one.
			if (state === 'agent-working') reply = '';
			if (state !== 'idle') return;
			cleanup();
			resolve({
				groupChatId: chat.id,
				agentSessionId: chat.id,
				agentName: chat.name,
				tabId: chat.id,
				action: 'focused',
				promptSent: true,
				replyText: reply || 'The group chat round ended without a moderator reply.',
			});
		};
		// Matches the room's maximum supervised turn. A stopped voice session cancels only this listener.
		const timeout = setTimeout(
			() => fail('The group chat is still working. Its reply remains in the chat.'),
			30 * 60_000
		);
		groupChatEvents.on('message', onMessage);
		groupChatEvents.on('submission', onSubmission);
		groupChatEvents.on('state', onState);
		signal?.addEventListener('abort', onAbort, { once: true });
		void submitMessage(chat.id, {
			id: itemId,
			timestamp: Date.now(),
			text: prompt,
			readOnlyMode: scope.readOnly,
		})
			.then((state) => {
				if (state.paused) fail('The group chat queue is paused. Resume it in Group Chat.');
				else onAccepted?.();
			})
			.catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
	});
}
