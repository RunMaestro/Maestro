/**
 * The Conductor router: context assembly, grammar-constrained decisions, recall
 * matching, and the routing log.
 *
 * Everything here sits between a settled transcript and the dispatch executor.
 * Nothing here performs a dispatch or touches a window - that is
 * `../dispatch/route-executor.ts`, and the separation is what lets the routing
 * rules be tested without an Electron window.
 */

export {
	createConductorRouter,
	isCorrectionUtterance,
	planCorrection,
	DEFAULT_CONFIDENCE_THRESHOLD,
	type ConductorRouter,
	type ConductorRouterOptions,
	type CorrectionPlan,
} from './conductor-router';
export {
	ConductorAgentBrain,
	createConductorAgentBrain,
	CONDUCTOR_AGENT_TIMEOUT_MS,
	type ConductorAgentOptions,
	type ConductorProcessManager,
} from './conductor-agent';
export {
	compileRouteDecisionGrammar,
	rosterScope,
	routeDecisionSchema,
	validateRouteDecision,
	UnsupportedSchemaError,
	type CompiledRouteGrammar,
	type GrammarValidation,
	type RouteGrammarScope,
} from './grammar';
export {
	buildRoutingContext,
	buildRoutingRoster,
	deriveTabTopic,
	getRoutingContext,
	invalidateRoutingContext,
	serializeRoutingContext,
	MAX_CONTEXT_CHARS,
	type RoutingContext,
	type RoutingContextSources,
} from './routing-context';
export {
	flushRoutingLog,
	lastRoutingTurn,
	loadRoutingLog,
	noteRoutingOutcome,
	readRoutingLog,
	recordRoutingTurn,
	resetRoutingLog,
	routingQuality,
	setRoutingLogPath,
	MAX_ENTRIES,
	type RoutingLogEntry,
	type RoutingOutcome,
	type RoutingQuality,
} from './routing-log';
export {
	narrowRosterForRecall,
	rankRecallCandidates,
	resolveRecall,
	DEFAULT_RECALL_LIMIT,
	type RecallCandidate,
	type RecallRankingOptions,
	type RecallResolution,
} from './tab-recall';
