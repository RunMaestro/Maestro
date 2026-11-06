/** Host-owned spawn identity. Resolving identity confers no delegation or plugin policy. */
import type { CallerRunIdentity } from '../../shared/agentDelegation';
import { PluginAuthorityError } from '../plugins/plugin-authority';
import {
	PluginToolRunIdentity,
	type PluginToolCallerContext,
	type PluginToolRunAuthority,
} from '../plugins/plugin-tool-run-identity';
import { PluginToolRunProofFiles } from '../plugins/plugin-tool-run-proof-file';

export interface HostCallerRun extends PluginToolRunAuthority {
	readonly run: Readonly<CallerRunIdentity>;
}

/** One instance per host, independent of the Plugins Encore feature and manager. */
export class HostCallerRuns {
	private readonly identities = new PluginToolRunIdentity();
	private readonly clients = new WeakMap<object, PluginToolCallerContext>();
	private readonly runClients = new WeakSet<object>();
	private files?: PluginToolRunProofFiles;

	/** Host spawn only; the base must be the host's canonical private user-data directory. */
	issue(binding: CallerRunIdentity, authority: PluginToolRunAuthority, privateBase: string) {
		this.files ??= PluginToolRunProofFiles.provision(this.identities, privateBase);
		return this.files.create(binding.agentId, authority, null, binding);
	}

	/** Called only at authenticated CLI upgrade. Neither `cli` nor loopback is authentication. */
	bind(client: { cliAuthenticated?: boolean }, proof: unknown): void {
		this.clients.delete(client);
		if (client.cliAuthenticated !== true) throw new Error('CallerRunUnavailable');
		try {
			const context = this.identities.resolveVerified(proof);
			if (!context.run) throw new Error('CallerRunUnavailable');
			this.clients.set(client, context);
			this.runClients.add(client);
		} catch (error) {
			if (error instanceof PluginAuthorityError) throw new Error('CallerRunUnavailable');
			throw error;
		}
	}

	/** A revoked bound run must fail admission, never fall back to an ordinary human send. */
	isRunClient(client: object): boolean {
		return this.runClients.has(client);
	}

	/** Recheck on every admission, even for an already connected CLI. No wire IDs are read. */
	resolve(client: { cliAuthenticated?: boolean }): HostCallerRun | undefined {
		if (client.cliAuthenticated !== true) return undefined;
		const context = this.clients.get(client);
		if (!context?.run) return undefined;
		try {
			context.assertActive();
		} catch (error) {
			this.clients.delete(client);
			if (error instanceof PluginAuthorityError) return undefined;
			throw error;
		}
		return context as HostCallerRun;
	}

	stop(): void {
		this.identities.stop();
		this.files?.stop();
	}
}

export const hostCallerRuns = new HostCallerRuns();
