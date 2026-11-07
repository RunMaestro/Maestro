/**
 * Local Models Module - the renderer side of the core Local Models service.
 *
 * Listing, downloading, verifying, and deleting local models, and installing the
 * native runtimes they run on. Consumers with their own gated channels (A
 * Cappella) wrap these hooks rather than keeping a second state machine.
 */

export { useLocalModels } from './useLocalModels';
export type { LocalModelsSource, LocalModelsState, UseLocalModelsOptions } from './useLocalModels';
export { useLocalModelsHardware } from './useLocalModelsHardware';
export type { LocalModelsHardwareState } from './useLocalModelsHardware';
export { useLocalRuntimes } from './useLocalRuntimes';
export type {
	LocalRuntimesSource,
	LocalRuntimesState,
	UseLocalRuntimesOptions,
} from './useLocalRuntimes';
export { useLocalModelEndpoints } from './useLocalModelEndpoints';
export type {
	EndpointCallFailure,
	EndpointModelsState,
	EndpointTestState,
	EndpointTestVerdict,
	LocalModelEndpointsState,
} from './useLocalModelEndpoints';
export { useLocalModelTaskReadiness } from './useLocalModelTaskReadiness';
export type { LocalModelTaskReadinessState } from './useLocalModelTaskReadiness';
export { useSemanticIndexStatus } from './useSemanticIndexStatus';
export type { SemanticIndexStatusState } from './useSemanticIndexStatus';
export {
	SEMANTIC_SEARCH_DEBOUNCE_MS,
	useSemanticSearch,
	useSemanticSearchReady,
} from './useSemanticSearch';
export type { SemanticSearchState, UseSemanticSearchOptions } from './useSemanticSearch';
export { useTokenProxyReport } from './useTokenProxyReport';
export type { TokenProxyReportState } from './useTokenProxyReport';
export { useTokenProxyModeChoice } from './useTokenProxyModeChoice';
export type {
	TokenProxyModeChoiceState,
	UseTokenProxyModeChoiceOptions,
} from './useTokenProxyModeChoice';
export { MODEL_SERVER_POLL_MS, useModelServer } from './useModelServer';
export type { ModelServerBusy, ModelServerHookState } from './useModelServer';
export { useRunOnSources } from './useRunOnSources';
export type { RunOnSourceProblem, RunOnSourcesState } from './useRunOnSources';
export { useHarnessTierOptions } from './useHarnessTierOptions';
export type { HarnessTierOptionsState } from './useHarnessTierOptions';
export { useSystemOne } from './useSystemOne';
export type { SystemOneBusy, SystemOneHookState } from './useSystemOne';
export { useSystemOneLedger } from './useSystemOneLedger';
export type { SystemOneLedgerFilters, SystemOneLedgerState } from './useSystemOneLedger';
export { useSystemOneUsage } from './useSystemOneUsage';
export type { SystemOneUsageState } from './useSystemOneUsage';
export { useSystemOneAgentAccess } from './useSystemOneAgentAccess';
export type { SystemOneAgentAccessState } from './useSystemOneAgentAccess';
