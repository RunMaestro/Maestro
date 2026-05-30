import { useState, useEffect } from 'react';
import type { RemotePathValidationState } from '../../components/NewInstanceModal/types';

interface UseRemotePathValidationOptions {
	/** Whether SSH remote is currently enabled */
	isSshEnabled: boolean;
	/** The path to validate (workingDir for create, projectRoot for edit) */
	path: string;
	/** The SSH remote ID to validate against */
	sshRemoteId: string | null | undefined;
	/** Debounce delay in ms (default: 300) */
	debounceMs?: number;
}

const DEFAULT_STATE: RemotePathValidationState = {
	checking: false,
	valid: false,
	isDirectory: false,
};

/**
 * Debounced remote path validation via SSH.
 * Checks if a path exists and is a directory on a remote host.
 */
export function useRemotePathValidation({
	isSshEnabled,
	path,
	sshRemoteId,
	debounceMs = 300,
}: UseRemotePathValidationOptions): RemotePathValidationState {
	const [validation, setValidation] = useState<RemotePathValidationState>(DEFAULT_STATE);

	useEffect(() => {
		if (!isSshEnabled) {
			setValidation(DEFAULT_STATE);
			return;
		}

		const trimmedPath = path.trim();
		if (!trimmedPath) {
			setValidation(DEFAULT_STATE);
			return;
		}

		if (!sshRemoteId) {
			setValidation(DEFAULT_STATE);
			return;
		}

		let cancelled = false;

		const timeoutId = setTimeout(async () => {
			if (cancelled) return;
			setValidation((prev) => ({ ...prev, checking: true }));

			try {
				const stat = await window.maestro.fs.stat(trimmedPath, sshRemoteId);
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
	}, [isSshEnabled, path, sshRemoteId, debounceMs]);

	return validation;
}

export type { UseRemotePathValidationOptions, RemotePathValidationState };
