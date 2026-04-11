// Cue trigger command - manually trigger a Cue subscription by name

import { withMaestroClient } from '../services/maestro-client';

interface CueTriggerOptions {
	prompt?: string;
	json?: boolean;
}

export async function cueTrigger(
	subscriptionName: string,
	options: CueTriggerOptions
): Promise<void> {
	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{
				type: string;
				success: boolean;
				subscriptionName: string;
				error?: string;
			}>(
				{
					type: 'trigger_cue_subscription',
					subscriptionName,
					prompt: options.prompt,
				},
				'trigger_cue_subscription_result'
			);
		});

		if (options.json) {
			console.log(
				JSON.stringify({
					type: 'trigger_result',
					success: result.success,
					subscriptionName,
					...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
					...(result.error ? { error: result.error } : {}),
				})
			);
			if (!result.success) {
				process.exitCode = 1;
			}
		} else if (result.success) {
			console.log(
				`Triggered Cue subscription "${subscriptionName}"${options.prompt ? ' with custom prompt' : ''}`
			);
		} else {
			console.error(
				`Subscription "${subscriptionName}" not found or could not be triggered${
					result.error ? `: ${result.error}` : ''
				}`
			);
			process.exit(1);
		}
	} catch (error) {
		if (options.json) {
			console.log(
				JSON.stringify({
					type: 'error',
					error: error instanceof Error ? error.message : String(error),
				})
			);
		} else {
			console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		}
		process.exit(1);
	}
}
