import { Lock, Music, Plus, X } from 'lucide-react';
import { SYMPHONY_REGISTRY_URL } from '../../../../../../shared/symphony-constants';
import type { Theme } from '../../../../../types';
import type { SymphonyRegistryState } from '../types';
import { EncoreFeatureCard } from './EncoreFeatureCard';

interface SymphonyRegistrySectionProps {
	theme: Theme;
	enabled: boolean;
	open: boolean;
	onToggleOpen: () => void;
	onManage: () => void;
	symphonyRegistryUrls: string[];
	registryState: SymphonyRegistryState;
}

export function SymphonyRegistrySection({
	theme,
	enabled,
	open,
	onToggleOpen,
	onManage,
	symphonyRegistryUrls,
	registryState,
}: SymphonyRegistrySectionProps) {
	return (
		<div data-setting-id="encore-symphony">
			<EncoreFeatureCard
				theme={theme}
				enabled={enabled}
				open={open}
				onToggleOpen={onToggleOpen}
				onManage={onManage}
				icon={Music}
				title="Maestro Symphony"
				description="Contribute to open source projects through curated repositories"
				contentClassName="space-y-3"
			>
				<div className="pt-3">
					<label
						className="block text-xs font-bold opacity-70 uppercase mb-2"
						style={{ color: theme.colors.textMain }}
					>
						Registry Sources
					</label>
					<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
						Repositories are loaded from all configured registry URLs. The default registry cannot
						be removed.
					</p>

					<div
						className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-mono mb-2"
						style={{
							backgroundColor: theme.colors.bgActivity,
							border: `1px solid ${theme.colors.border}`,
						}}
					>
						<Lock className="w-3 h-3 flex-shrink-0" style={{ color: theme.colors.textDim }} />
						<span className="truncate flex-1" style={{ color: theme.colors.textMain }}>
							{SYMPHONY_REGISTRY_URL}
						</span>
						<span
							className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0"
							style={{
								color: theme.colors.textDim,
								backgroundColor: theme.colors.border,
							}}
						>
							default
						</span>
					</div>

					{symphonyRegistryUrls.map((url) => (
						<div
							key={url}
							className="flex items-center gap-2 px-2 py-1.5 rounded text-xs font-mono mb-1"
							style={{
								backgroundColor: theme.colors.bgActivity,
								border: `1px solid ${theme.colors.border}`,
							}}
						>
							<span className="truncate flex-1" style={{ color: theme.colors.textMain }}>
								{url}
							</span>
							<button
								type="button"
								onClick={() => registryState.removeRegistryUrl(url)}
								className="p-0.5 rounded hover:bg-white/10 transition-colors flex-shrink-0"
								style={{ color: theme.colors.error }}
								title="Remove registry URL"
							>
								<X className="w-3 h-3" />
							</button>
						</div>
					))}

					<div className="flex items-center gap-2 mt-3">
						<div className="flex-1 relative">
							<input
								type="text"
								value={registryState.newRegistryUrl}
								onChange={(event) => registryState.setNewRegistryUrl(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault();
										registryState.addRegistryUrl();
									}
								}}
								placeholder="https://example.com/registry.json"
								className="w-full px-3 py-2 rounded text-sm font-mono outline-none"
								style={{
									backgroundColor: theme.colors.bgActivity,
									borderColor: registryState.registryUrlError
										? theme.colors.error
										: theme.colors.border,
									border: '1px solid',
									color: theme.colors.textMain,
								}}
							/>
							{registryState.registryUrlError && (
								<p
									className="absolute -bottom-4 left-0 text-[10px]"
									style={{ color: theme.colors.error }}
								>
									{registryState.registryUrlError}
								</p>
							)}
						</div>
						<button
							type="button"
							onClick={registryState.addRegistryUrl}
							disabled={!registryState.newRegistryUrl.trim()}
							className="flex items-center gap-1.5 px-3 py-2 rounded text-sm font-medium transition-colors disabled:opacity-50"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.bgMain,
							}}
						>
							<Plus className="w-4 h-4" /> Add
						</button>
					</div>
				</div>
			</EncoreFeatureCard>
		</div>
	);
}
