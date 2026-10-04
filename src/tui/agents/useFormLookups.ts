import { useEffect, useState } from 'react';
import type { MaestroClient, ProviderInfo, SshRemoteConfig } from '../../shared/maestro-lib';

export interface FormLookups {
	providers: ProviderInfo[];
	sshRemotes: SshRemoteConfig[];
	/** The chosen provider's model ids. Empty until it answers, or when it reports none. */
	models: string[];
	/** The first provider list has not come back yet. */
	loading: boolean;
}

const EMPTY: FormLookups = { providers: [], sshRemotes: [], models: [], loading: false };

/**
 * What the agent form asks the host while it is open: the SSH remotes, the
 * installed providers (probed on the chosen remote, since "installed" depends
 * on where the agent runs), and the chosen provider's models. A failed lookup
 * leaves the last answer in place, so a flaky host never empties a picker the
 * person is already using.
 */
export function useFormLookups(
	client: MaestroClient | undefined,
	open: boolean,
	providerId: string,
	sshRemoteId: string
): FormLookups {
	const [providers, setProviders] = useState<ProviderInfo[] | undefined>(undefined);
	const [sshRemotes, setSshRemotes] = useState<SshRemoteConfig[]>([]);
	const active = open && client !== undefined;

	useEffect(() => {
		if (!active || !client) return;
		let cancelled = false;
		void client.settings.sshRemotes().then((result) => {
			if (!cancelled && result.ok) setSshRemotes(result.value);
		});
		return () => {
			cancelled = true;
		};
	}, [active, client]);

	useEffect(() => {
		if (!active || !client) return;
		let cancelled = false;
		void client.providers.list(sshRemoteId ? { sshRemoteId } : undefined).then((result) => {
			if (!cancelled && result.ok) setProviders(result.value);
		});
		return () => {
			cancelled = true;
		};
	}, [active, client, sshRemoteId]);

	const models = useProviderModels(client, active, providerId, sshRemoteId);

	if (!active) return EMPTY;
	return {
		providers: providers ?? [],
		sshRemotes,
		models,
		loading: providers === undefined,
	};
}

/**
 * One provider's model ids, asked while `active`. A list for a provider the
 * person has since left would be wrong under the new one, so an answer only
 * counts for the provider and remote it was asked about. A failed read leaves
 * the last answer in place, and a provider that reports none gives `[]`.
 */
export function useProviderModels(
	client: MaestroClient | undefined,
	active: boolean,
	providerId: string,
	sshRemoteId: string
): string[] {
	const [models, setModels] = useState<{ key: string; list: string[] }>({ key: '', list: [] });
	useEffect(() => {
		if (!active || !client || !providerId) return;
		let cancelled = false;
		const key = `${providerId}@${sshRemoteId}`;
		void client.providers
			.models(providerId, sshRemoteId ? { sshRemoteId } : undefined)
			.then((result) => {
				if (!cancelled && result.ok) setModels({ key, list: result.value });
			});
		return () => {
			cancelled = true;
		};
	}, [active, client, providerId, sshRemoteId]);
	return active && models.key === `${providerId}@${sshRemoteId}` ? models.list : [];
}
