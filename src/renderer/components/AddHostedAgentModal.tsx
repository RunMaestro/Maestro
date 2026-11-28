/**
 * Add Hosted Agent: show an agent a Federation host runs in the Left Bar.
 *
 * A host's agents stay out of the Left Bar until someone adds them; the ones this machine moved
 * there (Move to Host) are in it already. This lists every host agent not shown yet, per peer, and
 * adds the one picked to the chosen group (`addHostedAgent()`, the same call as `maestro-cli
 * federation add`). Removing the row later (Remove Agent) leaves the host's agent alone.
 *
 * Opened from the palette ("Add Hosted Agent..."), the Left Bar hamburger menu, and `maestro-cli
 * open add-hosted-agent`.
 */

import { useMemo, useState } from 'react';
import { Network, Plus } from 'lucide-react';
import type { Theme } from '../types';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { selectModalOpen, useModalStore } from '../stores/modalStore';
import { useSessionStore } from '../stores/sessionStore';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { notifyToast } from '../stores/notificationStore';
import { addHostedAgent, buildHostedAgentListings } from '../services/hostedAgents';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { Modal } from './ui/Modal';
import { FilterInput } from './ui/FilterInput';
import { ThemedSelect } from './shared/ThemedSelect';

/** Mounts the Add Hosted Agent modal from the modal store. */
export function AddHostedAgentModalHost({ theme }: { theme: Theme }) {
	const open = useModalStore(selectModalOpen('addHostedAgent'));
	const closeModal = useModalStore((s) => s.closeModal);
	if (!open) return null;
	return <AddHostedAgentModal theme={theme} onClose={() => closeModal('addHostedAgent')} />;
}

export function AddHostedAgentModal({ theme, onClose }: { theme: Theme; onClose: () => void }) {
	const peers = usePeerMirrorStore((s) => s.peers);
	const order = usePeerMirrorStore((s) => s.order);
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);
	const [filter, setFilter] = useState('');
	const [groupId, setGroupId] = useState('');
	const [adding, setAdding] = useState<string | null>(null);

	const listings = useMemo(
		() => buildHostedAgentListings(peers, order, sessions),
		[peers, order, sessions]
	);
	const addable = useMemo(() => {
		const query = filter.trim().toLowerCase();
		return listings.filter(
			(listing) =>
				!listing.addedAs &&
				(!query ||
					listing.name.toLowerCase().includes(query) ||
					listing.peerName.toLowerCase().includes(query) ||
					(listing.cwd ?? '').toLowerCase().includes(query))
		);
	}, [listings, filter]);
	const totalAddable = listings.filter((listing) => !listing.addedAs).length;

	const add = async (ref: string) => {
		setAdding(ref);
		const result = await addHostedAgent({ agent: ref, ...(groupId ? { group: groupId } : {}) });
		setAdding(null);
		if (!result.ok) {
			notifyToast({ color: 'red', title: 'Could not add the hosted agent', message: result.error });
			return;
		}
		notifyToast({
			color: 'green',
			title: `Added "${result.added.name}"`,
			message: `It shows in your Left Bar and runs on its host (${result.added.ref}).`,
		});
		onClose();
	};

	return (
		<Modal
			theme={theme}
			title="Add Hosted Agent"
			subtitle="Show an agent a Maestro host runs in your Left Bar"
			priority={MODAL_PRIORITIES.ADD_HOSTED_AGENT}
			onClose={onClose}
			headerIcon={<Network className="w-4 h-4" style={{ color: theme.colors.accent }} />}
			width={640}
			resizeKey="addHostedAgent"
			defaultSize={{ width: 640, height: 520 }}
			contentClassName="p-5 overflow-y-auto flex-1 space-y-4 select-none"
		>
			{totalAddable === 0 ? (
				<p
					className="text-sm"
					style={{ color: theme.colors.textDim }}
					data-testid="add-hosted-empty"
				>
					Every agent your connected hosts run is in your Left Bar already, or no remote runs a
					Maestro host. `maestro-cli federation peers` shows which remotes do.
				</p>
			) : (
				<>
					<div className="flex items-end gap-3">
						<div className="flex-1 min-w-0">
							<FilterInput
								theme={theme}
								value={filter}
								onChange={setFilter}
								placeholder="Filter by name, host, or folder..."
								resultLabel={`${addable.length} of ${totalAddable}`}
								width="100%"
							/>
						</div>
						<div className="w-56 shrink-0">
							<ThemedSelect
								id="add-hosted-agent-group"
								theme={theme}
								value={groupId}
								onChange={setGroupId}
								aria-label="Left Bar group"
								options={[
									{ value: '', label: 'No Group (Ungrouped)' },
									...groups.map((group) => ({
										value: group.id,
										label: `${group.emoji} ${group.name}`.trim(),
									})),
								]}
							/>
						</div>
					</div>
					<div
						className="rounded border divide-y"
						style={{ borderColor: theme.colors.border }}
						data-testid="add-hosted-list"
					>
						{addable.map((listing, index) => {
							const firstOfPeer = index === 0 || addable[index - 1].peerId !== listing.peerId;
							return (
								<div key={listing.ref} style={{ borderColor: theme.colors.border }}>
									{firstOfPeer && (
										<div
											className="px-3 py-1.5 text-2xs font-bold uppercase tracking-wider"
											style={{
												color: theme.colors.textDim,
												backgroundColor: theme.colors.bgSidebar,
											}}
										>
											{listing.peerName}
										</div>
									)}
									<div className="flex items-center gap-3 px-3 py-2">
										<div className="flex-1 min-w-0">
											<div className="text-sm truncate" style={{ color: theme.colors.textMain }}>
												{listing.name}
											</div>
											<div
												className="text-2xs truncate select-text"
												style={{ color: theme.colors.textDim }}
											>
												{getAgentDisplayName(listing.toolType)}
												{listing.hostGroupName ? ` · ${listing.hostGroupName}` : ''}
												{listing.cwd ? ` · ${listing.cwd}` : ''}
											</div>
										</div>
										<button
											type="button"
											onClick={() => void add(listing.ref)}
											disabled={adding !== null}
											className="flex items-center gap-1 px-2 py-1 rounded border text-xs shrink-0 hover:bg-white/5 transition-colors disabled:opacity-50"
											style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
											data-testid="add-hosted-agent-button"
											aria-label={`Add ${listing.name}`}
										>
											<Plus className="w-3 h-3" />
											{adding === listing.ref ? 'Adding...' : 'Add'}
										</button>
									</div>
								</div>
							);
						})}
					</div>
				</>
			)}
		</Modal>
	);
}
