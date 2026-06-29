import { Sparkles } from 'lucide-react';
import type { Theme } from '../../../../../types';
import { SettingsSectionHeading } from '../../../SettingsSectionHeading';
import { SectionCard } from './SectionCard';
import { ToggleSettingRow } from './ToggleSettingRow';

interface DocumentGraphSectionProps {
	theme: Theme;
	documentGraphShowExternalLinks: boolean;
	setDocumentGraphShowExternalLinks: (enabled: boolean) => void;
	documentGraphMaxNodes: number;
	setDocumentGraphMaxNodes: (value: number) => void;
}

export function DocumentGraphSection({
	theme,
	documentGraphShowExternalLinks,
	setDocumentGraphShowExternalLinks,
	documentGraphMaxNodes,
	setDocumentGraphMaxNodes,
}: DocumentGraphSectionProps) {
	const maxNodePercentage = ((documentGraphMaxNodes - 50) / 950) * 100;

	return (
		<div data-setting-id="display-document-graph">
			<SettingsSectionHeading icon={Sparkles}>Document Graph</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ToggleSettingRow
					theme={theme}
					title="Show external links by default"
					description="Display external website links as nodes. Can be toggled in the graph view."
					checked={documentGraphShowExternalLinks}
					onChange={setDocumentGraphShowExternalLinks}
				/>
				<div>
					<label htmlFor="document-graph-max-nodes" className="block text-xs opacity-60 mb-2">
						Maximum nodes to display
					</label>
					<div className="flex items-center gap-3">
						<input
							id="document-graph-max-nodes"
							type="range"
							min={50}
							max={1000}
							step={50}
							value={documentGraphMaxNodes}
							onChange={(event) => setDocumentGraphMaxNodes(Number(event.target.value))}
							className="flex-1 h-2 rounded-lg appearance-none cursor-pointer"
							style={{
								background: `linear-gradient(to right, ${theme.colors.accent} 0%, ${theme.colors.accent} ${maxNodePercentage}%, ${theme.colors.bgActivity} ${maxNodePercentage}%, ${theme.colors.bgActivity} 100%)`,
							}}
						/>
						<span
							className="text-sm font-mono w-12 text-right"
							style={{ color: theme.colors.textMain }}
						>
							{documentGraphMaxNodes}
						</span>
					</div>
					<p className="text-xs opacity-50 mt-1">
						Limits initial graph size for performance. Use &quot;Load more&quot; to show additional
						nodes.
					</p>
				</div>
			</SectionCard>
		</div>
	);
}
