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
 * maestro-p binary path, retry flags, extra directories, and a provider conversion (a switch is).
 */

import { useCallback, useMemo } from 'react';
import type { Session, Theme } from '../../types';
import type { EditAgentModalProps } from '../NewInstanceModal/types';
import { EditAgentModal } from '../NewInstanceModal';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useHostedAgentSettingsStore } from '../../stores/hostedAgentSettingsStore';
import { saveHostedAgentSettings } from '../../services/liftedAgentSettingsSync';
import { mirrorKey, type MirroredPeer } from '../../../shared/maestro-lib/client/peer-mirror';
import {
	overlaySyncValues,
	type StoredSyncValue,
} from '../../../shared/maestro-lib/agents/lift-settings-sync';
import type { AgentRecord } from '../../../shared/maestro-lib/store/records';

type SaveArgs = Parameters<EditAgentModalProps['onSave']>;

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

/** The editor's save arguments as the record they describe; unset values remove the field. */
export function editedHostRecord(host: AgentRecord, args: SaveArgs): AgentRecord {
	const [
		,
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
		sshConfig,
		enableMaestroP,
		,
		maestroPMode,
		,
		,
		,
		contextWindowSource,
		,
		workingDirectory,
		,
		codexTransport,
		harnessControlMode,
	] = args;
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

	const onSave = useCallback(
		(...args: SaveArgs) => {
			if (!host || !peer) throw new Error('The agent is no longer on its host.');
			if (args[27] === true) {
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
		<EditAgentModal
			isOpen
			onClose={close}
			onSave={onSave}
			theme={theme}
			session={session}
			existingSessions={[]}
		/>
	);
}
