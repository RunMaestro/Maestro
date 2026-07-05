import { Network } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { CoworkingSetup } from '../../../CoworkingSetup';
import { EncoreFeatureCard } from './EncoreFeatureCard';

interface CoworkingSectionProps {
	theme: Theme;
	enabled: boolean;
	onToggle: () => void;
}

export function CoworkingSection({ theme, enabled, onToggle }: CoworkingSectionProps) {
	return (
		<div data-setting-id="encore-coworking">
			<EncoreFeatureCard
				theme={theme}
				enabled={enabled}
				onToggle={onToggle}
				icon={Network}
				title={
					<span className="flex items-center gap-2">
						Coworking
						<span
							className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase"
							style={{
								backgroundColor: theme.colors.warning + '30',
								color: theme.colors.warning,
							}}
						>
							Beta
						</span>
					</span>
				}
				description="Let agents read terminal scrollback and inspect browser tabs on demand. Installs a per-agent MCP server (Claude Code, Codex, OpenCode, Factory Droid)."
			>
				<CoworkingSetup theme={theme} />
			</EncoreFeatureCard>
		</div>
	);
}
