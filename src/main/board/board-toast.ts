/**
 * User-facing toast payload for a terminal Board card transition (Board I1).
 *
 * A finished (or blocked) card surfaces to the user as a toast over the SAME
 * `remote:notifyToast` relay Cue's notify action uses. The only durable trace of
 * a pooled run is its `workerAgentId`, so - mirroring the Cue precedent in
 * `src/main/cue/cue-notify-bridge.ts` - the toast body is made a click-to-jump
 * affordance onto that worker agent whenever the run recorded one. Legacy
 * profile-based runs have no `workerAgentId` and keep the non-clickable toast.
 *
 * Pure and Electron-free so it can be unit-tested directly; `notifyCard` in
 * `src/main/index.ts` hands the result straight to `safeSend`.
 */

import type { CardNotification } from './board-dispatcher';

/**
 * Shape accepted by the renderer's `onRemoteNotifyToast` bridge. Only the fields
 * the Board emits are modeled here; `color` is one of the 5 canonical Toast
 * colors (Board uses `green` for done, `yellow` for review, `red` for blocked).
 */
export interface BoardCardToastPayload {
	title: string;
	message: string;
	color: 'green' | 'yellow' | 'orange' | 'red' | 'theme';
	dismissible: boolean;
	sourceAgent: string;
	sessionId?: string;
	clickAction?: { kind: 'jump-session'; sessionId: string };
}

/**
 * Build the toast for a done/review/blocked card. Both `blocked` and `review`
 * need a human, so their toasts are sticky (`dismissible`); a done card
 * auto-dismisses. Review is yellow rather than red: the card did not fail, it is
 * waiting for approval. When the run was pooled the payload also carries
 * `sessionId` + a `jump-session` `clickAction` onto the worker agent
 * (`sessionId` additionally drives the legacy fallback and metadata resolution
 * in `useRemoteIntegration.ts`).
 */
export function buildBoardCardToastPayload(event: CardNotification): BoardCardToastPayload {
	const blocked = event.kind === 'blocked';
	const review = event.kind === 'review';
	// Phase 4: an isolated card's output lives on its own branch, which nothing
	// merges automatically - name it so the user can find it.
	const branchNote = event.worktreeBranch ? ` (branch ${event.worktreeBranch})` : '';
	const heading = blocked ? 'Card blocked' : review ? 'Card needs review' : 'Card done';
	const fallback = blocked
		? 'No reason reported.'
		: review
			? 'Waiting for human approval.'
			: 'Run completed.';
	return {
		title: `${heading}: ${event.cardTitle}`,
		message: (event.detail || fallback) + branchNote,
		color: blocked ? 'red' : review ? 'yellow' : 'green',
		dismissible: blocked || review,
		sourceAgent: 'Board',
		...(event.workerAgentId
			? {
					sessionId: event.workerAgentId,
					clickAction: {
						kind: 'jump-session' as const,
						sessionId: event.workerAgentId,
					},
				}
			: {}),
	};
}
