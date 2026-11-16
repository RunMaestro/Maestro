/**
 * HostedAgentSettingsModal - Edit Agent for an agent that runs on a Federation host.
 *
 * It is the same `EditAgentModal` a local agent opens, fed a view of the host's record, so every
 * field, picker, and check is the one a person already knows. The agent is presented as running
 * over SSH on the peer's remote (which it does): the working directory is then checked on that
 * remote and the model list is the one discovered there, not on this machine.
 *
 * Saving does not write the host directly. `saveHostedAgentSettings()` records the edit where
 * this machine keeps its copy (the lifted pointer, or the pending edits), and the settings sync
 * sends it: at once while the peer is connected, after it reconnects otherwise. The host then
 * broadcasts it to every conductor. What a host agent cannot take is not sent: SSH settings, the
 * maestro-p binary path, retry flags, extra directories, this machine's Local Models settings, and
 * a provider conversion (a switch is). `HOSTED_SAVE_ARGS` decides each save argument.
 *
 * Every field carries a badge saying where its value lives (`FederationFieldBadge`), from the
 * Federation tables. The editor shows the host's record, so its Peers picker lists the host's
 * agents and its rows name agents by their host ids.
 */

import { useCallback, useMemo } from 'react';
import type { Session, Theme } from '../../types';
import {
	readEditAgentSaveArgs,
	type EditAgentModalProps,
	type EditAgentSaveArgName,
} from '../NewInstanceModal/types';
import { EditAgentModal } from '../NewInstanceModal';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useHostedAgentSettingsStore } from '../../stores/hostedAgentSettingsStore';
import { saveHostedAgentSettings } from '../../services/liftedAgentSettingsSync';
import { mirrorKey, type MirroredPeer } from '../../../shared/maestro-lib/client/peer-mirror';
import {
	overlaySyncValues,
	type FederationFieldId,
	type StoredSyncValue,
} from '../../../shared/maestro-lib/agents/lift-settings-sync';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';
import { normalizePeerAgents } from '../../../shared/peerAgents';
import { FederationFieldsProvider, useFederationFieldsValue } from './FederationFieldBadge';

type SaveArgs = Parameters<EditAgentModalProps['onSave']>;

/**
 * What a hosted agent's save does with each Edit Agent save argument: `host` goes onto the host
 * record (and so through the settings sync), `here` names the Federation field it stays as on
 * this machine, `refused` fails the save, `none` is not a setting. A `Record` over every argument
 * name, so a new argument does not compile until it is decided here.
 */
export const HOSTED_SAVE_ARGS: Readonly<
	Record<
		EditAgentSaveArgName,
		| { kind: 'host'; fields: readonly FederationFieldId[] }
		| { kind: 'here'; field: FederationFieldId }
		| { kind: 'refused' }
		| { kind: 'none' }
	>
> = {
	sessionId: { kind: 'none' },
	name: { kind: 'host', fields: ['name'] },
	toolType: { kind: 'host', fields: ['provider'] },
	nudgeMessage: { kind: 'host', fields: ['nudgeMessage'] },
	newSessionMessage: { kind: 'host', fields: ['newSessionMessage'] },
	customPath: { kind: 'host', fields: ['customPath'] },
	customArgs: { kind: 'host', fields: ['customArgs'] },
	customEnvVars: { kind: 'host', fields: ['env'] },
	customModel: { kind: 'host', fields: ['model'] },
	customEffort: { kind: 'host', fields: ['effort'] },
	customContextWindow: { kind: 'host', fields: ['contextWindow'] },
	// Its working directory override is the agent's directory on the host; the rest is SSH.
	sessionSshRemoteConfig: { kind: 'host', fields: ['cwd'] },
	enableMaestroP: { kind: 'host', fields: ['enableMaestroP'] },
	maestroPPath: { kind: 'here', field: 'maestroPPath' },
	maestroPMode: { kind: 'host', fields: ['maestroPMode'] },
	retryOnAvailabilityErrors: { kind: 'here', field: 'retryOnAvailabilityErrors' },
	retryOnTokenExhaustion: { kind: 'here', field: 'retryOnTokenExhaustion' },
	additionalDirectories: { kind: 'here', field: 'additionalDirectories' },
	contextWindowSource: { kind: 'host', fields: ['contextWindowSource'] },
	customEnvVarsDisabled: { kind: 'here', field: 'customEnvVarsDisabled' },
	workingDirectory: { kind: 'host', fields: ['cwd'] },
	codexAutoResetOnExhaustion: { kind: 'here', field: 'codexAutoResetOnExhaustion' },
	codexTransport: { kind: 'host', fields: ['codexTransport'] },
	gatewayUrl: { kind: 'here', field: 'gatewayUrl' },
	runOn: { kind: 'here', field: 'runOn' },
	tierTargets: { kind: 'here', field: 'tierTargets' },
	peerGrants: {
		kind: 'host',
		fields: ['peerAgents', 'groupPeerAccess', 'worktreePeerAccess', 'peerDescription'],
	},
	acceptTranslationLimitations: { kind: 'none' },
	selectedUserResources: { kind: 'none' },
	migrationPlanId: { kind: 'none' },
	projectResourcesIntoRepo: { kind: 'none' },
	// A conversion rewrites this machine's provider files; the host has its own.
	convertProviderHistory: { kind: 'refused' },
	harnessControlMode: { kind: 'host', fields: ['harnessControlMode'] },
};

/**
 * The host's record as the editor reads it: an agent on the peer's SSH remote, with this
 * machine's pending edits already in it. Never enters `sessionStore`.
 */
export function hostedAgentEditSession(
	host: AgentRecord,
	peer: Pick<MirroredPeer, 'peerId' | 'remoteId'>,
	pending?: Record<string, StoredSyncValue>
): Session {
	const record = pending ? overlaySyncValues(host, pending) : host;
	const cwd = typeof record.cwd === 'string' ? record.cwd : '';
	return {
		...record,
		id: mirrorKey(peer.peerId, host.id),
		state: 'idle',
		cwd,
		projectRoot: cwd,
		fullPath: cwd,
		aiTabs: [],
		executionQueue: [],
		sessionSshRemoteConfig: { enabled: true, remoteId: peer.remoteId, workingDirOverride: cwd },
	} as unknown as Session;
}

/**
 * The editor's save arguments as the record they describe; unset values remove the field. Only
 * the `host` arguments of `HOSTED_SAVE_ARGS` are read.
 */
export function editedHostRecord(host: AgentRecord, args: SaveArgs): AgentRecord {
	const {
		name,
		toolType,
		nudgeMessage,
		newSessionMessage,
		customPath,
		customArgs,
		customEnvVars,
		customModel,
		customEffort,
		customContextWindow,
		sessionSshRemoteConfig: sshConfig,
		enableMaestroP,
		maestroPMode,
		contextWindowSource,
		workingDirectory,
		codexTransport,
		harnessControlMode,
		peerGrants,
	} = readEditAgentSaveArgs(args);
	const next: Record<string, unknown> = { ...host };
	const put = (key: string, value: unknown) => {
		if (value === undefined || value === null || value === '') delete next[key];
		else next[key] = value;
	};
	put('name', name?.trim() || host.name);
	if (toolType) put('toolType', toolType);
	put('nudgeMessage', nudgeMessage);
	put('newSessionMessage', newSessionMessage);
	put('customPath', customPath);
	put('customArgs', customArgs);
	put(
		'customEnvVars',
		customEnvVars && Object.keys(customEnvVars).length > 0 ? customEnvVars : undefined
	);
	put('customModel', customModel);
	put('customEffort', customEffort);
	put('customContextWindow', customContextWindow);
	put('enableMaestroP', enableMaestroP);
	put('maestroPMode', enableMaestroP ? maestroPMode : undefined);
	put('contextWindowSource', contextWindowSource);
	put('codexTransport', codexTransport);
	put('harnessControlMode', harnessControlMode);
	// The rows name the host's agents: the editor lists the host's fleet.
	put('peerAgents', normalizePeerAgents(peerGrants?.peerAgents));
	put('groupPeerAccess', peerGrants?.groupPeerAccess);
	put('worktreePeerAccess', peerGrants?.worktreePeerAccess);
	put('peerDescription', peerGrants?.peerDescription?.trim());
	// The editor reports a new directory itself, or in the SSH override it keeps for the remote.
	const cwd = workingDirectory?.trim() || sshConfig?.workingDirOverride?.trim();
	if (cwd) put('cwd', cwd);
	return next as AgentRecord;
}

export function HostedAgentSettingsModal({ theme }: { theme: Theme }) {
	const editing = useHostedAgentSettingsStore((s) => s.editing);
	const pending = useHostedAgentSettingsStore((s) =>
		s.editing ? s.pending[mirrorKey(s.editing.peerId, s.editing.agentId)] : undefined
	);
	const peer = usePeerMirrorStore((s) => (editing ? s.peers[editing.peerId] : undefined));
	const host = useMemo(
		() => peer?.agents.find((agent) => agent.id === editing?.agentId),
		[peer, editing?.agentId]
	);
	const session = useMemo(
		() => (host && peer ? hostedAgentEditSession(host, peer, pending?.values) : null),
		[host, peer, pending]
	);
	const close = useCallback(() => useHostedAgentSettingsStore.getState().closeEditor(), []);
	const federation = useFederationFieldsValue(
		editing ? { peerId: editing.peerId, agentId: editing.agentId, mode: 'mirror' } : null,
		theme
	);

	const onSave = useCallback(
		(...args: SaveArgs) => {
			if (!host || !peer) throw new Error('The agent is no longer on its host.');
			if (readEditAgentSaveArgs(args).convertProviderHistory === true) {
				throw new Error(
					'Converting memory and history is not available for an agent on a host. Switch the provider without converting.'
				);
			}
			const base = pending ? overlaySyncValues(host, pending.values) : host;
			saveHostedAgentSettings(peer.peerId, host, editedHostRecord(base, args));
		},
		[host, peer, pending]
	);

	if (!editing || !session) return null;
	return (
		<FederationFieldsProvider value={federation}>
			<EditAgentModal
				isOpen
				onClose={close}
				onSave={onSave}
				theme={theme}
				session={session}
				existingSessions={[]}
			/>
		</FederationFieldsProvider>
	);
}
