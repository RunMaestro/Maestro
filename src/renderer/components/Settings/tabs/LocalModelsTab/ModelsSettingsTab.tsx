/**
 * ModelsSettingsTab - the Models settings tab: everything model-related. The
 * Models row in the Settings sidebar opens the Overview, and five panels are
 * drawn as a subtree under it.
 *
 * - Overview: what Local Models is for, where this computer stands, and a card
 *   per panel that jumps to it (`ModelsOverview`).
 * - Library: models on this machine, in sections behind its own tab strip
 *   (Engines, Agent Models, Housekeeping, Speech, Search & Safety, Custom).
 * - Sources: where models come from besides the Library: model servers and
 *   user endpoints, Maestro's own model server that serves the Library's text
 *   models over HTTP, the models that are cloud only, and the Hugging Face
 *   mirror model files download from.
 * - System One: the engine that answers typed questions (Jev, OpenJev, or a
 *   local judge) with its key and Test, then the tasks whose output is a
 *   judgment (a decision, label, score, vector or transcript), with their
 *   assignments and fail policies, then what agents may ask and spend, and
 *   the decision ledger.
 * - System Two: the tasks whose output is text for someone to read or run,
 *   with their assignments, the Utility Agent, and the harness tier defaults
 *   (which model a low, medium or high task launches on).
 * - Gateway: the proxy each agent's own provider traffic goes through, and
 *   what the Maestro token proxy carried.
 *
 * Which panel and Library section are open is `useModelsSettingsNav`, owned by
 * `SettingsModal` because its sidebar draws the panels; this tab draws what the
 * nav says. Which system a task belongs to is `LocalModelTaskDefinition.system`,
 * read through `tasksForSystem`; nothing here sorts tasks by hand. The panel ids
 * and labels are `MODELS_SETTINGS_PANELS` in `shared/local-models/settings-location`,
 * the same words every "assign it in ..." message uses.
 *
 * It is a CORE tab, not an Encore Feature, and it starts empty: opening it
 * reads what is on disk and downloads nothing. Every download, detection, and
 * test is an explicit click inside a section.
 *
 * The tab owns the ONE `useLocalModels()`, `useLocalModelEndpoints()` and
 * `useSystemOne()` instance and hands it to each panel, so a download started
 * in Library or a model list refreshed in Sources is what the assignment
 * pickers offer, and the engine card and the fail policy column read one report.
 */

import {
	Brain,
	Cloud,
	Layers,
	Router,
	Server,
	SlidersHorizontal,
	Sparkles,
	type LucideIcon,
} from 'lucide-react';
import { CLOUD_ONLY_NOTE } from '../../../../../shared/local-models/library';
import {
	MODELS_SETTINGS_DETAIL_PANELS,
	MODELS_SETTINGS_PANEL_LABELS,
	type ModelsSettingsPanel,
} from '../../../../../shared/local-models/settings-location';
import {
	useLocalModelEndpoints,
	useLocalModels,
	useLocalRuntimes,
	useSystemOne,
} from '../../../../hooks/localModels';
import type { Theme } from '../../../../types';
import { SettingsSectionHeading } from '../../SettingsSectionHeading';
import { SectionCard } from '../DisplayTab/components/SectionCard';
import { LocalModelsAssignmentsSection } from './LocalModelsAssignmentsSection';
import { LocalModelsDownloadSourceCard } from './LocalModelsDownloadSourceCard';
import { LocalModelsEndpointsSection } from './LocalModelsEndpointsSection';
import { LocalModelsGatewaySection } from './LocalModelsGatewaySection';
import { LocalModelsModelsSection } from './LocalModelsModelsSection';
import { LocalModelsServerSection } from './LocalModelsServerSection';
import { MODELS_SETTINGS_PANEL_ICONS, ModelsOverview } from './ModelsOverview';
import { SystemOneAgentsSection } from './SystemOneAgentsSection';
import { SystemOneEngineSection } from './SystemOneEngineCard';
import { SystemOneLedgerSection } from './SystemOneLedgerSection';
import { TierDefaultsSection } from './TierDefaultsSection';
import { UtilityAgentSettings } from './UtilityAgentSettings';
import type { ModelsSettingsNav } from './useModelsSettingsNav';

/**
 * The panels as the Settings sidebar draws them under Models, in order. The
 * Overview is not among them: it is what the Models row itself opens.
 */
export const MODELS_SETTINGS_NAV_ITEMS: readonly {
	id: ModelsSettingsPanel;
	label: string;
	icon: LucideIcon;
}[] = Object.freeze(
	MODELS_SETTINGS_DETAIL_PANELS.map((id) => ({
		id,
		label: MODELS_SETTINGS_PANEL_LABELS[id],
		icon: MODELS_SETTINGS_PANEL_ICONS[id],
	}))
);

export interface ModelsSettingsTabProps {
	theme: Theme;
	/** Which panel and Library section are open. `SettingsModal` owns it; its sidebar moves it. */
	nav: ModelsSettingsNav;
}

export function ModelsSettingsTab({ theme, nav }: ModelsSettingsTabProps) {
	const models = useLocalModels();
	const endpoints = useLocalModelEndpoints();
	const runtimes = useLocalRuntimes();
	const systemOne = useSystemOne();
	const { panel } = nav;

	return (
		<div className="space-y-5" data-testid="models-settings-tab" data-panel={panel}>
			{panel === 'overview' && (
				<ModelsOverview
					theme={theme}
					models={models}
					runtimes={runtimes}
					endpointCount={endpoints.endpoints.length}
					onOpen={nav.open}
				/>
			)}

			{panel === 'library' && (
				<div data-setting-id="local-models-models">
					<LocalModelsModelsSection
						theme={theme}
						models={models}
						runtimes={runtimes}
						section={nav.librarySection}
						onSectionChange={nav.setLibrarySection}
					/>
				</div>
			)}

			{panel === 'sources' && (
				<div data-setting-id="local-models-endpoints">
					<SettingsSectionHeading
						icon={Server}
						description="Where models come from besides the Library: model servers Maestro can call, such as Ollama, LM Studio, or any OpenAI-compatible URL."
					>
						Endpoints
					</SettingsSectionHeading>
					<LocalModelsEndpointsSection theme={theme} state={endpoints} />
				</div>
			)}

			{panel === 'sources' && <LocalModelsServerSection theme={theme} />}

			{panel === 'sources' && (
				<div data-testid="local-models-cloud-only">
					<SettingsSectionHeading icon={Cloud}>Cloud only</SettingsSectionHeading>
					<SectionCard theme={theme}>
						<p className="text-xs opacity-70 select-text">{CLOUD_ONLY_NOTE}</p>
					</SectionCard>
				</div>
			)}

			{panel === 'sources' && (
				<div data-setting-id="local-models-download-source">
					<SettingsSectionHeading
						icon={SlidersHorizontal}
						description="Where model files are downloaded from, for networks that block Hugging Face. It covers every model download and Add from Hugging Face; engines come from npm and are not affected."
					>
						Advanced
					</SettingsSectionHeading>
					<LocalModelsDownloadSourceCard theme={theme} />
				</div>
			)}

			{panel === 'system-one' && <SystemOneEngineSection theme={theme} systemOne={systemOne} />}

			{panel === 'system-one' && (
				<div data-setting-id="local-models-system-one">
					<SettingsSectionHeading
						icon={Brain}
						description="Fast judgments. A task here returns a decision, label, score, vector, or transcript, never text for someone to read. A task left Off keeps its existing behavior."
					>
						{MODELS_SETTINGS_PANEL_LABELS['system-one']}
					</SettingsSectionHeading>
					<LocalModelsAssignmentsSection
						theme={theme}
						system="one"
						models={models}
						endpoints={endpoints}
						// The column is there from the first paint (a settings search can
						// land on it); its values wait for the report, so a row never shows
						// a default in place of the user's choice.
						failPolicies={{
							rows: systemOne.report?.failPolicies ?? [],
							disabled: systemOne.busy !== null,
							onChange: (taskId, policy) => void systemOne.set({ failPolicy: { taskId, policy } }),
						}}
						// Until the report arrives no engine is known, so System One is
						// not offered as a source; a task already on it still shows it.
						systemOneEngine={
							systemOne.report
								? {
										engine: systemOne.report.settings.engine,
										problem: systemOne.report.problem,
									}
								: undefined
						}
					/>
				</div>
			)}

			{panel === 'system-one' && <SystemOneAgentsSection theme={theme} systemOne={systemOne} />}

			{panel === 'system-one' && <SystemOneLedgerSection theme={theme} systemOne={systemOne} />}

			{panel === 'system-two' && (
				<>
					<UtilityAgentSettings theme={theme} />
					<div data-setting-id="local-models-system-two">
						<SettingsSectionHeading
							icon={Sparkles}
							description="Generation. A task here writes text for someone to read or run. A task left Off keeps its existing behavior."
						>
							{MODELS_SETTINGS_PANEL_LABELS['system-two']}
						</SettingsSectionHeading>
						<LocalModelsAssignmentsSection
							theme={theme}
							system="two"
							models={models}
							endpoints={endpoints}
						/>
					</div>
					<div data-setting-id="models-tier-defaults">
						<SettingsSectionHeading
							icon={Layers}
							description="Which model a low, medium or high task launches on, per harness. Auto Run and Cue tasks ask for a tier; an agent can override a tier in its own settings."
						>
							Tier defaults
						</SettingsSectionHeading>
						<TierDefaultsSection theme={theme} endpoints={endpoints.endpoints} />
					</div>
				</>
			)}

			{panel === 'gateway' && (
				<div data-setting-id="local-models-gateway">
					<SettingsSectionHeading
						icon={Router}
						description="Send an agent's provider traffic through a proxy: Headroom, LiteLLM, or Maestro's own token proxy, and see what it carried."
					>
						{MODELS_SETTINGS_PANEL_LABELS.gateway}
					</SettingsSectionHeading>
					<LocalModelsGatewaySection theme={theme} />
				</div>
			)}
		</div>
	);
}
