import { useState, useEffect, useRef } from 'react';
import { captureException } from '../../utils/sentry';

/**
 * Resolves the SSH remote name for display in the header when a session has SSH configured.
 *
 * Uses a sequence counter to guard against stale responses from out-of-order
 * IPC calls when the user switches sessions quickly.
 */
export function useSshRemoteName(
	sshEnabled: boolean | undefined,
	remoteId: string | null | undefined
): string | null {
	const [sshRemoteName, setSshRemoteName] = useState<string | null>(null);
	const seqRef = useRef(0);

	useEffect(() => {
		if (!sshEnabled || !remoteId) {
			setSshRemoteName(null);
			return;
		}

		const callSeq = ++seqRef.current;

		window.maestro.sshRemote
			.getConfigs()
			.then((result) => {
				if (callSeq !== seqRef.current) return; // Stale response — skip
				if (result.success && result.configs) {
					const remote = result.configs.find((r: { id: string }) => r.id === remoteId);
					setSshRemoteName(remote?.name || null);
				} else {
					setSshRemoteName(null);
				}
			})
			.catch((error) => {
				if (callSeq !== seqRef.current) return; // Stale — skip
				captureException(error, {
					extra: { message: 'useSshRemoteName: failed to load SSH remote configs', remoteId },
				});
				setSshRemoteName(null);
			});

		return () => {
			// Invalidate this call so late resolution does nothing
			seqRef.current++;
		};
	}, [sshEnabled, remoteId]);

	return sshRemoteName;
}
