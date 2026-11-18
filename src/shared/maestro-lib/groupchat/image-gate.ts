/**
 * The image gate for a group chat's moderator.
 *
 * A room keeps its images on disk and tells the moderator to read them, so the
 * moderator's provider has to be able to read images. The renderer refuses to
 * stage images in that case, but the message can still reach a send path with
 * images attached (a capability lookup that was loading, a stale client, or a
 * host that does not run the renderer gate). Every send path asks this rule at
 * send time, so a moderator switch cannot carry old images into a provider that
 * cannot read them.
 *
 * Only images are gated. A missing chat, a missing moderator id, an unknown
 * provider, or a capability lookup that has not settled all allow, preserving
 * the behavior that predates the gate. The provider id decides; custom path,
 * arguments, environment, model, and SSH settings do not change what a provider
 * can read.
 */

import { agentIdCanReadImages } from '../providers/capabilities';

export const MODERATOR_CANNOT_READ_IMAGES_REASON =
	"This room's moderator can't read images. Remove this message and send it again without images.";

export interface ModeratorImageGateChat {
	moderatorAgentId?: string | null;
}

/**
 * The refusal message for an image-bearing send, or null when it may proceed.
 */
export function moderatorImagesRefusal(
	chat: ModeratorImageGateChat | null | undefined,
	images: readonly string[] | undefined
): string | null {
	if (!images?.length) return null;
	if (!chat) return null;
	return agentIdCanReadImages(chat.moderatorAgentId) ? null : MODERATOR_CANNOT_READ_IMAGES_REASON;
}
