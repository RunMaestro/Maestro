/**
 * Where a provider's binary is on this machine.
 *
 * One answer for every launch that runs a provider locally with no desktop to detect it: a chat
 * turn (`loadTurnContext`), and a group chat or consult turn (`resolveProviderAgent`). The order is
 * the desktop's: the agent's own custom path, then the provider's custom path from Settings, then
 * the binary on PATH or in a known install directory. A custom path that does not exist is
 * ignored with a warning rather than failing the turn, because the next candidate may be fine.
 */

import { logger } from '../host';
import {
	checkBinaryExists,
	checkCustomPath,
	type BinaryDetectionResult,
} from '../launch/path-prober';
import type { AgentDefinition } from '../providers/definitions';

const LOG_CONTEXT = '[ProviderBinary]';

export type BinaryProbe = (
	binaryName: string,
	customPath?: string
) => Promise<BinaryDetectionResult>;

/** The probe a host that supplies none gets: the real filesystem and PATH. */
export const defaultBinaryProbe: BinaryProbe = (binaryName, customPath) =>
	customPath ? checkCustomPath(customPath) : checkBinaryExists(binaryName);

export interface ProviderBinarySearch {
	/** The agent's own binary override. */
	agentCustomPath?: string;
	/** The provider's binary override from Settings -> Agents. */
	providerCustomPath?: string;
	/** The agent runs on an SSH remote: its own binary runs there, so nothing is probed here. */
	sshEnabled: boolean;
	probe?: BinaryProbe;
}

/** The command to run, or `undefined` when the provider is not installed on this machine. */
export async function locateProviderBinary(
	definition: Pick<AgentDefinition, 'binaryName'>,
	search: ProviderBinarySearch
): Promise<string | undefined> {
	if (search.sshEnabled) return search.agentCustomPath || definition.binaryName;

	const probe = search.probe ?? defaultBinaryProbe;
	let detected: BinaryDetectionResult | undefined;
	if (search.agentCustomPath) {
		detected = await probe(definition.binaryName, search.agentCustomPath);
		if (!detected.exists || !detected.path) {
			logger.warn(
				`Ignoring invalid local custom path for ${definition.binaryName}: ${search.agentCustomPath}`,
				LOG_CONTEXT
			);
			detected = undefined;
		}
	}
	if (!detected && search.providerCustomPath) {
		const viaProvider = await probe(definition.binaryName, search.providerCustomPath);
		if (viaProvider.exists && viaProvider.path) detected = viaProvider;
	}
	if (!detected) {
		const onPath = await probe(definition.binaryName);
		if (onPath.exists && onPath.path) detected = onPath;
	}
	return detected?.path;
}
