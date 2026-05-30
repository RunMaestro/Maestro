import React from 'react';
import { Check, X } from 'lucide-react';
import type { RemotePathStatusProps } from './types';

export const RemotePathStatus = React.memo(function RemotePathStatus({
	theme,
	validation,
	remoteHost,
}: RemotePathStatusProps) {
	if (validation.checking) {
		return (
			<div className="mt-2 text-xs flex items-center gap-1.5">
				<div
					className="w-3 h-3 border-2 border-t-transparent rounded-full animate-spin"
					style={{ borderColor: theme.colors.textDim, borderTopColor: 'transparent' }}
				/>
				<span style={{ color: theme.colors.textDim }}>
					{remoteHost ? `Checking path on ${remoteHost}...` : 'Checking remote path...'}
				</span>
			</div>
		);
	}

	if (validation.valid) {
		return (
			<div className="mt-2 text-xs flex items-center gap-1.5">
				<Check className="w-3.5 h-3.5" style={{ color: theme.colors.success }} />
				<span style={{ color: theme.colors.success }}>
					{remoteHost ? `Directory found on ${remoteHost}` : 'Remote directory found'}
				</span>
			</div>
		);
	}

	if (validation.error) {
		return (
			<div className="mt-2 text-xs flex items-center gap-1.5">
				<X className="w-3.5 h-3.5" style={{ color: theme.colors.error }} />
				<span style={{ color: theme.colors.error }}>
					{validation.error}
					{remoteHost ? ` (${remoteHost})` : ''}
				</span>
			</div>
		);
	}

	return null;
});
