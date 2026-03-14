---
name: correct-course
description: 'Manage significant changes during sprint execution. Use when the user says "correct course" or "propose sprint change"'
---

# Correct Course - Sprint Change Management Workflow

**Goal:** Manage significant changes during sprint execution by analyzing impact across all project artifacts and producing a structured Sprint Change Proposal.

**Your Role:** You are a Scrum Master navigating change management. Analyze the triggering issue, assess impact across PRD, epics, architecture, and UX artifacts, and produce an actionable Sprint Change Proposal with clear handoff.

---

## INITIALIZATION

### Configuration Loading

Load config from `{project-root}/_bmad/bmm/config.yaml` and resolve:

- `project_name`, `user_name`
- `communication_language`, `document_output_language`
- `user_skill_level`
- `implementation_artifacts`
- `planning_artifacts`
- `project_knowledge`
- `date` as system-generated current datetime
- YOU MUST ALWAYS SPEAK OUTPUT in your Agent communication style with the config `{communication_language}`
- Language MUST be tailored to `{user_skill_level}`
- Generate all documents in `{document_output_language}`
- DOCUMENT OUTPUT: Updated epics, stories, or PRD sections. Clear, actionable changes. User skill level (`{user_skill_level}`) affects conversation style ONLY, not document updates.

### Paths

- `installed_path` = `{project-root}/_bmad/bmm/workflows/4-implementation/correct-course`
- `checklist` = `{installed_path}/checklist.md`
- `default_output_file` = `{planning_artifacts}/sprint-change-proposal-{date}.md`

### Input Files

| Input            | Path                                                                                                     | Load Strategy |
| ---------------- | -------------------------------------------------------------------------------------------------------- | ------------- |
| PRD              | `{planning_artifacts}/*prd*.md` (whole) or `{planning_artifacts}/*prd*/*.md` (sharded)                   | FULL_LOAD     |
| Epics            | `{planning_artifacts}/*epic*.md` (whole) or `{planning_artifacts}/*epic*/*.md` (sharded)                 | FULL_LOAD     |
| Architecture     | `{planning_artifacts}/*architecture*.md` (whole) or `{planning_artifacts}/*architecture*/*.md` (sharded) | FULL_LOAD     |
| UX Design        | `{planning_artifacts}/*ux*.md` (whole) or `{planning_artifacts}/*ux*/*.md` (sharded)                     | FULL_LOAD     |
| Tech Spec        | `{planning_artifacts}/*tech-spec*.md` (whole)                                                            | FULL_LOAD     |
| Document Project | `{project_knowledge}/index.md` (sharded)                                                                 | INDEX_GUIDED  |

### Context

- `project_context` = `**/project-context.md` (load if exists)

---

## EXECUTION

### Document Discovery - Loading Project Artifacts

**Strategy**: Course correction needs broad project context to assess change impact accurately. Load all available planning artifacts.

**Discovery Process for FULL_LOAD documents (PRD, Epics, Architecture, UX Design, Tech Spec):**

1. **Search for whole document first** - Look for files matching the whole-document pattern (e.g., `*prd*.md`, `*epic*.md`, `*architecture*.md`, `*ux*.md`, `*tech-spec*.md`)
2. **Check for sharded version** - If whole document not found, look for a directory with `index.md` (e.g., `prd/index.md`, `epics/index.md`)
3. **If sharded version found**:
   - Read `index.md` to understand the document structure
   - Read ALL section files listed in the index
   - Process the combined content as a single document
4. **Priority**: If both whole and sharded versions exist, use the whole document

**Discovery Process for INDEX_GUIDED documents (Document Project):**

1. **Search for index file** - Look for `{project_knowledge}/index.md`
2. **If found**: Read the index to understand available documentation sections
3. **Selectively load sections** based on relevance to the change being analyzed — do NOT load everything, only sections that relate to the impacted areas
4. **This document is optional** — skip if `{project_knowledge}` does not exist (greenfield projects)

**Fuzzy matching**: Be flexible with document names — users may use variations like `prd.md`, `bmm-prd.md`, `product-requirements.md`, etc.

**Missing documents**: Not all documents may exist. PRD and Epics are essential; Architecture, UX Design, Tech Spec, and Document Project are loaded if available. HALT if PRD or Epics cannot be found.

<workflow>

<step n="1" goal="Initialize Change Navigation">
  <action>Load {project_context} for coding standards and project-wide patterns (if exists)</action>
  <action>Confirm change trigger and gather user description of the issue</action>
  <action>Ask: "What specific issue or change has been identified that requires navigation?"</action>
  <action>Verify access to required project documents:</action>
    - PRD (Product Requirements Document)
    - Current Epics and Stories
    - Architecture documentation
    - UI/UX specifications
  <action>Ask user for mode preference:</action>
    - **Incremental** (recommended): Refine each edit collaboratively
    - **Batch**: Present all changes at once for review
  <action>Store mode selection for use throughout workflow</action>

<action if="change trigger is unclear">HALT: "Cannot navigate change without clear understanding of the triggering issue. Please provide specific details about what needs to change and why."</action>

<action if="core documents are unavailable">HALT: "Need access to project documents (PRD, Epics, Architecture, UI/UX) to assess change impact. Please ensure these documents are accessible."</action>
</step>

<step n="2" goal="Execute Change Analysis Checklist">
  <action>Read fully and follow the systematic analysis from: {checklist}</action>
  <action>Work through each checklist section interactively with the user</action>
  <action>Record status for each checklist item:</action>
    - [x] Done - Item completed successfully
    - [N/A] Skip - Item not applicable to this change
    - [!] Action-needed - Item requires attention or follow-up
  <action>Maintain running notes of findings and impacts discovered</action>
  <action>Present checklist progress after each major section</action>

<action if="checklist cannot be completed">Identify blocking issues and work with user to resolve before continuing</action>
</step>

<step n="3" goal="Draft Specific Change Proposals">
<action>Based on checklist findings, create explicit edit proposals for each identified artifact</action>

<action>For Story changes:</action>

- Show old → new text format
- Include story ID and section being modified
- Provide rationale for each change
- Example format:

  ```
  Story: [STORY-123] User Authentication
  Section: Acceptance Criteria

  OLD:
  - User can log in with email/password

  NEW:
  - User can log in with email/password
  - User can enable 2FA via authenticator app

  Rationale: Security requirement identified during implementation
  ```

<action>For PRD modifications:</action>

- Specify exact sections to update
- Show current content and proposed changes
- Explain impact on MVP scope and requirements

<action>For Architecture changes:</action>

- Identify affected components, patterns, or technology choices
- Describe diagram updates needed
- Note any ripple effects on other components

<action>For UI/UX specification updates:</action>

- Reference specific screens or components
- Show wireframe or flow changes needed
- Connect changes to user experience impact

<check if="mode is Incremental">
  <action>Present each edit proposal individually</action>
  <ask>Review and refine this change? Options: Approve [a], Edit [e], Skip [s]</ask>
  <action>Iterate on each proposal based on user feedback</action>
</check>

<action if="mode is Batch">Collect all edit proposals and present together at end of step</action>

</step>

<step n="4" goal="Generate Sprint Change Proposal">
<action>Compile comprehensive Sprint Change Proposal document with following sections:</action>

<action>Section 1: Issue Summary</action>

- Clear problem statement describing what triggered the change
- Context about when/how the issue was discovered
- Evidence or examples demonstrating the issue

<action>Section 2: Impact Analysis</action>

- Epic Impact: Which epics are affected and how
- Story Impact: Current and future stories requiring changes
- Artifact Conflicts: PRD, Architecture, UI/UX documents needing updates
- Technical Impact: Code, infrastructure, or deployment implications

<action>Section 3: Recommended Approach</action>

- Present chosen path forward from checklist evaluation:
  - Direct Adjustment: Modify/add stories within existing plan
  - Potential Rollback: Revert completed work to simplify resolution
  - MVP Review: Reduce scope or modify goals
- Provide clear rationale for recommendation
- Include effort estimate, risk assessment, and timeline impact

<action>Section 4: Detailed Change Proposals</action>

- Include all refined edit proposals from Step 3
- Group by artifact type (Stories, PRD, Architecture, UI/UX)
- Ensure each change includes before/after and justification

<action>Section 5: Implementation Handoff</action>

- Categorize change scope:
  - Minor: Direct implementation by dev team
  - Moderate: Backlog reorganization needed (PO/SM)
  - Major: Fundamental replan required (PM/Architect)
- Specify handoff recipients and their responsibilities
- Define success criteria for implementation

<action>Present complete Sprint Change Proposal to user</action>
<action>Write Sprint Change Proposal document to {default_output_file}</action>
<ask>Review complete proposal. Continue [c] or Edit [e]?</ask>
</step>

<step n="5" goal="Finalize and Route for Implementation">
<action>Get explicit user approval for complete proposal</action>
<ask>Do you approve this Sprint Change Proposal for implementation? (yes/no/revise)</ask>

<check if="no or revise">
  <action>Gather specific feedback on what needs adjustment</action>
  <action>Return to appropriate step to address concerns</action>
  <goto step="3">If changes needed to edit proposals</goto>
  <goto step="4">If changes needed to overall proposal structure</goto>

</check>

<check if="yes the proposal is approved by the user">
  <action>Finalize Sprint Change Proposal document</action>
  <action>Determine change scope classification:</action>

- **Minor**: Can be implemented directly by development team
- **Moderate**: Requires backlog reorganization and PO/SM coordination
- **Major**: Needs fundamental replan with PM/Architect involvement

<action>Provide appropriate handoff based on scope:</action>

</check>

<check if="Minor scope">
  <action>Route to: Development team for direct implementation</action>
  <action>Deliverables: Finalized edit proposals and implementation tasks</action>
</check>

<check if="Moderate scope">
  <action>Route to: Product Owner / Scrum Master agents</action>
  <action>Deliverables: Sprint Change Proposal + backlog reorganization plan</action>
</check>

<check if="Major scope">
  <action>Route to: Product Manager / Solution Architect</action>
  <action>Deliverables: Complete Sprint Change Proposal + escalation notice</action>

<action>Confirm handoff completion and next steps with user</action>
<action>Document handoff in workflow execution log</action>
</check>

</step>

<step n="6" goal="Workflow Completion">
<action>Summarize workflow execution:</action>
  - Issue addressed: {{change_trigger}}
  - Change scope: {{scope_classification}}
  - Artifacts modified: {{list_of_artifacts}}
  - Routed to: {{handoff_recipients}}

<action>Confirm all deliverables produced:</action>

- Sprint Change Proposal document
- Specific edit proposals with before/after
- Implementation handoff plan

<action>Report workflow completion to user with personalized message: "Correct Course workflow complete, {user_name}!"</action>
<action>Remind user of success criteria and next steps for implementation team</action>
</step>

</workflow>

---

# Bundled Reference Assets

The following upstream BMAD files are embedded so this Maestro prompt remains self-contained.

## src/bmm/workflows/4-implementation/correct-course/checklist.md

```md
# Change Navigation Checklist

<critical>This checklist is executed as part of: {project-root}/\_bmad/bmm/workflows/4-implementation/correct-course/workflow.md</critical>
<critical>Work through each section systematically with the user, recording findings and impacts</critical>

<checklist>

<section n="1" title="Understand the Trigger and Context">

<check-item id="1.1">
<prompt>Identify the triggering story that revealed this issue</prompt>
<action>Document story ID and brief description</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="1.2">
<prompt>Define the core problem precisely</prompt>
<action>Categorize issue type:</action>
  - Technical limitation discovered during implementation
  - New requirement emerged from stakeholders
  - Misunderstanding of original requirements
  - Strategic pivot or market change
  - Failed approach requiring different solution
<action>Write clear problem statement</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="1.3">
<prompt>Assess initial impact and gather supporting evidence</prompt>
<action>Collect concrete examples, error messages, stakeholder feedback, or technical constraints</action>
<action>Document evidence for later reference</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<halt-condition>
<action if="trigger is unclear">HALT: "Cannot proceed without understanding what caused the need for change"</action>
<action if="no evidence provided">HALT: "Need concrete evidence or examples of the issue before analyzing impact"</action>
</halt-condition>

</section>

<section n="2" title="Epic Impact Assessment">

<check-item id="2.1">
<prompt>Evaluate current epic containing the trigger story</prompt>
<action>Can this epic still be completed as originally planned?</action>
<action>If no, what modifications are needed?</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="2.2">
<prompt>Determine required epic-level changes</prompt>
<action>Check each scenario:</action>
  - Modify existing epic scope or acceptance criteria
  - Add new epic to address the issue
  - Remove or defer epic that's no longer viable
  - Completely redefine epic based on new understanding
<action>Document specific epic changes needed</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="2.3">
<prompt>Review all remaining planned epics for required changes</prompt>
<action>Check each future epic for impact</action>
<action>Identify dependencies that may be affected</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="2.4">
<prompt>Check if issue invalidates future epics or necessitates new ones</prompt>
<action>Does this change make any planned epics obsolete?</action>
<action>Are new epics needed to address gaps created by this change?</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="2.5">
<prompt>Consider if epic order or priority should change</prompt>
<action>Should epics be resequenced based on this issue?</action>
<action>Do priorities need adjustment?</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

</section>

<section n="3" title="Artifact Conflict and Impact Analysis">

<check-item id="3.1">
<prompt>Check PRD for conflicts</prompt>
<action>Does issue conflict with core PRD goals or objectives?</action>
<action>Do requirements need modification, addition, or removal?</action>
<action>Is the defined MVP still achievable or does scope need adjustment?</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="3.2">
<prompt>Review Architecture document for conflicts</prompt>
<action>Check each area for impact:</action>
  - System components and their interactions
  - Architectural patterns and design decisions
  - Technology stack choices
  - Data models and schemas
  - API designs and contracts
  - Integration points
<action>Document specific architecture sections requiring updates</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="3.3">
<prompt>Examine UI/UX specifications for conflicts</prompt>
<action>Check for impact on:</action>
  - User interface components
  - User flows and journeys
  - Wireframes or mockups
  - Interaction patterns
  - Accessibility considerations
<action>Note specific UI/UX sections needing revision</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="3.4">
<prompt>Consider impact on other artifacts</prompt>
<action>Review additional artifacts for impact:</action>
  - Deployment scripts
  - Infrastructure as Code (IaC)
  - Monitoring and observability setup
  - Testing strategies
  - Documentation
  - CI/CD pipelines
<action>Document any secondary artifacts requiring updates</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

</section>

<section n="4" title="Path Forward Evaluation">

<check-item id="4.1">
<prompt>Evaluate Option 1: Direct Adjustment</prompt>
<action>Can the issue be addressed by modifying existing stories?</action>
<action>Can new stories be added within the current epic structure?</action>
<action>Would this approach maintain project timeline and scope?</action>
<action>Effort estimate: [High/Medium/Low]</action>
<action>Risk level: [High/Medium/Low]</action>
<status>[ ] Viable / [ ] Not viable</status>
</check-item>

<check-item id="4.2">
<prompt>Evaluate Option 2: Potential Rollback</prompt>
<action>Would reverting recently completed stories simplify addressing this issue?</action>
<action>Which stories would need to be rolled back?</action>
<action>Is the rollback effort justified by the simplification gained?</action>
<action>Effort estimate: [High/Medium/Low]</action>
<action>Risk level: [High/Medium/Low]</action>
<status>[ ] Viable / [ ] Not viable</status>
</check-item>

<check-item id="4.3">
<prompt>Evaluate Option 3: PRD MVP Review</prompt>
<action>Is the original PRD MVP still achievable with this issue?</action>
<action>Does MVP scope need to be reduced or redefined?</action>
<action>Do core goals need modification based on new constraints?</action>
<action>What would be deferred to post-MVP if scope is reduced?</action>
<action>Effort estimate: [High/Medium/Low]</action>
<action>Risk level: [High/Medium/Low]</action>
<status>[ ] Viable / [ ] Not viable</status>
</check-item>

<check-item id="4.4">
<prompt>Select recommended path forward</prompt>
<action>Based on analysis of all options, choose the best path</action>
<action>Provide clear rationale considering:</action>
  - Implementation effort and timeline impact
  - Technical risk and complexity
  - Impact on team morale and momentum
  - Long-term sustainability and maintainability
  - Stakeholder expectations and business value
<action>Selected approach: [Option 1 / Option 2 / Option 3 / Hybrid]</action>
<action>Justification: [Document reasoning]</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

</section>

<section n="5" title="Sprint Change Proposal Components">

<check-item id="5.1">
<prompt>Create identified issue summary</prompt>
<action>Write clear, concise problem statement</action>
<action>Include context about discovery and impact</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="5.2">
<prompt>Document epic impact and artifact adjustment needs</prompt>
<action>Summarize findings from Epic Impact Assessment (Section 2)</action>
<action>Summarize findings from Artifact Conflict Analysis (Section 3)</action>
<action>Be specific about what changes are needed and why</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="5.3">
<prompt>Present recommended path forward with rationale</prompt>
<action>Include selected approach from Section 4</action>
<action>Provide complete justification for recommendation</action>
<action>Address trade-offs and alternatives considered</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="5.4">
<prompt>Define PRD MVP impact and high-level action plan</prompt>
<action>State clearly if MVP is affected</action>
<action>Outline major action items needed for implementation</action>
<action>Identify dependencies and sequencing</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="5.5">
<prompt>Establish agent handoff plan</prompt>
<action>Identify which roles/agents will execute the changes:</action>
  - Development team (for implementation)
  - Product Owner / Scrum Master (for backlog changes)
  - Product Manager / Architect (for strategic changes)
<action>Define responsibilities for each role</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

</section>

<section n="6" title="Final Review and Handoff">

<check-item id="6.1">
<prompt>Review checklist completion</prompt>
<action>Verify all applicable sections have been addressed</action>
<action>Confirm all [Action-needed] items have been documented</action>
<action>Ensure analysis is comprehensive and actionable</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="6.2">
<prompt>Verify Sprint Change Proposal accuracy</prompt>
<action>Review complete proposal for consistency and clarity</action>
<action>Ensure all recommendations are well-supported by analysis</action>
<action>Check that proposal is actionable and specific</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="6.3">
<prompt>Obtain explicit user approval</prompt>
<action>Present complete proposal to user</action>
<action>Get clear yes/no approval for proceeding</action>
<action>Document approval and any conditions</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="6.4">
<prompt>Update sprint-status.yaml to reflect approved epic changes</prompt>
<action>If epics were added: Add new epic entries with status 'backlog'</action>
<action>If epics were removed: Remove corresponding entries</action>
<action>If epics were renumbered: Update epic IDs and story references</action>
<action>If stories were added/removed: Update story entries within affected epics</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<check-item id="6.5">
<prompt>Confirm next steps and handoff plan</prompt>
<action>Review handoff responsibilities with user</action>
<action>Ensure all stakeholders understand their roles</action>
<action>Confirm timeline and success criteria</action>
<status>[ ] Done / [ ] N/A / [ ] Action-needed</status>
</check-item>

<halt-condition>
<action if="any critical section cannot be completed">HALT: "Cannot proceed to proposal without complete impact analysis"</action>
<action if="user approval not obtained">HALT: "Must have explicit approval before implementing changes"</action>
<action if="handoff responsibilities unclear">HALT: "Must clearly define who will execute the proposed changes"</action>
</halt-condition>

</section>

</checklist>

<execution-notes>
<note>This checklist is for SIGNIFICANT changes affecting project direction</note>
<note>Work interactively with user - they make final decisions</note>
<note>Be factual, not blame-oriented when analyzing issues</note>
<note>Handle changes professionally as opportunities to improve the project</note>
<note>Maintain conversation context throughout - this is collaborative work</note>
</execution-notes>
```
