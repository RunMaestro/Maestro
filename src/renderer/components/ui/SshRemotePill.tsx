/**
 * SshRemotePill - the canonical "this agent runs on an SSH remote" badge.
 *
 * Maestro marks remote agents in several surfaces (Main Panel header, group
 * chat participant cards, the `@` mention picker). They all used to hand-roll
 * the same purple `Server` + host-name pill, which drifted in size and casing.
 * Import this instead of writing another one.
 *
 * The absence of this pill means "local" - that is the app-wide convention, so
 * do not pair it with a LOCAL badge.
 *
 * The purple palette is intentionally fixed rather than theme-derived: SSH is a
 * safety-relevant fact (your prompt leaves this machine) and it reads the same
 * in every theme. Only the size varies.
 */

import { Server } from 'lucide-react';
import type { CSSProperties } from 'react';

export interface SshRemotePillProps {
	/**
	 * Remote display name. When omitted (config not loaded yet, or the remote was
	 * deleted) the pill falls back to the literal "SSH" so the row still says
	 * "not local" instead of silently looking local.
	 */
	remoteName?: string | null;
	/** `xs` for dense list rows, `sm` for headers and cards. */
	size?: 'xs' | 'sm';
	/** Overrides the default `SSH Remote: <name>` tooltip. */
	title?: string;
	className?: string;
	style?: CSSProperties;
}

const SIZE_CLASSES: Record<'xs' | 'sm', { pill: string; icon: string }> = {
	xs: { pill: 'text-3xs px-1.5 py-0.5 gap-1', icon: 'w-2.5 h-2.5' },
	sm: { pill: 'text-2xs px-2 py-0.5 gap-1', icon: 'w-2.5 h-2.5' },
};

export function SshRemotePill({
	remoteName,
	size = 'xs',
	title,
	className,
	style,
}: SshRemotePillProps) {
	const label = remoteName || 'SSH';
	const sizes = SIZE_CLASSES[size];

	return (
		<span
			className={`flex items-center shrink-0 rounded-full border border-purple-500/30 text-purple-500 bg-purple-500/10 ${sizes.pill} ${className ?? ''}`}
			title={
				title ?? (remoteName ? `SSH Remote: ${remoteName}` : 'Running on a remote host via SSH')
			}
			style={style}
		>
			<Server className={`${sizes.icon} shrink-0`} />
			<span className="uppercase truncate">{label}</span>
		</span>
	);
}

export default SshRemotePill;
