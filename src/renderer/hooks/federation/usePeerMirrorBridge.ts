/**
 * usePeerMirrorBridge - keep this window's `peerMirrorStore` in step with the main-process
 * Federation peer mirror. Mounted once, in App.
 *
 * Federation is always on. Where there is no `window.maestro.federation` (the browser build) this
 * does nothing and the store stays empty. Otherwise it subscribes to `federation:event` FIRST and
 * then loads the snapshot; pushes that arrive while the snapshot is in flight are replayed on top of
 * it, so nothing the service sent in between is lost. `federation:reset` empties the store.
 *
 * It also keeps the mirror selection exclusive with a group chat: opening a group chat leaves
 * the mirror, the way it leaves a local agent.
 */

import { useEffect } from 'react';
import type { MirrorPush } from '../../../shared/maestro-lib/client/peer-mirror';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useFederationAutoStore } from '../../stores/federationAutoStore';
import { logger } from '../../utils/logger';

export function usePeerMirrorBridge(): void {
	useEffect(() => {
		const store = usePeerMirrorStore.getState();
		const api = window.maestro?.federation;
		if (!api) {
			store.reset();
			return;
		}

		let disposed = false;
		let pending: MirrorPush[] | null = [];
		const offEvent = api.onEvent((push) => {
			if (disposed) return;
			if (pending) pending.push(push);
			else usePeerMirrorStore.getState().applyPush(push);
		});
		const offReset = api.onReset(() => {
			if (!disposed) usePeerMirrorStore.getState().reset();
		});
		// Automatic Federation: the first snapshot is loaded quietly, later ones announce changes.
		const offAuto = api.onAuto?.((snapshot) => {
			if (!disposed) useFederationAutoStore.getState().applySnapshot(snapshot);
		});
		api
			.autoStatus?.()
			.then((snapshot) => {
				if (!disposed) useFederationAutoStore.getState().applySnapshot(snapshot, false);
			})
			.catch(() => {
				// The pushes alone keep the store current.
			});
		const offGroupChat = useGroupChatStore.subscribe((state, previous) => {
			if (state.activeGroupChatId && state.activeGroupChatId !== previous.activeGroupChatId) {
				usePeerMirrorStore.getState().clearMirrorSelection();
			}
		});

		const replay = () => {
			const queued = pending ?? [];
			pending = null;
			const { applyPush } = usePeerMirrorStore.getState();
			for (const push of queued) applyPush(push);
		};

		api
			.snapshot()
			.then((snapshot) => {
				if (disposed) return;
				usePeerMirrorStore.getState().hydrate(snapshot.peers);
				replay();
			})
			.catch((error: unknown) => {
				if (disposed) return;
				// The pushes alone still build the mirror up; only the head start is lost.
				logger.warn('[Federation] Could not load the peer mirror snapshot', undefined, error);
				usePeerMirrorStore.getState().hydrate([]);
				replay();
			});

		return () => {
			disposed = true;
			offEvent();
			offReset();
			offAuto?.();
			offGroupChat();
			useFederationAutoStore.getState().reset();
			usePeerMirrorStore.getState().reset();
		};
	}, []);
}
