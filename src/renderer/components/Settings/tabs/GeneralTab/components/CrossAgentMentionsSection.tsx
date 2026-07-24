import { AlertTriangle, AtSign } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';

interface CrossAgentMentionsSectionProps {
	theme: Theme;
	crossAgentMentionsWritable: boolean;
	setCrossAgentMentionsWritable: (enabled: boolean) => void;
}

export function CrossAgentMentionsSection({
	theme,
	crossAgentMentionsWritable,
	setCrossAgentMentionsWritable,
}: CrossAgentMentionsSectionProps) {
	return (
		<div data-setting-id="general-cross-agent-mentions">
			<div className="block text-xs font-bold opacity-70 uppercase mb-2 flex items-center gap-2">
				<AtSign className="w-3 h-3" />
				Cross-Agent Mentions
			</div>
			<p className="text-xs opacity-50 mb-3">
				When you @-mention another agent, it is consulted in its own workspace. Choose whether that
				consult can only read files or is also allowed to write.
			</p>

			<div
				className="p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="flex items-center justify-between mb-2">
					<div className="text-sm font-medium" style={{ color: theme.colors.textMain }}>
						Consult Permission
					</div>
					<ToggleButtonGroup
						options={[
							{ value: 'readonly' as const, label: 'Read-Only' },
							{ value: 'readwrite' as const, label: 'Read/Write' },
						]}
						value={crossAgentMentionsWritable ? 'readwrite' : 'readonly'}
						onChange={(value) => setCrossAgentMentionsWritable(value === 'readwrite')}
						theme={theme}
					/>
				</div>
				<p className="text-xs opacity-50">
					{crossAgentMentionsWritable
						? 'Mentioned agents may modify files in their own workspace while answering.'
						: 'Mentioned agents can read to inform their answer but never modify files (the default and safest choice).'}
				</p>

				{crossAgentMentionsWritable && (
					<div
						className="flex items-start gap-1.5 text-xs mt-3"
						style={{ color: theme.colors.warning }}
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>
							A consulted agent can now change files on its own. Enable this only when you trust the
							mentioned agent to edit its workspace unattended.
						</span>
					</div>
				)}
			</div>
		</div>
	);
}
