import { AlertTriangle, AtSign } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { ToggleButtonGroup } from '../../../../ToggleButtonGroup';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';

interface CrossAgentMentionsSectionProps {
	theme: Theme;
	crossAgentMentionsWritable: boolean;
	setCrossAgentMentionsWritable: (enabled: boolean) => void;
	crossAgentHandoffsWritable: boolean;
	setCrossAgentHandoffsWritable: (enabled: boolean) => void;
}

export function CrossAgentMentionsSection({
	theme,
	crossAgentMentionsWritable,
	setCrossAgentMentionsWritable,
	crossAgentHandoffsWritable,
	setCrossAgentHandoffsWritable,
}: CrossAgentMentionsSectionProps) {
	return (
		<div data-setting-id="general-cross-agent-mentions">
			<SettingsSectionHeading icon={AtSign}>Cross-Agent Mentions</SettingsSectionHeading>
			<p className="text-xs opacity-70 mb-3">
				When you @-mention another agent, it answers from its own workspace. Read-Only makes that a{' '}
				<span className="font-medium">consult</span>: it reads and replies. Read/Write makes it a{' '}
				<span className="font-medium">delegation</span>: it can also change files. A{' '}
				<span className="font-medium">hand-off</span> (&quot;then send what you find to
				@agent&quot;) has its own switch below.
			</p>

			<div
				className="p-3 rounded border"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="font-medium" style={{ color: theme.colors.textMain }}>
					Consult or Delegate
				</div>
				<div className="text-xs opacity-70 mt-0.5 mb-2">
					{crossAgentMentionsWritable
						? 'Delegate: mentioned agents may modify files in their own workspace while answering.'
						: 'Consult: mentioned agents read to inform their answer but never modify files (the default and safest choice).'}
				</div>

				{crossAgentMentionsWritable && (
					<div
						className="flex items-start gap-1.5 text-xs mb-2"
						style={{ color: theme.colors.warning }}
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>
							Every mention is now a delegation: the agent can change files on its own. Enable this
							only when you trust the mentioned agent to edit its workspace unattended.
						</span>
					</div>
				)}

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

			{/* Hand-offs ("then send what you find to @agent") pass finished work on,
			    so they get their own switch and default to Read/Write. */}
			<div
				className="p-3 rounded border mt-3"
				style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgMain }}
			>
				<div className="font-medium" style={{ color: theme.colors.textMain }}>
					Hand-offs
				</div>
				<div className="text-xs opacity-70 mt-0.5 mb-2">
					{crossAgentHandoffsWritable
						? 'Read/Write: an agent handed a result ("then send what you find to @agent") may save it and change files in its own workspace (the default).'
						: 'Read-Only: an agent handed a result reads it and replies, but never modifies files.'}
				</div>

				{crossAgentHandoffsWritable && (
					<div
						className="flex items-start gap-1.5 text-xs mb-2"
						style={{ color: theme.colors.warning }}
					>
						<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
						<span>
							A hand-off forwards another agent's output, which can include text from the web. The
							receiving agent acts on it unattended.
						</span>
					</div>
				)}

				<ToggleButtonGroup
					options={[
						{ value: 'readonly' as const, label: 'Read-Only' },
						{ value: 'readwrite' as const, label: 'Read/Write' },
					]}
					value={crossAgentHandoffsWritable ? 'readwrite' : 'readonly'}
					onChange={(value) => setCrossAgentHandoffsWritable(value === 'readwrite')}
					theme={theme}
				/>
			</div>
		</div>
	);
}
