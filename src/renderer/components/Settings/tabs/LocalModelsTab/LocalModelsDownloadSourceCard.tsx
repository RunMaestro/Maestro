/**
 * LocalModelsDownloadSourceCard - where model files are downloaded from.
 *
 * Models come from Hugging Face. On a network that blocks it, the user points
 * this at a mirror that serves the same paths; the downloader and Add from
 * Hugging Face then request from there. It changes the host and nothing else:
 * every file is still checked against the hash the catalog (or the repo's own
 * metadata, for a model the user added) pins, so a mirror that serves different
 * bytes produces a failed download, not a model.
 *
 * The value is the `localModelsDownloadBase` setting, validated by the shared
 * `downloadBaseProblem()` the CLI uses. An empty field or the word `default`
 * means Hugging Face. Saving sends nothing: the next download uses it.
 */

import { useEffect, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';

import {
	DEFAULT_DOWNLOAD_BASE,
	downloadBaseProblem,
	downloadSourceName,
	isMirrorDownloadBase,
	normalizeDownloadBase,
} from '../../../../../shared/local-models/download-base';
import { useSettingsStore } from '../../../../stores/settingsStore';
import type { Theme } from '../../../../types';
import { FormInput } from '../../../ui/FormInput';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { CardButton } from './CardButton';

export interface LocalModelsDownloadSourceCardProps {
	theme: Theme;
}

export function LocalModelsDownloadSourceCard({ theme }: LocalModelsDownloadSourceCardProps) {
	const saved = useSettingsStore((s) => s.localModelsDownloadBase);
	const setSaved = useSettingsStore((s) => s.setLocalModelsDownloadBase);
	const [draft, setDraft] = useState(saved);
	// A change from outside (`maestro-cli models config set`) replaces the field.
	useEffect(() => setDraft(saved), [saved]);

	const problem = downloadBaseProblem(draft);
	const next = problem === null ? normalizeDownloadBase(draft) : null;
	const changed = next !== null && next !== saved;
	const mirror = isMirrorDownloadBase(saved);

	return (
		<SectionCard theme={theme}>
			<div data-testid="local-models-download-source">
				<div className="font-medium" style={{ color: theme.colors.textMain }}>
					Download source
				</div>
				<p className="text-xs opacity-70 mt-0.5">
					Models download from {DEFAULT_DOWNLOAD_BASE}. If your network blocks it, enter a mirror
					that serves the same paths. Every download is still checked against its hash.
				</p>
			</div>
			<FormInput
				theme={theme}
				label="Download base URL"
				value={draft}
				onChange={setDraft}
				onSubmit={() => next !== null && setSaved(next)}
				submitEnabled={changed}
				placeholder={DEFAULT_DOWNLOAD_BASE}
				error={problem ?? undefined}
				helperText={
					mirror
						? `Downloading from ${downloadSourceName(saved)}.`
						: 'Downloading from Hugging Face.'
				}
				monospace
				testId="local-models-download-source-input"
			/>
			<div className="flex flex-wrap gap-2">
				<CardButton
					theme={theme}
					icon={Check}
					label="Save"
					disabled={!changed}
					primary
					onClick={() => {
						if (next === null) return;
						setSaved(next);
						setDraft(next);
					}}
					testId="local-models-download-source-save"
				/>
				<CardButton
					theme={theme}
					icon={RotateCcw}
					label="Use Hugging Face"
					disabled={!mirror && draft === DEFAULT_DOWNLOAD_BASE}
					onClick={() => {
						setSaved(DEFAULT_DOWNLOAD_BASE);
						setDraft(DEFAULT_DOWNLOAD_BASE);
					}}
					testId="local-models-download-source-reset"
				/>
			</div>
		</SectionCard>
	);
}
