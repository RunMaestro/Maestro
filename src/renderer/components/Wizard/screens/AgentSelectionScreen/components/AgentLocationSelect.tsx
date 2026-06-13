import type { AgentLocationSelectProps } from '../types';

export function AgentLocationSelect({
	theme,
	sshRemotes,
	sshRemoteConfig,
	onSshRemoteChange,
	compact = false,
}: AgentLocationSelectProps): JSX.Element | null {
	if (sshRemotes.length === 0) return null;

	return (
		<div className={`flex items-center gap-2 ${compact ? 'text-sm' : ''}`}>
			<span className={compact ? undefined : 'text-sm'} style={{ color: theme.colors.textDim }}>
				on
			</span>
			<select
				value={sshRemoteConfig?.enabled ? sshRemoteConfig.remoteId || '' : ''}
				onChange={(event) => onSshRemoteChange(event.target.value)}
				className={
					compact
						? 'px-3 py-1 rounded border outline-none transition-all cursor-pointer text-xs'
						: 'px-3 py-2 rounded-lg border outline-none transition-all cursor-pointer'
				}
				style={{
					backgroundColor: theme.colors.bgMain,
					borderColor: theme.colors.border,
					color: theme.colors.textMain,
					minWidth: compact ? undefined : '160px',
				}}
				aria-label="Agent location"
			>
				<option value="">Local Machine</option>
				{sshRemotes.map((remote) => (
					<option key={remote.id} value={remote.id}>
						{remote.name || remote.host}
					</option>
				))}
			</select>
		</div>
	);
}
