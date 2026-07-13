import type { KeyboardEvent } from 'react';
import type { Theme } from '../../types';
import {
	type PluginExternalSessionProjection,
	type PluginWorkspaceProjectionSource,
	usePluginWorkspaceProjection,
} from './pluginWorkspaceProjection';

interface PluginWorkspaceRailProps {
	theme: Theme;
	source: PluginWorkspaceProjectionSource;
	ownerPluginId: string;
	workspaceLocalId: string;
}

function statusLabel(status: PluginExternalSessionProjection['status']): string {
	return status.replace(/_/g, ' ');
}

export function PluginWorkspaceRail({
	theme,
	source,
	ownerPluginId,
	workspaceLocalId,
}: PluginWorkspaceRailProps) {
	const projection = usePluginWorkspaceProjection(source);
	if (projection.phase === 'loading') {
		return (
			<div role="status" className="p-3 text-sm" style={{ color: theme.colors.textDim }}>
				Loading workspace sessions…
			</div>
		);
	}
	if (projection.phase === 'error' || projection.snapshot?.connection === 'error') {
		return (
			<div
				role="alert"
				aria-live="assertive"
				className="p-3 text-sm"
				style={{ color: theme.colors.error }}
			>
				{projection.snapshot?.error ?? projection.error ?? 'Plugin workspace transport failed.'}
			</div>
		);
	}

	const workspace = projection.snapshot?.workspaces.find(
		(candidate) =>
			candidate.ownerPluginId === ownerPluginId && candidate.workspaceLocalId === workspaceLocalId
	);
	const sessions = workspace?.sessions ?? [];
	const workspaceStatus = workspace?.status;
	return (
		<>
			<WorkspaceStatusSurface theme={theme} status={workspaceStatus} />
			<nav
				className="min-h-0 overflow-auto border-r p-2"
				aria-label="External sessions"
				style={{ borderColor: theme.colors.border }}
			>
				{sessions.length === 0 ? (
					<p className="p-2 text-sm" style={{ color: theme.colors.textDim }}>
						No external sessions.
					</p>
				) : (
					sessions.map((session) => {
						const reveal = (): void => {
							void source.reveal({ snapshotToken: session.snapshotToken });
						};
						const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault();
								reveal();
							}
						};
						return (
							<button
								key={session.externalSessionId}
								type="button"
								onClick={reveal}
								onKeyDown={onKeyDown}
								className="mb-1 flex w-full flex-col rounded px-2 py-2 text-left hover:bg-white/10"
								aria-description={session.pendingApproval ? 'Approval required' : undefined}
							>
								<span className="truncate text-sm">{session.title}</span>
								<span
									className="mt-1 flex items-center gap-2 text-xs"
									style={{ color: theme.colors.textDim }}
								>
									<span>{statusLabel(session.status)}</span>
									{session.unread > 0 && (
										<span aria-label={`${session.unread} unread`}>{session.unread}</span>
									)}
									{session.pendingApproval && <span>Approval required</span>}
								</span>
							</button>
						);
					})
				)}
			</nav>
		</>
	);
}

function WorkspaceStatusSurface({
	theme,
	status,
}: {
	theme: Theme;
	status:
		| { state: 'ready' | 'connecting' | 'degraded' | 'offline' | 'error'; label: string }
		| undefined;
}) {
	if (!status || status.state === 'ready') return null;
	const isError = status.state === 'error';
	const message = status.label || status.state;
	return (
		<div
			role={isError ? 'alert' : 'status'}
			aria-live={isError ? 'assertive' : 'polite'}
			className="p-2 text-xs"
			style={{ color: isError ? theme.colors.error : theme.colors.textDim }}
		>
			{message}
		</div>
	);
}
