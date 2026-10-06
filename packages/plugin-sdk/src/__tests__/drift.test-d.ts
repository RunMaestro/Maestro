/**
 * Compile-time drift guard for the vendored contribution SHAPES.
 *
 * The runtime guard (drift.test.ts) compares vocabularies and catalogs
 * (capabilities, tiers, topics, methods, surfaces) but cannot see a new or
 * changed FIELD on a contribution interface. These type-level assertions fail
 * `tsc` the moment a vendored shape falls behind its host source - e.g. a new
 * field on `UiItemContribution` or a new contribution array on
 * `PluginContributions` / `AggregatedContributions` that wasn't vendored.
 *
 * Run via vitest typecheck (see vitest.config.ts `typecheck`), which compiles
 * this file with tsconfig.test.json so it may reach into ../../../../src.
 */

import { expectTypeOf } from 'vitest';
import type {
	MaestroServicesApi,
	TranscriptionInvocation,
	TranscriptionResult,
	PluginServiceStatus,
} from '../index';
import type {
	MaestroServicesApi as SrcServicesApi,
	TranscriptionInvocation as SrcInvocation,
	TranscriptionResult as SrcResult,
	PluginServiceStatus as SrcStatus,
} from '../../../../src/shared/plugins/services';
expectTypeOf<MaestroServicesApi>().toEqualTypeOf<SrcServicesApi>();
expectTypeOf<TranscriptionInvocation>().toEqualTypeOf<SrcInvocation>();
expectTypeOf<TranscriptionResult>().toEqualTypeOf<SrcResult>();
expectTypeOf<PluginServiceStatus>().toEqualTypeOf<SrcStatus>();
import type {
	UiItemContribution,
	HostViewContribution,
	HostViewBlocks,
	PluginContributions,
	AggregatedContributions,
	ManifestValidationResult,
	PluginCategory,
	PluginEventPayloads,
	PluginManifest,
	PluginUiMountAttempt,
	PluginUiMountValidation,
	PluginUiSurface,
	ProtectedUiSurface,
	UiSurface,
} from '../index';
import type {
	UiItemContribution as SrcUiItemContribution,
	HostViewContribution as SrcHostViewContribution,
	HostViewBlocks as SrcHostViewBlocks,
	PluginContributions as SrcPluginContributions,
	AggregatedContributions as SrcAggregatedContributions,
	PluginUiMountAttempt as SrcPluginUiMountAttempt,
	PluginUiMountValidation as SrcPluginUiMountValidation,
	PluginUiSurface as SrcPluginUiSurface,
	ProtectedUiSurface as SrcProtectedUiSurface,
	UiSurface as SrcUiSurface,
} from '../../../../src/shared/plugins/contributions';
import type { PluginEventPayloads as SrcPluginEventPayloads } from '../../../../src/shared/plugins/events';
import type {
	PluginCategory as SrcPluginCategory,
	PluginManifest as SrcPluginManifest,
	ManifestValidationResult as SrcManifestValidationResult,
} from '../../../../src/shared/plugins/plugin-manifest';
expectTypeOf<UiItemContribution>().toEqualTypeOf<SrcUiItemContribution>();
expectTypeOf<HostViewContribution>().toEqualTypeOf<SrcHostViewContribution>();
expectTypeOf<HostViewBlocks>().toEqualTypeOf<SrcHostViewBlocks>();
expectTypeOf<PluginContributions>().toEqualTypeOf<SrcPluginContributions>();
expectTypeOf<AggregatedContributions>().toEqualTypeOf<SrcAggregatedContributions>();
expectTypeOf<PluginUiSurface>().toEqualTypeOf<SrcPluginUiSurface>();
expectTypeOf<ProtectedUiSurface>().toEqualTypeOf<SrcProtectedUiSurface>();
expectTypeOf<UiSurface>().toEqualTypeOf<SrcUiSurface>();
expectTypeOf<PluginUiMountAttempt>().toEqualTypeOf<SrcPluginUiMountAttempt>();
expectTypeOf<PluginUiMountValidation>().toEqualTypeOf<SrcPluginUiMountValidation>();
expectTypeOf<PluginEventPayloads>().toEqualTypeOf<SrcPluginEventPayloads>();
expectTypeOf<PluginCategory>().toEqualTypeOf<SrcPluginCategory>();
expectTypeOf<PluginManifest>().toEqualTypeOf<SrcPluginManifest>();
expectTypeOf<ManifestValidationResult>().toEqualTypeOf<SrcManifestValidationResult>();

import type {
	MaestroMediaApi,
	MediaProbe,
	MediaRunOptions,
	MediaToolStatus,
	MediaFailure,
} from '../index';
import type {
	MaestroMediaApi as SrcMediaApi,
	MediaProbe as SrcMediaProbe,
	MediaRunOptions as SrcMediaOptions,
	MediaToolStatus as SrcMediaStatus,
	MediaFailure as SrcMediaFailure,
} from '../../../../src/shared/plugins/media-tools';
expectTypeOf<MaestroMediaApi>().toEqualTypeOf<SrcMediaApi>();
expectTypeOf<MediaProbe>().toEqualTypeOf<SrcMediaProbe>();
expectTypeOf<MediaRunOptions>().toEqualTypeOf<SrcMediaOptions>();
expectTypeOf<MediaToolStatus>().toEqualTypeOf<SrcMediaStatus>();
expectTypeOf<MediaFailure>().toEqualTypeOf<SrcMediaFailure>();
