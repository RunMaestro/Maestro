/**
 * Read-only prerequisites for a future local recovery launch binding.
 *
 * A local launch plan, host file access and SHELL do not establish where a
 * provider's tools run or what its sandbox can see. This returns host evidence
 * only, deliberately incompatible with LocalRecoveryCapability. The launch
 * owner must separately prove the actual tool environment and retain/revoke a
 * binding over its entire lifecycle before any recovery command can be emitted.
 */
import * as fs from 'fs';
import * as os from 'os';
import { canonicalJson } from '../../../shared/canonicalJson';
import { readCliServerInfoFrom } from '../../../shared/cli-server-discovery';
import { getBasename, isAbsolutePath } from '../../../shared/formatters';
import type { AgentLaunchPlan } from '../../../shared/maestro-lib/launch/launch-plan';
import { isWindows } from '../../../shared/platformDetection';
import { resolveBundledCliPathSync } from '../../maestro-cli-manager';
import { resolvePathInRealRoot } from '../../utils/real-path-containment';
import { isTcpPort } from '../../utils/tcp-port';
import { localModelsDataDir } from '../paths';
import type { LocalRecoveryCapability } from './compress';
import { contentHash, TOKEN_PROXY_CACHE_DIRNAME } from './compression-cache';

export async function inspectTokenProxyRecoveryHost(
	plan: AgentLaunchPlan,
	/** The final child environment, not a stored agent's environment overrides. */
	effectiveEnv: NodeJS.ProcessEnv
): Promise<
	| (Pick<LocalRecoveryCapability, 'runtimePath' | 'cliPath' | 'dataDir'> & {
			kind: 'host-preflight-only';
			shellPath: string;
			/** Fingerprint of the inspected host prerequisites, not tool/context identity. */
			hostScope: string;
	  })
	| null
> {
	if (isWindows() || plan.target.kind !== 'local' || !plan.gateway || plan.runOn) return null;
	// Reject, never sanitize or change, environments that can redirect the CLI
	// loader or shell startup. Cue's custom-var sanitizer has a different policy:
	// this is the complete effective environment, including PATH/HOME/SHELL.
	if (
		Object.entries(effectiveEnv).some(
			([name, value]) =>
				value !== undefined &&
				value !== '' &&
				/^(?:NODE_(?:OPTIONS|PATH)|BASH_ENV|ENV|ZDOTDIR|LD_.*|DYLD_.*)$/.test(name)
		)
	)
		return null;
	const shellPath = effectiveEnv.SHELL;
	if (
		!shellPath ||
		!['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/sh', '/usr/bin/bash', '/usr/bin/zsh'].includes(
			shellPath
		)
	)
		return null;
	try {
		const dataDir = localModelsDataDir();
		const cliPath = resolveBundledCliPathSync();
		const runtimePath = process.execPath;
		if (
			!cliPath ||
			getBasename(cliPath) !== 'maestro-cli.js' ||
			![dataDir, cliPath, runtimePath].every(
				(value) =>
					value.length <= 2048 &&
					value.startsWith('/') &&
					isAbsolutePath(value) &&
					!/[\x00-\x1f\x7f]/.test(value)
			) ||
			(effectiveEnv.MAESTRO_USER_DATA !== undefined && effectiveEnv.MAESTRO_USER_DATA !== dataDir)
		)
			return null;
		const [archive, discovery] = await Promise.all([
			resolvePathInRealRoot(dataDir, TOKEN_PROXY_CACHE_DIRNAME),
			resolvePathInRealRoot(dataDir, 'cli-server.json'),
		]);
		if (archive.kind !== 'inside' || discovery.kind !== 'inside') return null;
		const bridge = readCliServerInfoFrom(dataDir);
		if (
			!bridge ||
			bridge.pid !== process.pid ||
			!isTcpPort(bridge.port) ||
			!Number.isSafeInteger(bridge.startedAt) ||
			bridge.startedAt <= 0 ||
			!bridge.token
		)
			return null;
		// Both snapshots resolve the original names again, so retargeted links or
		// replaced files during inspection make the prerequisites unavailable.
		const paths = [dataDir, archive.realPath, runtimePath, cliPath, shellPath, discovery.realPath];
		const snapshot = async () => {
			const results = await Promise.allSettled(
				paths.map(async (filePath, index) => {
					const realPath = await fs.promises.realpath(filePath);
					if (
						realPath.length > 2048 ||
						!realPath.startsWith('/') ||
						!isAbsolutePath(realPath) ||
						/[\x00-\x1f\x7f]/.test(realPath)
					)
						throw new Error('unsupported host path');
					const stat = await fs.promises.stat(realPath, { bigint: true });
					const directory = index < 2;
					if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error('wrong file kind');
					await fs.promises.access(
						realPath,
						fs.constants.R_OK | (directory || index === 2 || index === 4 ? fs.constants.X_OK : 0)
					);
					return {
						realPath,
						device: String(stat.dev),
						inode: String(stat.ino),
						// Directory mtimes change when the cache gains an original.
						...(directory ? {} : { size: String(stat.size), modified: String(stat.mtimeNs) }),
					};
				})
			);
			return results.map((result) => {
				if (result.status === 'rejected') throw result.reason;
				return result.value;
			});
		};
		const before = await snapshot();
		const after = await snapshot();
		const [archiveAfter, discoveryAfter] = await Promise.all([
			resolvePathInRealRoot(dataDir, TOKEN_PROXY_CACHE_DIRNAME),
			resolvePathInRealRoot(dataDir, 'cli-server.json'),
		]);
		const bridgeAfter = readCliServerInfoFrom(dataDir);
		if (
			canonicalJson(before) !== canonicalJson(after) ||
			canonicalJson(archive) !== canonicalJson(archiveAfter) ||
			canonicalJson(discovery) !== canonicalJson(discoveryAfter) ||
			localModelsDataDir() !== dataDir ||
			resolveBundledCliPathSync() !== cliPath ||
			!bridgeAfter ||
			bridgeAfter.pid !== bridge.pid ||
			bridgeAfter.port !== bridge.port ||
			bridgeAfter.startedAt !== bridge.startedAt ||
			bridgeAfter.token !== bridge.token ||
			bridgeAfter.cliSecret !== bridge.cliSecret ||
			getBasename(before[3].realPath) !== 'maestro-cli.js'
		)
			return null;
		return {
			kind: 'host-preflight-only',
			runtimePath: before[2].realPath,
			cliPath: before[3].realPath,
			dataDir,
			shellPath: before[4].realPath,
			hostScope: contentHash(
				canonicalJson({
					version: 1,
					hostname: os.hostname(),
					uid: process.getuid?.(),
					paths: before,
				})
			),
		};
	} catch {
		// Missing files, permissions and unsupported host inspection are absence
		// of evidence. Never start a listener, discover executables or run a tool.
		return null;
	}
}
