import React from 'react';
import { Check, X } from 'lucide-react';
import type { RemotePathStatusProps } from './types';

/**
 * The status row under a working-directory field: checking, found, or why not. The same words
 * for a local and a remote directory (docs/parity/agent-ux-parity.md): the agent's mode pill is
 * the only mark that names where it runs, so the row never names a host.
 */
export const RemotePathStatus = React.memo(function RemotePathStatus({
	theme,
	validation,
}: RemotePathStatusProps) {
	if (validation.checking) {
		return (
			<div className="mt-2 text-xs flex items-center gap-1.5">
				<div
					className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin"
					style={{ borderColor: theme.colors.textDim, borderTopColor: 'transparent' }}
				/>
				<span style={{ color: theme.colors.textDim }}>Checking path...</span>
			</div>
		);
	}

	if (validation.valid) {
		return (
			<div className="mt-2 text-xs flex items-center gap-1.5">
				<Check className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />
				<span style={{ color: theme.colors.success }}>Directory found</span>
			</div>
		);
	}

	if (validation.error) {
		return (
			<div className="mt-2 text-xs flex items-center gap-1.5">
				<X className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />
				<span style={{ color: theme.colors.error }}>{validation.error}</span>
			</div>
		);
	}

	return null;
});
