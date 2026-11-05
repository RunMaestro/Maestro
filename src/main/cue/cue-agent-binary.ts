/**
 * Which binary a Cue prompt run executes.
 *
 * Same precedence a tab spawn uses (`process:spawn`): the agent's OWN custom
 * path, then the provider-level one (Settings -> Agents), then local detection
 * or the remote's bare binary name. Cue used to skip the first rung, so an
 * agent pinned to a specific binary ran the provider's binary whenever Cue
 * drove it: the same agent executed two programs depending on the turn source.
 *
 * Locally, an agent's own path is checked before it is used, exactly as the tab
 * spawn does, and an invalid one falls through with a warning rather than
 * failing the run. Over SSH, explicit paths are preserved as supplied: they
 * name files on the remote host, so neither local validation nor detection
 * applies. Without an override the launch plan uses the remote's bare binary.
 */

import { checkCustomPath } from '../../shared/maestro-lib/launch/path-prober';

export interface ResolveCueAgentBinaryInput {
	/** The agent's own custom path (`Session.customPath`). */
	sessionCustomPath?: string;
	/** The provider-level custom path from the agent configs store. */
	providerCustomPath?: string;
	/** True when the agent runs on an SSH remote. */
	sshEnabled: boolean;
	/** Local detector result, or undefined when unavailable. Never called for SSH. */
	getDetectedPath: () => Promise<string | undefined>;
	onWarn?: (message: string) => void;
	/** Injected by tests. */
	checkPath?: typeof checkCustomPath;
}

/**
 * Resolve the selected host's binary for a Cue run, or undefined to let the spawn
 * builder fall back to the provider's bare command name.
 */
export async function resolveCueAgentBinary(
	input: ResolveCueAgentBinaryInput
): Promise<string | undefined> {
	const { sessionCustomPath, providerCustomPath, sshEnabled } = input;

	if (sshEnabled) return sessionCustomPath || providerCustomPath || undefined;

	if (sessionCustomPath) {
		const detection = await (input.checkPath ?? checkCustomPath)(sessionCustomPath);
		if (detection.exists && detection.path) return detection.path;
		input.onWarn?.(
			`Ignoring invalid custom path "${sessionCustomPath}" for this agent; using the provider's binary`
		);
	}

	if (providerCustomPath) return providerCustomPath;
	return input.getDetectedPath();
}
