/**
 * Web Server Routes Index
 *
 * Re-exports all route modules for the web server.
 */

export {
	ApiRoutes,
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

export { StaticRoutes } from './staticRoutes';

export {
	WsRoute,
	WsRouteCallbacks,
	WsSessionData,
	LiveSessionInfo as WsLiveSessionInfo,
	CustomAICommand as WsCustomAICommand,
} from './wsRoute';
