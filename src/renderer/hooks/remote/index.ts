/**
 * Remote/Web Integration Module
 *
 * Hooks for web client communication, live sessions, tunneling, and CLI activity.
 */

// Web client communication
export { useRemoteIntegration } from './useRemoteIntegration';
export type { UseRemoteIntegrationDeps, UseRemoteIntegrationReturn } from './useRemoteIntegration';

// Live overlay panel state
export { useLiveOverlay } from './useLiveOverlay';
export type { UseLiveOverlayReturn, TunnelStatus, UrlTab } from './useLiveOverlay';

// Event broadcasting to web clients
export { useWebBroadcasting } from './useWebBroadcasting';
export type { UseWebBroadcastingDeps, UseWebBroadcastingReturn } from './useWebBroadcasting';

// Mobile landscape detection
export { useMobileLandscape } from './useMobileLandscape';

// CLI activity detection
export { useCliActivityMonitoring } from './useCliActivityMonitoring';
export type {
	UseCliActivityMonitoringDeps,
	UseCliActivityMonitoringReturn,
} from './useCliActivityMonitoring';

// SSH remote configuration management
export { useSshRemotes } from './useSshRemotes';
export type { UseSshRemotesReturn } from './useSshRemotes';

// Remote command handling & SSH name mapping (Phase 2K)
export { useRemoteHandlers } from './useRemoteHandlers';
export type { UseRemoteHandlersDeps, UseRemoteHandlersReturn } from './useRemoteHandlers';

// Global live mode (web interface) management (Tier 3B)
export { useLiveMode } from './useLiveMode';
export type { UseLiveModeReturn } from './useLiveMode';
