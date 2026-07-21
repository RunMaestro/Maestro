/**
 * Self-destruct rewriter for `time.once` Cue subscriptions.
 *
 * Reads the project's canonical `cue.yaml`, removes the subscription with the
 * given name from the top-level `subscriptions` array, and writes the result
 * atomically. The engine's YAML file watcher picks up the change and reloads
 * the config naturally — callers should NOT trigger a reload themselves.
 *
 * Preserves the original file's leading comment block (the `# Pipeline: …`
 * header most cue.yaml files carry) so the rewrite doesn't strip pipeline
 * metadata that lives only in YAML comments.
 *
 * Returns a structured result so the completion path can log a clear reason
 * when a self-destruct fails (the YAML is gone, the sub is already absent,
 * etc.) without crashing the run.
 */

import { createCueConfigMutationService } from './config/cue-config-mutation-service';
import { resolveCueConfigPath } from './config/cue-config-repository';

export interface SelfDestructResult {
	removed: boolean;
	reason?: string;
}

const mutations = createCueConfigMutationService();

export async function removeSubscriptionFromYaml(
	projectRoot: string,
	subscriptionName: string
): Promise<SelfDestructResult> {
	try {
		if (!resolveCueConfigPath(projectRoot)) {
			return { removed: false, reason: 'cue.yaml not found' };
		}
		const removed = await mutations.removeSubscription(projectRoot, subscriptionName);
		if (!removed) {
			return { removed: false, reason: `subscription "${subscriptionName}" not present` };
		}
		console.log(`[CUE] self-destruct removed "${subscriptionName}" from .maestro/cue.yaml`);
		return { removed: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith('Cue YAML parse failed')) {
			return { removed: false, reason: message.replace('Cue YAML', 'yaml') };
		}
		if (message.includes('Config must have a "subscriptions" array')) {
			return { removed: false, reason: 'subscriptions array missing' };
		}
		if (/^E[A-Z]+:/.test(message)) {
			return { removed: false, reason: `read failed: ${message}` };
		}
		return { removed: false, reason: `write failed: ${message}` };
	}
}
