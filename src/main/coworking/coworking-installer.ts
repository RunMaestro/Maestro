/**
 * Coworking installer orchestrator. Public surface for the Settings UI:
 *   - `getInstallStatus()` - list per-agent install state for the panel
 *   - `installFor(agentId)` - write the user-level MCP config entry
 *   - `uninstallFor(agentId)` - remove it
 *   - `installForAll()` / `uninstallForAll()` - convenience for the
 *     "Install for all detected agents" button
 *
 * Knows how to build the `CoworkingMcpServerSpec` from the bundled-script
 * path + bridge socket env var.
 */

import { logger } from '../utils/logger';
import { getBridgeEnvVar } from './coworking-bridge';
import { buildMcpServerSpec, ensureCoworkingServerScript } from './coworking-server-paths';
import type { CoworkingInstallStatus, CoworkingMcpServerSpec } from './coworking-types';
import { COWORKING_SUPPORTED_AGENTS, getInstaller } from './installers';

const LOG_CTX = '[Coworking][Installer]';

/** Build the spec that strategies write into agent config files. */
async function buildSpec(): Promise<CoworkingMcpServerSpec> {
	await ensureCoworkingServerScript(); // refresh the bundled script if needed
	const env = getBridgeEnvVar();
	return await buildMcpServerSpec({ [env.name]: env.value });
}

/** List install status for every supported agent. */
export async function getInstallStatus(): Promise<CoworkingInstallStatus[]> {
	const out: CoworkingInstallStatus[] = [];
	for (const agentId of COWORKING_SUPPORTED_AGENTS) {
		const inst = getInstaller(agentId);
		if (!inst) continue;
		let installed = false;
		try {
			installed = await inst.isInstalled();
		} catch (err) {
			logger.warn(
				`${LOG_CTX} isInstalled(${agentId}) failed: ${err instanceof Error ? err.message : String(err)}`,
				'Coworking'
			);
		}
		out.push({ agentId, configPath: inst.configPath(), installed });
	}
	return out;
}

/** Install for a single agent. Idempotent. Throws on filesystem failure. */
export async function installFor(agentId: string): Promise<void> {
	const inst = getInstaller(agentId);
	if (!inst) throw new Error(`Coworking installer: unsupported agent '${agentId}'`);
	const spec = await buildSpec();
	await inst.install(spec);
	logger.info(`${LOG_CTX} installed for ${agentId} at ${inst.configPath()}`, 'Coworking');
}

/** Uninstall for a single agent. Idempotent. */
export async function uninstallFor(agentId: string): Promise<void> {
	const inst = getInstaller(agentId);
	if (!inst) throw new Error(`Coworking installer: unsupported agent '${agentId}'`);
	await inst.uninstall();
	logger.info(`${LOG_CTX} uninstalled for ${agentId}`, 'Coworking');
}

/**
 * Install for all supported agents. Returns per-agent results so the UI can
 * surface partial failures. Continues past errors instead of aborting.
 */
export async function installForAll(): Promise<
	Array<{ agentId: string; ok: boolean; error?: string }>
> {
	const spec = await buildSpec();
	const out: Array<{ agentId: string; ok: boolean; error?: string }> = [];
	for (const agentId of COWORKING_SUPPORTED_AGENTS) {
		const inst = getInstaller(agentId);
		if (!inst) continue;
		try {
			await inst.install(spec);
			out.push({ agentId, ok: true });
		} catch (err) {
			out.push({ agentId, ok: false, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return out;
}
