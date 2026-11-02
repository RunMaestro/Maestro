import type { Anchor, AnchorStore } from '../../main/utils/keyring-anchor';

/** Credential-store fixture outside the data snapshot being rolled back. */
export function fakeAnchor(holder: { value: Anchor | null }, available = true): AnchorStore {
	return {
		available: () => available,
		read: () => holder.value,
		write: (a) => {
			holder.value = { ...a };
		},
		clear: () => {
			holder.value = null;
		},
	};
}
