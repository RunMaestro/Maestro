/**
 * The one import site for Maestro's vendored Dataview core (D1, DV-2). Everything outside
 * `src/shared/dataview/` imports from here, never from `./vendor/` directly, so an upstream
 * bump only has to keep this surface stable. See docs/agent-guides/DATAVIEW.md.
 */

export {
	Link,
	Values,
	Groupings,
	Widget,
	Widgets,
	ListPairWidget,
	ExternalLinkWidget,
} from './vendor/data-model/value';
export type {
	DataObject,
	Literal,
	LiteralType,
	LiteralRepr,
	WrappedLiteral,
	Grouping,
	GroupElement,
} from './vendor/data-model/value';
export { Result, Success, Failure } from './vendor/api/result';
export { DataArray } from './vendor/api/data-array';
export type { ArrayFunc, ArrayComparator, LowestKey, Ingrouped } from './vendor/api/data-array';
export { DEFAULT_QUERY_SETTINGS } from './vendor/settings';
export type { QuerySettings, ExportSettings } from './vendor/settings';
export { DataviewSettings } from './settings';
export { renderMinimalDate, renderMinimalDuration, getFileTitle } from './vendor/util/normalize';
export { currentLocale } from './vendor/util/locale';

export { parseQuery } from './vendor/query/parse';
export { QueryFields } from './vendor/query/query';
export type {
	Query,
	QueryType,
	QueryHeader,
	QueryOperation,
	QuerySortBy,
	NamedField,
	ListQuery,
	TableQuery,
	TaskQuery,
	CalendarQuery,
	WhereStep,
	SortByStep,
	LimitStep,
	FlattenStep,
	GroupStep,
	ExtractStep,
} from './vendor/query/query';
export { parseField, EXPRESSION } from './vendor/expression/parse';
export { Fields } from './vendor/expression/field';
export type {
	Field,
	BinaryOp,
	CompareOp,
	ArithmeticOp,
	LiteralField,
	VariableField,
	ListField,
	ObjectField,
	BinaryOpField,
	FunctionField,
	LambdaField,
	IndexField,
	NegatedField,
} from './vendor/expression/field';
export { Sources } from './vendor/data-index/source';
export type {
	Source,
	SourceOp,
	TagSource,
	CsvSource,
	FolderSource,
	LinkSource,
	NegatedSource,
	EmptySource,
	BinaryOpSource,
} from './vendor/data-index/source';

export { Context } from './vendor/expression/context';
export type { LinkHandler } from './vendor/expression/context';
export { DEFAULT_FUNCTIONS, Functions } from './vendor/expression/functions';
export type { FunctionImpl, BoundFunctionImpl } from './vendor/expression/functions';
export { defaultLinkHandler } from './vendor/query/engine';
export { evaluateField, UNRESOLVED_LINK_HANDLER } from './evaluate';

export { PageMetadata, ListItem } from './vendor/data-model/markdown';
export type {
	SMarkdownPage,
	SListItem,
	SListEntry,
	STask,
} from './vendor/data-model/serialized/markdown';
export { nestItems, nestGroups } from './vendor/ui/views/task-view';
export { markdownTable, markdownList, markdownTaskList } from './vendor/ui/export/markdown';
export { dataviewLinkLabel, mayContainMarkdown } from './display';
export { Transferable } from './vendor/data-model/transferable';
export { dataviewJsonReplacer, dataviewJsonReviver } from './json';
export { parsePage, parseRawPage, finishPage } from './page';
export type { PageInput, PageParseWarning, ParsePageOptions } from './page';
export { extractMetadata } from './metadata';
export type { ExtractedMetadata, MetadataWarning } from './metadata';
export { createLinkResolver, linkTargetKeys, linkPathKey } from './resolve';
export type { LinkResolver } from './resolve';

export { matchingSourcePaths } from './vendor/data-index/resolver';
export { IndexMap, ValueCaseInsensitiveIndexMap, PathFilters } from './vendor/data-index/index';
export type { FullIndex, StarredEntry } from './vendor/data-index/index';
export { parseCsv } from './vendor/data-import/csv';
export {
	VaultPaths,
	isMarkdownPagePath,
	starredPathsFromBookmarks,
	buildResolvedLinks,
} from './vault';
export { PageIndex, DATAVIEW_CSV_CACHE_MS } from './pageIndex';
export type { VaultTextReader } from './pageIndex';

export {
	executeDql,
	executeInlineDql,
	parseErrorLine,
	DATAVIEW_BLOCK_ERROR_PREFIX,
} from './execute';
export { extractDataviewBlocks } from './blocks';
export type { DataviewBlock, DataviewBlockLanguage } from './blocks';
export {
	toWireValue,
	fromWireValue,
	mapTaskGroups,
	isTaskGroup,
	reviveDataviewResult,
	reviveDataviewInlineResult,
} from './wire';
export type {
	DataviewIndexReader,
	DataviewIdMeaning,
	DataviewWireValue,
	DataviewTaskGroups,
	DataviewTableResult,
	DataviewListResult,
	DataviewTaskResult,
	DataviewUnsupportedResult,
	DataviewErrorResult,
	DataviewResult,
	RevivedDataviewResult,
	DataviewValueResult,
	DataviewInlineResult,
	RevivedDataviewInlineResult,
	DataviewQueryRequest,
	DataviewInlineQueryRequest,
	DataviewQueryResponse,
	DataviewFileQueryRequest,
	DataviewFileBlock,
	DataviewFileQueryResult,
	DataviewCommandAction,
	DataviewWatchMode,
	DataviewIndexStatus,
	DataviewStatusRequest,
	DataviewRebuildRequest,
	DataviewChangeEvent,
	DataviewJsSnapshotRequest,
	DataviewReadInRootRequest,
	DataviewReadInRootResponse,
	DataviewJsRootRequest,
	DataviewJsRoot,
	DataviewTrustRequest,
	DataviewTrustResponse,
} from './types';
export {
	DATAVIEW_GUEST_SCHEME,
	DATAVIEW_GUEST_URL,
	DATAVIEW_GUEST_PARTITION_PREFIX,
	DATAVIEW_GUEST_CSP,
	DATAVIEW_JS_RUN_TIMEOUT_MS,
	DATAVIEW_JS_INDEX_TIMEOUT_MS,
	DATAVIEW_JS_MAX_FRAME_HEIGHT,
	DATAVIEW_JS_MAX_GUESTS_PER_WINDOW,
	dataviewGuestPartition,
	isDataviewGuestPartition,
	isAllowedDataviewGuestAttachment,
} from './sandboxHost';
export {
	dataviewJsRunPolicy,
	normalizeTrustedRoot,
	isTrustedDataviewRoot,
	isTrustableDataviewRoot,
	cleanTrustedRoots,
	withTrustedRoot,
	withoutTrustedRoot,
	type DataviewJsRunPolicy,
	type DataviewJsRunPolicyInput,
} from './trust';

export {
	parseSandboxMessage,
	sandboxEnvelope,
	openSandboxEnvelope,
	encodeSandboxSnapshot,
	decodeSandboxSnapshot,
	SANDBOX_MAX_GUEST_MESSAGE_BYTES,
	SNAPSHOT_ENCODE_BATCH_PAGES,
	SANDBOX_TO_HOST_CHANNEL,
	SANDBOX_TO_GUEST_CHANNEL,
} from './sandboxProtocol';
export type {
	SandboxSender,
	SandboxChannel,
	SandboxEnvelope,
	SandboxMessage,
	SandboxGuestMessage,
	SandboxHostMessage,
	SandboxParseResult,
	SandboxQueryDqlMessage,
	SandboxIoLoadMessage,
	SandboxOpenLinkMessage,
	SandboxToggleTaskMessage,
	SandboxRenderDoneMessage,
	SandboxRenderErrorMessage,
	SandboxIndexReadyMessage,
	SandboxEvalOutcome,
	SandboxEvalResultMessage,
	SandboxRunMessage,
	SandboxEvalExpression,
	SandboxEvalMessage,
	SandboxIndexSnapshot,
	SandboxSnapshotPayload,
	SandboxSnapshotPage,
	SandboxQueryDqlResultMessage,
	SandboxIoLoadResultMessage,
	SandboxRequestFailedMessage,
} from './sandboxProtocol';
