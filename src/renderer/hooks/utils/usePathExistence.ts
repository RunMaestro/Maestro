import { useCallback, useEffect, useRef, useState } from 'react';
import {
	checkPathExists,
	pathExistenceKey,
	subscribePathExistence,
} from '../../utils/fileLinks/pathExistence';

/**
 * A `pathExists` check for one rendering surface, over the shared cache in
 * `utils/fileLinks/pathExistence.ts`.
 *
 * The returned function answers synchronously (`undefined` while a check is in
 * flight) and changes identity only when an answer THIS surface asked for
 * lands, so a memo keyed on it re-parses one message rather than every message
 * on screen whenever any path anywhere resolves.
 */
export function usePathExistence(
	sshRemoteId?: string
): (absolutePath: string) => boolean | undefined {
	const [revision, setRevision] = useState(0);
	// Keys this surface is waiting on. Written during render (the remark plugin
	// runs there), read by the subscription below.
	const awaited = useRef(new Set<string>());

	useEffect(
		() =>
			subscribePathExistence((key) => {
				if (awaited.current.delete(key)) setRevision((r) => r + 1);
			}),
		[]
	);

	return useCallback(
		(absolutePath: string) => {
			const exists = checkPathExists(absolutePath, sshRemoteId);
			// A stale "no" is re-checked in the background too, so wait on
			// anything short of a yes.
			if (exists !== true) awaited.current.add(pathExistenceKey(absolutePath, sshRemoteId));
			return exists;
		},
		// `revision` is the point: a new identity is what tells the plugin memo
		// that an answer it was missing has arrived.
		[sshRemoteId, revision]
	);
}
