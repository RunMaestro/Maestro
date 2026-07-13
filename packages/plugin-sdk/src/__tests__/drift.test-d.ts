/**
 * Compile-time drift guard for the vendored contribution SHAPES.
 *
 * The runtime guard (drift.test.ts) compares vocabularies and catalogs
 * (capabilities, tiers, topics, methods, surfaces) but cannot see a new or
 * changed FIELD on a contribution interface. These type-level assertions fail
 * `tsc` the moment a vendored shape falls behind its host source — e.g. a new
 * field on `UiItemContribution` or a new contribution array on
 * `PluginContributions` / `AggregatedContributions` that wasn't vendored.
 *
 * Run via vitest typecheck (see vitest.config.ts `typecheck`), which compiles
 * this file with tsconfig.test.json so it may reach into ../../../../src.
 */

import { expectTypeOf } from 'vitest';
import type {
	UiItemContribution,
	HostViewContribution,
	HostViewBlocks,
	PluginContributions,
	AggregatedContributions,
	PluginEventPayloads,
	PluginCategory,
	PluginManifest,
	ManifestValidationResult,
	WorkspaceContribution,
	InteractivePanelContribution,
	CanonicalWorkspaceFoundation,
	ClosedPanelBridge,
	CanonicalClosedPanelBridge,
	JsonValue,
	MaestroInteractivePanelOwnerApi,
	WorkspaceCapability,
	WorkspaceStatusSnapshot,
	MaestroWorkspaceApi,
	WorkspaceRootCapability,
	OmpSafeStartupOptions,
	InteractiveStopReason,
	InteractiveRuntimeHandle,
	RuntimeEvent,
	MaestroInteractiveRuntimeApi,
	MaestroSdk,
} from '../index';
import type {
	UiItemContribution as SrcUiItemContribution,
	HostViewContribution as SrcHostViewContribution,
	HostViewBlocks as SrcHostViewBlocks,
	PluginContributions as SrcPluginContributions,
	AggregatedContributions as SrcAggregatedContributions,
} from '../../../../src/shared/plugins/contributions';
import type { PluginEventPayloads as SrcPluginEventPayloads } from '../../../../src/shared/plugins/events';
import type {
	PluginCategory as SrcPluginCategory,
	PluginManifest as SrcPluginManifest,
	ManifestValidationResult as SrcManifestValidationResult,
} from '../../../../src/shared/plugins/plugin-manifest';
import type {
	WorkspaceContribution as SrcWorkspaceContribution,
	InteractivePanelContribution as SrcInteractivePanelContribution,
	CanonicalWorkspaceFoundation as SrcCanonicalWorkspaceFoundation,
	CanonicalClosedPanelBridge as SrcCanonicalClosedPanelBridge,
} from '../../../../src/shared/plugins/workspace-foundation';
import type {
	WorkspaceCapability as SrcWorkspaceCapability,
	WorkspaceStatusSnapshot as SrcWorkspaceStatusSnapshot,
	MaestroWorkspaceApi as SrcMaestroWorkspaceApi,
} from '../../../../src/shared/plugins/workspace-foundation';
import type {
	WorkspaceRootCapability as SrcWorkspaceRootCapability,
	OmpSafeStartupOptions as SrcOmpSafeStartupOptions,
	InteractiveStopReason as SrcInteractiveStopReason,
	InteractiveRuntimeHandle as SrcInteractiveRuntimeHandle,
	RuntimeEvent as SrcRuntimeEvent,
	MaestroInteractiveRuntimeApi as SrcMaestroInteractiveRuntimeApi,
} from '../../../../src/shared/plugins/interactive-runtime';
import type {
	ClosedPanelBridge as SrcClosedPanelBridge,
	JsonValue as SrcJsonValue,
	MaestroInteractivePanelOwnerApi as SrcMaestroInteractivePanelOwnerApi,
} from '../../../../src/shared/plugins/interactive-panel';
expectTypeOf<UiItemContribution>().toEqualTypeOf<SrcUiItemContribution>();
expectTypeOf<HostViewContribution>().toEqualTypeOf<SrcHostViewContribution>();
expectTypeOf<HostViewBlocks>().toEqualTypeOf<SrcHostViewBlocks>();
expectTypeOf<PluginContributions>().toEqualTypeOf<SrcPluginContributions>();
expectTypeOf<AggregatedContributions>().toEqualTypeOf<SrcAggregatedContributions>();
expectTypeOf<PluginEventPayloads>().toEqualTypeOf<SrcPluginEventPayloads>();
expectTypeOf<PluginCategory>().toEqualTypeOf<SrcPluginCategory>();
expectTypeOf<PluginManifest>().toEqualTypeOf<SrcPluginManifest>();
expectTypeOf<ManifestValidationResult>().toEqualTypeOf<SrcManifestValidationResult>();
expectTypeOf<WorkspaceContribution>().toEqualTypeOf<SrcWorkspaceContribution>();
expectTypeOf<InteractivePanelContribution>().toEqualTypeOf<SrcInteractivePanelContribution>();
expectTypeOf<CanonicalWorkspaceFoundation>().toEqualTypeOf<SrcCanonicalWorkspaceFoundation>();
expectTypeOf<ClosedPanelBridge>().toEqualTypeOf<SrcClosedPanelBridge>();
expectTypeOf<CanonicalClosedPanelBridge>().toEqualTypeOf<SrcCanonicalClosedPanelBridge>();
expectTypeOf<JsonValue>().toEqualTypeOf<SrcJsonValue>();
expectTypeOf<WorkspaceCapability>().toEqualTypeOf<SrcWorkspaceCapability>();
expectTypeOf<WorkspaceStatusSnapshot>().toEqualTypeOf<SrcWorkspaceStatusSnapshot>();
expectTypeOf<MaestroWorkspaceApi>().toEqualTypeOf<SrcMaestroWorkspaceApi>();
expectTypeOf<WorkspaceRootCapability>().toEqualTypeOf<SrcWorkspaceRootCapability>();
expectTypeOf<OmpSafeStartupOptions>().toEqualTypeOf<SrcOmpSafeStartupOptions>();
expectTypeOf<InteractiveStopReason>().toEqualTypeOf<SrcInteractiveStopReason>();
expectTypeOf<InteractiveRuntimeHandle>().toEqualTypeOf<SrcInteractiveRuntimeHandle>();
expectTypeOf<RuntimeEvent>().toEqualTypeOf<SrcRuntimeEvent>();
expectTypeOf<MaestroInteractiveRuntimeApi>().toEqualTypeOf<SrcMaestroInteractiveRuntimeApi>();
expectTypeOf<MaestroSdk['interactiveRuntime']>().toEqualTypeOf<
	MaestroInteractiveRuntimeApi | undefined
>();
expectTypeOf<
	MaestroInteractiveRuntimeApi['requestWorkspaceRoot']
>().returns.resolves.toEqualTypeOf<WorkspaceRootCapability | null>();
type ActivationLeaksWorkspaceRoot = 'workspaceRoot' extends keyof MaestroSdk ? true : false;
expectTypeOf<ActivationLeaksWorkspaceRoot>().toEqualTypeOf<false>();
expectTypeOf<MaestroInteractivePanelOwnerApi>().toEqualTypeOf<SrcMaestroInteractivePanelOwnerApi>();
expectTypeOf<MaestroSdk['workspace']>().toEqualTypeOf<MaestroWorkspaceApi | undefined>();
expectTypeOf<MaestroSdk['interactivePanel']>().toEqualTypeOf<
	MaestroInteractivePanelOwnerApi | undefined
>();
