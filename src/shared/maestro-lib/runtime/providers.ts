/**
 * `providers.list` without a desktop: which providers this machine can run.
 *
 * The desktop answers from its detector; a runtime has none, so it asks the same
 * two library questions the detector asks: is the binary on the search path, or,
 * when the user set a provider-level custom path in Settings -> Agents, is that
 * file runnable. Local only: an SSH remote needs the desktop's probing, which
 * Phase 6 brings through the run layer.
 *
 * Probing shells out (`which`, a stat per candidate), so the answer is cached for
 * a minute and concurrent callers share one probe.
 */

import type { ProviderInfo } from '../client/types';
import {
	checkBinaryExists,
	checkCustomPath,
	type BinaryDetectionResult,
} from '../launch/path-prober';
import { getVisibleAgentDefinitions } from '../providers/definitions';

export const PROVIDER_CACHE_MS = 60_000;

export interface ProviderListerOptions {
	/** Provider id to the custom path the user set for it, when there is one. Read fresh on each probe. */
	readCustomPaths(): Record<string, string | undefined>;
	/** Default: `checkCustomPath` for a custom path, else `checkBinaryExists`. */
	probe?(binaryName: string, customPath?: string): Promise<BinaryDetectionResult>;
	now?(): number;
	ttlMs?: number;
}

const defaultProbe = (binaryName: string, customPath?: string): Promise<BinaryDetectionResult> =>
	customPath ? checkCustomPath(customPath) : checkBinaryExists(binaryName);

export function createProviderLister(
	options: ProviderListerOptions
): () => Promise<ProviderInfo[]> {
	const probe = options.probe ?? defaultProbe;
	const now = options.now ?? Date.now;
	const ttlMs = options.ttlMs ?? PROVIDER_CACHE_MS;

	let cached: { at: number; providers: ProviderInfo[] } | undefined;
	let inFlight: Promise<ProviderInfo[]> | undefined;

	async function probeAll(): Promise<ProviderInfo[]> {
		const customPaths = options.readCustomPaths();
		const definitions = getVisibleAgentDefinitions().filter(
			(definition) => definition.id !== 'terminal'
		);
		return Promise.all(
			definitions.map(async (definition): Promise<ProviderInfo> => {
				const customPath = customPaths[definition.id]?.trim() || undefined;
				let detected: BinaryDetectionResult;
				try {
					detected = await probe(definition.binaryName, customPath);
				} catch (error) {
					return {
						id: definition.id,
						name: definition.name,
						available: false,
						unavailableReason: `Probing failed: ${error instanceof Error ? error.message : String(error)}`,
					};
				}
				if (detected.exists) {
					return {
						id: definition.id,
						name: definition.name,
						available: true,
						...(detected.path ? { path: detected.path } : {}),
					};
				}
				return {
					id: definition.id,
					name: definition.name,
					available: false,
					unavailableReason: customPath
						? `The custom path ${customPath} is not an executable file.`
						: `${definition.binaryName} was not found on the search path.`,
				};
			})
		);
	}

	return async () => {
		if (cached && now() - cached.at < ttlMs) return cached.providers.map((info) => ({ ...info }));
		inFlight ??= probeAll()
			.then((providers) => {
				cached = { at: now(), providers };
				return providers;
			})
			.finally(() => {
				inFlight = undefined;
			});
		return (await inFlight).map((info) => ({ ...info }));
	};
}
