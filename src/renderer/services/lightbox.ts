/**
 * lightbox - open and close the image lightbox from anywhere in a window.
 *
 * The lightbox is per window: each renderer has its own modal store and draws
 * its own `LightboxModal`. The app window's modal handlers and a tab window's
 * modal host both open and close it through these, so the two cannot disagree
 * on what the lightbox remembers (its carousel, where the image came from, and
 * whether it may be deleted).
 */

import { getModalActions } from '../stores/modalStore';
import { useGroupChatStore } from '../stores/groupChatStore';

/**
 * Show `image` in the lightbox, with `contextImages` as the carousel. Only a
 * staged image (one the user is about to send) can be deleted from it. `null`
 * closes it.
 */
export function openLightbox(
	image: string | null,
	contextImages?: string[],
	source: 'staged' | 'history' = 'history'
): void {
	const { activeGroupChatId } = useGroupChatStore.getState();
	const actions = getModalActions();
	// setLightboxImage opens the modal - must be called first so that
	// subsequent updateModalData calls (isGroupChat, allowDelete) find an active modal.
	actions.setLightboxImage(image);
	actions.setLightboxIsGroupChat(activeGroupChatId !== null);
	actions.setLightboxAllowDelete(source === 'staged');
	actions.setLightboxImages(contextImages || []);
	actions.setLightboxSource(source);
}

/** Close the lightbox and forget its carousel. */
export function closeLightbox(): void {
	const actions = getModalActions();
	actions.setLightboxImage(null);
	actions.setLightboxImages([]);
	actions.setLightboxSource('history');
	actions.setLightboxIsGroupChat(false);
	actions.setLightboxAllowDelete(false);
}
