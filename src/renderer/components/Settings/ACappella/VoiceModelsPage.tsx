/**
 * Models - what A Cappella is holding on your disk, and how to get it back.
 *
 * Voice Setup is about acquiring models; this page is about owning them. It
 * shows the installed set with size, install date, and last-verified date, and
 * puts Remove and Re-verify next to each one.
 *
 * The reclaim-disk offer appears when the A Cappella Encore Feature is switched
 * OFF, which is the moment it matters: a feature you have stopped using should
 * not keep 1.4 GB without saying so. It deletes only the A Cappella model root
 * (`userData/models/acappella`) and confirms first, because a one-click delete
 * of a gigabyte the user might be about to re-enable is not a kindness.
 *
 * Stat rows come from the shared widget library (`StatCardGrid`) rather than a
 * new one-off card.
 */

import { useCallback, useMemo, useState } from 'react';
import { HardDrive } from 'lucide-react';

import { formatRelativeTime, formatSize } from '../../../../shared/formatters';
import type { Theme } from '../../../types';
import { StatCardGrid, type StatCardDatum } from '../../widgets';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';
import { VoiceModelRow } from './VoiceModelRow';
import { VoiceLatencyCard } from './VoiceLatencyCard';
import { VoiceSelfTestCard } from './VoiceSelfTestCard';
import { useVoiceModels } from './useVoiceModels';

export interface VoiceModelsPageProps {
	theme: Theme;
	/** Mirror of the A Cappella Encore flag. Drives the reclaim-disk offer. */
	enabled: boolean;
}

export function VoiceModelsPage({ theme, enabled }: VoiceModelsPageProps) {
	const models = useVoiceModels(enabled);
	const [confirmingReclaim, setConfirmingReclaim] = useState(false);

	const installed = useMemo(
		() => models.listings.filter((listing) => listing.status.bytesOnDisk > 0),
		[models.listings]
	);

	const cards = useMemo<StatCardDatum[]>(() => {
		const footprintBytes = models.footprint?.bytes ?? 0;
		const installedCount = models.listings.filter(
			(listing) => listing.status.status === 'installed'
		).length;
		const corruptCount = models.listings.filter(
			(listing) => listing.status.status === 'corrupt'
		).length;
		return [
			{ label: 'On disk', value: footprintBytes, displayValue: formatSize(footprintBytes) },
			{ label: 'Installed', value: installedCount },
			{
				label: 'Needs attention',
				value: corruptCount,
				color: corruptCount > 0 ? theme.colors.warning : undefined,
			},
		];
	}, [models.footprint, models.listings, theme.colors.warning]);

	const handleReclaim = useCallback(async () => {
		setConfirmingReclaim(false);
		await models.removeAll();
	}, [models]);

	const footprintBytes = models.footprint?.bytes ?? 0;

	return (
		<div data-setting-id="encore-a-cappella-models" className="select-none space-y-5">
			<div>
				<SettingsSectionHeading icon={HardDrive}>Models on disk</SettingsSectionHeading>
				<SectionCard theme={theme}>
					<StatCardGrid theme={theme} cards={cards} />

					{models.footprint && models.footprint.models.length > 0 && (
						<p className="text-[11px] opacity-55 select-text">
							{models.footprint.models
								.map((model) => `${model.id} ${formatSize(model.bytes)}`)
								.join(' - ')}
						</p>
					)}

					{!enabled && footprintBytes > 0 && (
						<div className="space-y-2">
							<p className="text-xs opacity-70">
								A Cappella is switched off but is still holding {formatSize(footprintBytes)} of
								model files. Removing them frees the space; turning the feature back on will offer
								to download them again.
							</p>
							{confirmingReclaim ? (
								<div className="flex flex-wrap gap-2">
									<button
										type="button"
										onClick={() => void handleReclaim()}
										className="px-2 py-1 rounded border text-xs"
										style={{
											borderColor: theme.colors.warning,
											color: theme.colors.warning,
											backgroundColor: 'transparent',
										}}
									>
										Delete {formatSize(footprintBytes)} of A Cappella models
									</button>
									<button
										type="button"
										onClick={() => setConfirmingReclaim(false)}
										className="px-2 py-1 rounded border text-xs"
										style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
									>
										Keep them
									</button>
								</div>
							) : (
								<button
									type="button"
									data-setting-id="encore-a-cappella-reclaim-disk"
									onClick={() => setConfirmingReclaim(true)}
									className="px-2 py-1 rounded border text-xs"
									style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
								>
									Reclaim {formatSize(footprintBytes)}
								</button>
							)}
						</div>
					)}

					{installed.length === 0 && (
						<p className="text-xs opacity-70">
							No A Cappella models are installed. Voice Setup lists what each one is for and what it
							costs in disk.
						</p>
					)}
				</SectionCard>
			</div>

			{/* Below the disk card and above the per-model rows: the question "is any
			    of this actually working" comes after "what is installed" and before
			    the detail of each one. */}
			<VoiceSelfTestCard theme={theme} />

			<VoiceLatencyCard theme={theme} />

			{installed.map((listing) => (
				<div key={listing.entry.id}>
					<SectionCard theme={theme}>
						<div className="text-[11px] opacity-55">
							{listing.status.manifest
								? `Installed ${formatRelativeTime(listing.status.manifest.installedAt)} - last verified ${formatRelativeTime(listing.status.manifest.verifiedAt)} - ${formatSize(listing.status.bytesOnDisk)} on disk`
								: `${formatSize(listing.status.bytesOnDisk)} on disk with no manifest`}
						</div>
						<VoiceModelRow
							theme={theme}
							listing={listing}
							compact
							progress={models.progress[listing.entry.id]}
							verifyResult={models.verifyResults[listing.entry.id]}
							onDownload={(id) => void models.download(id)}
							onPause={(id) => void models.pause(id)}
							onResume={(id) => void models.resume(id)}
							onCancel={(id) => void models.cancel(id)}
							onVerify={(id) => void models.verify(id)}
							onRemove={(id) => void models.remove(id)}
						/>
					</SectionCard>
				</div>
			))}
		</div>
	);
}
