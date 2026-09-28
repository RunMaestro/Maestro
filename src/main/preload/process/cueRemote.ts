import { ipcRenderer } from 'electron';

export function createCueRemoteApi() {
	return {
		/**
		 * Listen for remote trigger Cue subscription requests (from web/CLI clients)
		 */
		onRemoteTriggerCueSubscription: (
			callback: (
				subscriptionName: string,
				prompt: string | undefined,
				responseChannel: string,
				sourceAgentId: string | undefined
			) => void
		): (() => void) => {
			const handler = (
				_: unknown,
				subscriptionName: string,
				prompt: string | undefined,
				responseChannel: string,
				sourceAgentId: string | undefined
			) => {
				try {
					Promise.resolve(callback(subscriptionName, prompt, responseChannel, sourceAgentId)).catch(
						(error) => {
							console.error('[Cue] Remote trigger callback failed:', error);
							ipcRenderer.send(responseChannel, false);
						}
					);
				} catch (error) {
					console.error('[Cue] Remote trigger callback threw:', error);
					ipcRenderer.send(responseChannel, false);
				}
			};
			ipcRenderer.on('remote:triggerCueSubscription', handler);
			return () => ipcRenderer.removeListener('remote:triggerCueSubscription', handler);
		},

		/**
		 * Send response for remote trigger Cue subscription
		 */
		sendRemoteTriggerCueSubscriptionResponse: (responseChannel: string, result: unknown): void => {
			ipcRenderer.send(responseChannel, result);
		},
	};
}
