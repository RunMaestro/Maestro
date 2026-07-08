/**
 * E2E Tests: stats, graph, Symphony, and leaderboard first tranche.
 *
 * This file authors deterministic coverage only. The scenarios seed local
 * app state and stub network-backed Symphony/leaderboard surfaces.
 */
import { test, expect, helpers } from './fixtures/electron-app';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const activeScenarioMatrix = [
	{ id: 'SGS-A01', title: 'renders Usage Dashboard summary and analytics sections' },
	{ id: 'SGS-A02', title: 'shows the Usage Dashboard live stats update indicator' },
	{ id: 'SGS-A03', title: 'opens Document Graph search and help controls from file preview' },
	{ id: 'SGS-A04', title: 'browses Symphony projects, status tabs, and achievements' },
	{ id: 'SGS-A05', title: 'opens About achievements and the leaderboard registration entry point' },
	{ id: 'SGS-A06', title: 'toggles Usage Dashboard chart metric modes for seeded stats' },
	{ id: 'SGS-A07', title: 'drills into Usage Dashboard Auto Run task and run tables' },
	{ id: 'SGS-A08', title: 'adjusts Document Graph layout, depth, and preview controls' },
	{ id: 'SGS-A09', title: 'syncs Symphony active contribution status controls' },
	{ id: 'SGS-A10', title: 'previews Symphony issue documents and blocked issue messaging' },
	{ id: 'SGS-A11', title: 'validates and submits mocked leaderboard registration details' },
	{ id: 'SGS-A12', title: 'navigates Usage Dashboard tabs and sections by keyboard' },
	{ id: 'SGS-A13', title: 'toggles Agent Usage chart metric modes' },
	{ id: 'SGS-A14', title: 'toggles Document Graph external links and refresh controls' },
	{ id: 'SGS-A15', title: 'opens achievement badge details and share menu actions' },
	{ id: 'SGS-A16', title: 'shows Symphony GitHub CLI preflight when starting contribution' },
	{ id: 'SGS-A17', title: 'handles mocked leaderboard pending confirmation state' },
	{ id: 'SGS-A18', title: 'toggles Usage Dashboard duration trend smoothing' },
	{ id: 'SGS-A19', title: 'reads Auto Run task completion chart accessibility details' },
	{ id: 'SGS-A20', title: 'opens Document Graph help legend shortcut and mouse guidance' },
	{ id: 'SGS-A21', title: 'shows Symphony empty project issue states' },
	{ id: 'SGS-A22', title: 'reviews Symphony completed contribution summary details' },
	{ id: 'SGS-A23', title: 'toggles Usage Dashboard activity heatmap metric modes' },
	{ id: 'SGS-A24', title: 'reads Usage Dashboard provider comparison accessibility data' },
	{ id: 'SGS-A25', title: 'opens the Symphony help popover from the modal header' },
	{ id: 'SGS-A26', title: 'reviews Symphony stats cards and achievement progress' },
	{ id: 'SGS-A27', title: 'handles mocked leaderboard submission failure messaging' },
	{ id: 'SGS-A28', title: 'exports Usage Dashboard CSV data to a chosen file' },
	{ id: 'SGS-A29', title: 'cycles Usage Dashboard views with global shortcuts' },
	{ id: 'SGS-A30', title: 'recovers Document Graph after an unmatched search' },
	{ id: 'SGS-A31', title: 'cancels Document Graph close confirmation from the toolbar' },
	{ id: 'SGS-A32', title: 'filters Symphony projects by category and empty search state' },
	{ id: 'SGS-A33', title: 'keeps Usage Dashboard open after canceling CSV export' },
	{ id: 'SGS-A34', title: 'updates Usage Dashboard footer for time range and database size' },
	{ id: 'SGS-A35', title: 'wraps Usage Dashboard view shortcuts backward from overview' },
	{ id: 'SGS-A36', title: 'shows Activity tab weekday and duration sections for month data' },
	{ id: 'SGS-A37', title: 'focuses Document Graph search from the keyboard shortcut' },
	{ id: 'SGS-A38', title: 'dismisses Document Graph layout menu with Escape' },
	{ id: 'SGS-A39', title: 'dismisses Document Graph depth and preview sliders with Escape' },
	{ id: 'SGS-A40', title: 'shows Symphony GitHub CLI unauthenticated preflight' },
	{ id: 'SGS-A41', title: 'cancels Symphony build-tools preflight after authenticated CLI check' },
	{ id: 'SGS-A42', title: 'returns from Symphony repository detail with Escape' },
	{ id: 'SGS-A43', title: 'shows Usage Dashboard agent statistics and efficiency sections' },
	{ id: 'SGS-A44', title: 'shows Usage Dashboard Auto Run summary and task list metadata' },
	{ id: 'SGS-A45', title: 'closes Usage Dashboard from Escape without changing seeded state' },
	{ id: 'SGS-A46', title: 'toggles Document Graph external link visibility twice' },
	{ id: 'SGS-A47', title: 'dismisses Document Graph help panel with Escape' },
	{ id: 'SGS-A48', title: 'selects Document Graph force layout and returns to mind map' },
	{ id: 'SGS-A49', title: 'shows Symphony active contribution session navigation affordance' },
	{ id: 'SGS-A50', title: 'closes the Symphony help popover from its inline action' },
	{ id: 'SGS-A51', title: 'shows Symphony history summary statistics above completed cards' },
	{ id: 'SGS-A52', title: 'shows Symphony project registration affordance in the header' },
	{ id: 'SGS-A53', title: 'closes Usage Dashboard from the header close control' },
	{ id: 'SGS-A54', title: 'reads Auto Run metric card accessible summaries' },
	{ id: 'SGS-A55', title: 'cancels Document Graph Escape close confirmation' },
	{ id: 'SGS-A56', title: 'sets Document Graph preview character limit boundaries' },
	{ id: 'SGS-A57', title: 'shows Symphony repository metadata and external affordances' },
	{ id: 'SGS-A58', title: 'switches Symphony issue Auto Run documents from the selector' },
	{ id: 'SGS-A59', title: 'fills leaderboard optional social profile fields' },
	{ id: 'SGS-A60', title: 'cycles Usage Dashboard time range footer labels' },
	{ id: 'SGS-A61', title: 'maps Usage Dashboard tabs to stable tabpanel ids' },
	{ id: 'SGS-A62', title: 'reads overview source and location chart legends' },
	{ id: 'SGS-A63', title: 'refreshes Document Graph while preserving search state' },
	{ id: 'SGS-A64', title: 'closes Document Graph help panel from its inline button' },
	{ id: 'SGS-A65', title: 'sets Document Graph neighbor depth boundary values' },
	{ id: 'SGS-A66', title: 'shows Symphony active card progress and token metadata' },
	{ id: 'SGS-A67', title: 'returns from Symphony repository detail with the back button' },
	{ id: 'SGS-A68', title: 'shows Symphony available issue start footer guidance' },
	{ id: 'SGS-A69', title: 'copies achievement share text with success feedback' },
	{ id: 'SGS-A70', title: 'adds remote stats and reads SSH Remote location legend' },
	{ id: 'SGS-A71', title: 'adds a second provider to Usage Dashboard agent legend' },
	{ id: 'SGS-A72', title: 'adds a failed Auto Run session and recalculates metrics' },
	{ id: 'SGS-A73', title: 'shows Document Graph layout menu descriptions' },
	{ id: 'SGS-A74', title: 'shows Document Graph help status indicator guidance' },
	{ id: 'SGS-A75', title: 'clears Document Graph search after a refreshed match' },
	{ id: 'SGS-A76', title: 'dismisses Symphony build-tools preflight from the backdrop' },
	{ id: 'SGS-A77', title: 'shows Symphony active sync failure feedback' },
	{ id: 'SGS-A78', title: 'keeps leaderboard submission disabled until required fields are valid' },
	{ id: 'SGS-A79', title: 'submits leaderboard registration with Enter from a valid form' },
	{ id: 'SGS-A80', title: 'reads Usage Dashboard summary card accessible names' },
	{ id: 'SGS-A81', title: 'toggles Peak Hours count and duration pressed states' },
	{ id: 'SGS-A82', title: 'shows Document Graph external node and edge legend entries' },
	{ id: 'SGS-A83', title: 'shows Document Graph keyboard and mouse legend guidance' },
	{ id: 'SGS-A84', title: 'reviews Symphony completed contribution card metadata' },
	{ id: 'SGS-A85', title: 'reviews Symphony stats cards and achievement grid' },
	{ id: 'SGS-A86', title: 'validates leaderboard email format and privacy copy' },
	{ id: 'SGS-A87', title: 'shows leaderboard pending email confirmation state' },
	{ id: 'SGS-A88', title: 'sanitizes extended leaderboard social handles' },
	{ id: 'SGS-A89', title: 'keeps Usage Dashboard summary metrics current after live stats' },
	{ id: 'SGS-A90', title: 'shows Usage Dashboard empty state from zero aggregation' },
	{ id: 'SGS-A91', title: 'recovers Usage Dashboard after aggregation retry' },
	{ id: 'SGS-A92', title: 'persists Document Graph external-link visibility after reopen' },
	{ id: 'SGS-A93', title: 'persists Document Graph layout selection after reopen' },
	{ id: 'SGS-A94', title: 'shows Symphony merged PR status check result' },
	{ id: 'SGS-A95', title: 'shows Symphony no-PR status check result' },
	{ id: 'SGS-A96', title: 'shows Symphony PR status check failure result' },
	{ id: 'SGS-A97', title: 'confirms and cancels leaderboard opt-out after registration' },
	{ id: 'SGS-A98', title: 'shows leaderboard manual auth token recovery controls' },
	{ id: 'SGS-A99', title: 'submits leaderboard stats after manual auth token entry' },
	{ id: 'SGS-A100', title: 'keeps Usage Dashboard retry available after repeated stat errors' },
	{ id: 'SGS-A101', title: 'shows Document Graph selected-node metadata and task counts' },
	{ id: 'SGS-A102', title: 'opens Document Graph document-node context menu actions' },
	{ id: 'SGS-A103', title: 'opens Document Graph in-graph preview from focused keyboard shortcut' },
	{ id: 'SGS-A104', title: 'focuses a Document Graph node from the context menu' },
	{ id: 'SGS-A105', title: 'opens Symphony agent creation after authenticated preflight' },
	{ id: 'SGS-A106', title: 'keeps Symphony agent creation disabled for missing required fields' },
	{ id: 'SGS-A107', title: 'finalizes Symphony PR with contribution metrics payload' },
	{ id: 'SGS-A108', title: 'pulls leaderboard stats down when server data is ahead' },
	{ id: 'SGS-A109', title: 'reports leaderboard already-in-sync server state' },
	{ id: 'SGS-A110', title: 'reports leaderboard pull-down when no server record exists' },
	{ id: 'SGS-A111', title: 'reports leaderboard pull-down email-not-confirmed error' },
	{ id: 'SGS-A112', title: 'reports leaderboard pull-down invalid-token error' },
	{ id: 'SGS-A113', title: 'reports leaderboard pull-down generic sync failure' },
	{ id: 'SGS-A114', title: 'recovers leaderboard auth token automatically before resubmitting' },
	{ id: 'SGS-A115', title: 'shows Symphony registry load failure retry affordance' },
	{ id: 'SGS-A116', title: 'shows Symphony document preview failure message' },
	{ id: 'SGS-A117', title: 'cancels Symphony agent creation dialog after build preflight' },
	{ id: 'SGS-A118', title: 'clears Document Graph search with Escape from the input' },
	{ id: 'SGS-A119', title: 'shows Symphony active empty state and browse-projects affordance' },
	{ id: 'SGS-A120', title: 'exports Usage Dashboard CSV with the selected time range' },
	{ id: 'SGS-A121', title: 're-enables Usage Dashboard CSV export after write failure' },
	{ id: 'SGS-A122', title: 'shows Document Graph selected-node info path' },
	{ id: 'SGS-A123', title: 'dismisses Document Graph node context menu with Escape' },
	{ id: 'SGS-A124', title: 'shows Symphony agent creation provider detection empty state' },
	{ id: 'SGS-A125', title: 'surfaces Symphony agent creation failure without closing the dialog' },
	{ id: 'SGS-A126', title: 'reports leaderboard pull-down when local stats are ahead' },
	{ id: 'SGS-A127', title: 'uses the selected Usage Dashboard range in the export filename' },
	{ id: 'SGS-A128', title: 'does not request CSV data after canceling the export dialog' },
	{ id: 'SGS-A129', title: 'disables Usage Dashboard CSV export while export is pending' },
	{ id: 'SGS-A130', title: 'shows Document Graph selected-node project path' },
	{ id: 'SGS-A131', title: 'dismisses Document Graph context menu after Copy Path' },
	{ id: 'SGS-A132', title: 'updates Symphony agent working directory from folder picker' },
	{ id: 'SGS-A133', title: 'creates a Symphony idle session after stubbed contribution start' },
	{ id: 'SGS-A134', title: 'pushes leaderboard stats after local-ahead pull-down warning' },
	{ id: 'SGS-A135', title: 'exports Usage Dashboard CSV with the selected quarter range' },
	{ id: 'SGS-A136', title: 'reloads Usage Dashboard database size when ranges change' },
	{ id: 'SGS-A137', title: 'closes Document Graph in-graph preview with Escape' },
	{ id: 'SGS-A138', title: 'preserves Document Graph force layout through refresh' },
	{ id: 'SGS-A139', title: 'opens Symphony repository GitHub link through shell routing' },
	{ id: 'SGS-A140', title: 'opens Symphony issue GitHub link through shell routing' },
	{ id: 'SGS-A141', title: 'switches Symphony issue documents with document controls' },
	{ id: 'SGS-A142', title: 'returns from Symphony active empty state to project browse' },
	{ id: 'SGS-A143', title: 'passes Symphony clone payload before starting contribution' },
	{ id: 'SGS-A144', title: 'shows Symphony clone failure before starting contribution' },
	{ id: 'SGS-A145', title: 'shows Usage Dashboard Auto Run stats load failure controls' },
	{ id: 'SGS-A146', title: 'shows Usage Dashboard Auto Run empty state from no sessions' },
	{ id: 'SGS-A147', title: 'shows disabled Document Graph preview history controls' },
	{ id: 'SGS-A148', title: 'keeps Document Graph reset-layout control available after refresh' },
	{ id: 'SGS-A149', title: 'submits leaderboard payload metadata for local stats' },
	{ id: 'SGS-A150', title: 'resends leaderboard confirmation and resumes polling' },
	{ id: 'SGS-A151', title: 'shows leaderboard resend confirmation failure message' },
	{ id: 'SGS-A152', title: 'opens leaderboard public site link through shell routing' },
	{ id: 'SGS-A153', title: 'opens Symphony active draft PR link through shell routing' },
	{ id: 'SGS-A154', title: 'opens Symphony completed PR link through shell routing' },
	{ id: 'SGS-A155', title: 'copies Document Graph selected path to clipboard' },
	{ id: 'SGS-A156', title: 'syncs Symphony active contribution by ID' },
	{ id: 'SGS-A157', title: 'reports Symphony closed PR status count' },
	{ id: 'SGS-A158', title: 'reports Symphony checked PRs without changes' },
	{ id: 'SGS-A159', title: 'submits leaderboard social metadata handles' },
	{ id: 'SGS-A160', title: 'shows Document Graph external node metadata after selection' },
	{ id: 'SGS-A161', title: 'opens Document Graph external node context menu actions' },
	{ id: 'SGS-A162', title: 'copies Document Graph external node URL to clipboard' },
	{ id: 'SGS-A163', title: 'opens Document Graph external node URL through shell routing' },
	{ id: 'SGS-A164', title: 'dismisses Document Graph external node context menu with Escape' },
	{ id: 'SGS-A165', title: 'shows Document Graph external selected-node path' },
	{ id: 'SGS-A166', title: 'opens focused Document Graph external node with Enter' },
	{ id: 'SGS-A167', title: 'shows Document Graph external node multi-link count' },
	{ id: 'SGS-A168', title: 'uses Copy URLs for aggregated Document Graph external links' },
	{ id: 'SGS-A169', title: 'copies aggregated Document Graph external URLs to clipboard' },
	{ id: 'SGS-A170', title: 'shows Document Graph multiple external domain count' },
	{ id: 'SGS-A171', title: 'selects Document Graph external domain from search filter' },
	{ id: 'SGS-A172', title: 'copies searched Document Graph external domain URL' },
	{ id: 'SGS-A173', title: 'opens searched Document Graph external domain URL' },
	{ id: 'SGS-A174', title: 'clears Document Graph external domain search filter' },
	{
		id: 'SGS-A175',
		title: 'keeps Usage Dashboard all-time summary cards visible after seeded load',
	},
	{
		id: 'SGS-A176',
		title: 'keeps Usage Dashboard day-range summary cards visible after selection',
	},
	{
		id: 'SGS-A177',
		title: 'keeps Usage Dashboard week-range summary cards visible after selection',
	},
	{
		id: 'SGS-A178',
		title: 'keeps Usage Dashboard month-range summary cards visible after selection',
	},
	{
		id: 'SGS-A179',
		title: 'keeps Usage Dashboard quarter-range summary cards visible after selection',
	},
	{
		id: 'SGS-A180',
		title: 'keeps Usage Dashboard year-range summary cards visible after selection',
	},
	{ id: 'SGS-A181', title: 'keeps Usage Dashboard export control enabled for all-time data' },
	{
		id: 'SGS-A182',
		title: 'keeps Usage Dashboard export control enabled after day range selection',
	},
	{
		id: 'SGS-A183',
		title: 'keeps Usage Dashboard export control enabled after month range selection',
	},
	{
		id: 'SGS-A184',
		title: 'keeps Usage Dashboard export control enabled after quarter range selection',
	},
	{ id: 'SGS-A185', title: 'shows Usage Dashboard Overview tab as a stable navigation target' },
	{ id: 'SGS-A186', title: 'shows Usage Dashboard Agents tab as a stable navigation target' },
	{ id: 'SGS-A187', title: 'shows Usage Dashboard Activity tab as a stable navigation target' },
	{ id: 'SGS-A188', title: 'shows Usage Dashboard Auto Run tab as a stable navigation target' },
	{ id: 'SGS-A189', title: 'renders Usage Dashboard agent session stats after seeded stats load' },
	{
		id: 'SGS-A190',
		title: 'renders Usage Dashboard agent efficiency chart after seeded stats load',
	},
	{ id: 'SGS-A191', title: 'renders Usage Dashboard activity heatmap after seeded stats load' },
	{ id: 'SGS-A192', title: 'renders Usage Dashboard weekday comparison after seeded stats load' },
	{
		id: 'SGS-A193',
		title: 'renders Usage Dashboard Auto Run summary region after seeded stats load',
	},
	{
		id: 'SGS-A194',
		title: 'renders Usage Dashboard Auto Run metrics region after seeded stats load',
	},
	{ id: 'SGS-A195', title: 'renders Usage Dashboard Auto Run task chart after seeded stats load' },
	{
		id: 'SGS-A196',
		title: 'renders Usage Dashboard Auto Run metric cards after seeded stats load',
	},
	{
		id: 'SGS-A197',
		title: 'preserves Usage Dashboard Overview content after cycling through Agents',
	},
	{
		id: 'SGS-A198',
		title: 'preserves Usage Dashboard Overview content after cycling through Activity',
	},
	{
		id: 'SGS-A199',
		title: 'preserves Usage Dashboard Overview content after cycling through Auto Run',
	},
	{ id: 'SGS-A200', title: 'keeps Usage Dashboard summary visible after rapid range changes' },
	{
		id: 'SGS-A201',
		title: 'keeps Usage Dashboard Agents content visible after rapid range changes',
	},
	{
		id: 'SGS-A202',
		title: 'keeps Usage Dashboard Activity content visible after rapid range changes',
	},
	{
		id: 'SGS-A203',
		title: 'keeps Usage Dashboard Auto Run content visible after rapid range changes',
	},
	{
		id: 'SGS-A204',
		title: 'shows Usage Dashboard Total Queries summary after additional seeded query',
	},
	{ id: 'SGS-A205', title: 'shows Usage Dashboard new-data indicator after additional user query' },
	{ id: 'SGS-A206', title: 'shows Usage Dashboard new-data indicator after additional auto query' },
	{ id: 'SGS-A207', title: 'keeps Usage Dashboard summary cards stable after live local query' },
	{ id: 'SGS-A208', title: 'keeps Usage Dashboard Agents tab stable after live local query' },
	{ id: 'SGS-A209', title: 'keeps Usage Dashboard Activity tab stable after live local query' },
	{ id: 'SGS-A210', title: 'keeps Usage Dashboard Auto Run tab stable after live local query' },
	{ id: 'SGS-A211', title: 'shows Usage Dashboard source labels for seeded user and auto queries' },
	{ id: 'SGS-A212', title: 'shows Usage Dashboard location labels for seeded local activity' },
	{ id: 'SGS-A213', title: 'shows Usage Dashboard provider labels for seeded Codex activity' },
	{
		id: 'SGS-A214',
		title: 'shows Usage Dashboard database-size footer beside selected range controls',
	},
	{ id: 'SGS-A215', title: 'keeps Usage Dashboard first range selector keyboard-addressable' },
	{ id: 'SGS-A216', title: 'keeps Usage Dashboard CSV export button keyboard-addressable' },
	{ id: 'SGS-A217', title: 'keeps Usage Dashboard close button available from the header' },
	{ id: 'SGS-A218', title: 'keeps Usage Dashboard visible after a canceled CSV save dialog' },
	{
		id: 'SGS-A219',
		title: 'does not write Usage Dashboard CSV when save dialog is canceled again',
	},
	{ id: 'SGS-A220', title: 'records Usage Dashboard CSV export request for week range' },
	{ id: 'SGS-A221', title: 'records Usage Dashboard CSV export request for month range' },
	{ id: 'SGS-A222', title: 'records Usage Dashboard CSV export request for year range' },
	{ id: 'SGS-A223', title: 'keeps Usage Dashboard export button enabled after completed write' },
	{ id: 'SGS-A224', title: 'reuses Usage Dashboard selected all-time range for export payload' },
	{ id: 'SGS-A225', title: 'shows Usage Dashboard Auto Run task list region with seeded task' },
	{ id: 'SGS-A226', title: 'shows Usage Dashboard Auto Run chart figure with seeded task totals' },
	{ id: 'SGS-A227', title: 'shows Usage Dashboard Auto Run metrics after returning from Overview' },
	{ id: 'SGS-A228', title: 'shows Usage Dashboard Activity tab after returning from Auto Run' },
	{ id: 'SGS-A229', title: 'shows Usage Dashboard Agents tab after returning from Activity' },
	{ id: 'SGS-A230', title: 'shows Usage Dashboard Overview tab after returning from Agents' },
	{ id: 'SGS-A231', title: 'keeps Usage Dashboard tablist controls visible across range changes' },
	{
		id: 'SGS-A232',
		title: 'keeps Usage Dashboard Auto Run task chart visible across range changes',
	},
	{ id: 'SGS-A233', title: 'keeps Usage Dashboard activity heatmap visible across range changes' },
	{
		id: 'SGS-A234',
		title: 'keeps Usage Dashboard agent efficiency chart visible across range changes',
	},
	{
		id: 'SGS-A235',
		title: 'shows Usage Dashboard summary cards after selecting each common range',
	},
	{
		id: 'SGS-A236',
		title: 'keeps Usage Dashboard footer visible after selecting each common range',
	},
	{
		id: 'SGS-A237',
		title: 'keeps Usage Dashboard Auto Run tab content visible after all-time reset',
	},
	{
		id: 'SGS-A238',
		title: 'keeps Usage Dashboard Activity tab content visible after all-time reset',
	},
	{
		id: 'SGS-A239',
		title: 'keeps Usage Dashboard Agents tab content visible after all-time reset',
	},
	{
		id: 'SGS-A240',
		title: 'shows Usage Dashboard data controls after reopening from Escape close',
	},
	{ id: 'SGS-A241', title: 'shows Usage Dashboard summary after reopening from header close' },
	{ id: 'SGS-A242', title: 'shows Usage Dashboard Agents chart after reopening the modal' },
	{ id: 'SGS-A243', title: 'shows Usage Dashboard Activity chart after reopening the modal' },
	{ id: 'SGS-A244', title: 'shows Usage Dashboard Auto Run chart after reopening the modal' },
	{ id: 'SGS-A245', title: 'keeps Document Graph README search result visible after refresh' },
	{ id: 'SGS-A246', title: 'keeps Document Graph runbook search result visible after refresh' },
	{ id: 'SGS-A247', title: 'clears Document Graph README search before searching runbook' },
	{ id: 'SGS-A248', title: 'clears Document Graph runbook search before searching readme' },
	{ id: 'SGS-A249', title: 'opens Document Graph help node-types guidance from closeout tranche' },
	{ id: 'SGS-A250', title: 'opens Document Graph help keyboard guidance from closeout tranche' },
	{ id: 'SGS-A251', title: 'opens Document Graph help mouse guidance from closeout tranche' },
	{
		id: 'SGS-A252',
		title: 'keeps Document Graph help status guidance visible after repeated open',
	},
	{ id: 'SGS-A253', title: 'selects Document Graph radial layout in closeout tranche' },
	{ id: 'SGS-A254', title: 'selects Document Graph force layout in closeout tranche' },
	{ id: 'SGS-A255', title: 'returns Document Graph layout to mind map in closeout tranche' },
	{ id: 'SGS-A256', title: 'keeps Document Graph layout menu visible after switching radial' },
	{ id: 'SGS-A257', title: 'sets Document Graph neighbor depth to one link' },
	{ id: 'SGS-A258', title: 'sets Document Graph neighbor depth to two links' },
	{ id: 'SGS-A259', title: 'sets Document Graph neighbor depth to three links' },
	{ id: 'SGS-A260', title: 'restores Document Graph depth guidance after repeated adjustment' },
	{ id: 'SGS-A261', title: 'lowers Document Graph preview size to compact text' },
	{ id: 'SGS-A262', title: 'raises Document Graph preview size to medium text' },
	{ id: 'SGS-A263', title: 'raises Document Graph preview size to long text' },
	{ id: 'SGS-A264', title: 'keeps Document Graph preview controls visible after adjustment' },
	{ id: 'SGS-A265', title: 'toggles Document Graph external links on from closeout tranche' },
	{ id: 'SGS-A266', title: 'toggles Document Graph external links back off from closeout tranche' },
	{ id: 'SGS-A267', title: 'refreshes Document Graph after README search' },
	{ id: 'SGS-A268', title: 'refreshes Document Graph after runbook search' },
	{ id: 'SGS-A269', title: 'refreshes Document Graph after external link toggle' },
	{ id: 'SGS-A270', title: 'refreshes Document Graph after layout change' },
	{
		id: 'SGS-A271',
		title: 'shows Document Graph center-node README metadata after closeout click',
	},
	{ id: 'SGS-A272', title: 'shows Document Graph selected node task counts after closeout click' },
	{ id: 'SGS-A273', title: 'shows Document Graph selected node created-date metadata' },
	{ id: 'SGS-A274', title: 'shows Document Graph selected node modified-date metadata' },
	{ id: 'SGS-A275', title: 'opens Document Graph node context menu from closeout right click' },
	{ id: 'SGS-A276', title: 'keeps Document Graph context Open action available' },
	{ id: 'SGS-A277', title: 'keeps Document Graph context Copy Path action available' },
	{ id: 'SGS-A278', title: 'keeps Document Graph context Focus action available' },
	{ id: 'SGS-A279', title: 'dismisses Document Graph context menu after closeout Escape' },
	{ id: 'SGS-A280', title: 'previews Document Graph node content from closeout keyboard shortcut' },
	{ id: 'SGS-A281', title: 'keeps Document Graph preview file action available' },
	{ id: 'SGS-A282', title: 'shows Document Graph preview fixture content after keyboard shortcut' },
	{
		id: 'SGS-A283',
		title: 'shows Document Graph preview history disabled controls in closeout tranche',
	},
	{ id: 'SGS-A284', title: 'shows Document Graph selected-node README summary' },
	{ id: 'SGS-A285', title: 'shows Document Graph selected-node project label' },
	{ id: 'SGS-A286', title: 'shows Document Graph selected-node README file path' },
	{
		id: 'SGS-A287',
		title: 'keeps Document Graph selected node visible after breadcrumb inspection',
	},
	{ id: 'SGS-A288', title: 'clears Document Graph search with Escape in closeout tranche' },
	{ id: 'SGS-A289', title: 'keeps Document Graph search input focused after keyboard clear' },
	{ id: 'SGS-A290', title: 'restores Document Graph results after retyping README search' },
	{ id: 'SGS-A291', title: 'restores Document Graph results after retyping runbook search' },
	{ id: 'SGS-A292', title: 'keeps Document Graph document count visible after search clear' },
	{ id: 'SGS-A293', title: 'keeps Document Graph close control visible during closeout tranche' },
	{ id: 'SGS-A294', title: 'cancels Document Graph close confirmation during closeout tranche' },
	{ id: 'SGS-A295', title: 'confirms Document Graph close from closeout tranche' },
	{ id: 'SGS-A296', title: 'keeps Document Graph help close button visible in closeout tranche' },
	{ id: 'SGS-A297', title: 'dismisses Document Graph help panel with Escape in closeout tranche' },
	{ id: 'SGS-A298', title: 'opens Document Graph help panel again after Escape dismissal' },
	{ id: 'SGS-A299', title: 'keeps Document Graph status indicator guidance visible' },
	{ id: 'SGS-A300', title: 'keeps Document Graph shortcut guidance visible after refresh' },
	{ id: 'SGS-A301', title: 'keeps Document Graph mouse action guidance visible after refresh' },
	{ id: 'SGS-A302', title: 'shows Document Graph README node after focus context action' },
	{ id: 'SGS-A303', title: 'shows Document Graph runbook node after search focus' },
	{ id: 'SGS-A304', title: 'keeps Document Graph canvas visible after layout cycling' },
	{ id: 'SGS-A305', title: 'keeps Document Graph canvas visible after depth cycling' },
	{ id: 'SGS-A306', title: 'keeps Document Graph canvas visible after preview cycling' },
	{ id: 'SGS-A307', title: 'keeps Document Graph node count visible after repeated refresh' },
	{ id: 'SGS-A308', title: 'keeps Document Graph external link legend stable after toggle' },
	{ id: 'SGS-A309', title: 'keeps Document Graph README search stable after layout change' },
	{ id: 'SGS-A310', title: 'keeps Document Graph runbook search stable after depth change' },
	{ id: 'SGS-A311', title: 'keeps Document Graph help panel scoped inside dialog' },
	{
		id: 'SGS-A312',
		title: 'keeps Document Graph toolbar controls visible after context dismissal',
	},
	{ id: 'SGS-A313', title: 'keeps Document Graph selection visible after reset layout' },
	{ id: 'SGS-A314', title: 'keeps Symphony project browse search matching Maestro Core' },
	{ id: 'SGS-A315', title: 'keeps Symphony project browse search matching Documentation Hub' },
	{ id: 'SGS-A316', title: 'shows Symphony project browse empty search recovery' },
	{ id: 'SGS-A317', title: 'opens Symphony Maestro Core detail from closeout tranche' },
	{ id: 'SGS-A318', title: 'shows Symphony available issue count from project detail' },
	{ id: 'SGS-A319', title: 'shows Symphony in-progress issue count from project detail' },
	{ id: 'SGS-A320', title: 'shows Symphony blocked issue count from project detail' },
	{ id: 'SGS-A321', title: 'opens Symphony available issue detail from closeout tranche' },
	{ id: 'SGS-A322', title: 'shows Symphony selected issue document list' },
	{ id: 'SGS-A323', title: 'shows Symphony blocked issue messaging from closeout tranche' },
	{ id: 'SGS-A324', title: 'shows Symphony claimed issue draft PR notice' },
	{ id: 'SGS-A325', title: 'keeps Symphony active tab ready-for-review status visible' },
	{ id: 'SGS-A326', title: 'keeps Symphony active tab draft PR action visible' },
	{ id: 'SGS-A327', title: 'keeps Symphony active tab current document metadata visible' },
	{ id: 'SGS-A328', title: 'keeps Symphony active tab progress metadata visible' },
	{ id: 'SGS-A329', title: 'keeps Symphony history tab completed contribution visible' },
	{ id: 'SGS-A330', title: 'keeps Symphony history tab merged status visible' },
	{ id: 'SGS-A331', title: 'keeps Symphony history tab PR action visible' },
	{ id: 'SGS-A332', title: 'keeps Symphony history tab cost metadata visible' },
	{ id: 'SGS-A333', title: 'keeps Symphony stats tab tokens donated card visible' },
	{ id: 'SGS-A334', title: 'keeps Symphony stats tab time contributed card visible' },
	{ id: 'SGS-A335', title: 'keeps Symphony stats tab streak card visible' },
	{ id: 'SGS-A336', title: 'keeps Symphony stats tab achievements heading visible' },
	{ id: 'SGS-A337', title: 'opens Symphony help popover in closeout tranche' },
	{ id: 'SGS-A338', title: 'keeps Symphony help runmaestro copy visible' },
	{ id: 'SGS-A339', title: 'keeps Symphony help close control visible' },
	{ id: 'SGS-A340', title: 'opens About achievements section from closeout tranche' },
	{ id: 'SGS-A341', title: 'opens About achievement detail from closeout tranche' },
	{ id: 'SGS-A342', title: 'opens About achievement share menu from closeout tranche' },
	{ id: 'SGS-A343', title: 'opens leaderboard registration from closeout tranche' },
	{ id: 'SGS-A344', title: 'keeps leaderboard current stats copy visible' },
	{ id: 'SGS-A345', title: 'validates leaderboard display-name required state' },
	{ id: 'SGS-A346', title: 'validates leaderboard email required state' },
	{ id: 'SGS-A347', title: 'enables leaderboard push after valid profile fields' },
	{ id: 'SGS-A348', title: 'keeps leaderboard optional GitHub field editable' },
	{ id: 'SGS-A349', title: 'keeps leaderboard optional X field editable' },
	{ id: 'SGS-A350', title: 'shows leaderboard privacy copy with invalid email' },
	{ id: 'SGS-A351', title: 'shows leaderboard confirmation message after submit' },
	{ id: 'SGS-A352', title: 'shows leaderboard pending email confirmation state' },
	{ id: 'SGS-A353', title: 'shows leaderboard submission failure retry control' },
	{ id: 'SGS-A354', title: 'shows leaderboard manual token recovery field' },
	{ id: 'SGS-A355', title: 'shows leaderboard pull-down after manual token recovery' },
	{ id: 'SGS-A356', title: 'keeps Symphony repository back navigation visible' },
	{
		id: 'SGS-A357',
		title: 'keeps Usage Dashboard database size visible after recovery range change',
	},
	{
		id: 'SGS-A358',
		title: 'keeps Document Graph help scoped after recovery refresh',
	},
	{
		id: 'SGS-A359',
		title: 'keeps Symphony stats achievements visible after recovery tab switch',
	},
	{
		id: 'SGS-A360',
		title: 'keeps About achievement share actions visible in recovery tranche',
	},
	{
		id: 'SGS-A361',
		title: 'keeps leaderboard pull-down visible after recovery manual token flow',
	},
] as const;

const skippedScenarioMatrix = [
	{
		id: 'SGS-S01',
		title: 'completes a full Symphony contribution from GitHub issue to draft PR',
		reason:
			'Product gap for this tranche: requires live GitHub CLI, repo checkout, and Auto Run execution.',
	},
	{
		id: 'SGS-S02',
		title: 'verifies downloadable achievement badge images',
		reason: 'Product gap for this tranche: requires canvas/screenshot artifact verification.',
	},
] as const;

const envGatedScenarioMatrix = [
	{
		id: 'SGS-E01',
		title: 'submits leaderboard registration to runmaestro.ai',
		reason: 'Env-gated: requires live network and leaderboard backend.',
	},
	{
		id: 'SGS-E02',
		title: 'refreshes real Symphony issue status from GitHub',
		reason: 'Env-gated: requires authenticated GitHub CLI or API access.',
	},
	{
		id: 'SGS-E03',
		title: 'confirms leaderboard email through live backend polling',
		reason: 'Env-gated: requires live runmaestro.ai email confirmation and polling backend.',
	},
	{
		id: 'SGS-E04',
		title: 'pulls registered leaderboard stats from runmaestro.ai with a live auth token',
		reason: 'Env-gated: requires live leaderboard backend, confirmed email, and auth token.',
	},
] as const;

type StatsBridge = {
	recordSessionCreated: (payload: Record<string, unknown>) => Promise<void>;
	recordSessionClosed: (sessionId: string, closedAt: number) => Promise<void>;
	recordQuery: (payload: Record<string, unknown>) => Promise<void>;
	startAutoRun: (payload: Record<string, unknown>) => Promise<string>;
	recordAutoTask: (payload: Record<string, unknown>) => Promise<void>;
	endAutoRun: (autoRunSessionId: string, duration: number, tasksCompleted: number) => Promise<void>;
};

type MaestroStatsGlobal = typeof globalThis & {
	maestro: {
		stats: StatsBridge;
	};
};

function createEmptyStatsAggregation() {
	return {
		totalQueries: 0,
		totalDuration: 0,
		avgDuration: 0,
		byAgent: {},
		bySource: { user: 0, auto: 0 },
		byDay: [],
		byLocation: { local: 0, remote: 0 },
		byHour: [],
		totalSessions: 0,
		sessionsByAgent: {},
		sessionsByDay: [],
		avgSessionDuration: 0,
		byAgentByDay: {},
		bySessionByDay: {},
	};
}

function formatLocalDateKey(timestamp: number) {
	const date = new Date(timestamp);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDateAssertionLabel(timestamp: number) {
	const dateKey = formatLocalDateKey(timestamp);
	return new Date(`${dateKey}T00:00`).toLocaleDateString('en-US', {
		month: 'short',
		day: 'numeric',
		year: 'numeric',
	});
}

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createStatsGraphSymphonyWorkbench() {
	const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-e2e-stats-graph-symphony-'));
	const projectDir = path.join(homeDir, 'project');
	const docsDir = path.join(projectDir, 'docs');
	const now = Date.now();
	const statsSeedTime = now - 60_000;
	const idSuffix = `${now}-${Math.random().toString(36).slice(2)}`;
	const sessionId = `stats-graph-symphony-${idSuffix}`;
	const aiTabId = `stats-graph-symphony-ai-${idSuffix}`;
	const fileTabId = `stats-graph-symphony-file-${idSuffix}`;
	const readmePath = path.join(projectDir, 'README.md');
	const runbookPath = path.join(docsDir, 'RUNBOOK.md');

	fs.mkdirSync(docsDir, { recursive: true });
	fs.writeFileSync(
		readmePath,
		`# Stats Graph Symphony Fixture

Usage dashboard, document graph, Symphony, and achievements fixture.

[Runbook](docs/RUNBOOK.md)
[Maestro leaderboard](https://runmaestro.ai)

- [ ] Graph tranche still active
- [x] Stats tranche seeded
`,
		'utf-8'
	);
	fs.writeFileSync(
		runbookPath,
		`# Symphony Runbook

Deterministic runbook body for document graph search coverage.

[Root README](../README.md)
`,
		'utf-8'
	);

	const aiLogs = [
		{
			id: `stats-graph-symphony-log-${idSuffix}`,
			timestamp: now,
			source: 'stdout',
			text: 'Stats graph Symphony seeded agent output.',
		},
	];

	return {
		homeDir,
		projectDir,
		runbookPath,
		sessionId,
		statsSeedTime,
		statsSeedDateKey: formatLocalDateKey(statsSeedTime),
		statsSeedDateLabel: formatDateAssertionLabel(statsSeedTime),
		sessions: [
			{
				id: sessionId,
				name: 'Stats Graph Symphony Agent',
				toolType: 'codex',
				state: 'idle',
				cwd: projectDir,
				fullPath: projectDir,
				projectRoot: projectDir,
				createdAt: now,
				aiLogs,
				shellLogs: [],
				workLog: [],
				contextUsage: 0,
				usageStats: {
					inputTokens: 2200,
					outputTokens: 560,
					cacheReadInputTokens: 120,
					cacheCreationInputTokens: 80,
					totalCostUsd: 0.08,
					contextWindow: 128000,
				},
				inputMode: 'ai',
				aiPid: 0,
				terminalPid: 0,
				port: 0,
				isLive: false,
				changedFiles: [],
				isGitRepo: false,
				fileTree: [],
				fileExplorerExpanded: [],
				fileExplorerScrollPos: 0,
				executionQueue: [],
				activeTimeMs: 0,
				fileTreeAutoRefreshInterval: 180,
				aiTabs: [
					{
						id: aiTabId,
						agentSessionId: 'codex-stats-graph-symphony-tab',
						name: 'Main',
						starred: false,
						logs: aiLogs,
						inputValue: '',
						stagedImages: [],
						createdAt: now,
						state: 'idle',
					},
				],
				activeTabId: aiTabId,
				closedTabHistory: [],
				filePreviewTabs: [
					{
						id: fileTabId,
						path: readmePath,
						name: 'README.md',
						extension: '.md',
						content: fs.readFileSync(readmePath, 'utf-8'),
						scrollTop: 0,
						searchQuery: '',
						editMode: false,
						createdAt: now,
						lastModified: now,
					},
				],
				activeFileTabId: fileTabId,
				unifiedTabOrder: [
					{ type: 'ai', id: aiTabId },
					{ type: 'file', id: fileTabId },
				],
				unifiedClosedTabHistory: [],
			},
		],
	};
}

async function seedStats(
	page: Page,
	workbench: ReturnType<typeof createStatsGraphSymphonyWorkbench>
) {
	await page.evaluate(
		async ({ projectDir, sessionId, statsSeedTime }) => {
			const baseTime = statsSeedTime;
			const { stats } = (globalThis as MaestroStatsGlobal).maestro;
			await stats.recordSessionCreated({
				sessionId,
				agentType: 'codex',
				projectPath: projectDir,
				createdAt: baseTime - 3_600_000,
				isRemote: false,
			});
			await stats.recordSessionClosed(sessionId, baseTime);
			await stats.recordQuery({
				sessionId,
				agentType: 'codex',
				source: 'user',
				startTime: baseTime - 600_000,
				duration: 120_000,
				projectPath: projectDir,
				tabId: 'sgs-user-query',
				isRemote: false,
			});
			await stats.recordQuery({
				sessionId,
				agentType: 'codex',
				source: 'auto',
				startTime: baseTime - 300_000,
				duration: 90_000,
				projectPath: projectDir,
				tabId: 'sgs-auto-query',
				isRemote: false,
			});
			const autoRunId = await stats.startAutoRun({
				sessionId,
				agentType: 'codex',
				documentPath: `${projectDir}/docs/RUNBOOK.md`,
				startTime: baseTime - 240_000,
				duration: 180_000,
				tasksTotal: 3,
				tasksCompleted: 2,
				projectPath: projectDir,
			});
			await stats.recordAutoTask({
				autoRunSessionId: autoRunId,
				sessionId,
				agentType: 'codex',
				taskIndex: 0,
				taskContent: 'Seed stats graph tranche',
				startTime: baseTime - 220_000,
				duration: 60_000,
				success: true,
			});
			await stats.endAutoRun(autoRunId, 180_000, 2);
		},
		{
			projectDir: workbench.projectDir,
			sessionId: workbench.sessionId,
			statsSeedTime: workbench.statsSeedTime,
		}
	);
}

async function stubSymphonyHandlers(
	electronApp: ElectronApplication,
	workbench: ReturnType<typeof createStatsGraphSymphonyWorkbench>
) {
	await electronApp.evaluate(
		({ ipcMain }, payload: { sessionId: string }) => {
			const now = '2026-05-29T12:00:00.000Z';
			const stats = {
				totalContributions: 2,
				totalMerged: 1,
				totalIssuesResolved: 1,
				totalDocumentsProcessed: 5,
				totalTasksCompleted: 24,
				totalTokensUsed: 1_500_000,
				totalTimeSpent: 7_200_000,
				estimatedCostDonated: 12.34,
				repositoriesContributed: ['RunMaestro/Maestro', 'RunMaestro/docs'],
				uniqueMaintainersHelped: 2,
				currentStreak: 2,
				longestStreak: 7,
				firstContributionAt: '2026-05-01T12:00:00.000Z',
				lastContributionAt: now,
			};
			const registry = {
				schemaVersion: '1.0',
				lastUpdated: now,
				repositories: [
					{
						slug: 'RunMaestro/Maestro',
						name: 'Maestro Core',
						description: 'Electron workspace for orchestrating coding agents.',
						url: 'https://github.com/RunMaestro/Maestro',
						category: 'developer-tools',
						tags: ['electron', 'codex', 'testing'],
						maintainer: { name: 'RunMaestro', url: 'https://github.com/RunMaestro' },
						isActive: true,
						featured: true,
						addedAt: '2026-05-01T12:00:00.000Z',
						stars: 1234,
					},
					{
						slug: 'RunMaestro/docs',
						name: 'Documentation Hub',
						description: 'Public documentation for Maestro.',
						url: 'https://github.com/RunMaestro/docs',
						category: 'documentation',
						tags: ['docs'],
						maintainer: { name: 'RunMaestro' },
						isActive: true,
						addedAt: '2026-05-02T12:00:00.000Z',
						stars: 321,
					},
				],
			};
			const issues = {
				'RunMaestro/Maestro': [
					{
						number: 42,
						title: 'Add deterministic E2E coverage',
						body: 'Please run the attached Auto Run document.',
						url: 'https://api.github.com/repos/RunMaestro/Maestro/issues/42',
						htmlUrl: 'https://github.com/RunMaestro/Maestro/issues/42',
						author: 'maintainer',
						createdAt: '2026-05-20T12:00:00.000Z',
						updatedAt: now,
						documentPaths: [
							{
								name: 'e2e-plan.md',
								path: 'https://example.com/symphony/e2e-plan.md',
								isExternal: true,
							},
							{
								name: 'follow-up-checklist.md',
								path: 'https://example.com/symphony/follow-up-checklist.md',
								isExternal: true,
							},
						],
						labels: [{ name: 'good first issue', color: '0e8a16' }],
						status: 'available',
					},
					{
						number: 43,
						title: 'Blocked dependency upgrade',
						body: 'Wait for upstream release before working.',
						url: 'https://api.github.com/repos/RunMaestro/Maestro/issues/43',
						htmlUrl: 'https://github.com/RunMaestro/Maestro/issues/43',
						author: 'maintainer',
						createdAt: '2026-05-21T12:00:00.000Z',
						updatedAt: now,
						documentPaths: [
							{
								name: 'blocked-plan.md',
								path: 'https://example.com/symphony/blocked-plan.md',
								isExternal: true,
							},
						],
						labels: [{ name: 'blocking', color: 'cc0000' }],
						status: 'available',
					},
					{
						number: 44,
						title: 'Already claimed contribution',
						body: 'Another contributor is handling this issue.',
						url: 'https://api.github.com/repos/RunMaestro/Maestro/issues/44',
						htmlUrl: 'https://github.com/RunMaestro/Maestro/issues/44',
						author: 'maintainer',
						createdAt: '2026-05-22T12:00:00.000Z',
						updatedAt: now,
						documentPaths: [
							{
								name: 'claimed-plan.md',
								path: 'https://example.com/symphony/claimed-plan.md',
								isExternal: true,
							},
						],
						labels: [{ name: 'enhancement', color: '1d76db' }],
						status: 'in_progress',
						claimedByPr: {
							number: 77,
							url: 'https://github.com/RunMaestro/Maestro/pull/77',
							author: 'codex-user',
							isDraft: true,
						},
					},
				],
				'RunMaestro/docs': [],
			};
			const activeContribution = {
				id: 'symphony-active-sgs',
				repoSlug: 'RunMaestro/Maestro',
				repoName: 'Maestro Core',
				issueNumber: 42,
				issueTitle: 'Add deterministic E2E coverage',
				localPath: '/tmp/maestro-symphony-sgs',
				branchName: 'symphony/issue-42-sgs',
				draftPrNumber: 77,
				draftPrUrl: 'https://github.com/RunMaestro/Maestro/pull/77',
				startedAt: '2026-05-29T10:00:00.000Z',
				status: 'ready_for_review',
				progress: {
					totalDocuments: 2,
					completedDocuments: 2,
					currentDocument: 'e2e-plan.md',
					totalTasks: 6,
					completedTasks: 6,
				},
				tokenUsage: {
					inputTokens: 120_000,
					outputTokens: 42_000,
					estimatedCost: 3.21,
				},
				timeSpent: 3_600_000,
				sessionId: payload.sessionId,
				agentType: 'codex',
			};
			const completedContribution = {
				id: 'symphony-completed-sgs',
				repoSlug: 'RunMaestro/docs',
				repoName: 'Documentation Hub',
				issueNumber: 12,
				issueTitle: 'Document mobile bridge setup',
				startedAt: '2026-05-28T10:00:00.000Z',
				completedAt: '2026-05-28T12:00:00.000Z',
				prUrl: 'https://github.com/RunMaestro/docs/pull/12',
				prNumber: 12,
				tokenUsage: { inputTokens: 300_000, outputTokens: 80_000, totalCost: 4.56 },
				timeSpent: 7_200_000,
				documentsProcessed: 3,
				tasksCompleted: 18,
				wasMerged: true,
				mergedAt: '2026-05-28T14:00:00.000Z',
			};
			const state = { active: [activeContribution], history: [completedContribution], stats };

			ipcMain.removeHandler('symphony:getRegistry');
			ipcMain.handle('symphony:getRegistry', async () => ({
				success: true,
				registry,
				fromCache: true,
				cacheAge: 300_000,
			}));
			ipcMain.removeHandler('symphony:getIssueCounts');
			ipcMain.handle('symphony:getIssueCounts', async () => ({
				success: true,
				counts: { 'RunMaestro/Maestro': 3, 'RunMaestro/docs': 0 },
				fromCache: true,
				cacheAge: 60_000,
			}));
			ipcMain.removeHandler('symphony:getIssues');
			ipcMain.handle('symphony:getIssues', async (_event, repoSlug: string) => ({
				success: true,
				issues: issues[repoSlug as keyof typeof issues] ?? [],
				fromCache: true,
				cacheAge: 60_000,
			}));
			ipcMain.removeHandler('symphony:getState');
			ipcMain.handle('symphony:getState', async () => ({ success: true, state }));
			ipcMain.removeHandler('symphony:getActive');
			ipcMain.handle('symphony:getActive', async () => ({
				success: true,
				contributions: state.active,
			}));
			ipcMain.removeHandler('symphony:getCompleted');
			ipcMain.handle('symphony:getCompleted', async (_event, limit?: number) => ({
				success: true,
				contributions: state.history.slice(0, limit ?? state.history.length),
			}));
			ipcMain.removeHandler('symphony:getStats');
			ipcMain.handle('symphony:getStats', async () => ({ success: true, stats }));
			ipcMain.removeHandler('symphony:checkPRStatuses');
			ipcMain.handle('symphony:checkPRStatuses', async () => ({
				success: true,
				checked: 1,
				merged: 1,
				closed: 0,
			}));
			ipcMain.removeHandler('symphony:syncContribution');
			ipcMain.handle('symphony:syncContribution', async () => ({
				success: true,
				message: 'Contribution status synced',
			}));
			ipcMain.removeHandler('symphony:fetchDocumentContent');
			ipcMain.handle('symphony:fetchDocumentContent', async () => ({
				success: true,
				content: '# External Symphony Doc\n\nDocument preview body for SGS.',
			}));
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({ installed: false, authenticated: false }));
		},
		{ sessionId: workbench.sessionId }
	);
}

async function stubAboutAndLeaderboardHandlers(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		ipcMain.removeHandler('agentSessions:getGlobalStats');
		ipcMain.handle('agentSessions:getGlobalStats', async () => ({
			totalSessions: 2,
			totalMessages: 5,
			totalInputTokens: 120_000,
			totalOutputTokens: 42_000,
			totalCacheReadTokens: 10_000,
			totalCacheCreationTokens: 2_000,
			totalCostUsd: 3.21,
			hasCostData: true,
			totalSizeBytes: 4096,
			isComplete: true,
			byProvider: {},
		}));
		ipcMain.removeHandler('leaderboard:getInstallationId');
		ipcMain.handle('leaderboard:getInstallationId', async () => 'sgs-installation-id');
		ipcMain.removeHandler('leaderboard:submit');
		ipcMain.handle('leaderboard:submit', async () => ({
			success: true,
			emailSent: true,
			clientToken: 'sgs-client-token',
			message: 'Confirmation email queued.',
		}));
		ipcMain.removeHandler('leaderboard:pollAuthStatus');
		ipcMain.handle('leaderboard:pollAuthStatus', async () => ({ status: 'pending' }));
	});
}

async function openQuickActions(window: Page) {
	const quickActionsDialog = window.getByRole('dialog', { name: 'Quick Actions' });
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await quickActionsDialog.isVisible().catch(() => false)) break;
		await window.bringToFront();
		await window.keyboard.press('Meta+K');
		await quickActionsDialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
	}
	await expect(quickActionsDialog).toBeVisible();
	await expect(
		quickActionsDialog.getByPlaceholder('Type a command or jump to agent...')
	).toBeVisible();
	return quickActionsDialog;
}

async function openUsageDashboard(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Usage Dashboard');
	await quickActionsDialog.getByRole('button', { name: /Usage Dashboard/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const usageDashboard = window.getByRole('dialog', { name: 'Usage Dashboard' });
	await expect(usageDashboard).toBeVisible();
	return usageDashboard;
}

async function openSymphonyFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('Maestro Symphony');
	await quickActionsDialog.getByRole('button', { name: /Maestro Symphony/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const symphonyDialog = window.getByRole('dialog').first();
	await expect(symphonyDialog).toBeVisible();
	await expect(symphonyDialog.getByText('Maestro Symphony').first()).toBeVisible();
	return symphonyDialog;
}

async function selectSymphonyIssue(symphonyDialog: Locator, issueName: RegExp | string) {
	const accessibleName =
		typeof issueName === 'string' ? new RegExp(escapeRegExp(issueName)) : issueName;
	await symphonyDialog.getByRole('button', { name: accessibleName }).click();
}

function getSymphonyDocumentButton(symphonyDialog: Locator, documentName: string) {
	return symphonyDialog.getByRole('button', { name: documentName, exact: true });
}

function getSymphonyCloseoutText(symphonyDialog: Locator, expected: string) {
	if (/^[^\s:]+\.md$/.test(expected)) {
		return getSymphonyDocumentButton(symphonyDialog, expected);
	}

	return symphonyDialog.getByText(new RegExp(escapeRegExp(expected))).first();
}

async function openAboutFromQuickActions(window: Page) {
	const quickActionsDialog = await openQuickActions(window);
	await quickActionsDialog
		.getByPlaceholder('Type a command or jump to agent...')
		.fill('About Maestro');
	await quickActionsDialog.getByRole('button', { name: /About Maestro/ }).click();

	await expect(quickActionsDialog).toBeHidden();
	const aboutDialog = window.getByRole('dialog', { name: 'About Maestro' });
	await expect(aboutDialog).toBeVisible();
	return aboutDialog;
}

async function openDocumentGraphFromPreview(window: Page) {
	await window.getByTitle('View in Document Graph (⌘ ⇧ G)').click();
	const graphDialog = window.getByRole('dialog', { name: 'Document Graph', exact: true });
	await expect(graphDialog).toBeVisible({ timeout: 15000 });
	await expect(graphDialog.getByText(/\d+ documents/)).toBeVisible({ timeout: 15000 });
	return graphDialog;
}

const DOCUMENT_GRAPH_SEARCH_MATCH_STATUS = /\d+ of \d+ matching/;

async function expectDocumentGraphSearchMatch(
	graphDialog: ReturnType<Page['getByRole']>,
	options?: { timeout?: number }
) {
	await expect(graphDialog.getByText(DOCUMENT_GRAPH_SEARCH_MATCH_STATUS)).toBeVisible(options);
}

async function openDocumentGraphDepthMenu(graphDialog: ReturnType<Page['getByRole']>) {
	await graphDialog.getByText(/Depth: /).click();
}

async function clickDocumentGraphLayoutOption(
	graphDialog: ReturnType<Page['getByRole']>,
	option: string
) {
	await graphDialog.getByTitle(/Layout: /).click();
	await graphDialog
		.getByRole('button', { name: new RegExp(option) })
		.last()
		.click();
}

async function closeDocumentGraph(window: Page) {
	await window
		.getByRole('dialog', { name: 'Document Graph', exact: true })
		.getByTitle('Close (Esc)')
		.first()
		.click();
	const closeDialog = window.getByRole('dialog', { name: 'Close Document Graph?' });
	await expect(closeDialog).toBeVisible();
	await closeDialog.getByRole('button', { name: 'Close Graph' }).click();
	await expect(window.getByRole('dialog', { name: 'Document Graph', exact: true })).toBeHidden();
}

async function clickDocumentGraphCenter(
	graphDialog: ReturnType<Page['getByRole']>,
	button: 'left' | 'right' = 'left'
) {
	const canvas = graphDialog.locator('canvas');
	const box = await canvas.boundingBox();
	if (!box) throw new Error('Document graph canvas was not visible');

	await canvas.click({
		button,
		position: { x: box.width / 2, y: box.height / 2 },
	});
}

async function dragDocumentGraphCenterNode(
	window: Page,
	graphDialog: ReturnType<Page['getByRole']>
) {
	const canvas = graphDialog.locator('canvas');
	const box = await canvas.boundingBox();
	if (!box) throw new Error('Document graph canvas was not visible');

	await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await window.mouse.down();
	await window.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 30, {
		steps: 4,
	});
	await window.mouse.up();
}

async function showDocumentGraphExternalLinks(graphDialog: ReturnType<Page['getByRole']>) {
	await graphDialog.getByTitle('Show external links').click();
	await expect(graphDialog.getByTitle('Hide external links')).toBeVisible({ timeout: 15000 });
}

const DOCUMENT_GRAPH_EXTERNAL_NODE_SCREEN_OFFSET = 160;
const DOCUMENT_GRAPH_FILTERED_EXTERNAL_NODE_OFFSETS = [
	{ x: -90, y: 140 },
	{ x: -90, y: 155 },
	{ x: -105, y: 140 },
	{ x: -75, y: 140 },
	{ x: -90, y: 125 },
	{ x: -105, y: 155 },
	{ x: -75, y: 155 },
];
const DOCUMENT_GRAPH_FILTERED_EXTERNAL_NODE_LABEL = 'External: docs.runmaestro.ai';

async function isVisible(locator: Locator, timeout = 500) {
	try {
		await expect(locator).toBeVisible({ timeout });
		return true;
	} catch {
		return false;
	}
}

async function clickDocumentGraphExternalNode(
	graphDialog: ReturnType<Page['getByRole']>,
	button: 'left' | 'right' = 'left'
) {
	const canvas = graphDialog.locator('canvas');
	const box = await canvas.boundingBox();
	if (!box) throw new Error('Document graph canvas was not visible');

	await canvas.click({
		button,
		position: {
			x: box.width / 2,
			y: Math.min(box.height - 24, box.height / 2 + DOCUMENT_GRAPH_EXTERNAL_NODE_SCREEN_OFFSET),
		},
	});
}

async function clickDocumentGraphFilteredExternalNode(
	graphDialog: ReturnType<Page['getByRole']>,
	button: 'left' | 'right' = 'left'
) {
	const canvas = graphDialog.locator('canvas');
	const box = await canvas.boundingBox();
	if (!box) throw new Error('Document graph canvas was not visible');

	for (const offset of DOCUMENT_GRAPH_FILTERED_EXTERNAL_NODE_OFFSETS) {
		await canvas.click({
			button,
			position: {
				x: Math.max(24, Math.min(box.width - 24, box.width / 2 + offset.x)),
				y: Math.max(24, Math.min(box.height - 24, box.height / 2 + offset.y)),
			},
		});

		if (button === 'left') {
			if (await isVisible(graphDialog.getByText(DOCUMENT_GRAPH_FILTERED_EXTERNAL_NODE_LABEL))) {
				return;
			}
		} else if (await isVisible(graphDialog.getByRole('button', { name: /^Copy URL$/ }))) {
			return;
		}
	}

	throw new Error('Could not target filtered docs.runmaestro.ai external domain node');
}

function addSecondRunMaestroExternalLink(
	workbench: ReturnType<typeof createStatsGraphSymphonyWorkbench>
) {
	fs.appendFileSync(
		workbench.runbookPath,
		'\n[Maestro docs](https://runmaestro.ai/docs)\n',
		'utf-8'
	);
}

function addDocsRunMaestroExternalLink(
	workbench: ReturnType<typeof createStatsGraphSymphonyWorkbench>
) {
	fs.appendFileSync(
		workbench.runbookPath,
		'\n[Maestro docs site](https://docs.runmaestro.ai)\n',
		'utf-8'
	);
}

async function stubSymphonyAgentDetection(
	electronApp: ElectronApplication,
	agentsAvailable = true
) {
	await electronApp.evaluate(({ ipcMain }, available: boolean) => {
		const capabilities = { supportsBatchMode: true, supportsModelSelection: false };
		const agents = available
			? [
					{
						id: 'codex',
						name: 'Codex',
						binaryName: 'codex',
						command: 'codex',
						args: [],
						available: true,
						path: '/usr/local/bin/codex',
						capabilities,
					},
				]
			: [];

		ipcMain.removeHandler('agents:detect');
		ipcMain.handle('agents:detect', async () => agents);
		ipcMain.removeHandler('agents:get');
		ipcMain.handle(
			'agents:get',
			async (_event, agentId: string) => agents.find((agent) => agent.id === agentId) ?? null
		);
		ipcMain.removeHandler('agents:refresh');
		ipcMain.handle('agents:refresh', async (_event, agentId: string) =>
			agents.find((agent) => agent.id === agentId)
		);
		ipcMain.removeHandler('agents:getConfig');
		ipcMain.handle('agents:getConfig', async () => ({}));
		ipcMain.removeHandler('agents:setConfig');
		ipcMain.handle('agents:setConfig', async () => true);
		ipcMain.removeHandler('agents:getModels');
		ipcMain.handle('agents:getModels', async () => []);
	}, agentsAvailable);
}

async function stubExternalLinkCapture(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & { __sgsExternalUrls?: string[] };
		state.__sgsExternalUrls = [];
		ipcMain.removeHandler('shell:openExternal');
		ipcMain.handle('shell:openExternal', async (_event, url: string) => {
			state.__sgsExternalUrls!.push(url);
		});
	});
}

async function getCapturedExternalLinks(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & { __sgsExternalUrls?: string[] };
		return state.__sgsExternalUrls ?? [];
	});
}

async function stubWindowClipboardTextCapture(electronApp: ElectronApplication) {
	await electronApp.evaluate(({ ipcMain }) => {
		const state = globalThis as typeof globalThis & { __sgsClipboardText?: string };
		state.__sgsClipboardText = '';
		ipcMain.removeHandler('clipboard:writeText');
		ipcMain.handle('clipboard:writeText', async (_event, text: string) => {
			state.__sgsClipboardText = text;
		});
	});
}

async function getCapturedWindowClipboardText(electronApp: ElectronApplication) {
	return electronApp.evaluate(() => {
		const state = globalThis as typeof globalThis & { __sgsClipboardText?: string };
		return state.__sgsClipboardText ?? '';
	});
}

async function openLeaderboardWithManualAuthToken(
	window: Page,
	electronApp: ElectronApplication,
	displayName: string,
	email: string
) {
	await electronApp.evaluate(({ ipcMain }) => {
		let submitCalls = 0;
		ipcMain.removeHandler('leaderboard:submit');
		ipcMain.handle('leaderboard:submit', async () => {
			submitCalls += 1;
			if (submitCalls === 1) {
				return { success: false, authTokenRequired: true };
			}
			return { success: true };
		});
		ipcMain.removeHandler('leaderboard:pollAuthStatus');
		ipcMain.handle('leaderboard:pollAuthStatus', async () => ({ status: 'pending' }));
	});

	const aboutDialog = await openAboutFromQuickActions(window);
	await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

	const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
	await leaderboardDialog.getByPlaceholder('ConductorPedram').fill(displayName);
	await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill(email);
	await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();
	await expect(
		leaderboardDialog.getByPlaceholder('Paste your 64-character auth token')
	).toBeVisible();
	await leaderboardDialog
		.getByPlaceholder('Paste your 64-character auth token')
		.fill('b'.repeat(64));
	await leaderboardDialog.getByRole('button', { name: 'Submit' }).click();
	await expect(
		leaderboardDialog.getByText(
			'Your profile has been updated! Use "Pull Down" to sync stats from the server.'
		)
	).toBeVisible();

	await leaderboardDialog.getByRole('button').first().click();
	await expect(leaderboardDialog).toBeHidden();
	const registeredAboutDialog = await openAboutFromQuickActions(window);
	await registeredAboutDialog.getByRole('button', { name: /Leaderboard/ }).click();

	const registeredLeaderboardDialog = window.getByRole('dialog', { name: /Leaderboard/ });
	await expect(
		registeredLeaderboardDialog.getByRole('button', { name: 'Pull Down' })
	).toBeVisible();
	return registeredLeaderboardDialog;
}

test.describe(`Stats graph Symphony matrix (${activeScenarioMatrix.length} active; ${skippedScenarioMatrix.length + envGatedScenarioMatrix.length} non-active residuals documented)`, () => {
	let window: Page;
	let electronApp: ElectronApplication;
	let cleanupApp: (() => Promise<void>) | undefined;
	let workbench: ReturnType<typeof createStatsGraphSymphonyWorkbench>;

	test.beforeEach(async () => {
		workbench = createStatsGraphSymphonyWorkbench();
		const launched = await helpers.launchAppWithState({
			homeDir: workbench.homeDir,
			sessions: workbench.sessions,
			settings: {
				leaderboardRegistration: null,
			},
		});
		window = launched.window;
		electronApp = launched.electronApp;
		cleanupApp = launched.cleanup;
		await seedStats(window, workbench);
		await stubSymphonyHandlers(electronApp, workbench);
		await stubAboutAndLeaderboardHandlers(electronApp);
		await expect(window.getByText('Stats Graph Symphony Fixture')).toBeVisible();
	});

	test.afterEach(async () => {
		await cleanupApp?.();
		cleanupApp = undefined;
	});

	test(`${activeScenarioMatrix[0].id} ${activeScenarioMatrix[0].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('all');
		await expect(usageDashboard.getByText('Showing all time data')).toBeVisible();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
		await expect(usageDashboard.getByText('Total Queries')).toBeVisible();

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-weekday-comparison')).toBeVisible();
	});

	test(`${activeScenarioMatrix[1].id} ${activeScenarioMatrix[1].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir, sessionId }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				await stats.recordQuery({
					sessionId,
					agentType: 'codex',
					source: 'user',
					startTime: Date.now(),
					duration: 30_000,
					projectPath: projectDir,
					tabId: 'sgs-live-update',
					isRemote: false,
				});
			},
			{ projectDir: workbench.projectDir, sessionId: workbench.sessionId }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
	});

	test(`${activeScenarioMatrix[2].id} ${activeScenarioMatrix[2].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByLabel('Search documents in graph').fill('runbook');
		await expectDocumentGraphSearchMatch(graphDialog);
		await graphDialog.getByTitle('Open help panel').click();
		await expect(graphDialog.getByRole('region', { name: 'Help panel' })).toBeVisible();
		await expect(graphDialog.getByText('Node Types')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[3].id} ${activeScenarioMatrix[3].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByPlaceholder('Search repositories...').fill('core');
		await expect(symphonyDialog.getByRole('button', { name: /Maestro Core/ })).toBeVisible();
		await expect(symphonyDialog.getByText('Documentation Hub')).toBeHidden();

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await expect(symphonyDialog.getByText('Available Issues (1)')).toBeVisible();
		await expect(symphonyDialog.getByText('In Progress (1)')).toBeVisible();
		await expect(symphonyDialog.getByText('Blocked (1)')).toBeVisible();
		await expect(symphonyDialog.getByText('Draft PR #77')).toBeVisible();
		await expect(symphonyDialog.getByText('Already claimed contribution')).toBeVisible();
		await expect(symphonyDialog.getByText('Add deterministic E2E coverage')).toBeVisible();
		await expect(symphonyDialog.getByText('Blocked dependency upgrade')).toBeVisible();
		await expect(symphonyDialog.getByText('Select an issue to see details')).toBeVisible();
	});

	test(`${activeScenarioMatrix[4].id} ${activeScenarioMatrix[4].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);

		await expect(aboutDialog.getByText('Global Statistics')).toBeVisible();
		await expect(aboutDialog.getByText('Achievements')).toBeVisible();
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await expect(leaderboardDialog).toBeVisible();
		await expect(leaderboardDialog.getByText('Join the global Maestro leaderboard')).toBeVisible();
		await expect(leaderboardDialog.getByText('Your Current Stats')).toBeVisible();
		await expect(leaderboardDialog.getByText('Total Runs:')).toBeVisible();
	});

	test(`${activeScenarioMatrix[5].id} ${activeScenarioMatrix[5].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('all');

		const sourceSection = usageDashboard.getByTestId('section-source-distribution');
		await expect(
			sourceSection.getByRole('figure', { name: /query counts breakdown/i })
		).toBeVisible();
		await sourceSection.getByRole('button', { name: 'Duration' }).click();
		await expect(sourceSection.getByRole('figure', { name: /duration breakdown/i })).toBeVisible();
		await expect(sourceSection.getByRole('list', { name: 'Chart legend' })).toBeVisible();

		const locationSection = usageDashboard.getByTestId('section-location-distribution');
		await expect(locationSection.getByRole('img', { name: /Local 100\.0%/i })).toBeVisible();
		await expect(locationSection.getByText('Local')).toBeVisible();

		const peakSection = usageDashboard.getByTestId('section-peak-hours');
		await peakSection.getByRole('button', { name: 'Duration' }).click();
		await expect(peakSection.getByText('Peak:')).toBeVisible();
	});

	test(`${activeScenarioMatrix[6].id} ${activeScenarioMatrix[6].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('section-autorun-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metrics')).toBeVisible();
		await expect(usageDashboard.getByRole('group', { name: /Total Sessions/ })).toBeVisible();
		await expect(usageDashboard.getByRole('group', { name: /Tasks Done/ })).toBeVisible();

		await expect(usageDashboard.getByTestId('section-tasks-by-hour')).toBeVisible();
		await expect(usageDashboard.getByTestId('tasks-by-hour-chart')).toBeVisible();
		await expect(usageDashboard.getByText(/Peak hours:/)).toBeVisible();

		const longestRuns = usageDashboard.getByTestId('longest-autoruns-table');
		await expect(longestRuns).toBeVisible();
		await expect(longestRuns.getByText('RUNBOOK.md')).toBeVisible();
		await expect(longestRuns.getByText('2 / 3')).toBeVisible();
	});

	test(`${activeScenarioMatrix[7].id} ${activeScenarioMatrix[7].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle(/Layout: /).click();
		await graphDialog.getByRole('button', { name: /Radial/ }).click();
		await expect(graphDialog.getByTitle('Layout: Radial')).toBeVisible();

		await openDocumentGraphDepthMenu(graphDialog);
		await graphDialog.locator('input[type="range"]').first().fill('2');
		await expect(graphDialog.getByText('Showing documents within 2 links of focus')).toBeVisible();
		await window.keyboard.press('Escape');

		await graphDialog.getByText(/Preview: \d+/).click();
		await graphDialog.locator('input[type="range"]').last().fill('250');
		await expect(graphDialog.getByText('Characters shown in document previews')).toBeVisible();
		await window.keyboard.press('Escape');

		await graphDialog.getByLabel('Search documents in graph').fill('readme');
		await expect(graphDialog.getByText('README.md')).toBeVisible();
		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[8].id} ${activeScenarioMatrix[8].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await expect(symphonyDialog.getByText('Ready for Review')).toBeVisible();
		await expect(symphonyDialog.getByText('Current: e2e-plan.md')).toBeVisible();

		await symphonyDialog.getByTitle('Sync status with GitHub').click();
		await expect(symphonyDialog.getByText('Contribution status synced')).toBeVisible();

		await symphonyDialog.getByRole('button', { name: 'Check PR Status' }).click();
		await expect(symphonyDialog.getByText('1 PR merged')).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: 'Finalize PR' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[9].id} ${activeScenarioMatrix[9].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await expect(symphonyDialog.getByText('#42').last()).toBeVisible();
		await expect(getSymphonyDocumentButton(symphonyDialog, 'e2e-plan.md')).toBeVisible();
		await expect(symphonyDialog.getByText('Document preview body for SGS.')).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: 'Start Symphony' })).toBeEnabled();

		await selectSymphonyIssue(symphonyDialog, /#43 Blocked dependency upgrade/);
		await expect(symphonyDialog.getByText('Blocked by a dependency')).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: 'Start Symphony' })).toBeDisabled();
		await expect(symphonyDialog.getByText('Already claimed contribution')).toBeVisible();
		await expect(symphonyDialog.getByText('Draft PR #77 by @codex-user')).toBeVisible();
	});

	test(`${activeScenarioMatrix[10].id} ${activeScenarioMatrix[10].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Stats Conductor');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('bad-email');
		await expect(leaderboardDialog.getByText('Please enter a valid email address')).toBeVisible();
		await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeDisabled();

		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('stats@example.com');
		await leaderboardDialog.getByPlaceholder('username').first().fill('stats-conductor');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();
		await expect(leaderboardDialog.getByText(/Profile submitted!/)).toBeVisible();
	});

	test(`${activeScenarioMatrix[11].id} ${activeScenarioMatrix[11].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);
		const viewModeTabs = usageDashboard.getByTestId('view-mode-tabs');

		await viewModeTabs.focus();
		await window.keyboard.press('ArrowRight');
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
			'aria-selected',
			'true'
		);

		await window.keyboard.press('Tab');
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeFocused();

		await window.keyboard.press('ArrowDown');
		await expect(usageDashboard.getByTestId('section-agent-efficiency')).toBeFocused();

		await window.keyboard.press('End');
		await expect(usageDashboard.getByTestId('section-agent-usage')).toBeFocused();
	});

	test(`${activeScenarioMatrix[12].id} ${activeScenarioMatrix[12].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		const agentUsage = usageDashboard.getByTestId('section-agent-usage');
		await agentUsage.scrollIntoViewIfNeeded();

		await expect(agentUsage.getByRole('figure', { name: /query counts over time/i })).toBeVisible();
		await agentUsage.getByRole('button', { name: 'Time' }).click();
		await expect(agentUsage.getByRole('figure', { name: /duration over time/i })).toBeVisible();
		await agentUsage.getByRole('button', { name: 'Queries' }).click();
		await expect(agentUsage.getByRole('figure', { name: /query counts over time/i })).toBeVisible();
	});

	test(`${activeScenarioMatrix[13].id} ${activeScenarioMatrix[13].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await searchInput.fill('runbook');
		await expectDocumentGraphSearchMatch(graphDialog);
		await graphDialog.getByLabel('Clear search').click();
		await expect(searchInput).toHaveValue('');

		await graphDialog.getByRole('button', { name: 'External' }).click();
		await expect(graphDialog.getByTitle('Hide external links')).toBeVisible();

		await graphDialog.getByTitle('Refresh graph').click();
		await expect(graphDialog.getByText(/\d+ documents/)).toBeVisible({ timeout: 15000 });
		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[14].id} ${activeScenarioMatrix[14].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);

		await expect(aboutDialog.getByText('Maestro Achievements')).toBeVisible();
		await aboutDialog.getByTitle('Apprentice Conductor - Click to view details').click();
		await expect(aboutDialog.getByText('Level 1')).toBeVisible();
		await expect(aboutDialog.getByText('Locked', { exact: true })).toBeVisible();

		await aboutDialog.getByTitle('Share achievements').click();
		await expect(aboutDialog.getByRole('button', { name: 'Copy to Clipboard' })).toBeVisible();
		await expect(aboutDialog.getByRole('button', { name: 'Save as Image' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[15].id} ${activeScenarioMatrix[15].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();

		await expect(window.getByText('GitHub CLI Required')).toBeVisible();
		await expect(window.getByText(/gh auth login/)).toBeVisible();
		await window.getByRole('button', { name: 'Close' }).last().click();
		await expect(window.getByText('GitHub CLI Required')).toBeHidden();
	});

	test(`${activeScenarioMatrix[16].id} ${activeScenarioMatrix[16].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async () => ({
				success: true,
				pendingEmailConfirmation: true,
				clientToken: 'sgs-pending-client-token',
				message: 'Confirmation email queued.',
			}));
			ipcMain.removeHandler('leaderboard:pollAuthStatus');
			ipcMain.handle('leaderboard:pollAuthStatus', async () => ({ status: 'pending' }));
		});

		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Pending Conductor');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('pending@example.com');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();

		await expect(
			leaderboardDialog.getByText('Please check your email to confirm your registration.')
		).toBeVisible();
		await expect(
			leaderboardDialog.getByText('Click the link in your email to complete registration.')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[17].id} ${activeScenarioMatrix[17].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		const durationTrends = usageDashboard.getByTestId('section-duration-trends');
		await durationTrends.scrollIntoViewIfNeeded();

		await expect(
			durationTrends.getByRole('figure', { name: /Duration trends chart showing average/i })
		).toBeVisible();
		await durationTrends.getByRole('button', { name: 'Enable smoothing' }).click();
		await expect(durationTrends.getByRole('button', { name: 'Disable smoothing' })).toBeVisible();
		await expect(durationTrends.getByText('Duration Trends')).toBeVisible();
	});

	test(`${activeScenarioMatrix[18].id} ${activeScenarioMatrix[18].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		const tasksChart = usageDashboard.getByTestId('autorun-tasks-chart');
		await tasksChart.scrollIntoViewIfNeeded();

		await expect(tasksChart).toHaveAttribute('aria-label', /Tasks completed over time chart/);
		await expect(tasksChart.getByRole('list', { name: 'Tasks completed by date' })).toBeVisible();
		await expect(
			usageDashboard.getByTestId(`task-bar-${workbench.statsSeedDateKey}`)
		).toHaveAttribute(
			'aria-label',
			new RegExp(
				`${escapeRegExp(workbench.statsSeedDateLabel)}: \\d+ tasks attempted, \\d+ successful`
			)
		);
	});

	test(`${activeScenarioMatrix[19].id} ${activeScenarioMatrix[19].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Open help panel').click();
		const helpPanel = graphDialog.getByRole('region', { name: 'Help panel' });
		await expect(helpPanel).toBeVisible();
		await expect(helpPanel.getByText('Keyboard Shortcuts')).toBeVisible();
		await expect(helpPanel.getByText('Focus node in graph')).toBeVisible();
		await expect(helpPanel.getByText('Preview document in-graph')).toBeVisible();
		await expect(helpPanel.getByText('Mouse Actions')).toBeVisible();
		await expect(helpPanel.getByText('Right-click')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[20].id} ${activeScenarioMatrix[20].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByPlaceholder('Search repositories...').fill('documentation');
		await expect(symphonyDialog.getByRole('button', { name: /Documentation Hub/ })).toBeVisible();
		await symphonyDialog.getByRole('button', { name: /Documentation Hub/ }).click();

		await expect(symphonyDialog.getByText('Maestro Symphony: Documentation Hub')).toBeVisible();
		await expect(symphonyDialog.getByText('No issues with runmaestro.ai label')).toBeVisible();
		await expect(symphonyDialog.getByText('No outstanding work for this project')).toBeVisible();
		await expect(
			symphonyDialog.getByText('There are no issues labeled with runmaestro.ai')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[21].id} ${activeScenarioMatrix[21].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: 'History' }).click();
		await expect(symphonyDialog.getByText('Document mobile bridge setup')).toBeVisible();
		await expect(symphonyDialog.getByText('Merged').first()).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: /PR #12/ })).toBeVisible();
		await expect(symphonyDialog.getByText('Documents').first()).toBeVisible();
		await expect(symphonyDialog.getByText('Tasks').first()).toBeVisible();
		await expect(symphonyDialog.getByText('Tokens').first()).toBeVisible();
		await expect(symphonyDialog.getByText('Cost').first()).toBeVisible();
		await expect(symphonyDialog.getByText('$4.56')).toBeVisible();
	});

	test(`${activeScenarioMatrix[22].id} ${activeScenarioMatrix[22].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		const activityHeatmap = usageDashboard.getByTestId('section-activity-heatmap');
		await activityHeatmap.scrollIntoViewIfNeeded();

		await expect(
			activityHeatmap.getByRole('figure', { name: /query activity over/i })
		).toBeVisible();
		await activityHeatmap.getByLabel('Show total duration').click();
		await expect(activityHeatmap.getByRole('figure', { name: /duration over/i })).toBeVisible();
		await expect(
			activityHeatmap.getByRole('list', { name: 'Activity intensity scale from less to more' })
		).toBeVisible();
		await expect(
			activityHeatmap.getByRole('listitem', { name: 'Intensity level 4: High activity' })
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[23].id} ${activeScenarioMatrix[23].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		const agentComparison = usageDashboard.getByTestId('section-agent-comparison').first();
		await agentComparison.scrollIntoViewIfNeeded();

		await expect(
			agentComparison.getByRole('figure', { name: /Provider comparison chart/i })
		).toBeVisible();
		await expect(agentComparison.getByRole('list', { name: 'Agent usage data' })).toBeVisible();
		await expect(
			agentComparison.getByRole('listitem', { name: /codex: \d+ queries/i })
		).toBeVisible();
		await expect(
			agentComparison.getByRole('meter', { name: /codex usage percentage/i })
		).toBeVisible();
		await expect(agentComparison.getByRole('list', { name: 'Chart legend' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[24].id} ${activeScenarioMatrix[24].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByLabel('Help').click();

		await expect(symphonyDialog.getByText('About Maestro Symphony').last()).toBeVisible();
		await expect(
			symphonyDialog.getByText('Symphony connects Maestro users with open source projects')
		).toBeVisible();
		await expect(
			symphonyDialog.getByRole('button', { name: 'docs.runmaestro.ai/symphony' })
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[25].id} ${activeScenarioMatrix[25].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: 'Stats' }).click();

		await expect(symphonyDialog.getByText('Tokens Donated')).toBeVisible();
		await expect(symphonyDialog.getByText('1.5M')).toBeVisible();
		await expect(symphonyDialog.getByText('Worth $12.34')).toBeVisible();
		await expect(symphonyDialog.getByText('Time Contributed')).toBeVisible();
		await expect(symphonyDialog.getByText('2h 0m')).toBeVisible();
		await expect(symphonyDialog.getByText('2 repositories')).toBeVisible();
		await expect(symphonyDialog.getByText('Streak', { exact: true })).toBeVisible();
		await expect(symphonyDialog.getByText('2 weeks')).toBeVisible();
		await expect(symphonyDialog.getByText('Best: 7 weeks')).toBeVisible();
		await expect(symphonyDialog.getByText('First Steps')).toBeVisible();
		await expect(symphonyDialog.getByText('Merged Melody')).toBeVisible();
	});

	test(`${activeScenarioMatrix[26].id} ${activeScenarioMatrix[26].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async () => ({
				success: false,
				error: 'Leaderboard unavailable for SGS fallback',
			}));
		});

		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Error Conductor');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('error@example.com');
		await leaderboardDialog.getByPlaceholder('username').first().fill('error-conductor');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();

		await expect(
			leaderboardDialog.getByText('Leaderboard unavailable for SGS fallback')
		).toBeVisible();
		await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[27].id} ${activeScenarioMatrix[27].title}`, async () => {
		const exportPath = path.join(workbench.homeDir, 'usage-dashboard-export.csv');
		await electronApp.evaluate(({ ipcMain }, filePath: string) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async (_event, options: { title?: string }) => {
				if (options.title !== 'Export Usage Data') {
					throw new Error(`Unexpected save dialog: ${options.title ?? 'untitled'}`);
				}
				return filePath;
			});
		}, exportPath);

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.locator('select').first().selectOption('all');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
		const csv = fs.readFileSync(exportPath, 'utf-8');
		expect(csv).toContain(workbench.sessionId);
		expect(csv).toContain('codex');
	});

	test(`${activeScenarioMatrix[28].id} ${activeScenarioMatrix[28].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await window.keyboard.press('Meta+Shift+]');
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await window.keyboard.press('Meta+Shift+]');
		await expect(usageDashboard.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await window.keyboard.press('Meta+Shift+]');
		await expect(usageDashboard.getByRole('tab', { name: 'Auto Run' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(usageDashboard.getByTestId('section-autorun-stats')).toBeVisible();
	});

	test(`${activeScenarioMatrix[29].id} ${activeScenarioMatrix[29].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await searchInput.fill('missing-sgs-node');
		await expect(graphDialog.getByText(/0 of \d+ matching/)).toBeVisible();
		await graphDialog.getByLabel('Clear search').click();
		await expect(searchInput).toHaveValue('');
		await expect(graphDialog.getByText(/\d+ documents/)).toBeVisible({ timeout: 15000 });

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[30].id} ${activeScenarioMatrix[30].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Close (Esc)').first().click();
		const closeDialog = window.getByRole('dialog', { name: 'Close Document Graph?' });
		await expect(closeDialog).toBeVisible();
		await closeDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(closeDialog).toBeHidden();
		await expect(graphDialog).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[31].id} ${activeScenarioMatrix[31].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);
		const searchInput = symphonyDialog.getByPlaceholder('Search repositories...');
		const documentationCategory = symphonyDialog
			.locator('button')
			.filter({ hasText: 'Documentation' })
			.first();

		await documentationCategory.click();
		await expect(symphonyDialog.getByRole('button', { name: /Documentation Hub/ })).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: /Maestro Core/ })).toBeHidden();

		await searchInput.fill('missing-sgs-repo');
		await expect(symphonyDialog.getByText('No repositories match your search')).toBeVisible();

		await searchInput.fill('');
		await symphonyDialog.getByRole('button', { name: 'All' }).click();
		await expect(symphonyDialog.getByRole('button', { name: /Maestro Core/ })).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: /Documentation Hub/ })).toBeVisible();
	});

	test(`${activeScenarioMatrix[32].id} ${activeScenarioMatrix[32].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => null);
		});

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.locator('select').first().selectOption('all');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
	});

	test(`${activeScenarioMatrix[33].id} ${activeScenarioMatrix[33].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('month');

		await expect(usageDashboard.getByText('Showing this month data')).toBeVisible();
		await expect(usageDashboard.getByTestId('database-size-indicator')).toBeVisible();
		await expect(usageDashboard.getByText('Press Esc to close')).toBeVisible();
	});

	test(`${activeScenarioMatrix[34].id} ${activeScenarioMatrix[34].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await window.keyboard.press('Meta+Shift+[');
		await expect(usageDashboard.getByRole('tab', { name: 'Auto Run' })).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(usageDashboard.getByTestId('section-longest-autoruns')).toBeVisible();
	});

	test(`${activeScenarioMatrix[35].id} ${activeScenarioMatrix[35].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('month');
		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();

		await expect(usageDashboard.getByTestId('section-weekday-comparison')).toBeVisible();
		await expect(usageDashboard.getByText('Weekday vs Weekend')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-duration-trends')).toBeVisible();
		await expect(usageDashboard.getByText('Duration Trends')).toBeVisible();
	});

	test(`${activeScenarioMatrix[36].id} ${activeScenarioMatrix[36].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.dispatchEvent('keydown', {
			key: 'f',
			ctrlKey: true,
			bubbles: true,
			cancelable: true,
		});
		await expect(graphDialog.getByLabel('Search documents in graph')).toBeFocused();
		await graphDialog.getByLabel('Search documents in graph').fill('readme');
		await expect(graphDialog.getByText(/1 of \d+ matching/)).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[37].id} ${activeScenarioMatrix[37].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle(/Layout: /).click();
		await expect(graphDialog.getByRole('button', { name: /Radial/ })).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByRole('button', { name: /Radial/ })).toBeHidden();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[38].id} ${activeScenarioMatrix[38].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await openDocumentGraphDepthMenu(graphDialog);
		await expect(graphDialog.getByText('Neighbor Depth')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Neighbor Depth')).toBeHidden();

		await graphDialog.getByText(/Preview: \d+/).click();
		await expect(graphDialog.getByText('Preview Characters')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Preview Characters')).toBeHidden();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[39].id} ${activeScenarioMatrix[39].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({ installed: true, authenticated: false }));
		});

		const symphonyDialog = await openSymphonyFromQuickActions(window);
		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();

		await expect(window.getByText('GitHub CLI Not Authenticated')).toBeVisible();
		await expect(window.getByText(/gh auth login/)).toBeVisible();
		await window.getByRole('button', { name: 'Close' }).last().click();
		await expect(window.getByText('GitHub CLI Not Authenticated')).toBeHidden();
	});

	test(`${activeScenarioMatrix[40].id} ${activeScenarioMatrix[40].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({ installed: true, authenticated: true }));
		});

		const symphonyDialog = await openSymphonyFromQuickActions(window);
		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();

		await expect(window.getByText('GitHub CLI authenticated')).toBeVisible();
		await expect(window.getByText('Build Tools Required')).toBeVisible();
		await window.getByRole('button', { name: 'Cancel' }).last().click();
		await expect(window.getByText('Build Tools Required')).toBeHidden();
	});

	test(`${activeScenarioMatrix[41].id} ${activeScenarioMatrix[41].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await expect(symphonyDialog.getByText('Maestro Symphony: Maestro Core')).toBeVisible();

		await window.keyboard.press('Escape');
		await expect(symphonyDialog.getByText('Maestro Symphony: Maestro Core')).toBeHidden();
		await expect(symphonyDialog.getByRole('grid', { name: 'Repository tiles' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[42].id} ${activeScenarioMatrix[42].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();

		await expect(usageDashboard.getByTestId('section-session-stats')).toBeVisible();
		await expect(usageDashboard.getByText('Agent Statistics')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-agent-efficiency')).toBeVisible();
		await expect(usageDashboard.getByText('Agent Efficiency')).toBeVisible();
	});

	test(`${activeScenarioMatrix[43].id} ${activeScenarioMatrix[43].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();

		await expect(
			usageDashboard.getByRole('region', { name: 'Auto Run summary metrics' })
		).toBeVisible();
		await expect(usageDashboard.getByRole('group', { name: /Total Sessions/ })).toBeVisible();
		await expect(usageDashboard.getByRole('group', { name: /Avg Session/ })).toBeVisible();
		await expect(
			usageDashboard.getByRole('list', { name: 'Tasks completed by date' })
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[44].id} ${activeScenarioMatrix[44].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(usageDashboard).toBeHidden();
		await expect(window.getByText('Stats Graph Symphony Fixture')).toBeVisible();
	});

	test(`${activeScenarioMatrix[45].id} ${activeScenarioMatrix[45].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByRole('button', { name: 'External' }).click();
		await expect(graphDialog.getByTitle('Hide external links')).toBeVisible();
		await expect(graphDialog.getByText(/external domain/)).toBeVisible();
		await graphDialog.getByRole('button', { name: 'External' }).click();
		await expect(graphDialog.getByTitle('Show external links')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[46].id} ${activeScenarioMatrix[46].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Open help panel').click();
		await expect(graphDialog.getByRole('region', { name: 'Help panel' })).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByRole('region', { name: 'Help panel' })).toBeHidden();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[47].id} ${activeScenarioMatrix[47].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle(/Layout: /).click();
		await graphDialog.getByRole('button', { name: /Force/ }).click();
		await expect(graphDialog.getByTitle('Layout: Force')).toBeVisible();
		await graphDialog.getByTitle('Layout: Force').click();
		await graphDialog.getByRole('button', { name: /Mind Map/ }).click();
		await expect(graphDialog.getByTitle('Layout: Mind Map')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[48].id} ${activeScenarioMatrix[48].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();

		await expect(
			symphonyDialog.getByTitle('Go to session: Stats Graph Symphony Agent')
		).toBeVisible();
		await expect(symphonyDialog.getByText('Ready for Review')).toBeVisible();
	});

	test(`${activeScenarioMatrix[49].id} ${activeScenarioMatrix[49].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByLabel('Help').click();
		await expect(symphonyDialog.getByText('About Maestro Symphony').last()).toBeVisible();
		await symphonyDialog.getByRole('button', { name: 'Close' }).last().click();
		await expect(symphonyDialog.getByText('About Maestro Symphony').last()).toBeHidden();
	});

	test(`${activeScenarioMatrix[50].id} ${activeScenarioMatrix[50].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: 'History' }).click();

		await expect(symphonyDialog.getByText('PRs Created')).toBeVisible();
		await expect(symphonyDialog.getByText('Merged').first()).toBeVisible();
		await expect(symphonyDialog.getByText('Tasks').first()).toBeVisible();
		await expect(symphonyDialog.getByText('Value').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[51].id} ${activeScenarioMatrix[51].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await expect(
			symphonyDialog.getByTitle('Register your project for Symphony contributions')
		).toBeVisible();
		await expect(
			symphonyDialog.getByRole('button', { name: /Register Your Project/ })
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[52].id} ${activeScenarioMatrix[52].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByTitle('Close (Esc)').click();
		await expect(usageDashboard).toBeHidden();
		await expect(window.getByText('Stats Graph Symphony Fixture')).toBeVisible();
	});

	test(`${activeScenarioMatrix[53].id} ${activeScenarioMatrix[53].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		const metrics = usageDashboard.getByRole('region', { name: 'Auto Run summary metrics' });

		await expect(metrics.getByRole('group', { name: /Total Sessions: 1/ })).toBeVisible();
		await expect(
			metrics.getByRole('group', { name: /Tasks Done: 2, of 3 attempted/ })
		).toBeVisible();
		await expect(metrics.getByRole('group', { name: /Success Rate: 67%/ })).toBeVisible();
		await expect(metrics.getByRole('group', { name: /Avg Tasks\/Session: 2\.0/ })).toBeVisible();
	});

	test(`${activeScenarioMatrix[54].id} ${activeScenarioMatrix[54].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.focus();
		await window.keyboard.press('Escape');
		const closeDialog = window.getByRole('dialog', { name: 'Close Document Graph?' });
		await expect(closeDialog).toBeVisible();
		await closeDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(closeDialog).toBeHidden();
		await expect(graphDialog).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[55].id} ${activeScenarioMatrix[55].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByText(/Preview: \d+/).click();
		const previewSlider = graphDialog.locator('input[type="range"]').last();
		await previewSlider.fill('50');
		await expect(graphDialog.getByText('Preview Characters')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Preview: 50')).toBeVisible();

		await graphDialog.getByText('Preview: 50').click();
		await graphDialog.locator('input[type="range"]').last().fill('500');
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Preview: 500')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[56].id} ${activeScenarioMatrix[56].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();

		await expect(symphonyDialog.getByText('About')).toBeVisible();
		await expect(
			symphonyDialog.getByText('Electron workspace for orchestrating coding agents.')
		).toBeVisible();
		await expect(symphonyDialog.getByText('Maintainer')).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: /RunMaestro/ })).toBeVisible();
		await expect(symphonyDialog.getByText('electron', { exact: true }).first()).toBeVisible();
		await expect(symphonyDialog.getByText('codex', { exact: true }).first()).toBeVisible();
		await expect(symphonyDialog.getByText('testing', { exact: true }).first()).toBeVisible();
		await expect(symphonyDialog.getByTitle('View repository on GitHub')).toBeVisible();
	});

	test(`${activeScenarioMatrix[57].id} ${activeScenarioMatrix[57].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);

		await expect(symphonyDialog.getByText('2 Auto Run documents to process')).toBeVisible();
		await getSymphonyDocumentButton(symphonyDialog, 'e2e-plan.md').click();
		await expect(getSymphonyDocumentButton(symphonyDialog, 'follow-up-checklist.md')).toBeVisible();
		await getSymphonyDocumentButton(symphonyDialog, 'follow-up-checklist.md').click();
		await expect(getSymphonyDocumentButton(symphonyDialog, 'follow-up-checklist.md')).toBeVisible();
		await expect(symphonyDialog.getByText('Document preview body for SGS.')).toBeVisible();
	});

	test(`${activeScenarioMatrix[58].id} ${activeScenarioMatrix[58].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Social Conductor');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('social@example.com');
		await expect(leaderboardDialog.getByText('Optional: Link your social profiles')).toBeVisible();

		await leaderboardDialog.locator('input[placeholder="username"]').nth(0).fill('@stats-github');
		await expect(leaderboardDialog.locator('input[placeholder="username"]').nth(0)).toHaveValue(
			'stats-github'
		);
		await leaderboardDialog.getByPlaceholder('handle').fill('@stats-x');
		await expect(leaderboardDialog.getByPlaceholder('handle')).toHaveValue('stats-x');
		await leaderboardDialog.locator('input[placeholder="username"]').nth(1).fill('@stats-linkedin');
		await expect(leaderboardDialog.locator('input[placeholder="username"]').nth(1)).toHaveValue(
			'stats-linkedin'
		);
		await leaderboardDialog.getByPlaceholder('username#1234 or username').fill('@stats-discord');
		await expect(leaderboardDialog.getByPlaceholder('username#1234 or username')).toHaveValue(
			'stats-discord'
		);
		await leaderboardDialog.getByPlaceholder('username.bsky.social').fill('@stats.bsky.social');
		await expect(leaderboardDialog.getByPlaceholder('username.bsky.social')).toHaveValue(
			'stats.bsky.social'
		);
		await expect(
			leaderboardDialog.getByText(
				'Your email is kept private and will not be displayed on the leaderboard'
			)
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[59].id} ${activeScenarioMatrix[59].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);
		const timeRange = usageDashboard.locator('select').first();

		await timeRange.selectOption('week');
		await expect(usageDashboard.getByText('Showing this week data')).toBeVisible();
		await timeRange.selectOption('quarter');
		await expect(usageDashboard.getByText('Showing this quarter data')).toBeVisible();
		await timeRange.selectOption('year');
		await expect(usageDashboard.getByText('Showing this year data')).toBeVisible();
		await timeRange.selectOption('all');
		await expect(usageDashboard.getByText('Showing all time data')).toBeVisible();
	});

	test(`${activeScenarioMatrix[60].id} ${activeScenarioMatrix[60].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);
		const viewTabs = usageDashboard.getByRole('tablist', { name: 'Dashboard view modes' });
		const tabTargets = [
			{ name: 'Overview', panelId: 'tabpanel-overview' },
			{ name: 'Agents', panelId: 'tabpanel-agents' },
			{ name: 'Activity', panelId: 'tabpanel-activity' },
			{ name: 'Auto Run', panelId: 'tabpanel-autorun' },
		];

		for (const { name, panelId } of tabTargets) {
			const tab = viewTabs.getByRole('tab', { name });
			await tab.click();
			await expect(tab).toHaveAttribute('aria-controls', panelId);
			await expect(tab).toHaveAttribute('aria-selected', 'true');
			await expect(usageDashboard.getByTestId('usage-dashboard-content')).toHaveAttribute(
				'id',
				panelId
			);
		}
	});

	test(`${activeScenarioMatrix[61].id} ${activeScenarioMatrix[61].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.locator('select').first().selectOption('all');

		const sourceSection = usageDashboard.getByTestId('section-source-distribution');
		await expect(sourceSection.getByRole('list', { name: 'Chart legend' })).toBeVisible();
		await expect(sourceSection.getByText('Interactive')).toBeVisible();
		await expect(sourceSection.getByText('Auto Run')).toBeVisible();

		const locationSection = usageDashboard.getByTestId('section-location-distribution');
		await expect(locationSection.getByRole('list', { name: 'Chart legend' })).toBeVisible();
		await expect(locationSection.getByText('Local')).toBeVisible();
	});

	test(`${activeScenarioMatrix[62].id} ${activeScenarioMatrix[62].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await searchInput.fill('runbook');
		await expectDocumentGraphSearchMatch(graphDialog);
		await graphDialog.getByTitle('Refresh graph').click();
		await expect(searchInput).toHaveValue('runbook');
		await expectDocumentGraphSearchMatch(graphDialog, { timeout: 15000 });

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[63].id} ${activeScenarioMatrix[63].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Open help panel').click();
		const helpPanel = graphDialog.getByRole('region', { name: 'Help panel' });
		await expect(helpPanel).toBeVisible();
		await helpPanel.getByTitle('Close (Esc)').click();
		await expect(helpPanel).toBeHidden();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[64].id} ${activeScenarioMatrix[64].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await openDocumentGraphDepthMenu(graphDialog);
		const depthSlider = graphDialog.locator('input[type="range"]').first();
		await depthSlider.fill('1');
		await expect(graphDialog.getByText('Showing documents within 1 link of focus')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Depth: 1')).toBeVisible();

		await graphDialog.getByText('Depth: 1').click();
		await graphDialog.locator('input[type="range"]').first().fill('0');
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Depth: All')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[65].id} ${activeScenarioMatrix[65].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();

		await expect(symphonyDialog.getByText('Ready for Review')).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: /Draft PR #77/ })).toBeVisible();
		await expect(symphonyDialog.getByText('2 / 2 documents')).toBeVisible();
		await expect(symphonyDialog.getByText('Current: e2e-plan.md')).toBeVisible();
		await expect(symphonyDialog.getByText('In: 120K')).toBeVisible();
		await expect(symphonyDialog.getByText('Out: 42K')).toBeVisible();
		await expect(symphonyDialog.getByText('$3.21')).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: 'Finalize PR' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[66].id} ${activeScenarioMatrix[66].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await expect(symphonyDialog.getByText('Maestro Symphony: Maestro Core')).toBeVisible();
		await symphonyDialog.getByTitle('Back (Esc)').click();
		await expect(symphonyDialog.getByText('Maestro Symphony: Maestro Core')).toBeHidden();
		await expect(symphonyDialog.getByRole('grid', { name: 'Repository tiles' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[67].id} ${activeScenarioMatrix[67].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);

		await expect(symphonyDialog.getByText('#42').last()).toBeVisible();
		await expect(
			symphonyDialog.getByText('Will clone repo, create draft PR, and run all documents')
		).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: 'Start Symphony' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[68].id} ${activeScenarioMatrix[68].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);

		await aboutDialog.getByTitle('Share achievements').click();
		await aboutDialog.getByRole('button', { name: 'Copy to Clipboard' }).click();
		await expect(aboutDialog.getByRole('button', { name: 'Copied!' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[69].id} ${activeScenarioMatrix[69].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				const sessionId = 'sgs-remote-location-session';
				await stats.recordSessionCreated({
					sessionId,
					agentType: 'codex',
					projectPath: projectDir,
					createdAt: Date.now() - 60_000,
					isRemote: true,
				});
				await stats.recordQuery({
					sessionId,
					agentType: 'codex',
					source: 'user',
					startTime: Date.now() - 30_000,
					duration: 45_000,
					projectPath: projectDir,
					tabId: 'sgs-remote-query',
					isRemote: true,
				});
			},
			{ projectDir: workbench.projectDir }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
		await usageDashboard.locator('select').first().selectOption('all');
		await expect(
			usageDashboard.getByTestId('section-location-distribution').getByText('SSH Remote')
		).toBeVisible({ timeout: 5000 });
	});

	test(`${activeScenarioMatrix[70].id} ${activeScenarioMatrix[70].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				const sessionId = 'sgs-claude-agent-session';
				await stats.recordSessionCreated({
					sessionId,
					agentType: 'claude-code',
					projectPath: projectDir,
					createdAt: Date.now() - 120_000,
					isRemote: false,
				});
				await stats.recordQuery({
					sessionId,
					agentType: 'claude-code',
					source: 'user',
					startTime: Date.now() - 90_000,
					duration: 75_000,
					projectPath: projectDir,
					tabId: 'sgs-claude-query',
					isRemote: false,
				});
			},
			{ projectDir: workbench.projectDir }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		const providerComparison = usageDashboard.getByTestId('section-agent-comparison').first();
		await providerComparison.scrollIntoViewIfNeeded();
		const chartLegend = providerComparison.getByRole('list', { name: 'Chart legend' });
		await expect(chartLegend).toBeVisible();
		await expect(chartLegend.getByText('claude-code')).toBeVisible();
	});

	test(`${activeScenarioMatrix[71].id} ${activeScenarioMatrix[71].title}`, async () => {
		await window.evaluate(
			async ({ projectDir, sessionId }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				const failedRunId = await stats.startAutoRun({
					sessionId,
					agentType: 'codex',
					documentPath: `${projectDir}/docs/RUNBOOK.md`,
					startTime: Date.now() - 180_000,
					duration: 240_000,
					tasksTotal: 4,
					tasksCompleted: 1,
					projectPath: projectDir,
				});
				await stats.recordAutoTask({
					autoRunSessionId: failedRunId,
					sessionId,
					agentType: 'codex',
					taskIndex: 0,
					taskContent: 'Record failed stats graph tranche',
					startTime: Date.now() - 150_000,
					duration: 120_000,
					success: false,
				});
				await stats.endAutoRun(failedRunId, 240_000, 1);
			},
			{ projectDir: workbench.projectDir, sessionId: workbench.sessionId }
		);

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		const metrics = usageDashboard.getByRole('region', { name: 'Auto Run summary metrics' });

		await expect(metrics.getByRole('group', { name: /Total Sessions: 2/ })).toBeVisible();
		await expect(
			metrics.getByRole('group', { name: /Tasks Done: 3, of 7 attempted/ })
		).toBeVisible();
		await expect(metrics.getByRole('group', { name: /Success Rate: 43%/ })).toBeVisible();
	});

	test(`${activeScenarioMatrix[72].id} ${activeScenarioMatrix[72].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle(/Layout: /).click();
		await expect(graphDialog.getByText('Tree columns')).toBeVisible();
		await expect(graphDialog.getByText('Concentric rings')).toBeVisible();
		await expect(graphDialog.getByText('Physics simulation')).toBeVisible();
		await window.keyboard.press('Escape');
		await expect(graphDialog.getByText('Concentric rings')).toBeHidden();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[73].id} ${activeScenarioMatrix[73].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Open help panel').click();
		const helpPanel = graphDialog.getByRole('region', { name: 'Help panel' });

		await expect(helpPanel.getByText('Status Indicators')).toBeVisible();
		await expect(helpPanel.getByText('Broken Links')).toBeVisible();
		await expect(helpPanel.getByText('Links to non-existent files')).toBeVisible();
		await expect(
			helpPanel.getByRole('img', { name: 'Broken links warning indicator' })
		).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[74].id} ${activeScenarioMatrix[74].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await searchInput.fill('runbook');
		await graphDialog.getByTitle('Refresh graph').click();
		await expectDocumentGraphSearchMatch(graphDialog, { timeout: 15000 });
		await graphDialog.getByLabel('Clear search').click();
		await expect(searchInput).toHaveValue('');
		await expect(graphDialog.getByText(/\d+ documents/)).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[75].id} ${activeScenarioMatrix[75].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({ installed: true, authenticated: true }));
		});

		const symphonyDialog = await openSymphonyFromQuickActions(window);
		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();

		await expect(window.getByText('Build Tools Required')).toBeVisible();
		await window.getByRole('button', { name: 'Cancel' }).last().click();
		await expect(window.getByText('Build Tools Required')).toBeHidden();
	});

	test(`${activeScenarioMatrix[76].id} ${activeScenarioMatrix[76].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('symphony:syncContribution');
			ipcMain.handle('symphony:syncContribution', async () => {
				throw new Error('SGS sync unavailable');
			});
		});

		const symphonyDialog = await openSymphonyFromQuickActions(window);
		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await symphonyDialog.getByTitle('Sync status with GitHub').click();

		await expect(symphonyDialog.getByText('Sync failed')).toBeVisible();
	});

	test(`${activeScenarioMatrix[77].id} ${activeScenarioMatrix[77].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeDisabled();
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('required@example.com');
		await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeDisabled();
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Required Conductor');
		await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[78].id} ${activeScenarioMatrix[78].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Enter Conductor');
		const emailInput = leaderboardDialog.getByPlaceholder('conductor@maestro.ai');
		await emailInput.fill('enter@example.com');
		await emailInput.press('Enter');

		await expect(leaderboardDialog.getByText(/Profile submitted!/)).toBeVisible();
	});

	test(`${activeScenarioMatrix[79].id} ${activeScenarioMatrix[79].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.locator('select').first().selectOption('all');

		const summarySection = usageDashboard.getByTestId('section-summary-cards');
		await expect(summarySection).toHaveAttribute('aria-label', 'Summary Cards');
		await expect(
			summarySection.getByRole('region', { name: 'Usage summary metrics' })
		).toBeVisible();
		await expect(summarySection.getByTestId('metric-card')).toHaveCount(10);
		await expect(summarySection.getByRole('group', { name: 'Agents: 1' })).toBeVisible();
		await expect(summarySection.getByRole('group', { name: 'Open Tabs: 2' })).toBeVisible();
		await expect(summarySection.getByRole('group', { name: 'Total Queries: 2' })).toBeVisible();
		await expect(summarySection.getByRole('group', { name: 'Queries/Session: 2.0' })).toBeVisible();
		await expect(summarySection.getByRole('group', { name: 'Total Time: 3m 30s' })).toBeVisible();
		await expect(summarySection.getByRole('group', { name: 'Avg Duration: 1m 45s' })).toBeVisible();
		await expect(
			summarySection.getByRole('group', { name: /Peak Hour: \d{1,2} (AM|PM)/ })
		).toBeVisible();
		await expect(summarySection.getByRole('group', { name: 'Top Agent: codex' })).toBeVisible();
		await expect(summarySection.getByRole('group', { name: 'Interactive %: 50%' })).toBeVisible();
		await expect(summarySection.getByRole('group', { name: 'Local %: 100%' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[80].id} ${activeScenarioMatrix[80].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.locator('select').first().selectOption('all');

		const peakSection = usageDashboard.getByTestId('section-peak-hours');
		const countButton = peakSection.getByRole('button', { name: 'Count' });
		const durationButton = peakSection.getByRole('button', { name: 'Duration' });

		await expect(
			peakSection.getByRole('figure', {
				name: 'Peak hours chart showing activity distribution across hours of the day',
			})
		).toBeVisible();
		await expect(countButton).toHaveAttribute('aria-pressed', 'true');
		await expect(durationButton).toHaveAttribute('aria-pressed', 'false');
		await durationButton.click();
		await expect(durationButton).toHaveAttribute('aria-pressed', 'true');
		await expect(countButton).toHaveAttribute('aria-pressed', 'false');
		await expect(peakSection.getByText('Peak:')).toBeVisible();
		await expect(peakSection.getByText(/\d{1,2}(am|pm)/).last()).toBeVisible();
		await countButton.click();
		await expect(countButton).toHaveAttribute('aria-pressed', 'true');
	});

	test(`${activeScenarioMatrix[81].id} ${activeScenarioMatrix[81].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Show external links').click();
		await expect(graphDialog.getByTitle('Hide external links')).toBeVisible({ timeout: 15000 });
		await graphDialog.getByTitle('Open help panel').click();
		const helpPanel = graphDialog.getByRole('region', { name: 'Help panel' });

		await expect(helpPanel.getByText('Node Types')).toBeVisible();
		await expect(helpPanel.getByText('Document', { exact: true })).toBeVisible();
		await expect(helpPanel.getByText('Card with title and description')).toBeVisible();
		await expect(helpPanel.getByText('External Link').first()).toBeVisible();
		await expect(helpPanel.getByText('Pill showing domain name')).toBeVisible();
		await expect(helpPanel.getByText('Connection Types')).toBeVisible();
		await expect(helpPanel.getByText('Internal Link')).toBeVisible();
		await expect(helpPanel.getByText('Connection between markdown files')).toBeVisible();
		await expect(helpPanel.getByText('Connection to external domain')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[82].id} ${activeScenarioMatrix[82].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Open help panel').click();
		const helpPanel = graphDialog.getByRole('region', { name: 'Help panel' });

		await expect(helpPanel.getByText('Keyboard Shortcuts')).toBeVisible();
		await expect(helpPanel.getByText('Navigate between nodes')).toBeVisible();
		await expect(helpPanel.getByText('Focus node in graph')).toBeVisible();
		await expect(helpPanel.getByText('Preview document in-graph')).toBeVisible();
		await expect(helpPanel.getByText('Open in main preview')).toBeVisible();
		await expect(helpPanel.getByText('Focus search')).toBeVisible();
		await expect(helpPanel.getByText('Mouse Actions')).toBeVisible();
		await expect(helpPanel.getByText('Double-click')).toBeVisible();
		await expect(helpPanel.getByText('Recenter view')).toBeVisible();

		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[83].id} ${activeScenarioMatrix[83].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: 'History' }).click();
		await expect(symphonyDialog.getByText('PRs Created')).toBeVisible();
		await expect(symphonyDialog.getByText('Merged').first()).toBeVisible();
		await expect(symphonyDialog.getByText('Document mobile bridge setup')).toBeVisible();
		await expect(symphonyDialog.getByText('RunMaestro/docs')).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: /PR #12/ })).toBeVisible();
		await expect(symphonyDialog.getByText('380.0K')).toBeVisible();
		await expect(symphonyDialog.getByText('$4.56')).toBeVisible();
	});

	test(`${activeScenarioMatrix[84].id} ${activeScenarioMatrix[84].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: 'Stats' }).click();
		await expect(symphonyDialog.getByText('Tokens Donated')).toBeVisible();
		await expect(symphonyDialog.getByText('1.5M')).toBeVisible();
		await expect(symphonyDialog.getByText('Worth $12.34')).toBeVisible();
		await expect(symphonyDialog.getByText('Time Contributed')).toBeVisible();
		await expect(symphonyDialog.getByText('2h 0m')).toBeVisible();
		await expect(symphonyDialog.getByText('2 repositories')).toBeVisible();
		await expect(symphonyDialog.getByText('Streak', { exact: true })).toBeVisible();
		await expect(symphonyDialog.getByText('2 weeks')).toBeVisible();
		await expect(symphonyDialog.getByText('Best: 7 weeks')).toBeVisible();
		await expect(symphonyDialog.getByText('Achievements')).toBeVisible();
	});

	test(`${activeScenarioMatrix[85].id} ${activeScenarioMatrix[85].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		const emailInput = leaderboardDialog.getByPlaceholder('conductor@maestro.ai');
		await emailInput.fill('not-an-email');

		await expect(leaderboardDialog.getByText('Please enter a valid email address')).toBeVisible();
		await expect(
			leaderboardDialog.getByText(
				'Your email is kept private and will not be displayed on the leaderboard'
			)
		).toBeVisible();
		await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeDisabled();
	});

	test(`${activeScenarioMatrix[86].id} ${activeScenarioMatrix[86].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async () => ({
				success: true,
				pendingEmailConfirmation: true,
				clientToken: 'sgs-pending-token',
			}));
		});
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Pending Conductor');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('pending@example.com');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();

		await expect(
			leaderboardDialog.getByText('Please check your email to confirm your registration.')
		).toBeVisible();
		await expect(
			leaderboardDialog.getByText(
				'Click the link in your email to complete registration. This will update automatically.'
			)
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[87].id} ${activeScenarioMatrix[87].title}`, async () => {
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Social Conductor');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('social@example.com');
		await leaderboardDialog.getByPlaceholder('username').nth(1).fill('@linkedin-user');
		await leaderboardDialog.getByPlaceholder('username#1234 or username').fill('@discord-user');
		await leaderboardDialog.getByPlaceholder('username.bsky.social').fill('@social.bsky.social');

		await expect(leaderboardDialog.getByPlaceholder('username').nth(1)).toHaveValue(
			'linkedin-user'
		);
		await expect(leaderboardDialog.getByPlaceholder('username#1234 or username')).toHaveValue(
			'discord-user'
		);
		await expect(leaderboardDialog.getByPlaceholder('username.bsky.social')).toHaveValue(
			'social.bsky.social'
		);
		await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[88].id} ${activeScenarioMatrix[88].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir, sessionId }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				await stats.recordQuery({
					sessionId,
					agentType: 'codex',
					source: 'user',
					startTime: Date.now() - 15_000,
					duration: 30_000,
					projectPath: projectDir,
					tabId: 'sgs-live-summary-tab',
					isRemote: false,
				});
			},
			{ projectDir: workbench.projectDir, sessionId: workbench.sessionId }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
		await usageDashboard.locator('select').first().selectOption('all');
		await expect(
			usageDashboard.getByTestId('section-summary-cards').getByRole('group', {
				name: 'Total Queries: 3',
			})
		).toBeVisible({ timeout: 5000 });
	});

	test(`${activeScenarioMatrix[89].id} ${activeScenarioMatrix[89].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }, aggregation) => {
			ipcMain.removeHandler('stats:get-aggregation');
			ipcMain.handle('stats:get-aggregation', async () => aggregation);
		}, createEmptyStatsAggregation());

		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByTestId('usage-dashboard-empty')).toBeVisible();
		await expect(usageDashboard.getByText('No usage data yet')).toBeVisible();
		await expect(usageDashboard.getByText('Start using Maestro to see your stats!')).toBeVisible();
	});

	test(`${activeScenarioMatrix[90].id} ${activeScenarioMatrix[90].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }, aggregation) => {
			let calls = 0;
			ipcMain.removeHandler('stats:get-aggregation');
			ipcMain.handle('stats:get-aggregation', async () => {
				calls += 1;
				if (calls === 1) {
					throw new Error('SGS aggregation unavailable');
				}
				return aggregation;
			});
		}, createEmptyStatsAggregation());

		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByText('Failed to load usage data')).toBeVisible();
		await usageDashboard.getByRole('button', { name: 'Retry' }).click();
		await expect(usageDashboard.getByTestId('usage-dashboard-empty')).toBeVisible();
	});

	test(`${activeScenarioMatrix[91].id} ${activeScenarioMatrix[91].title}`, async () => {
		let graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle('Show external links').click();
		await expect(graphDialog.getByTitle('Hide external links')).toBeVisible({ timeout: 15000 });
		await closeDocumentGraph(window);

		graphDialog = await openDocumentGraphFromPreview(window);
		await expect(graphDialog.getByTitle('Hide external links')).toBeVisible({ timeout: 15000 });
		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[92].id} ${activeScenarioMatrix[92].title}`, async () => {
		let graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle(/Layout: /).click();
		await graphDialog.getByRole('button', { name: /Radial/ }).click();
		await expect(graphDialog.getByTitle('Layout: Radial')).toBeVisible();
		await closeDocumentGraph(window);

		graphDialog = await openDocumentGraphFromPreview(window);
		await expect(graphDialog.getByTitle('Layout: Radial')).toBeVisible();
		await closeDocumentGraph(window);
	});

	test(`${activeScenarioMatrix[93].id} ${activeScenarioMatrix[93].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await symphonyDialog.getByRole('button', { name: 'Check PR Status' }).click();

		await expect(symphonyDialog.getByText('1 PR merged')).toBeVisible();
	});

	test(`${activeScenarioMatrix[94].id} ${activeScenarioMatrix[94].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('symphony:checkPRStatuses');
			ipcMain.handle('symphony:checkPRStatuses', async () => ({
				success: true,
				checked: 0,
				merged: 0,
				closed: 0,
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await symphonyDialog.getByRole('button', { name: 'Check PR Status' }).click();

		await expect(symphonyDialog.getByText('No PRs to check')).toBeVisible();
	});

	test(`${activeScenarioMatrix[95].id} ${activeScenarioMatrix[95].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('symphony:checkPRStatuses');
			ipcMain.handle('symphony:checkPRStatuses', async () => {
				throw new Error('SGS PR status unavailable');
			});
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await symphonyDialog.getByRole('button', { name: 'Check PR Status' }).click();

		await expect(symphonyDialog.getByText('Failed to check statuses')).toBeVisible();
	});

	test(`${activeScenarioMatrix[96].id} ${activeScenarioMatrix[96].title}`, async () => {
		const leaderboardDialog = await openLeaderboardWithManualAuthToken(
			window,
			electronApp,
			'Opt Out Conductor',
			'optout@example.com'
		);

		await leaderboardDialog.getByRole('button', { name: 'Opt Out' }).click();
		await expect(
			leaderboardDialog.getByText(/Are you sure you want to remove yourself from the leaderboard/)
		).toBeVisible();
		await leaderboardDialog.getByRole('button', { name: 'Keep Registration' }).click();
		await expect(leaderboardDialog.getByRole('button', { name: 'Opt Out' })).toBeVisible();

		await leaderboardDialog.getByRole('button', { name: 'Opt Out' }).click();
		await leaderboardDialog.getByRole('button', { name: 'Yes, Remove Me' }).click();
		await expect(
			leaderboardDialog.getByText(
				'You have opted out of the leaderboard. Your local stats are preserved.'
			)
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[97].id} ${activeScenarioMatrix[97].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async () => ({
				success: false,
				authTokenRequired: true,
			}));
			ipcMain.removeHandler('leaderboard:pollAuthStatus');
			ipcMain.handle('leaderboard:pollAuthStatus', async () => ({ status: 'pending' }));
		});
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Manual Token');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('manual@example.com');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();

		await expect(
			leaderboardDialog.getByRole('button', { name: 'Resend Confirmation Email' })
		).toBeVisible();
		await expect(leaderboardDialog.getByText('Enter Auth Token')).toBeVisible();
		await expect(
			leaderboardDialog.getByPlaceholder('Paste your 64-character auth token')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[98].id} ${activeScenarioMatrix[98].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			let submitCalls = 0;
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async () => {
				submitCalls += 1;
				if (submitCalls === 1) {
					return { success: false, authTokenRequired: true };
				}
				return { success: true };
			});
			ipcMain.removeHandler('leaderboard:pollAuthStatus');
			ipcMain.handle('leaderboard:pollAuthStatus', async () => ({ status: 'pending' }));
		});
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Manual Submit');
		await leaderboardDialog
			.getByPlaceholder('conductor@maestro.ai')
			.fill('manual-submit@example.com');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();
		await leaderboardDialog
			.getByPlaceholder('Paste your 64-character auth token')
			.fill('a'.repeat(64));
		await leaderboardDialog.getByRole('button', { name: 'Submit' }).click();

		await expect(
			leaderboardDialog.getByText(
				'Your profile has been updated! Use "Pull Down" to sync stats from the server.'
			)
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[99].id} ${activeScenarioMatrix[99].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('stats:get-aggregation');
			ipcMain.handle('stats:get-aggregation', async () => {
				throw new Error('SGS repeated aggregation outage');
			});
		});

		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByText('Failed to load usage data')).toBeVisible();
		await usageDashboard.getByRole('button', { name: 'Retry' }).click();
		await expect(usageDashboard.getByText('Failed to load usage data')).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Retry' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[100].id} ${activeScenarioMatrix[100].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog);

		await expect(graphDialog.getByText('README.md').first()).toBeVisible();
		await expect(graphDialog.getByText('1 connection')).toBeVisible();
		await expect(graphDialog.getByTitle('Markdown tasks')).toBeVisible();
		await expect(graphDialog.getByTitle('Created date')).toBeVisible();
		await expect(graphDialog.getByTitle('Modified date')).toBeVisible();
	});

	test(`${activeScenarioMatrix[101].id} ${activeScenarioMatrix[101].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog, 'right');

		await expect(graphDialog.getByRole('button', { name: 'Open' })).toBeVisible();
		await expect(graphDialog.getByRole('button', { name: 'Copy Path' })).toBeVisible();
		await expect(graphDialog.getByRole('button', { name: 'Focus' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[102].id} ${activeScenarioMatrix[102].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog);
		await window.keyboard.press('P');

		await expect(graphDialog.getByText('README.md').first()).toBeVisible();
		await expect(graphDialog.getByText('Stats Graph Symphony Fixture').first()).toBeVisible();
		await expect(graphDialog.getByTitle('Open in file preview')).toBeVisible();
	});

	test(`${activeScenarioMatrix[103].id} ${activeScenarioMatrix[103].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog, 'right');
		await graphDialog.getByRole('button', { name: 'Focus' }).click();

		await expect(graphDialog.getByRole('button', { name: 'Copy Path' })).toBeHidden();
		await expect(graphDialog.getByText('README.md').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[104].id} ${activeScenarioMatrix[104].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({
				installed: true,
				authenticated: true,
				username: 'sgs-conductor',
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await expect(window.getByText('GitHub CLI authenticated')).toBeVisible();
		await expect(window.getByText('Build Tools Required')).toBeVisible();
		await window.getByRole('button', { name: 'I Have the Build Tools' }).click();

		const agentDialog = window.getByRole('dialog', { name: 'Create Symphony Agent' });
		await expect(agentDialog).toBeVisible();
		await expect(agentDialog.getByText('Contributing to')).toBeVisible();
		await expect(agentDialog.getByText('#42: Add deterministic E2E coverage')).toBeVisible();
		await expect(agentDialog.getByText('Select AI Provider')).toBeVisible();
		await expect(agentDialog.getByText('Session Name')).toBeVisible();
		await expect(agentDialog.getByText('Working Directory')).toBeVisible();
	});

	test(`${activeScenarioMatrix[105].id} ${activeScenarioMatrix[105].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({
				installed: true,
				authenticated: true,
				username: 'sgs-conductor',
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await window.getByRole('button', { name: 'I Have the Build Tools' }).click();

		const agentDialog = window.getByRole('dialog', { name: 'Create Symphony Agent' });
		await agentDialog.getByPlaceholder('Symphony: owner/repo #123').fill('');
		await agentDialog.getByPlaceholder('~/Maestro-Symphony/owner-repo').fill('');

		await expect(agentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();
	});

	test(`${activeScenarioMatrix[106].id} ${activeScenarioMatrix[106].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & {
				__sgsCompleteCalls?: Array<Record<string, unknown>>;
			};
			state.__sgsCompleteCalls = [];
			ipcMain.removeHandler('symphony:complete');
			ipcMain.handle('symphony:complete', async (_event, payload: Record<string, unknown>) => {
				state.__sgsCompleteCalls!.push(payload);
				return { prUrl: 'https://github.com/RunMaestro/Maestro/pull/77' };
			});
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await symphonyDialog.getByRole('button', { name: 'Finalize PR' }).click();

		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & {
						__sgsCompleteCalls?: Array<{ stats?: { documentsProcessed?: number } }>;
					};
					return state.__sgsCompleteCalls?.[0]?.stats?.documentsProcessed ?? 0;
				})
			)
			.toBe(2);
	});

	test(`${activeScenarioMatrix[107].id} ${activeScenarioMatrix[107].title}`, async () => {
		const leaderboardDialog = await openLeaderboardWithManualAuthToken(
			window,
			electronApp,
			'Server Ahead',
			'server-ahead@example.com'
		);
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:sync');
			ipcMain.handle('leaderboard:sync', async () => ({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: 9_000_000,
					totalRuns: 8,
					badgeLevel: 2,
					longestRunMs: 1_800_000,
					longestRunDate: '2026-05-29',
				},
			}));
		});

		await leaderboardDialog.getByRole('button', { name: 'Pull Down' }).click();

		await expect(leaderboardDialog.getByText(/Synced! Updated to .* from server/)).toBeVisible();
	});

	test(`${activeScenarioMatrix[108].id} ${activeScenarioMatrix[108].title}`, async () => {
		const localStats = await window.evaluate(() => window.maestro.settings.get('autoRunStats'));
		const localTime =
			typeof localStats === 'object' &&
			localStats !== null &&
			'cumulativeTimeMs' in localStats &&
			typeof localStats.cumulativeTimeMs === 'number'
				? localStats.cumulativeTimeMs
				: 0;
		const leaderboardDialog = await openLeaderboardWithManualAuthToken(
			window,
			electronApp,
			'Already Synced',
			'already-synced@example.com'
		);
		await electronApp.evaluate(({ ipcMain }, syncedTime: number) => {
			ipcMain.removeHandler('leaderboard:sync');
			ipcMain.handle('leaderboard:sync', async () => ({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: syncedTime,
					totalRuns: 0,
					badgeLevel: 0,
				},
			}));
		}, localTime);

		await leaderboardDialog.getByRole('button', { name: 'Pull Down' }).click();

		await expect(
			leaderboardDialog.getByText('Already in sync! Local and server stats match.')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[109].id} ${activeScenarioMatrix[109].title}`, async () => {
		const leaderboardDialog = await openLeaderboardWithManualAuthToken(
			window,
			electronApp,
			'No Server Record',
			'no-record@example.com'
		);
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:sync');
			ipcMain.handle('leaderboard:sync', async () => ({
				success: true,
				found: false,
			}));
		});

		await leaderboardDialog.getByRole('button', { name: 'Pull Down' }).click();

		await expect(
			leaderboardDialog.getByText('No server record found. Submit your first entry to create one!')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[110].id} ${activeScenarioMatrix[110].title}`, async () => {
		const leaderboardDialog = await openLeaderboardWithManualAuthToken(
			window,
			electronApp,
			'Email Pending Sync',
			'email-pending-sync@example.com'
		);
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:sync');
			ipcMain.handle('leaderboard:sync', async () => ({
				success: false,
				errorCode: 'EMAIL_NOT_CONFIRMED',
			}));
		});

		await leaderboardDialog.getByRole('button', { name: 'Pull Down' }).click();

		await expect(
			leaderboardDialog.getByText(
				'Email not yet confirmed. Please check your inbox for the confirmation email.'
			)
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[111].id} ${activeScenarioMatrix[111].title}`, async () => {
		const leaderboardDialog = await openLeaderboardWithManualAuthToken(
			window,
			electronApp,
			'Invalid Token Sync',
			'invalid-token-sync@example.com'
		);
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:sync');
			ipcMain.handle('leaderboard:sync', async () => ({
				success: false,
				errorCode: 'INVALID_TOKEN',
			}));
		});

		await leaderboardDialog.getByRole('button', { name: 'Pull Down' }).click();

		await expect(
			leaderboardDialog.getByText('Invalid auth token. Please re-register to get a new token.')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[112].id} ${activeScenarioMatrix[112].title}`, async () => {
		const leaderboardDialog = await openLeaderboardWithManualAuthToken(
			window,
			electronApp,
			'Generic Sync Failure',
			'generic-sync-failure@example.com'
		);
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:sync');
			ipcMain.handle('leaderboard:sync', async () => ({
				success: false,
				error: 'SGS leaderboard sync offline',
			}));
		});

		await leaderboardDialog.getByRole('button', { name: 'Pull Down' }).click();

		await expect(leaderboardDialog.getByText('SGS leaderboard sync offline')).toBeVisible();
	});

	test(`${activeScenarioMatrix[113].id} ${activeScenarioMatrix[113].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			let submitCalls = 0;
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async () => {
				submitCalls += 1;
				if (submitCalls === 1) {
					return { success: false, authTokenRequired: true };
				}
				return { success: true };
			});
			ipcMain.removeHandler('leaderboard:pollAuthStatus');
			ipcMain.handle('leaderboard:pollAuthStatus', async () => ({
				status: 'confirmed',
				authToken: 'c'.repeat(64),
			}));
		});
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Auto Recover');
		await leaderboardDialog
			.getByPlaceholder('conductor@maestro.ai')
			.fill('auto-recover@example.com');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();

		await expect(
			leaderboardDialog.getByText('Auth token recovered and stats submitted successfully!')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[114].id} ${activeScenarioMatrix[114].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('symphony:getRegistry');
			ipcMain.handle('symphony:getRegistry', async () => {
				throw new Error('SGS registry unavailable');
			});
		});

		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await expect(symphonyDialog.getByText('SGS registry unavailable')).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: 'Retry' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[115].id} ${activeScenarioMatrix[115].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('symphony:fetchDocumentContent');
			ipcMain.handle('symphony:fetchDocumentContent', async () => ({
				success: false,
				error: 'SGS document unavailable',
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);

		await expect(
			symphonyDialog.getByText('Failed to load document: SGS document unavailable')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[116].id} ${activeScenarioMatrix[116].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({
				installed: true,
				authenticated: true,
				username: 'sgs-conductor',
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await window.getByRole('button', { name: 'I Have the Build Tools' }).click();

		const agentDialog = window.getByRole('dialog', { name: 'Create Symphony Agent' });
		await expect(agentDialog).toBeVisible();
		await agentDialog.getByRole('button', { name: 'Cancel' }).click();
		await expect(agentDialog).toBeHidden();
		await expect(symphonyDialog.getByRole('button', { name: 'Start Symphony' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[117].id} ${activeScenarioMatrix[117].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await searchInput.fill('missing-sgs-node');
		await expect(graphDialog.getByText(/0 of \d+ matching/)).toBeVisible();
		await searchInput.press('Escape');

		await expect(searchInput).toHaveValue('');
		await expect(graphDialog.getByText(/\d+ documents?/)).toBeVisible();
	});

	test(`${activeScenarioMatrix[118].id} ${activeScenarioMatrix[118].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			const emptyStats = {
				totalContributions: 0,
				totalMerged: 0,
				totalIssuesResolved: 0,
				totalDocumentsProcessed: 0,
				totalTasksCompleted: 0,
				totalTokensUsed: 0,
				totalTimeSpent: 0,
				estimatedCostDonated: 0,
				repositoriesContributed: [],
				uniqueMaintainersHelped: 0,
				currentStreak: 0,
				longestStreak: 0,
			};
			ipcMain.removeHandler('symphony:getState');
			ipcMain.handle('symphony:getState', async () => ({
				success: true,
				state: { active: [], history: [], stats: emptyStats },
			}));
			ipcMain.removeHandler('symphony:getActive');
			ipcMain.handle('symphony:getActive', async () => ({
				success: true,
				contributions: [],
			}));
			ipcMain.removeHandler('symphony:getStats');
			ipcMain.handle('symphony:getStats', async () => ({
				success: true,
				stats: emptyStats,
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: 'Active', exact: true }).click();

		await expect(symphonyDialog.getByText('No active contributions')).toBeVisible();
		await expect(
			symphonyDialog.getByText('Start a contribution from the Projects tab')
		).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: 'Browse Projects' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[119].id} ${activeScenarioMatrix[119].title}`, async () => {
		const exportPath = path.join(workbench.homeDir, 'usage-dashboard-month-export.csv');
		await electronApp.evaluate(({ ipcMain }, filePath: string) => {
			const state = globalThis as typeof globalThis & { __sgsExportRanges?: string[] };
			state.__sgsExportRanges = [];
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => filePath);
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle('stats:export-csv', async (_event, range: string) => {
				state.__sgsExportRanges!.push(range);
				return `range\n${range}\n`;
			});
		}, exportPath);

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.locator('select').first().selectOption('month');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & { __sgsExportRanges?: string[] };
					return state.__sgsExportRanges?.[0] ?? '';
				})
			)
			.toBe('month');
	});

	test(`${activeScenarioMatrix[120].id} ${activeScenarioMatrix[120].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => '/tmp/sgs-export-failure.csv');
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle('stats:export-csv', async () => 'header\nvalue\n');
			ipcMain.removeHandler('fs:writeFile');
			ipcMain.handle('fs:writeFile', async () => {
				throw new Error('SGS CSV write denied');
			});
		});

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
		await expect(usageDashboard).toBeVisible();
	});

	test(`${activeScenarioMatrix[121].id} ${activeScenarioMatrix[121].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog);

		await expect(graphDialog.getByText('README').first()).toBeVisible();
		await expect(graphDialog.getByText('README.md').first()).toBeVisible();
		await expect(graphDialog.getByText('1 connection').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[122].id} ${activeScenarioMatrix[122].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog, 'right');
		await expect(graphDialog.getByRole('button', { name: 'Open' })).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(graphDialog.getByRole('button', { name: 'Open' })).toBeHidden();
		await expect(graphDialog).toBeVisible();
	});

	test(`${activeScenarioMatrix[123].id} ${activeScenarioMatrix[123].title}`, async () => {
		await stubSymphonyAgentDetection(electronApp, false);
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({
				installed: true,
				authenticated: true,
				username: 'sgs-conductor',
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await window.getByRole('button', { name: 'I Have the Build Tools' }).click();

		const agentDialog = window.getByRole('dialog', { name: 'Create Symphony Agent' });
		await expect(agentDialog.getByText('No compatible AI agents detected.')).toBeVisible();
		await expect(agentDialog.getByRole('button', { name: 'Create Agent' })).toBeDisabled();
	});

	test(`${activeScenarioMatrix[124].id} ${activeScenarioMatrix[124].title}`, async () => {
		await stubSymphonyAgentDetection(electronApp);
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({
				installed: true,
				authenticated: true,
				username: 'sgs-conductor',
			}));
			ipcMain.removeHandler('symphony:cloneRepo');
			ipcMain.handle('symphony:cloneRepo', async () => ({ success: true }));
			ipcMain.removeHandler('symphony:startContribution');
			ipcMain.handle('symphony:startContribution', async () => ({
				success: false,
				error: 'SGS start contribution rejected',
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await window.getByRole('button', { name: 'I Have the Build Tools' }).click();

		const agentDialog = window.getByRole('dialog', { name: 'Create Symphony Agent' });
		await expect(agentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		await agentDialog.getByRole('button', { name: 'Create Agent' }).click();

		await expect(agentDialog.getByText('SGS start contribution rejected')).toBeVisible();
		await expect(agentDialog).toBeVisible();
	});

	test(`${activeScenarioMatrix[125].id} ${activeScenarioMatrix[125].title}`, async () => {
		const localTime = 180_000;
		await window.evaluate((stats) => window.maestro.settings.set('autoRunStats', stats), {
			cumulativeTimeMs: localTime,
			totalRuns: 2,
			currentBadgeLevel: 0,
			longestRunMs: 120_000,
			longestRunTimestamp: Date.parse('2026-05-29T12:00:00.000Z'),
		});
		const leaderboardDialog = await openLeaderboardWithManualAuthToken(
			window,
			electronApp,
			'Local Ahead',
			'local-ahead@example.com'
		);
		await electronApp.evaluate(({ ipcMain }, syncedTime: number) => {
			ipcMain.removeHandler('leaderboard:sync');
			ipcMain.handle('leaderboard:sync', async () => ({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: Math.max(0, syncedTime - 60_000),
					totalRuns: 1,
					badgeLevel: 0,
				},
			}));
		}, localTime);

		await leaderboardDialog.getByRole('button', { name: 'Pull Down' }).click();

		await expect(leaderboardDialog.getByText(/Local is ahead/)).toBeVisible();
		await expect(leaderboardDialog.getByText(/No sync needed/)).toBeVisible();
	});

	test(`${activeScenarioMatrix[126].id} ${activeScenarioMatrix[126].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & {
				__sgsSaveOptions?: Array<{ defaultPath?: string }>;
			};
			state.__sgsSaveOptions = [];
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async (_event, options: { defaultPath?: string }) => {
				state.__sgsSaveOptions!.push(options);
				return null;
			});
		});

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.locator('select').first().selectOption('year');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & {
						__sgsSaveOptions?: Array<{ defaultPath?: string }>;
					};
					return state.__sgsSaveOptions?.[0]?.defaultPath ?? '';
				})
			)
			.toContain('maestro-usage-year-');
	});

	test(`${activeScenarioMatrix[127].id} ${activeScenarioMatrix[127].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & { __sgsExportCalls?: number };
			state.__sgsExportCalls = 0;
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => null);
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle('stats:export-csv', async () => {
				state.__sgsExportCalls! += 1;
				return 'should-not-export';
			});
		});

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & { __sgsExportCalls?: number };
					return state.__sgsExportCalls ?? -1;
				})
			)
			.toBe(0);
		await expect(usageDashboard).toBeVisible();
	});

	test(`${activeScenarioMatrix[128].id} ${activeScenarioMatrix[128].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => '/tmp/sgs-pending-export.csv');
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle(
				'stats:export-csv',
				async () => new Promise((resolve) => setTimeout(() => resolve('range\nall\n'), 250))
			);
		});

		const usageDashboard = await openUsageDashboard(window);
		const exportButton = usageDashboard.getByRole('button', { name: 'Export CSV' });
		await exportButton.click();

		await expect(exportButton).toBeDisabled();
		await expect(exportButton).toBeEnabled();
	});

	test(`${activeScenarioMatrix[129].id} ${activeScenarioMatrix[129].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog);

		await expect(graphDialog.getByText('project').first()).toBeVisible();
		await expect(graphDialog.getByText('README').first()).toBeVisible();
		await expect(graphDialog.getByText('README.md').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[130].id} ${activeScenarioMatrix[130].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog, 'right');
		await graphDialog.getByRole('button', { name: 'Copy Path' }).click();

		await expect(graphDialog.getByRole('button', { name: 'Copy Path' })).toBeHidden();
		await expect(graphDialog).toBeVisible();
	});

	test(`${activeScenarioMatrix[131].id} ${activeScenarioMatrix[131].title}`, async () => {
		await stubSymphonyAgentDetection(electronApp);
		const selectedFolder = path.join(workbench.homeDir, 'picked-symphony-worktree');
		await electronApp.evaluate(({ ipcMain }, folder: string) => {
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({
				installed: true,
				authenticated: true,
				username: 'sgs-conductor',
			}));
			ipcMain.removeHandler('dialog:selectFolder');
			ipcMain.handle('dialog:selectFolder', async () => folder);
		}, selectedFolder);
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await window.getByRole('button', { name: 'I Have the Build Tools' }).click();

		const agentDialog = window.getByRole('dialog', { name: 'Create Symphony Agent' });
		await agentDialog.getByTitle('Browse for folder').click();

		await expect(agentDialog.getByPlaceholder('~/Maestro-Symphony/owner-repo')).toHaveValue(
			selectedFolder
		);
	});

	test(`${activeScenarioMatrix[132].id} ${activeScenarioMatrix[132].title}`, async () => {
		await stubSymphonyAgentDetection(electronApp);
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & {
				__sgsStartPayload?: { issueNumber?: number; repoSlug?: string };
			};
			state.__sgsStartPayload = undefined;
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({
				installed: true,
				authenticated: true,
				username: 'sgs-conductor',
			}));
			ipcMain.removeHandler('git:isRepo');
			ipcMain.handle('git:isRepo', async () => false);
			ipcMain.removeHandler('symphony:cloneRepo');
			ipcMain.handle('symphony:cloneRepo', async () => ({ success: true }));
			ipcMain.removeHandler('symphony:startContribution');
			ipcMain.handle(
				'symphony:startContribution',
				async (_event, payload: { issueNumber?: number; repoSlug?: string }) => {
					state.__sgsStartPayload = payload;
					return {
						success: true,
						branchName: 'symphony/sgs-42',
						autoRunPath: '/tmp/sgs-auto-run-docs',
						draftPrNumber: 88,
						draftPrUrl: 'https://github.com/RunMaestro/Maestro/pull/88',
					};
				}
			);
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await window.getByRole('button', { name: 'I Have the Build Tools' }).click();

		const agentDialog = window.getByRole('dialog', { name: 'Create Symphony Agent' });
		await expect(agentDialog.getByRole('button', { name: 'Create Agent' })).toBeEnabled();
		await agentDialog.getByRole('button', { name: 'Create Agent' }).click();

		await expect(agentDialog).toBeHidden();
		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & {
						__sgsStartPayload?: { issueNumber?: number; repoSlug?: string };
					};
					return `${state.__sgsStartPayload?.repoSlug ?? ''}#${state.__sgsStartPayload?.issueNumber ?? 0}`;
				})
			)
			.toBe('RunMaestro/Maestro#42');
	});

	test(`${activeScenarioMatrix[133].id} ${activeScenarioMatrix[133].title}`, async () => {
		const localTime = 240_000;
		await window.evaluate((stats) => window.maestro.settings.set('autoRunStats', stats), {
			cumulativeTimeMs: localTime,
			totalRuns: 3,
			currentBadgeLevel: 1,
			longestRunMs: 180_000,
			longestRunTimestamp: Date.parse('2026-05-29T12:00:00.000Z'),
		});
		const leaderboardDialog = await openLeaderboardWithManualAuthToken(
			window,
			electronApp,
			'Local Ahead Push',
			'local-ahead-push@example.com'
		);
		await electronApp.evaluate(({ ipcMain }, syncedTime: number) => {
			ipcMain.removeHandler('leaderboard:sync');
			ipcMain.handle('leaderboard:sync', async () => ({
				success: true,
				found: true,
				data: {
					cumulativeTimeMs: Math.max(0, syncedTime - 60_000),
					totalRuns: 1,
					badgeLevel: 0,
				},
			}));
		}, localTime);

		await leaderboardDialog.getByRole('button', { name: 'Pull Down' }).click();
		await expect(leaderboardDialog.getByText(/Local is ahead/)).toBeVisible();
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();

		await expect(
			leaderboardDialog.getByText(
				'Profile submitted! Stats are synced via Auto Runs. Use "Pull Down" to sync from other devices.'
			)
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[134].id} ${activeScenarioMatrix[134].title}`, async () => {
		const exportPath = path.join(workbench.homeDir, 'usage-dashboard-quarter-export.csv');
		await electronApp.evaluate(({ ipcMain }, filePath: string) => {
			const state = globalThis as typeof globalThis & { __sgsExportRanges?: string[] };
			state.__sgsExportRanges = [];
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => filePath);
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle('stats:export-csv', async (_event, range: string) => {
				state.__sgsExportRanges!.push(range);
				return `range\n${range}\n`;
			});
		}, exportPath);

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.locator('select').first().selectOption('quarter');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & { __sgsExportRanges?: string[] };
					return state.__sgsExportRanges ?? [];
				})
			)
			.toEqual(['quarter']);
	});

	test(`${activeScenarioMatrix[135].id} ${activeScenarioMatrix[135].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & { __sgsDatabaseSizeCalls?: number };
			state.__sgsDatabaseSizeCalls = 0;
			ipcMain.removeHandler('stats:get-database-size');
			ipcMain.handle('stats:get-database-size', async () => {
				state.__sgsDatabaseSizeCalls! += 1;
				return 4096;
			});
		});

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.locator('select').first().selectOption('day');
		await usageDashboard.locator('select').first().selectOption('week');

		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & { __sgsDatabaseSizeCalls?: number };
					return state.__sgsDatabaseSizeCalls ?? 0;
				})
			)
			.toBeGreaterThanOrEqual(3);
		await expect(usageDashboard).toBeVisible();
	});

	test(`${activeScenarioMatrix[136].id} ${activeScenarioMatrix[136].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog);
		await window.keyboard.press('P');
		await expect(graphDialog.getByTitle('Open in file preview')).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(graphDialog.getByTitle('Open in file preview')).toBeHidden();
		await expect(graphDialog).toBeVisible();
	});

	test(`${activeScenarioMatrix[137].id} ${activeScenarioMatrix[137].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle(/Layout: /).click();
		await graphDialog.getByRole('button', { name: /Force/ }).click();
		await expect(graphDialog.getByTitle('Layout: Force')).toBeVisible();
		await graphDialog.getByTitle('Refresh graph').click();

		await expect(graphDialog.getByTitle('Layout: Force')).toBeVisible({ timeout: 15000 });
		await expect(graphDialog.getByText(/\d+ documents/)).toBeVisible({ timeout: 15000 });
	});

	test(`${activeScenarioMatrix[138].id} ${activeScenarioMatrix[138].title}`, async () => {
		await stubExternalLinkCapture(electronApp);
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await symphonyDialog.getByTitle('View repository on GitHub').click();

		await expect
			.poll(() => getCapturedExternalLinks(electronApp))
			.toContain('https://github.com/RunMaestro/Maestro');
	});

	test(`${activeScenarioMatrix[139].id} ${activeScenarioMatrix[139].title}`, async () => {
		await stubExternalLinkCapture(electronApp);
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'View Issue' }).click();

		await expect
			.poll(() => getCapturedExternalLinks(electronApp))
			.toContain('https://github.com/RunMaestro/Maestro/issues/42');
	});

	test(`${activeScenarioMatrix[140].id} ${activeScenarioMatrix[140].title}`, async () => {
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await expect(getSymphonyDocumentButton(symphonyDialog, 'e2e-plan.md')).toBeVisible();
		await getSymphonyDocumentButton(symphonyDialog, 'e2e-plan.md').click();
		await getSymphonyDocumentButton(symphonyDialog, 'follow-up-checklist.md').last().click();
		await expect(getSymphonyDocumentButton(symphonyDialog, 'follow-up-checklist.md')).toBeVisible();
		await getSymphonyDocumentButton(symphonyDialog, 'follow-up-checklist.md').click();
		await getSymphonyDocumentButton(symphonyDialog, 'e2e-plan.md').last().click();
		await expect(getSymphonyDocumentButton(symphonyDialog, 'e2e-plan.md')).toBeVisible();
	});

	test(`${activeScenarioMatrix[141].id} ${activeScenarioMatrix[141].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			const emptyStats = {
				totalContributions: 0,
				totalMerged: 0,
				totalIssuesResolved: 0,
				totalDocumentsProcessed: 0,
				totalTasksCompleted: 0,
				totalTokensUsed: 0,
				totalTimeSpent: 0,
				estimatedCostDonated: 0,
				repositoriesContributed: [],
				uniqueMaintainersHelped: 0,
				currentStreak: 0,
				longestStreak: 0,
			};
			ipcMain.removeHandler('symphony:getState');
			ipcMain.handle('symphony:getState', async () => ({
				success: true,
				state: { active: [], history: [], stats: emptyStats },
			}));
			ipcMain.removeHandler('symphony:getActive');
			ipcMain.handle('symphony:getActive', async () => ({
				success: true,
				contributions: [],
			}));
			ipcMain.removeHandler('symphony:getStats');
			ipcMain.handle('symphony:getStats', async () => ({ success: true, stats: emptyStats }));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: 'Active', exact: true }).click();
		await symphonyDialog.getByRole('button', { name: 'Browse Projects' }).click();

		await expect(symphonyDialog.getByPlaceholder('Search repositories...')).toBeVisible();
		await expect(symphonyDialog.getByRole('button', { name: /Maestro Core/ })).toBeVisible();
	});

	test(`${activeScenarioMatrix[142].id} ${activeScenarioMatrix[142].title}`, async () => {
		await stubSymphonyAgentDetection(electronApp);
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & {
				__sgsClonePayloads?: Array<{ repoUrl?: string; localPath?: string }>;
			};
			state.__sgsClonePayloads = [];
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({
				installed: true,
				authenticated: true,
				username: 'sgs-conductor',
			}));
			ipcMain.removeHandler('symphony:cloneRepo');
			ipcMain.handle(
				'symphony:cloneRepo',
				async (_event, payload: { repoUrl?: string; localPath?: string }) => {
					state.__sgsClonePayloads!.push(payload);
					return { success: true };
				}
			);
			ipcMain.removeHandler('symphony:startContribution');
			ipcMain.handle('symphony:startContribution', async () => ({
				success: true,
				branchName: 'symphony/sgs-clone-payload',
				autoRunPath: '/tmp/sgs-clone-payload-docs',
				draftPrNumber: 89,
				draftPrUrl: 'https://github.com/RunMaestro/Maestro/pull/89',
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await window.getByRole('button', { name: 'I Have the Build Tools' }).click();
		await window
			.getByRole('dialog', { name: 'Create Symphony Agent' })
			.getByRole('button', { name: 'Create Agent' })
			.click();

		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & {
						__sgsClonePayloads?: Array<{ repoUrl?: string; localPath?: string }>;
					};
					const payload = state.__sgsClonePayloads?.[0];
					return `${payload?.repoUrl ?? ''}|${payload?.localPath ?? ''}`;
				})
			)
			.toContain('https://github.com/RunMaestro/Maestro|');
	});

	test(`${activeScenarioMatrix[143].id} ${activeScenarioMatrix[143].title}`, async () => {
		await stubSymphonyAgentDetection(electronApp);
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & { __sgsStartCalls?: number };
			state.__sgsStartCalls = 0;
			ipcMain.removeHandler('git:checkGhCli');
			ipcMain.handle('git:checkGhCli', async () => ({
				installed: true,
				authenticated: true,
				username: 'sgs-conductor',
			}));
			ipcMain.removeHandler('symphony:cloneRepo');
			ipcMain.handle('symphony:cloneRepo', async () => ({
				success: false,
				error: 'SGS clone failed before start',
			}));
			ipcMain.removeHandler('symphony:startContribution');
			ipcMain.handle('symphony:startContribution', async () => {
				state.__sgsStartCalls! += 1;
				return { success: true };
			});
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
		await selectSymphonyIssue(symphonyDialog, /#42 Add deterministic E2E coverage/);
		await symphonyDialog.getByRole('button', { name: 'Start Symphony' }).click();
		await window.getByRole('button', { name: 'I Have the Build Tools' }).click();

		const agentDialog = window.getByRole('dialog', { name: 'Create Symphony Agent' });
		await agentDialog.getByRole('button', { name: 'Create Agent' }).click();

		await expect(agentDialog.getByText('SGS clone failed before start')).toBeVisible();
		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & { __sgsStartCalls?: number };
					return state.__sgsStartCalls ?? -1;
				})
			)
			.toBe(0);
	});

	test(`${activeScenarioMatrix[144].id} ${activeScenarioMatrix[144].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('stats:get-autorun-sessions');
			ipcMain.handle('stats:get-autorun-sessions', async () => {
				throw new Error('SGS Auto Run sessions unavailable');
			});
		});

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();

		await expect(usageDashboard.getByTestId('autorun-stats-error')).toBeVisible();
		await expect(usageDashboard.getByText('Failed to load Auto Run stats')).toBeVisible();
		await expect(
			usageDashboard.getByTestId('autorun-stats-error').getByRole('button', { name: 'Retry' })
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[145].id} ${activeScenarioMatrix[145].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('stats:get-autorun-sessions');
			ipcMain.handle('stats:get-autorun-sessions', async () => []);
		});

		const usageDashboard = await openUsageDashboard(window);
		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();

		await expect(usageDashboard.getByTestId('autorun-stats-empty')).toBeVisible();
		await expect(usageDashboard.getByText('No Auto Run data yet')).toBeVisible();
	});

	test(`${activeScenarioMatrix[146].id} ${activeScenarioMatrix[146].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog);
		await window.keyboard.press('P');

		await expect(graphDialog.getByTitle('Open in file preview')).toBeVisible();
		await expect(graphDialog.getByLabel('Go back')).toBeDisabled();
		await expect(graphDialog.getByLabel('Go forward')).toBeDisabled();
		await expect(graphDialog.getByTitle('No previous document')).toBeVisible();
		await expect(graphDialog.getByTitle('No next document')).toBeVisible();
	});

	test(`${activeScenarioMatrix[147].id} ${activeScenarioMatrix[147].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await graphDialog.getByTitle(/Layout: /).click();
		await graphDialog.getByRole('button', { name: /Radial/ }).click();
		await expect(graphDialog.getByTitle('Layout: Radial')).toBeVisible();
		await dragDocumentGraphCenterNode(window, graphDialog);
		await expect(
			graphDialog.getByTitle('Reset all node positions to algorithmic layout')
		).toBeVisible();
		await graphDialog.getByTitle('Refresh graph').click();

		await expect(
			graphDialog.getByTitle('Reset all node positions to algorithmic layout')
		).toBeVisible();
		await expect(graphDialog.getByTitle('Layout: Radial')).toBeVisible({ timeout: 15000 });
	});

	test(`${activeScenarioMatrix[148].id} ${activeScenarioMatrix[148].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & {
				__sgsSubmitPayloads?: Array<Record<string, unknown>>;
			};
			state.__sgsSubmitPayloads = [];
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async (_event, payload: Record<string, unknown>) => {
				state.__sgsSubmitPayloads!.push(payload);
				return { success: true };
			});
		});
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Payload Conductor');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('payload@example.com');
		await leaderboardDialog.locator('input[placeholder="username"]').first().fill('payload-user');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();

		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & {
						__sgsSubmitPayloads?: Array<Record<string, unknown>>;
					};
					const payload = state.__sgsSubmitPayloads?.[0];
					if (!payload) return '';
					return [
						payload.displayName,
						payload.email,
						payload.githubUsername,
						payload.keyboardMasteryLevel,
						payload.clientTotalTimeMs === payload.cumulativeTimeMs,
					].join('|');
				})
			)
			.toBe('Payload Conductor|payload@example.com|payload-user|1|true');
	});

	test(`${activeScenarioMatrix[149].id} ${activeScenarioMatrix[149].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async () => ({
				success: false,
				authTokenRequired: true,
			}));
			ipcMain.removeHandler('leaderboard:pollAuthStatus');
			ipcMain.handle('leaderboard:pollAuthStatus', async () => ({ status: 'pending' }));
			ipcMain.removeHandler('leaderboard:resendConfirmation');
			ipcMain.handle('leaderboard:resendConfirmation', async () => ({
				success: true,
				message: 'SGS resend confirmation queued',
			}));
		});
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Resend Success');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('resend@example.com');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();
		await leaderboardDialog.getByRole('button', { name: 'Resend Confirmation Email' }).click();

		await expect(leaderboardDialog.getByText('SGS resend confirmation queued')).toBeVisible();
		await expect(
			leaderboardDialog.getByText('Click the link in your email to complete registration.')
		).toBeVisible();
	});

	test(`${activeScenarioMatrix[150].id} ${activeScenarioMatrix[150].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async () => ({
				success: false,
				authTokenRequired: true,
			}));
			ipcMain.removeHandler('leaderboard:pollAuthStatus');
			ipcMain.handle('leaderboard:pollAuthStatus', async () => ({ status: 'pending' }));
			ipcMain.removeHandler('leaderboard:resendConfirmation');
			ipcMain.handle('leaderboard:resendConfirmation', async () => ({
				success: false,
				error: 'SGS resend confirmation failed',
			}));
		});
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Resend Failure');
		await leaderboardDialog
			.getByPlaceholder('conductor@maestro.ai')
			.fill('resend-failure@example.com');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();
		await leaderboardDialog.getByRole('button', { name: 'Resend Confirmation Email' }).click();

		await expect(leaderboardDialog.getByText('SGS resend confirmation failed')).toBeVisible();
	});

	test(`${activeScenarioMatrix[151].id} ${activeScenarioMatrix[151].title}`, async () => {
		await stubExternalLinkCapture(electronApp);
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByRole('button', { name: /runmaestro\.ai/ }).click();

		await expect
			.poll(() => getCapturedExternalLinks(electronApp))
			.toContain('https://runmaestro.ai');
	});

	test(`${activeScenarioMatrix[152].id} ${activeScenarioMatrix[152].title}`, async () => {
		await stubExternalLinkCapture(electronApp);
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await symphonyDialog.getByRole('button', { name: /Draft PR #77/ }).click();

		await expect
			.poll(() => getCapturedExternalLinks(electronApp))
			.toContain('https://github.com/RunMaestro/Maestro/pull/77');
	});

	test(`${activeScenarioMatrix[153].id} ${activeScenarioMatrix[153].title}`, async () => {
		await stubExternalLinkCapture(electronApp);
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: 'History' }).click();
		await symphonyDialog.getByRole('button', { name: /PR #12/ }).click();

		await expect
			.poll(() => getCapturedExternalLinks(electronApp))
			.toContain('https://github.com/RunMaestro/docs/pull/12');
	});

	test(`${activeScenarioMatrix[154].id} ${activeScenarioMatrix[154].title}`, async () => {
		await stubWindowClipboardTextCapture(electronApp);
		const graphDialog = await openDocumentGraphFromPreview(window);

		await clickDocumentGraphCenter(graphDialog, 'right');
		await graphDialog.getByRole('button', { name: 'Copy Path' }).click();

		await expect.poll(() => getCapturedWindowClipboardText(electronApp)).toBe('README.md');
	});

	test(`${activeScenarioMatrix[155].id} ${activeScenarioMatrix[155].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & { __sgsSyncContributionIds?: string[] };
			state.__sgsSyncContributionIds = [];
			ipcMain.removeHandler('symphony:syncContribution');
			ipcMain.handle('symphony:syncContribution', async (_event, contributionId: string) => {
				state.__sgsSyncContributionIds!.push(contributionId);
				return { success: true, message: 'SGS active sync refreshed' };
			});
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await symphonyDialog.getByTitle('Sync status with GitHub').click();

		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & {
						__sgsSyncContributionIds?: string[];
					};
					return state.__sgsSyncContributionIds ?? [];
				})
			)
			.toContain('symphony-active-sgs');
		await expect(symphonyDialog.getByText('SGS active sync refreshed')).toBeVisible();
	});

	test(`${activeScenarioMatrix[156].id} ${activeScenarioMatrix[156].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('symphony:checkPRStatuses');
			ipcMain.handle('symphony:checkPRStatuses', async () => ({
				success: true,
				checked: 1,
				merged: 0,
				closed: 1,
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await symphonyDialog.getByRole('button', { name: 'Check PR Status' }).click();

		await expect(symphonyDialog.getByText('1 PR closed')).toBeVisible();
	});

	test(`${activeScenarioMatrix[157].id} ${activeScenarioMatrix[157].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('symphony:checkPRStatuses');
			ipcMain.handle('symphony:checkPRStatuses', async () => ({
				success: true,
				checked: 1,
				merged: 0,
				closed: 0,
			}));
		});
		const symphonyDialog = await openSymphonyFromQuickActions(window);

		await symphonyDialog.getByRole('button', { name: /Active \(1\)/ }).click();
		await symphonyDialog.getByRole('button', { name: 'Check PR Status' }).click();

		await expect(symphonyDialog.getByText('All PRs up to date')).toBeVisible();
	});

	test(`${activeScenarioMatrix[158].id} ${activeScenarioMatrix[158].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			const state = globalThis as typeof globalThis & {
				__sgsSubmitPayloads?: Array<Record<string, unknown>>;
			};
			state.__sgsSubmitPayloads = [];
			ipcMain.removeHandler('leaderboard:submit');
			ipcMain.handle('leaderboard:submit', async (_event, payload: Record<string, unknown>) => {
				state.__sgsSubmitPayloads!.push(payload);
				return { success: true };
			});
		});
		const aboutDialog = await openAboutFromQuickActions(window);
		await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();

		const leaderboardDialog = window.getByRole('dialog', { name: 'Register for Leaderboard' });
		await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Social Metadata');
		await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('social@example.com');
		await leaderboardDialog.locator('input[placeholder="username"]').first().fill('social-github');
		await leaderboardDialog.getByPlaceholder('handle').fill('@social-x');
		await leaderboardDialog
			.locator('input[placeholder="username"]')
			.nth(1)
			.fill('@social-linkedin');
		await leaderboardDialog.getByPlaceholder('username#1234 or username').fill('@social-discord');
		await leaderboardDialog.getByPlaceholder('username.bsky.social').fill('@social.bsky.social');
		await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();

		await expect
			.poll(() =>
				electronApp.evaluate(() => {
					const state = globalThis as typeof globalThis & {
						__sgsSubmitPayloads?: Array<Record<string, unknown>>;
					};
					const payload = state.__sgsSubmitPayloads?.[0];
					if (!payload) return '';
					return [
						payload.githubUsername,
						payload.twitterHandle,
						payload.linkedinHandle,
						payload.discordUsername,
						payload.blueskyHandle,
					].join('|');
				})
			)
			.toBe('social-github|social-x|social-linkedin|social-discord|social.bsky.social');
	});

	test(`${activeScenarioMatrix[159].id} ${activeScenarioMatrix[159].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog);

		await expect(graphDialog.getByText('External: runmaestro.ai')).toBeVisible();
		await expect(graphDialog.getByText(/2 documents, 1 external domain/)).toBeVisible();
	});

	test(`${activeScenarioMatrix[160].id} ${activeScenarioMatrix[160].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog, 'right');

		await expect(graphDialog.getByRole('button', { name: 'Open' })).toBeVisible();
		await expect(graphDialog.getByRole('button', { name: 'Copy URL' })).toBeVisible();
		await expect(graphDialog.getByRole('button', { name: 'Focus' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[161].id} ${activeScenarioMatrix[161].title}`, async () => {
		await stubWindowClipboardTextCapture(electronApp);
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog, 'right');
		await graphDialog.getByRole('button', { name: 'Copy URL' }).click();

		await expect
			.poll(() => getCapturedWindowClipboardText(electronApp))
			.toBe('https://runmaestro.ai');
		await expect(graphDialog.getByRole('button', { name: 'Copy URL' })).toBeHidden();
	});

	test(`${activeScenarioMatrix[162].id} ${activeScenarioMatrix[162].title}`, async () => {
		await stubExternalLinkCapture(electronApp);
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog, 'right');
		await graphDialog.getByRole('button', { name: 'Open' }).click();

		await expect
			.poll(() => getCapturedExternalLinks(electronApp))
			.toContain('https://runmaestro.ai');
	});

	test(`${activeScenarioMatrix[163].id} ${activeScenarioMatrix[163].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog, 'right');
		await expect(graphDialog.getByRole('button', { name: 'Copy URL' })).toBeVisible();
		await window.keyboard.press('Escape');

		await expect(graphDialog.getByRole('button', { name: 'Copy URL' })).toBeHidden();
		await expect(graphDialog).toBeVisible();
	});

	test(`${activeScenarioMatrix[164].id} ${activeScenarioMatrix[164].title}`, async () => {
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog);

		await expect(graphDialog.getByText('External: runmaestro.ai')).toBeVisible();
	});

	test(`${activeScenarioMatrix[165].id} ${activeScenarioMatrix[165].title}`, async () => {
		await window.evaluate(() => {
			const state = globalThis as typeof globalThis & { __sgsWindowOpenUrls?: string[] };
			state.__sgsWindowOpenUrls = [];
			window.open = (url?: string | URL) => {
				state.__sgsWindowOpenUrls!.push(String(url));
				return null;
			};
		});
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog);
		await window.keyboard.press('Enter');

		await expect
			.poll(() =>
				window.evaluate(() => {
					const state = globalThis as typeof globalThis & { __sgsWindowOpenUrls?: string[] };
					return state.__sgsWindowOpenUrls ?? [];
				})
			)
			.toContain('https://runmaestro.ai');
	});

	test(`${activeScenarioMatrix[166].id} ${activeScenarioMatrix[166].title}`, async () => {
		addSecondRunMaestroExternalLink(workbench);
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog);

		await expect(graphDialog.getByText('External: runmaestro.ai')).toBeVisible();
		await expect(graphDialog.getByText('(2 links)')).toBeVisible();
	});

	test(`${activeScenarioMatrix[167].id} ${activeScenarioMatrix[167].title}`, async () => {
		addSecondRunMaestroExternalLink(workbench);
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog, 'right');

		await expect(graphDialog.getByRole('button', { name: /^Copy URLs$/ })).toBeVisible();
		await expect(graphDialog.getByRole('button', { name: /^Copy URL$/ })).toBeHidden();
	});

	test(`${activeScenarioMatrix[168].id} ${activeScenarioMatrix[168].title}`, async () => {
		addSecondRunMaestroExternalLink(workbench);
		await stubWindowClipboardTextCapture(electronApp);
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);
		await clickDocumentGraphExternalNode(graphDialog, 'right');
		await graphDialog.getByRole('button', { name: /^Copy URLs$/ }).click();

		await expect
			.poll(() => getCapturedWindowClipboardText(electronApp))
			.toBe('https://runmaestro.ai\nhttps://runmaestro.ai/docs');
	});

	test(`${activeScenarioMatrix[169].id} ${activeScenarioMatrix[169].title}`, async () => {
		addDocsRunMaestroExternalLink(workbench);
		const graphDialog = await openDocumentGraphFromPreview(window);

		await showDocumentGraphExternalLinks(graphDialog);

		await expect(graphDialog.getByText(/2 documents, 2 external domains/)).toBeVisible();
	});

	test(`${activeScenarioMatrix[170].id} ${activeScenarioMatrix[170].title}`, async () => {
		addDocsRunMaestroExternalLink(workbench);
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await showDocumentGraphExternalLinks(graphDialog);
		await searchInput.fill('docs.runmaestro.ai');
		await expect(graphDialog.getByText(/[12] of 4 matching/)).toBeVisible();
		await clickDocumentGraphFilteredExternalNode(graphDialog);

		await expect(graphDialog.getByText('External: docs.runmaestro.ai')).toBeVisible();
	});

	test(`${activeScenarioMatrix[171].id} ${activeScenarioMatrix[171].title}`, async () => {
		addDocsRunMaestroExternalLink(workbench);
		await stubWindowClipboardTextCapture(electronApp);
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await showDocumentGraphExternalLinks(graphDialog);
		await searchInput.fill('docs.runmaestro.ai');
		await clickDocumentGraphFilteredExternalNode(graphDialog, 'right');
		await graphDialog.getByRole('button', { name: /^Copy URL$/ }).click();

		await expect
			.poll(() => getCapturedWindowClipboardText(electronApp))
			.toBe('https://docs.runmaestro.ai');
	});

	test(`${activeScenarioMatrix[172].id} ${activeScenarioMatrix[172].title}`, async () => {
		await stubExternalLinkCapture(electronApp);
		addDocsRunMaestroExternalLink(workbench);
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await showDocumentGraphExternalLinks(graphDialog);
		await searchInput.fill('docs.runmaestro.ai');
		await clickDocumentGraphFilteredExternalNode(graphDialog, 'right');
		await graphDialog.getByRole('button', { name: 'Open' }).click();

		await expect
			.poll(() => getCapturedExternalLinks(electronApp))
			.toContain('https://docs.runmaestro.ai');
	});

	test(`${activeScenarioMatrix[173].id} ${activeScenarioMatrix[173].title}`, async () => {
		addDocsRunMaestroExternalLink(workbench);
		const graphDialog = await openDocumentGraphFromPreview(window);
		const searchInput = graphDialog.getByLabel('Search documents in graph');

		await showDocumentGraphExternalLinks(graphDialog);
		await searchInput.fill('docs.runmaestro.ai');
		await expect(graphDialog.getByText(/[12] of 4 matching/)).toBeVisible();
		await graphDialog.getByLabel('Clear search').click();

		await expect(searchInput).toHaveValue('');
		await expect(graphDialog.getByText(/2 documents, 2 external domains/)).toBeVisible();
	});

	test(`${activeScenarioMatrix[175].id} ${activeScenarioMatrix[175].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[176].id} ${activeScenarioMatrix[176].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-weekday-comparison')).toBeVisible();
	});

	test(`${activeScenarioMatrix[177].id} ${activeScenarioMatrix[177].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metrics')).toBeVisible();
	});

	test(`${activeScenarioMatrix[178].id} ${activeScenarioMatrix[178].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metric-card').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[179].id} ${activeScenarioMatrix[179].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.locator('select').first().selectOption('year');
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[180].id} ${activeScenarioMatrix[180].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.locator('select').first().selectOption('all');
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
	});

	test(`${activeScenarioMatrix[181].id} ${activeScenarioMatrix[181].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.locator('select').first().selectOption('day');
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[182].id} ${activeScenarioMatrix[182].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('tab', { name: 'Overview' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Activity' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Auto Run' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[183].id} ${activeScenarioMatrix[183].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[184].id} ${activeScenarioMatrix[184].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir, sessionId, source }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				await stats.recordQuery({
					sessionId,
					agentType: 'codex',
					source,
					startTime: Date.now(),
					duration: 45_000,
					projectPath: projectDir,
					tabId: `sgs-live-164`,
					isRemote: false,
				});
			},
			{ projectDir: workbench.projectDir, sessionId: workbench.sessionId, source: 'user' }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
	});

	test(`${activeScenarioMatrix[185].id} ${activeScenarioMatrix[185].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => null);
		});
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect(usageDashboard).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[186].id} ${activeScenarioMatrix[186].title}`, async () => {
		const exportPath = path.join(workbench.homeDir, `usage-tranche-166.csv`);
		await electronApp.evaluate(({ ipcMain }, filePath: string) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => filePath);
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle('stats:export-csv', async () => 'range\nusage-tranche\n');
		}, exportPath);
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('all');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
	});

	test(`${activeScenarioMatrix[187].id} ${activeScenarioMatrix[187].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.getByRole('tab', { name: 'Overview' }).click();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
	});

	test(`${activeScenarioMatrix[188].id} ${activeScenarioMatrix[188].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('week');
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
		await expect(usageDashboard.getByText('Total Queries')).toBeVisible();
	});

	test(`${activeScenarioMatrix[189].id} ${activeScenarioMatrix[189].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[190].id} ${activeScenarioMatrix[190].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-weekday-comparison')).toBeVisible();
	});

	test(`${activeScenarioMatrix[191].id} ${activeScenarioMatrix[191].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metrics')).toBeVisible();
	});

	test(`${activeScenarioMatrix[192].id} ${activeScenarioMatrix[192].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metric-card').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[193].id} ${activeScenarioMatrix[193].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.locator('select').first().selectOption('day');
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[194].id} ${activeScenarioMatrix[194].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.locator('select').first().selectOption('week');
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
	});

	test(`${activeScenarioMatrix[195].id} ${activeScenarioMatrix[195].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.locator('select').first().selectOption('month');
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[196].id} ${activeScenarioMatrix[196].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('tab', { name: 'Overview' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Activity' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Auto Run' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[197].id} ${activeScenarioMatrix[197].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[198].id} ${activeScenarioMatrix[198].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir, sessionId, source }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				await stats.recordQuery({
					sessionId,
					agentType: 'codex',
					source,
					startTime: Date.now(),
					duration: 45_000,
					projectPath: projectDir,
					tabId: `sgs-live-178`,
					isRemote: false,
				});
			},
			{ projectDir: workbench.projectDir, sessionId: workbench.sessionId, source: 'user' }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
	});

	test(`${activeScenarioMatrix[199].id} ${activeScenarioMatrix[199].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => null);
		});
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect(usageDashboard).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[200].id} ${activeScenarioMatrix[200].title}`, async () => {
		const exportPath = path.join(workbench.homeDir, `usage-tranche-180.csv`);
		await electronApp.evaluate(({ ipcMain }, filePath: string) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => filePath);
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle('stats:export-csv', async () => 'range\nusage-tranche\n');
		}, exportPath);
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('week');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
	});

	test(`${activeScenarioMatrix[201].id} ${activeScenarioMatrix[201].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.getByRole('tab', { name: 'Overview' }).click();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
	});

	test(`${activeScenarioMatrix[202].id} ${activeScenarioMatrix[202].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('quarter');
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
		await expect(usageDashboard.getByText('Total Queries')).toBeVisible();
	});

	test(`${activeScenarioMatrix[203].id} ${activeScenarioMatrix[203].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[204].id} ${activeScenarioMatrix[204].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-weekday-comparison')).toBeVisible();
	});

	test(`${activeScenarioMatrix[205].id} ${activeScenarioMatrix[205].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metrics')).toBeVisible();
	});

	test(`${activeScenarioMatrix[206].id} ${activeScenarioMatrix[206].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metric-card').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[207].id} ${activeScenarioMatrix[207].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.locator('select').first().selectOption('month');
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[208].id} ${activeScenarioMatrix[208].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.locator('select').first().selectOption('quarter');
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
	});

	test(`${activeScenarioMatrix[209].id} ${activeScenarioMatrix[209].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.locator('select').first().selectOption('year');
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[210].id} ${activeScenarioMatrix[210].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('tab', { name: 'Overview' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Activity' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Auto Run' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[211].id} ${activeScenarioMatrix[211].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[212].id} ${activeScenarioMatrix[212].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir, sessionId, source }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				await stats.recordQuery({
					sessionId,
					agentType: 'codex',
					source,
					startTime: Date.now(),
					duration: 45_000,
					projectPath: projectDir,
					tabId: `sgs-live-192`,
					isRemote: false,
				});
			},
			{ projectDir: workbench.projectDir, sessionId: workbench.sessionId, source: 'user' }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
	});

	test(`${activeScenarioMatrix[213].id} ${activeScenarioMatrix[213].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => null);
		});
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect(usageDashboard).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[214].id} ${activeScenarioMatrix[214].title}`, async () => {
		const exportPath = path.join(workbench.homeDir, `usage-tranche-194.csv`);
		await electronApp.evaluate(({ ipcMain }, filePath: string) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => filePath);
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle('stats:export-csv', async () => 'range\nusage-tranche\n');
		}, exportPath);
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('quarter');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
	});

	test(`${activeScenarioMatrix[215].id} ${activeScenarioMatrix[215].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.getByRole('tab', { name: 'Overview' }).click();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
	});

	test(`${activeScenarioMatrix[216].id} ${activeScenarioMatrix[216].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('all');
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
		await expect(usageDashboard.getByText('Total Queries')).toBeVisible();
	});

	test(`${activeScenarioMatrix[217].id} ${activeScenarioMatrix[217].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[218].id} ${activeScenarioMatrix[218].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-weekday-comparison')).toBeVisible();
	});

	test(`${activeScenarioMatrix[219].id} ${activeScenarioMatrix[219].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metrics')).toBeVisible();
	});

	test(`${activeScenarioMatrix[220].id} ${activeScenarioMatrix[220].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metric-card').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[221].id} ${activeScenarioMatrix[221].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.locator('select').first().selectOption('year');
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[222].id} ${activeScenarioMatrix[222].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.locator('select').first().selectOption('all');
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
	});

	test(`${activeScenarioMatrix[223].id} ${activeScenarioMatrix[223].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.locator('select').first().selectOption('day');
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[224].id} ${activeScenarioMatrix[224].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('tab', { name: 'Overview' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Activity' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Auto Run' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[225].id} ${activeScenarioMatrix[225].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[226].id} ${activeScenarioMatrix[226].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir, sessionId, source }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				await stats.recordQuery({
					sessionId,
					agentType: 'codex',
					source,
					startTime: Date.now(),
					duration: 45_000,
					projectPath: projectDir,
					tabId: `sgs-live-206`,
					isRemote: false,
				});
			},
			{ projectDir: workbench.projectDir, sessionId: workbench.sessionId, source: 'user' }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
	});

	test(`${activeScenarioMatrix[227].id} ${activeScenarioMatrix[227].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => null);
		});
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect(usageDashboard).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[228].id} ${activeScenarioMatrix[228].title}`, async () => {
		const exportPath = path.join(workbench.homeDir, `usage-tranche-208.csv`);
		await electronApp.evaluate(({ ipcMain }, filePath: string) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => filePath);
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle('stats:export-csv', async () => 'range\nusage-tranche\n');
		}, exportPath);
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('all');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
	});

	test(`${activeScenarioMatrix[229].id} ${activeScenarioMatrix[229].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.getByRole('tab', { name: 'Overview' }).click();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
	});

	test(`${activeScenarioMatrix[230].id} ${activeScenarioMatrix[230].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('week');
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
		await expect(usageDashboard.getByText('Total Queries')).toBeVisible();
	});

	test(`${activeScenarioMatrix[231].id} ${activeScenarioMatrix[231].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await expect(usageDashboard.getByTestId('section-session-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[232].id} ${activeScenarioMatrix[232].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
		await expect(usageDashboard.getByTestId('section-weekday-comparison')).toBeVisible();
	});

	test(`${activeScenarioMatrix[233].id} ${activeScenarioMatrix[233].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-stats')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metrics')).toBeVisible();
	});

	test(`${activeScenarioMatrix[234].id} ${activeScenarioMatrix[234].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
		await expect(usageDashboard.getByTestId('autorun-metric-card').first()).toBeVisible();
	});

	test(`${activeScenarioMatrix[235].id} ${activeScenarioMatrix[235].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.locator('select').first().selectOption('day');
		await expect(usageDashboard.getByTestId('agent-efficiency-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[236].id} ${activeScenarioMatrix[236].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.locator('select').first().selectOption('week');
		await expect(usageDashboard.getByTestId('section-activity-heatmap')).toBeVisible();
	});

	test(`${activeScenarioMatrix[237].id} ${activeScenarioMatrix[237].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.locator('select').first().selectOption('month');
		await expect(usageDashboard.getByTestId('autorun-tasks-chart')).toBeVisible();
	});

	test(`${activeScenarioMatrix[238].id} ${activeScenarioMatrix[238].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('tab', { name: 'Overview' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Agents' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Activity' })).toBeVisible();
		await expect(usageDashboard.getByRole('tab', { name: 'Auto Run' })).toBeVisible();
	});

	test(`${activeScenarioMatrix[239].id} ${activeScenarioMatrix[239].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[240].id} ${activeScenarioMatrix[240].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await window.evaluate(
			async ({ projectDir, sessionId, source }) => {
				const { stats } = (globalThis as MaestroStatsGlobal).maestro;
				await stats.recordQuery({
					sessionId,
					agentType: 'codex',
					source,
					startTime: Date.now(),
					duration: 45_000,
					projectPath: projectDir,
					tabId: `sgs-live-220`,
					isRemote: false,
				});
			},
			{ projectDir: workbench.projectDir, sessionId: workbench.sessionId, source: 'user' }
		);

		await expect(usageDashboard.getByTestId('new-data-indicator')).toBeVisible({ timeout: 5000 });
	});

	test(`${activeScenarioMatrix[241].id} ${activeScenarioMatrix[241].title}`, async () => {
		await electronApp.evaluate(({ ipcMain }) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => null);
		});
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect(usageDashboard).toBeVisible();
		await expect(usageDashboard.getByRole('button', { name: 'Export CSV' })).toBeEnabled();
	});

	test(`${activeScenarioMatrix[242].id} ${activeScenarioMatrix[242].title}`, async () => {
		const exportPath = path.join(workbench.homeDir, `usage-tranche-222.csv`);
		await electronApp.evaluate(({ ipcMain }, filePath: string) => {
			ipcMain.removeHandler('dialog:saveFile');
			ipcMain.handle('dialog:saveFile', async () => filePath);
			ipcMain.removeHandler('stats:export-csv');
			ipcMain.handle('stats:export-csv', async () => 'range\nusage-tranche\n');
		}, exportPath);
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.locator('select').first().selectOption('week');
		await usageDashboard.getByRole('button', { name: 'Export CSV' }).click();

		await expect.poll(() => fs.existsSync(exportPath)).toBe(true);
	});

	test(`${activeScenarioMatrix[243].id} ${activeScenarioMatrix[243].title}`, async () => {
		const usageDashboard = await openUsageDashboard(window);

		await usageDashboard.getByRole('tab', { name: 'Agents' }).click();
		await usageDashboard.getByRole('tab', { name: 'Activity' }).click();
		await usageDashboard.getByRole('tab', { name: 'Auto Run' }).click();
		await usageDashboard.getByRole('tab', { name: 'Overview' }).click();
		await expect(usageDashboard.getByTestId('summary-cards')).toBeVisible();
	});

	const closeoutScenarioIndexOffset = 20;
	const closeoutScenarioTitle = (matrixIndex: number) => {
		const scenario = activeScenarioMatrix[matrixIndex + closeoutScenarioIndexOffset];
		return `${scenario.id} ${scenario.title}`;
	};

	const documentGraphCloseoutMatrix = [
		{ matrixIndex: 224, action: 'search-refresh', query: 'readme', expected: 'README.md' },
		{
			matrixIndex: 225,
			action: 'search-refresh',
			query: 'runbook',
			expected: DOCUMENT_GRAPH_SEARCH_MATCH_STATUS,
		},
		{
			matrixIndex: 226,
			action: 'search-clear-retype',
			firstQuery: 'readme',
			query: 'runbook',
			expected: DOCUMENT_GRAPH_SEARCH_MATCH_STATUS,
		},
		{
			matrixIndex: 227,
			action: 'search-clear-retype',
			firstQuery: 'runbook',
			query: 'readme',
			expected: 'README.md',
		},
		{ matrixIndex: 228, action: 'help', expected: 'Node Types' },
		{ matrixIndex: 229, action: 'help', expected: 'Keyboard Shortcuts' },
		{ matrixIndex: 230, action: 'help', expected: 'Mouse Actions' },
		{ matrixIndex: 231, action: 'help-repeat', expected: 'Status Indicator' },
		{ matrixIndex: 232, action: 'layout', option: 'Radial', expected: 'Layout: Radial' },
		{ matrixIndex: 233, action: 'layout', option: 'Force', expected: 'Layout: Force' },
		{ matrixIndex: 234, action: 'layout', option: 'Mind Map', expected: 'Layout: Mind Map' },
		{ matrixIndex: 235, action: 'layout-menu', option: 'Radial', expected: 'Radial' },
		{
			matrixIndex: 236,
			action: 'depth',
			value: '1',
			expected: 'Showing documents within 1 link of focus',
		},
		{
			matrixIndex: 237,
			action: 'depth',
			value: '2',
			expected: 'Showing documents within 2 links of focus',
		},
		{
			matrixIndex: 238,
			action: 'depth',
			value: '3',
			expected: 'Showing documents within 3 links of focus',
		},
		{
			matrixIndex: 239,
			action: 'depth',
			value: '2',
			expected: 'Showing documents within 2 links of focus',
		},
		{ matrixIndex: 240, action: 'preview', value: '50' },
		{ matrixIndex: 241, action: 'preview', value: '250' },
		{ matrixIndex: 242, action: 'preview', value: '500' },
		{ matrixIndex: 243, action: 'preview', value: '350' },
		{ matrixIndex: 244, action: 'external-on' },
		{ matrixIndex: 245, action: 'external-toggle-twice' },
		{ matrixIndex: 246, action: 'refresh-after-search', query: 'readme', expected: 'README.md' },
		{
			matrixIndex: 247,
			action: 'refresh-after-search',
			query: 'runbook',
			expected: DOCUMENT_GRAPH_SEARCH_MATCH_STATUS,
		},
		{ matrixIndex: 248, action: 'refresh-after-external' },
		{
			matrixIndex: 249,
			action: 'refresh-after-layout',
			option: 'Radial',
			expected: 'Layout: Radial',
		},
		{ matrixIndex: 250, action: 'center-text', expected: 'README.md' },
		{ matrixIndex: 251, action: 'center-text', expected: '1 connection' },
		{ matrixIndex: 252, action: 'center-title', expected: 'Created date' },
		{ matrixIndex: 253, action: 'center-title', expected: 'Modified date' },
		{ matrixIndex: 254, action: 'context-button', expected: 'Open' },
		{ matrixIndex: 255, action: 'context-button', expected: 'Open' },
		{ matrixIndex: 256, action: 'context-button', expected: 'Copy Path' },
		{ matrixIndex: 257, action: 'context-button', expected: 'Focus' },
		{ matrixIndex: 258, action: 'context-escape' },
		{ matrixIndex: 259, action: 'keyboard-preview-text', expected: 'README.md' },
		{ matrixIndex: 260, action: 'keyboard-preview-title', expected: 'Open in file preview' },
		{ matrixIndex: 261, action: 'keyboard-preview-text', expected: 'Stats Graph Symphony Fixture' },
		{ matrixIndex: 262, action: 'keyboard-preview-history' },
		{ matrixIndex: 263, action: 'breadcrumb-current' },
		{ matrixIndex: 264, action: 'breadcrumb-project' },
		{ matrixIndex: 265, action: 'breadcrumb-readme' },
		{ matrixIndex: 266, action: 'center-text', expected: 'README.md' },
		{ matrixIndex: 267, action: 'escape-search', query: 'runbook' },
		{ matrixIndex: 268, action: 'escape-search-focused', query: 'readme' },
		{
			matrixIndex: 269,
			action: 'search-clear-retype',
			firstQuery: 'runbook',
			query: 'readme',
			expected: 'README.md',
		},
		{
			matrixIndex: 270,
			action: 'search-clear-retype',
			firstQuery: 'readme',
			query: 'runbook',
			expected: DOCUMENT_GRAPH_SEARCH_MATCH_STATUS,
		},
		{ matrixIndex: 271, action: 'search-clear-count', query: 'readme' },
		{ matrixIndex: 272, action: 'close-control' },
		{ matrixIndex: 273, action: 'close-cancel' },
		{ matrixIndex: 274, action: 'close-confirm' },
		{ matrixIndex: 275, action: 'help-close-visible' },
		{ matrixIndex: 276, action: 'help-escape' },
		{ matrixIndex: 277, action: 'help-repeat', expected: 'Node Types' },
		{ matrixIndex: 278, action: 'help', expected: 'Status Indicator' },
		{ matrixIndex: 279, action: 'help-refresh', expected: 'Keyboard Shortcuts' },
		{ matrixIndex: 280, action: 'help-refresh', expected: 'Mouse Actions' },
		{ matrixIndex: 281, action: 'context-focus' },
		{
			matrixIndex: 282,
			action: 'search',
			query: 'runbook',
			expected: DOCUMENT_GRAPH_SEARCH_MATCH_STATUS,
		},
		{ matrixIndex: 283, action: 'canvas-after-layout' },
		{ matrixIndex: 284, action: 'canvas-after-depth' },
		{ matrixIndex: 285, action: 'canvas-after-preview' },
		{ matrixIndex: 286, action: 'refresh-count' },
		{ matrixIndex: 287, action: 'external-on' },
		{ matrixIndex: 288, action: 'layout-search', query: 'readme', expected: 'README.md' },
		{
			matrixIndex: 289,
			action: 'depth-search',
			query: 'runbook',
			expected: DOCUMENT_GRAPH_SEARCH_MATCH_STATUS,
		},
		{ matrixIndex: 290, action: 'help-dialog-scope', expected: 'Node Types' },
		{ matrixIndex: 291, action: 'context-escape' },
		{ matrixIndex: 292, action: 'reset-layout-selection' },
	] as const;

	const symphonyCloseoutMatrix = [
		{ matrixIndex: 293, action: 'project-search', query: 'core', expected: 'Maestro Core' },
		{
			matrixIndex: 294,
			action: 'project-search',
			query: 'documentation',
			expected: 'Documentation Hub',
		},
		{ matrixIndex: 295, action: 'project-search-empty', query: 'missing-repository' },
		{ matrixIndex: 296, action: 'project-detail', expected: 'Maestro Symphony: Maestro Core' },
		{ matrixIndex: 297, action: 'project-detail', expected: 'Available Issues (1)' },
		{ matrixIndex: 298, action: 'project-detail', expected: 'In Progress (1)' },
		{ matrixIndex: 299, action: 'project-detail', expected: 'Blocked (1)' },
		{
			matrixIndex: 300,
			action: 'issue-detail',
			issue: 'Add deterministic E2E coverage',
			expected: '#42',
		},
		{
			matrixIndex: 301,
			action: 'issue-detail',
			issue: 'Add deterministic E2E coverage',
			expected: 'e2e-plan.md',
		},
		{
			matrixIndex: 302,
			action: 'issue-detail',
			issue: 'Blocked dependency upgrade',
			expected: 'Blocked by a dependency',
		},
		{
			matrixIndex: 303,
			action: 'issue-detail',
			issue: 'Blocked dependency upgrade',
			expected: 'Draft PR #77 by @codex-user',
		},
		{ matrixIndex: 304, action: 'tab-text', tab: 'Active (1)', expected: 'Ready for Review' },
		{ matrixIndex: 305, action: 'tab-text', tab: 'Active (1)', expected: 'Draft PR #77' },
		{ matrixIndex: 306, action: 'tab-text', tab: 'Active (1)', expected: 'Current: e2e-plan.md' },
		{ matrixIndex: 307, action: 'tab-text', tab: 'Active (1)', expected: '2 / 2 documents' },
		{
			matrixIndex: 308,
			action: 'tab-text',
			tab: 'History',
			expected: 'Document mobile bridge setup',
		},
		{ matrixIndex: 309, action: 'tab-text', tab: 'History', expected: 'Merged' },
		{ matrixIndex: 310, action: 'tab-text', tab: 'History', expected: 'PR #12' },
		{ matrixIndex: 311, action: 'tab-text', tab: 'History', expected: '$4.56' },
		{ matrixIndex: 312, action: 'tab-text', tab: 'Stats', expected: 'Tokens Donated' },
		{ matrixIndex: 313, action: 'tab-text', tab: 'Stats', expected: 'Time Contributed' },
		{ matrixIndex: 314, action: 'tab-text', tab: 'Stats', expected: 'Streak' },
		{ matrixIndex: 315, action: 'tab-text', tab: 'Stats', expected: 'Achievements' },
		{ matrixIndex: 316, action: 'help', expected: 'About Maestro Symphony' },
		{ matrixIndex: 317, action: 'help', expected: 'runmaestro.ai' },
		{ matrixIndex: 318, action: 'help-close' },
		{ matrixIndex: 319, action: 'about-text', expected: 'Maestro Achievements' },
		{ matrixIndex: 320, action: 'achievement-detail' },
		{ matrixIndex: 321, action: 'achievement-share' },
		{
			matrixIndex: 322,
			action: 'leaderboard-open',
			expected: 'Join the global Maestro leaderboard',
		},
		{ matrixIndex: 323, action: 'leaderboard-open', expected: 'Your Current Stats' },
		{ matrixIndex: 324, action: 'leaderboard-display-required' },
		{ matrixIndex: 325, action: 'leaderboard-email-required' },
		{ matrixIndex: 326, action: 'leaderboard-valid' },
		{ matrixIndex: 327, action: 'leaderboard-github-field' },
		{ matrixIndex: 328, action: 'leaderboard-x-field' },
		{ matrixIndex: 329, action: 'leaderboard-invalid-email' },
		{ matrixIndex: 330, action: 'leaderboard-confirmation' },
		{ matrixIndex: 331, action: 'leaderboard-pending' },
		{ matrixIndex: 332, action: 'leaderboard-failure' },
		{ matrixIndex: 333, action: 'leaderboard-manual-token' },
		{ matrixIndex: 334, action: 'leaderboard-pulldown-after-token' },
		{ matrixIndex: 335, action: 'project-back' },
	] as const;

	for (const scenario of documentGraphCloseoutMatrix) {
		test(closeoutScenarioTitle(scenario.matrixIndex), async () => {
			const graphDialog = await openDocumentGraphFromPreview(window);

			switch (scenario.action) {
				case 'search':
					await graphDialog.getByLabel('Search documents in graph').fill(scenario.query);
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible();
					break;
				case 'search-refresh':
					await graphDialog.getByLabel('Search documents in graph').fill(scenario.query);
					await graphDialog.getByTitle('Refresh graph').click();
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible({ timeout: 15000 });
					break;
				case 'search-clear-retype': {
					const searchInput = graphDialog.getByLabel('Search documents in graph');
					await searchInput.fill(scenario.firstQuery);
					await graphDialog.getByLabel('Clear search').click();
					await searchInput.fill(scenario.query);
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible();
					break;
				}
				case 'help':
					await graphDialog.getByTitle('Open help panel').click();
					await expect(graphDialog.getByRole('region', { name: 'Help panel' })).toBeVisible();
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible();
					break;
				case 'help-repeat':
					await graphDialog.getByTitle('Open help panel').click();
					await graphDialog.getByTitle('Close help panel').click();
					await graphDialog.getByTitle('Open help panel').click();
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible();
					break;
				case 'help-refresh':
					await graphDialog.getByTitle('Refresh graph').click();
					await graphDialog.getByTitle('Open help panel').click();
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible({ timeout: 15000 });
					break;
				case 'layout':
					await clickDocumentGraphLayoutOption(graphDialog, scenario.option);
					await expect(graphDialog.getByTitle(scenario.expected)).toBeVisible();
					break;
				case 'layout-menu':
					await graphDialog.getByTitle(/Layout: /).click();
					await expect(
						graphDialog.getByRole('button', { name: new RegExp(scenario.expected) }).last()
					).toBeVisible();
					break;
				case 'depth':
					await openDocumentGraphDepthMenu(graphDialog);
					await graphDialog.locator('input[type="range"]').first().fill(scenario.value);
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible();
					break;
				case 'preview':
					await graphDialog.getByText(/Preview: \d+/).click();
					await graphDialog.locator('input[type="range"]').last().fill(scenario.value);
					await expect(
						graphDialog.getByText('Characters shown in document previews')
					).toBeVisible();
					break;
				case 'external-on':
					await graphDialog.getByTitle('Show external links').click();
					await expect(graphDialog.getByTitle('Hide external links')).toBeVisible({
						timeout: 15000,
					});
					break;
				case 'external-toggle-twice':
					await graphDialog.getByTitle('Show external links').click();
					await graphDialog.getByTitle('Hide external links').click();
					await expect(graphDialog.getByTitle('Show external links')).toBeVisible({
						timeout: 15000,
					});
					break;
				case 'refresh-after-search':
					await graphDialog.getByLabel('Search documents in graph').fill(scenario.query);
					await graphDialog.getByTitle('Refresh graph').click();
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible({ timeout: 15000 });
					break;
				case 'refresh-after-external':
					await graphDialog.getByTitle('Show external links').click();
					await graphDialog.getByTitle('Refresh graph').click();
					await expect(graphDialog.getByTitle('Hide external links')).toBeVisible({
						timeout: 15000,
					});
					break;
				case 'refresh-after-layout':
					await clickDocumentGraphLayoutOption(graphDialog, scenario.option);
					await graphDialog.getByTitle('Refresh graph').click();
					await expect(graphDialog.getByTitle(scenario.expected)).toBeVisible({ timeout: 15000 });
					break;
				case 'center-text':
					await clickDocumentGraphCenter(graphDialog);
					await expect(graphDialog.getByText(scenario.expected).first()).toBeVisible();
					break;
				case 'center-title':
					await clickDocumentGraphCenter(graphDialog);
					await expect(graphDialog.getByTitle(scenario.expected)).toBeVisible();
					break;
				case 'context-button':
					await clickDocumentGraphCenter(graphDialog, 'right');
					await expect(graphDialog.getByRole('button', { name: scenario.expected })).toBeVisible();
					break;
				case 'context-escape':
					await clickDocumentGraphCenter(graphDialog, 'right');
					await expect(graphDialog.getByRole('button', { name: 'Open' })).toBeVisible();
					await window.keyboard.press('Escape');
					await expect(graphDialog.getByRole('button', { name: 'Open' })).toBeHidden();
					break;
				case 'keyboard-preview-text':
					await clickDocumentGraphCenter(graphDialog);
					await window.keyboard.press('P');
					await expect(graphDialog.getByText(scenario.expected).first()).toBeVisible();
					break;
				case 'keyboard-preview-title':
					await clickDocumentGraphCenter(graphDialog);
					await window.keyboard.press('P');
					await expect(graphDialog.getByTitle(scenario.expected)).toBeVisible();
					break;
				case 'keyboard-preview-history':
					await clickDocumentGraphCenter(graphDialog);
					await window.keyboard.press('P');
					await expect(graphDialog.getByLabel('Go back')).toBeDisabled();
					await expect(graphDialog.getByLabel('Go forward')).toBeDisabled();
					break;
				case 'breadcrumb-current': {
					await clickDocumentGraphCenter(graphDialog);
					await expect(graphDialog.getByText('README').first()).toBeVisible();
					await expect(graphDialog.getByText('1 connection').first()).toBeVisible();
					break;
				}
				case 'breadcrumb-project': {
					await clickDocumentGraphCenter(graphDialog);
					await expect(graphDialog.getByText('project').first()).toBeVisible();
					break;
				}
				case 'breadcrumb-readme': {
					await clickDocumentGraphCenter(graphDialog);
					await expect(graphDialog.getByText('README.md').first()).toBeVisible();
					break;
				}
				case 'escape-search': {
					const searchInput = graphDialog.getByLabel('Search documents in graph');
					await searchInput.fill(scenario.query);
					await expect(searchInput).toHaveValue(scenario.query);
					await searchInput.press('Escape');
					await expect(searchInput).toHaveValue('');
					break;
				}
				case 'escape-search-focused': {
					const searchInput = graphDialog.getByLabel('Search documents in graph');
					await searchInput.fill(scenario.query);
					await expect(searchInput).toHaveValue(scenario.query);
					await searchInput.press('Escape');
					await expect(searchInput).toBeFocused();
					break;
				}
				case 'search-clear-count': {
					const searchInput = graphDialog.getByLabel('Search documents in graph');
					await searchInput.fill(scenario.query);
					await graphDialog.getByLabel('Clear search').click();
					await expect(graphDialog.getByText(/\d+ documents/)).toBeVisible({ timeout: 15000 });
					break;
				}
				case 'close-control':
					await expect(graphDialog.getByTitle('Close (Esc)').first()).toBeVisible();
					break;
				case 'close-cancel': {
					await graphDialog.getByTitle('Close (Esc)').first().click();
					const closeDialog = window.getByRole('dialog', { name: 'Close Document Graph?' });
					await expect(closeDialog).toBeVisible();
					await closeDialog.getByRole('button', { name: 'Cancel' }).click();
					await expect(graphDialog).toBeVisible();
					break;
				}
				case 'close-confirm':
					await closeDocumentGraph(window);
					break;
				case 'help-close-visible':
					await graphDialog.getByTitle('Open help panel').click();
					await expect(graphDialog.getByTitle('Close help panel')).toBeVisible();
					break;
				case 'help-escape':
					await graphDialog.getByTitle('Open help panel').click();
					await window.keyboard.press('Escape');
					await expect(graphDialog.getByRole('region', { name: 'Help panel' })).toBeHidden();
					break;
				case 'context-focus':
					await clickDocumentGraphCenter(graphDialog, 'right');
					await graphDialog.getByRole('button', { name: 'Focus' }).click();
					await expect(graphDialog.getByText('README.md').first()).toBeVisible();
					break;
				case 'canvas-after-layout':
					await clickDocumentGraphLayoutOption(graphDialog, 'Radial');
					await expect(graphDialog.locator('canvas')).toBeVisible();
					break;
				case 'canvas-after-depth':
					await openDocumentGraphDepthMenu(graphDialog);
					await graphDialog.locator('input[type="range"]').first().fill('2');
					await expect(graphDialog.locator('canvas')).toBeVisible();
					break;
				case 'canvas-after-preview':
					await graphDialog.getByText(/Preview: \d+/).click();
					await graphDialog.locator('input[type="range"]').last().fill('250');
					await expect(graphDialog.locator('canvas')).toBeVisible();
					break;
				case 'refresh-count':
					await graphDialog.getByTitle('Refresh graph').click();
					await expect(graphDialog.getByText(/\d+ documents/)).toBeVisible({ timeout: 15000 });
					break;
				case 'layout-search':
					await clickDocumentGraphLayoutOption(graphDialog, 'Radial');
					await graphDialog.getByLabel('Search documents in graph').fill(scenario.query);
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible();
					break;
				case 'depth-search':
					await openDocumentGraphDepthMenu(graphDialog);
					await graphDialog.locator('input[type="range"]').first().fill('2');
					await graphDialog.getByLabel('Search documents in graph').fill(scenario.query);
					await expect(graphDialog.getByText(scenario.expected)).toBeVisible();
					break;
				case 'help-dialog-scope':
					await graphDialog.getByTitle('Open help panel').click();
					await expect(
						graphDialog.getByRole('region', { name: 'Help panel' }).getByText(scenario.expected)
					).toBeVisible();
					break;
				case 'reset-layout-selection':
					await dragDocumentGraphCenterNode(window, graphDialog);
					await expect(
						graphDialog.getByTitle('Reset all node positions to algorithmic layout')
					).toBeVisible();
					await graphDialog.getByTitle('Reset all node positions to algorithmic layout').click();
					await expect(graphDialog.getByText('README.md').first()).toBeVisible();
					break;
			}
		});
	}

	for (const scenario of symphonyCloseoutMatrix) {
		test(closeoutScenarioTitle(scenario.matrixIndex), async () => {
			switch (scenario.action) {
				case 'project-search': {
					const symphonyDialog = await openSymphonyFromQuickActions(window);
					await symphonyDialog.getByPlaceholder('Search repositories...').fill(scenario.query);
					await expect(
						symphonyDialog.getByRole('button', { name: new RegExp(scenario.expected) })
					).toBeVisible();
					break;
				}
				case 'project-search-empty': {
					const symphonyDialog = await openSymphonyFromQuickActions(window);
					await symphonyDialog.getByPlaceholder('Search repositories...').fill(scenario.query);
					await expect(symphonyDialog.getByText('No repositories match your search')).toBeVisible();
					break;
				}
				case 'project-detail': {
					const symphonyDialog = await openSymphonyFromQuickActions(window);
					await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
					await expect(symphonyDialog.getByText(scenario.expected)).toBeVisible();
					break;
				}
				case 'issue-detail': {
					const symphonyDialog = await openSymphonyFromQuickActions(window);
					await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
					await selectSymphonyIssue(symphonyDialog, scenario.issue);
					await expect(getSymphonyCloseoutText(symphonyDialog, scenario.expected)).toBeVisible();
					break;
				}
				case 'tab-text': {
					const symphonyDialog = await openSymphonyFromQuickActions(window);
					await symphonyDialog.getByRole('button', { name: scenario.tab }).click();
					await expect(getSymphonyCloseoutText(symphonyDialog, scenario.expected)).toBeVisible();
					break;
				}
				case 'help': {
					const symphonyDialog = await openSymphonyFromQuickActions(window);
					await symphonyDialog.getByLabel('Help').click();
					await expect(symphonyDialog.getByText(scenario.expected).last()).toBeVisible();
					break;
				}
				case 'help-close': {
					const symphonyDialog = await openSymphonyFromQuickActions(window);
					await symphonyDialog.getByLabel('Help').click();
					await expect(symphonyDialog.getByRole('button', { name: 'Close' }).last()).toBeVisible();
					break;
				}
				case 'about-text': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await expect(aboutDialog.getByText(scenario.expected)).toBeVisible();
					break;
				}
				case 'achievement-detail': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByTitle('Apprentice Conductor - Click to view details').click();
					await expect(aboutDialog.getByText('Level 1')).toBeVisible();
					break;
				}
				case 'achievement-share': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByTitle('Share achievements').click();
					await expect(
						aboutDialog.getByRole('button', { name: 'Copy to Clipboard' })
					).toBeVisible();
					break;
				}
				case 'leaderboard-open': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await expect(leaderboardDialog.getByText(scenario.expected)).toBeVisible();
					break;
				}
				case 'leaderboard-display-required': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await leaderboardDialog
						.getByPlaceholder('conductor@maestro.ai')
						.fill('display-required@example.com');
					await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeDisabled();
					break;
				}
				case 'leaderboard-email-required': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Email Required');
					await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeDisabled();
					break;
				}
				case 'leaderboard-valid': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Valid Closeout');
					await leaderboardDialog
						.getByPlaceholder('conductor@maestro.ai')
						.fill('valid-closeout@example.com');
					await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeEnabled();
					break;
				}
				case 'leaderboard-github-field': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await leaderboardDialog.getByPlaceholder('username').first().fill('stats-closeout');
					await expect(leaderboardDialog.getByPlaceholder('username').first()).toHaveValue(
						'stats-closeout'
					);
					break;
				}
				case 'leaderboard-x-field': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await leaderboardDialog.getByPlaceholder('username').nth(1).fill('stats_x_closeout');
					await expect(leaderboardDialog.getByPlaceholder('username').nth(1)).toHaveValue(
						'stats_x_closeout'
					);
					break;
				}
				case 'leaderboard-invalid-email': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Invalid Email');
					await leaderboardDialog.getByPlaceholder('conductor@maestro.ai').fill('bad-email');
					await expect(
						leaderboardDialog.getByText('Please enter a valid email address')
					).toBeVisible();
					break;
				}
				case 'leaderboard-confirmation': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Confirm Closeout');
					await leaderboardDialog
						.getByPlaceholder('conductor@maestro.ai')
						.fill('confirm-closeout@example.com');
					await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();
					await expect(leaderboardDialog.getByText(/Profile submitted!/)).toBeVisible();
					break;
				}
				case 'leaderboard-pending': {
					await electronApp.evaluate(({ ipcMain }) => {
						ipcMain.removeHandler('leaderboard:submit');
						ipcMain.handle('leaderboard:submit', async () => ({
							success: true,
							pendingEmailConfirmation: true,
							clientToken: 'sgs-closeout-pending-token',
							message: 'Confirmation email queued.',
						}));
					});
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Pending Closeout');
					await leaderboardDialog
						.getByPlaceholder('conductor@maestro.ai')
						.fill('pending-closeout@example.com');
					await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();
					await expect(
						leaderboardDialog.getByText('Please check your email to confirm your registration.')
					).toBeVisible();
					break;
				}
				case 'leaderboard-failure': {
					await electronApp.evaluate(({ ipcMain }) => {
						ipcMain.removeHandler('leaderboard:submit');
						ipcMain.handle('leaderboard:submit', async () => ({
							success: false,
							error: 'SGS closeout leaderboard failure',
						}));
					});
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByRole('button', { name: /Join Leaderboard/ }).click();
					const leaderboardDialog = window.getByRole('dialog', {
						name: 'Register for Leaderboard',
					});
					await leaderboardDialog.getByPlaceholder('ConductorPedram').fill('Failure Closeout');
					await leaderboardDialog
						.getByPlaceholder('conductor@maestro.ai')
						.fill('failure-closeout@example.com');
					await leaderboardDialog.getByRole('button', { name: 'Push Up' }).click();
					await expect(
						leaderboardDialog.getByText('SGS closeout leaderboard failure')
					).toBeVisible();
					await expect(leaderboardDialog.getByRole('button', { name: 'Push Up' })).toBeEnabled();
					break;
				}
				case 'leaderboard-manual-token': {
					await openLeaderboardWithManualAuthToken(
						window,
						electronApp,
						'Manual Closeout',
						'manual-closeout@example.com'
					);
					await expect(window.getByRole('dialog', { name: /Leaderboard/ })).toBeVisible();
					break;
				}
				case 'leaderboard-pulldown-after-token': {
					const leaderboardDialog = await openLeaderboardWithManualAuthToken(
						window,
						electronApp,
						'Pull Closeout',
						'pull-closeout@example.com'
					);
					await expect(leaderboardDialog.getByRole('button', { name: 'Pull Down' })).toBeVisible();
					break;
				}
				case 'project-back': {
					const symphonyDialog = await openSymphonyFromQuickActions(window);
					await symphonyDialog.getByRole('button', { name: /Maestro Core/ }).click();
					await expect(symphonyDialog.getByTitle('Back (Esc)')).toBeVisible();
					break;
				}
			}
		});
	}

	const recoveryTrancheMatrix = [
		{ matrixIndex: 336, action: 'usage-db-size' },
		{ matrixIndex: 337, action: 'graph-help-after-refresh' },
		{ matrixIndex: 338, action: 'symphony-stats-achievements' },
		{ matrixIndex: 339, action: 'achievement-share-actions' },
		{ matrixIndex: 340, action: 'leaderboard-manual-token-pulldown' },
	] as const;

	for (const scenario of recoveryTrancheMatrix) {
		test(closeoutScenarioTitle(scenario.matrixIndex), async () => {
			switch (scenario.action) {
				case 'usage-db-size': {
					const usageDashboard = await openUsageDashboard(window);
					await usageDashboard.locator('select').first().selectOption('month');
					await expect(usageDashboard.getByTestId('database-size-indicator')).toBeVisible();
					break;
				}
				case 'graph-help-after-refresh': {
					const graphDialog = await openDocumentGraphFromPreview(window);
					await graphDialog.getByTitle('Refresh graph').click();
					await graphDialog.getByTitle('Open help panel').click();
					const helpPanel = graphDialog.getByRole('region', { name: 'Help panel' });
					await expect(helpPanel).toBeVisible({ timeout: 15000 });
					await expect(helpPanel.getByText('Node Types')).toBeVisible();
					break;
				}
				case 'symphony-stats-achievements': {
					const symphonyDialog = await openSymphonyFromQuickActions(window);
					await symphonyDialog.getByRole('button', { name: 'Stats' }).click();
					await expect(symphonyDialog.getByText('Tokens Donated')).toBeVisible();
					await expect(symphonyDialog.getByText('Achievements')).toBeVisible();
					break;
				}
				case 'achievement-share-actions': {
					const aboutDialog = await openAboutFromQuickActions(window);
					await aboutDialog.getByTitle('Share achievements').click();
					await expect(
						aboutDialog.getByRole('button', { name: 'Copy to Clipboard' })
					).toBeVisible();
					break;
				}
				case 'leaderboard-manual-token-pulldown': {
					const leaderboardDialog = await openLeaderboardWithManualAuthToken(
						window,
						electronApp,
						'Recovery Pull Down',
						'recovery-pulldown@example.com'
					);
					await expect(leaderboardDialog.getByRole('button', { name: 'Pull Down' })).toBeVisible();
					break;
				}
			}
		});
	}
});
