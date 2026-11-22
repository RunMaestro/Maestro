import { isWebDesktop } from '../../../utils/runtimeContext';
import { Mic } from 'lucide-react';
import {
	OFF_ASSIGNMENT,
	resolveLocalModelAssignment,
	withLocalModelAssignment,
} from '../../../../shared/local-models/tasks';
import { useLocalModels } from '../../../hooks/localModels/useLocalModels';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { Theme } from '../../../types';
import { ThemedSelect } from '../../shared/ThemedSelect';
import { SettingsSectionHeading } from '../SettingsSectionHeading';
import { SectionCard } from '../tabs/DisplayTab/components/SectionCard';

export function DictationSettings({ theme }: { theme: Theme }) {
	return isWebDesktop() ? null : <DesktopDictationSettings theme={theme} />;
}

function DesktopDictationSettings({ theme }: { theme: Theme }) {
	const assignments = useSettingsStore((state) => state.localModelAssignments);
	const { listings, download, progress, error } = useLocalModels();
	const speechModels = listings.filter(({ entry }) => entry.kind === 'stt');
	const assignment = resolveLocalModelAssignment(assignments, 'dictation');
	const selected = assignment.type === 'local' ? assignment.modelId : assignment.type;
	const listing = speechModels.find(({ entry }) => entry.id === selected);
	const languages = listing?.entry.speechToText?.languages ?? [];

	function selectModel(modelId: string) {
		const settings = useSettingsStore.getState();
		const model = speechModels.find(({ entry }) => entry.id === modelId);
		const currentLanguage = assignment.type === 'local' ? assignment.language : undefined;
		const language =
			currentLanguage && model?.entry.speechToText?.languages.includes(currentLanguage)
				? currentLanguage
				: undefined;
		settings.setLocalModelAssignments(
			withLocalModelAssignment(
				settings.localModelAssignments,
				'dictation',
				model ? { type: 'local', modelId, ...(language && { language }) } : OFF_ASSIGNMENT
			)
		);
	}

	return (
		<div data-setting-id="general-dictation">
			<SettingsSectionHeading icon={Mic}>Dictation</SettingsSectionHeading>
			<SectionCard theme={theme}>
				<ThemedSelect
					theme={theme}
					aria-label="Dictation model"
					value={selected}
					options={[
						{ value: 'off', label: 'Off' },
						...(assignment.type === 'endpoint'
							? [{ value: 'endpoint', label: 'Configured endpoint' }]
							: []),
						...speechModels.map(({ entry }) => ({ value: entry.id, label: entry.displayName })),
					]}
					onChange={selectModel}
				/>
				{assignment.type === 'local' && languages.length > 1 && (
					<ThemedSelect
						theme={theme}
						aria-label="Dictation language"
						value={assignment.language ?? ''}
						options={[
							{ value: '', label: 'Model default language' },
							...languages.map((language) => ({ value: language, label: language })),
						]}
						onChange={(language) => {
							const settings = useSettingsStore.getState();
							settings.setLocalModelAssignments(
								withLocalModelAssignment(settings.localModelAssignments, 'dictation', {
									type: 'local',
									modelId: assignment.modelId,
									...(language && { language }),
								})
							);
						}}
					/>
				)}
				{listing && listing.status.status !== 'installed' && (
					<button
						type="button"
						className="focus-ring rounded border px-3 py-2 text-sm"
						disabled={!!progress[listing.entry.id]}
						onClick={() => void download(listing.entry.id)}
					>
						Download {listing.entry.displayName}
					</button>
				)}
				{error && <p role="alert">{error}</p>}
			</SectionCard>
		</div>
	);
}
