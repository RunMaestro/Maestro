// List models command - the models a provider offers, as the desktop's model
// pickers see them.
//
// Discovery runs in the desktop (it shells out to the provider's CLI and
// caches the result there), so this asks the running app. `--refresh` is the
// CLI half of the pickers' Refresh button: it bypasses the cache, and the new
// list is pushed to every picker already on screen.

import { withMaestroClient } from '../services/maestro-client';
import { failCommand } from '../services/session-command';

interface ListModelsOptions {
	refresh?: boolean;
	sshRemote?: string;
	json?: boolean;
}

export async function listModels(provider: string, options: ListModelsOptions): Promise<void> {
	let result: {
		success: boolean;
		error?: string;
		agentId?: string;
		sshRemoteId?: string | null;
		models?: string[];
	};
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand(
				{
					type: 'list_agent_models',
					agentId: provider,
					refresh: options.refresh === true,
					...(options.sshRemote ? { sshRemoteId: options.sshRemote } : {}),
				},
				'list_agent_models_result'
			)
		);
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
	if (!result.success) failCommand(result.error || 'Listing models failed', options.json);

	// '' is the "agent default" sentinel some providers report; it is not a model.
	const models = (result.models ?? []).filter((model) => model !== '');
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				provider: result.agentId ?? provider,
				sshRemoteId: result.sshRemoteId ?? null,
				refreshed: options.refresh === true,
				models,
			})
		);
		return;
	}
	if (models.length === 0) {
		console.log(`No models discovered for ${provider}.`);
		return;
	}
	// One model per line so the output greps and pipes cleanly.
	for (const model of models) console.log(model);
}
