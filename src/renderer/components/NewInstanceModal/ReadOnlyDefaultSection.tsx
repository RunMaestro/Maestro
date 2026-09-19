/**
 * ReadOnlyDefaultSection - the agent-level "Read Only by default" toggle shared
 * by the create (NewInstanceModal) and edit (EditAgentModal) agent dialogs.
 *
 * Styled to match the rest of the agent modals: a standard uppercase section
 * heading plus a checkbox row (see AgentResilienceSection for the pattern).
 *
 * Render it only for a provider whose capabilities declare
 * `supportsReadOnlyMode`. The others have no flag that makes the agent read-only
 * (see `src/main/agents/capabilities.ts`), so the composer hides its permission
 * pill for them too - offering a default here would promise a safety guarantee
 * Maestro cannot deliver for that provider.
 */

import React from 'react';

import type { Theme } from '../../types';

interface ReadOnlyDefaultSectionProps {
	theme: Theme;
	readOnlyByDefault: boolean;
	onChange: (value: boolean) => void;
}

export function ReadOnlyDefaultSection({
	theme,
	readOnlyByDefault,
	onChange,
}: ReadOnlyDefaultSectionProps): React.ReactElement {
	return (
		<div>
			<div
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: theme.colors.textMain }}
			>
				Default Permission
			</div>

			<label
				className="flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors hover:bg-white/5"
				style={{ backgroundColor: theme.colors.bgActivity }}
			>
				<input
					type="checkbox"
					checked={readOnlyByDefault}
					onChange={(e) => onChange(e.target.checked)}
					className="mt-0.5 accent-current"
					style={{ accentColor: theme.colors.accent }}
					aria-label="Read Only by default"
				/>
				<div className="flex flex-col min-w-0">
					<span className="text-xs font-medium" style={{ color: theme.colors.textMain }}>
						Read Only by default
					</span>
					<span className="text-2xs" style={{ color: theme.colors.textDim }}>
						Every new chat this agent opens starts in read-only (plan) mode, in the workspace and in
						any worktree cut from it. Use the composer&apos;s permission pill to switch an
						individual chat to full access. Chats that already exist are left as they are.
					</span>
				</div>
			</label>
		</div>
	);
}
