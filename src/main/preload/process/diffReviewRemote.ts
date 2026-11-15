import { ipcRenderer } from 'electron';
import type {
	DiffReviewCommandRequest,
	DiffReviewCommandResult,
} from '../../../shared/diffReviewCommands';

/**
 * Remote Git Diff review verbs (`maestro-cli diff-review`), answered by the
 * renderer that holds the pending review comments.
 */
export function createDiffReviewRemoteApi() {
	return {
		/**
		 * Subscribe to a remote diff review verb. A round trip rather than a
		 * fire-and-forget send: every verb answers the caller with the comment it
		 * added or removed, the pending list, or what the agent was sent.
		 */
		onRemoteDiffReviewCommand: (
			callback: (request: DiffReviewCommandRequest, responseChannel: string) => void
		): (() => void) => {
			const handler = (_: unknown, request: DiffReviewCommandRequest, responseChannel: string) =>
				callback(request, responseChannel);
			ipcRenderer.on('remote:diffReviewCommand', handler);
			return () => ipcRenderer.removeListener('remote:diffReviewCommand', handler);
		},

		sendRemoteDiffReviewCommandResponse: (
			responseChannel: string,
			result: DiffReviewCommandResult
		): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}
