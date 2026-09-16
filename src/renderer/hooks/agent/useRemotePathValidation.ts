import { useState, useEffect } from 'react';
import type { RemotePathValidationState } from '../../components/NewInstanceModal/types';

interface UseRemotePathValidationOptions {
	/** Whether SSH remote is currently enabled */
	isSshEnabled: boolean;
	/** The path to validate (workingDir for create, projectRoot for edit) */
	path: string;
	/** The SSH remote ID to validate against */
	sshRemoteId: string | null | undefined;
	/**
	 * Validate against the LOCAL filesystem when SSH is off. Off by default:
	 * the New Agent modal fills the path from a folder picker, so it needs no
	 * check, while the Edit Agent dialog accepts a typed path that must exist
	 * before it becomes the agent's spawn cwd.
	 */
	validateLocal?: boolean;
	/** Debounce delay in ms (default: 300) */
	debounceMs?: number;
}

const DEFAULT_STATE: RemotePathValidationState = {
	checking: false,
	valid: false,
	isDirectory: false,
};

/**
 * Debounced path validation: checks that a path exists and is a directory,
 * on the SSH remote when SSH is enabled, or locally when `validateLocal` is set.
 */
export function useRemotePathValidation({
	isSshEnabled,
	path,
	sshRemoteId,
	validateLocal = false,
	debounceMs = 300,
}: UseRemotePathValidationOptions): RemotePathValidationState {
	const [validation, setValidation] = useState<RemotePathValidationState>(DEFAULT_STATE);

	useEffect(() => {
		// A result belongs to the path and remote it was checked against. Drop it
		// the moment either changes, so a directory that validated a keystroke ago
		// cannot vouch for the path being typed now.
		setValidation(DEFAULT_STATE);

		if (!isSshEnabled && !validateLocal) {
			return;
		}

		const trimmedPath = path.trim();
		if (!trimmedPath) {
			setValidation(DEFAULT_STATE);
			return;
		}

		// A local check passes no remote id; an SSH check needs one.
		const remoteId = isSshEnabled ? sshRemoteId : undefined;
		if (isSshEnabled && !remoteId) {
			setValidation(DEFAULT_STATE);
			return;
		}

		let cancelled = false;

		const timeoutId = setTimeout(async () => {
			if (cancelled) return;
			setValidation((prev) => ({ ...prev, checking: true }));

			try {
				const stat = await window.maestro.fs.stat(trimmedPath, remoteId ?? undefined);
				if (cancelled) return;
				if (stat && stat.isDirectory) {
					setValidation({
						checking: false,
						valid: true,
						isDirectory: true,
					});
				} else if (stat && stat.isFile) {
					setValidation({
						checking: false,
						valid: false,
						isDirectory: false,
						error: 'Path is a file, not a directory',
					});
				} else {
					setValidation({
						checking: false,
						valid: false,
						isDirectory: false,
						error: 'Path not found or not accessible',
					});
				}
			} catch {
				if (cancelled) return;
				setValidation({
					checking: false,
					valid: false,
					isDirectory: false,
					error: 'Path not found or not accessible',
				});
			}
		}, debounceMs);

		return () => {
			cancelled = true;
			clearTimeout(timeoutId);
		};
	}, [isSshEnabled, validateLocal, path, sshRemoteId, debounceMs]);

	return validation;
}

export type { UseRemotePathValidationOptions, RemotePathValidationState };
