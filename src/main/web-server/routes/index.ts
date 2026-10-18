/**
 * Web Server Routes Index
 *
 * Re-exports all route modules for the web server.
 */

export { ApiRoutes } from './apiRoutes';
export type {
	ApiRouteCallbacks,
	SessionUsageStats,
	LastResponsePreview,
	AITabData,
	SessionData,
	SessionDetail,
	LiveSessionInfo as ApiLiveSessionInfo,
	RateLimitConfig,
} from './apiRoutes';

// Note: HistoryEntry type is exported from shared/types.ts (canonical location)

export { AuthRoutes } from './authRoutes';

export { ConcertoRoutes } from './concertoRoutes';

export { MediaRoutes } from './mediaRoutes';

export { ImageRoutes } from './imageRoutes';

export { StaticRoutes } from './staticRoutes';

export { WsRoute } from './wsRoute';
export type {
	WsRouteCallbacks,
	WsSessionData,
	LiveSessionInfo as WsLiveSessionInfo,
	CustomAICommand as WsCustomAICommand,
} from './wsRoute';
