---
name: bmad-create-story
description: 'Creates a dedicated story file with all the context the agent will need to implement it later. Use when the user says "create the next story" or "create story [story identifier]"'
---

# Create Story Workflow

**Goal:** Create a comprehensive story file that gives the dev agent everything needed for flawless implementation.

**Your Role:** Story context engine that prevents LLM developer mistakes, omissions, or disasters.

- Communicate all responses in {communication_language} and generate all documents in {document_output_language}
- Your purpose is NOT to copy from epics - it's to create a comprehensive, optimized story file that gives the DEV agent EVERYTHING needed for flawless implementation
- COMMON LLM MISTAKES TO PREVENT: reinventing wheels, wrong libraries, wrong file locations, breaking regressions, ignoring UX, vague implementations, lying about completion, not learning from past work
- EXHAUSTIVE ANALYSIS REQUIRED: You must thoroughly analyze ALL artifacts to extract critical context - do NOT be lazy or skim! This is the most important function in the entire development process!
- UTILIZE SUBPROCESSES AND SUBAGENTS: Use research subagents, subprocesses or parallel processing if available to thoroughly analyze different artifacts simultaneously and thoroughly
- SAVE QUESTIONS: If you think of questions or clarifications during analysis, save them for the end after the complete story is written
- ZERO USER INTERVENTION: Process should be fully automated except for initial epic/story selection or missing documents

---

## INITIALIZATION

### Configuration Loading

Load config from `{project-root}/_bmad/bmm/config.yaml` and resolve:

- `project_name`, `user_name`
- `communication_language`, `document_output_language`
- `user_skill_level`
- `planning_artifacts`, `implementation_artifacts`
- `date` as system-generated current datetime

### Paths

- `installed_path` = `.`
- `template` = `./template.md`
- `validation` = `./checklist.md`
- `sprint_status` = `{implementation_artifacts}/sprint-status.yaml`
- `epics_file` = `{planning_artifacts}/epics.md`
- `prd_file` = `{planning_artifacts}/prd.md`
- `architecture_file` = `{planning_artifacts}/architecture.md`
- `ux_file` = `{planning_artifacts}/*ux*.md`
- `story_title` = "" (will be elicited if not derivable)
- `project_context` = `**/project-context.md` (load if exists)
- `default_output_file` = `{implementation_artifacts}/{{story_key}}.md`

### Input Files

| Input        | Description                                                        | Path Pattern(s)                                                                                      | Load Strategy  |
| ------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------- |
| prd          | PRD (fallback - epics file should have most content)               | whole: `{planning_artifacts}/*prd*.md`, sharded: `{planning_artifacts}/*prd*/*.md`                   | SELECTIVE_LOAD |
| architecture | Architecture (fallback - epics file should have relevant sections) | whole: `{planning_artifacts}/*architecture*.md`, sharded: `{planning_artifacts}/*architecture*/*.md` | SELECTIVE_LOAD |
| ux           | UX design (fallback - epics file should have relevant sections)    | whole: `{planning_artifacts}/*ux*.md`, sharded: `{planning_artifacts}/*ux*/*.md`                     | SELECTIVE_LOAD |
| epics        | Enhanced epics+stories file with BDD and source hints              | whole: `{planning_artifacts}/*epic*.md`, sharded: `{planning_artifacts}/*epic*/*.md`                 | SELECTIVE_LOAD |

---

## EXECUTION

<workflow>

<step n="1" goal="Determine target story">
  <check if="{{story_path}} is provided by user or user provided the epic and story number such as 2-4 or 1.6 or epic 1 story 5">
    <action>Parse user-provided story path: extract epic_num, story_num, story_title from format like "1-2-user-auth"</action>
    <action>Set {{epic_num}}, {{story_num}}, {{story_key}} from user input</action>
    <action>GOTO step 2a</action>
  </check>

<action>Check if {{sprint_status}} file exists for auto discover</action>
<check if="sprint status file does NOT exist">
<output>🚫 No sprint status file found and no story specified</output>
<output>
**Required Options:** 1. Run `sprint-planning` to initialize sprint tracking (recommended) 2. Provide specific epic-story number to create (e.g., "1-2-user-auth") 3. Provide path to story documents if sprint status doesn't exist yet
</output>
<ask>Choose option [1], provide epic-story number, path to story docs, or [q] to quit:</ask>

    <check if="user chooses 'q'">
      <action>HALT - No work needed</action>
    </check>

    <check if="user chooses '1'">
      <output>Run sprint-planning workflow first to create sprint-status.yaml</output>
      <action>HALT - User needs to run sprint-planning</action>
    </check>

    <check if="user provides epic-story number">
      <action>Parse user input: extract epic_num, story_num, story_title</action>
      <action>Set {{epic_num}}, {{story_num}}, {{story_key}} from user input</action>
      <action>GOTO step 2a</action>
    </check>

    <check if="user provides story docs path">
      <action>Use user-provided path for story documents</action>
      <action>GOTO step 2a</action>
    </check>

  </check>

  <!-- Auto-discover from sprint status only if no user input -->
  <check if="no user input provided">
    <critical>MUST read COMPLETE {sprint_status} file from start to end to preserve order</critical>
    <action>Load the FULL file: {{sprint_status}}</action>
    <action>Read ALL lines from beginning to end - do not skip any content</action>
    <action>Parse the development_status section completely</action>

    <action>Find the FIRST story (by reading in order from top to bottom) where:
      - Key matches pattern: number-number-name (e.g., "1-2-user-auth")
      - NOT an epic key (epic-X) or retrospective (epic-X-retrospective)
      - Status value equals "backlog"
    </action>

    <check if="no backlog story found">
      <output>📋 No backlog stories found in sprint-status.yaml

        All stories are either already created, in progress, or done.

        **Options:**
        1. Run sprint-planning to refresh story tracking
        2. Load PM agent and run correct-course to add more stories
        3. Check if current sprint is complete and run retrospective
      </output>
      <action>HALT</action>
    </check>

    <action>Extract from found story key (e.g., "1-2-user-authentication"):
      - epic_num: first number before dash (e.g., "1")
      - story_num: second number after first dash (e.g., "2")
      - story_title: remainder after second dash (e.g., "user-authentication")
    </action>
    <action>Set {{story_id}} = "{{epic_num}}.{{story_num}}"</action>
    <action>Store story_key for later use (e.g., "1-2-user-authentication")</action>

    <!-- Mark epic as in-progress if this is first story -->
    <action>Check if this is the first story in epic {{epic_num}} by looking for {{epic_num}}-1-* pattern</action>
    <check if="this is first story in epic {{epic_num}}">
      <action>Load {{sprint_status}} and check epic-{{epic_num}} status</action>
      <action>If epic status is "backlog" → update to "in-progress"</action>
      <action>If epic status is "contexted" (legacy status) → update to "in-progress" (backward compatibility)</action>
      <action>If epic status is "in-progress" → no change needed</action>
      <check if="epic status is 'done'">
        <output>🚫 ERROR: Cannot create story in completed epic</output>
        <output>Epic {{epic_num}} is marked as 'done'. All stories are complete.</output>
        <output>If you need to add more work, either:</output>
        <output>1. Manually change epic status back to 'in-progress' in sprint-status.yaml</output>
        <output>2. Create a new epic for additional work</output>
        <action>HALT - Cannot proceed</action>
      </check>
      <check if="epic status is not one of: backlog, contexted, in-progress, done">
        <output>🚫 ERROR: Invalid epic status '{{epic_status}}'</output>
        <output>Epic {{epic_num}} has invalid status. Expected: backlog, in-progress, or done</output>
        <output>Please fix sprint-status.yaml manually or run sprint-planning to regenerate</output>
        <action>HALT - Cannot proceed</action>
      </check>
      <output>📊 Epic {{epic_num}} status updated to in-progress</output>
    </check>

    <action>GOTO step 2a</action>

  </check>
</step>

<step n="2" goal="Load and analyze core artifacts">
  <critical>🔬 EXHAUSTIVE ARTIFACT ANALYSIS - This is where you prevent future developer fuckups!</critical>

  <!-- Load all available content through discovery protocol -->

<action>Read fully and follow `{installed_path}/discover-inputs.md` to load all input files</action>
<note>Available content: {epics_content}, {prd_content}, {architecture_content}, {ux_content},
{project_context}</note>

  <!-- Analyze epics file for story foundation -->

<action>From {epics_content}, extract Epic {{epic_num}} complete context:</action> **EPIC ANALYSIS:** - Epic
objectives and business value - ALL stories in this epic for cross-story context - Our specific story's requirements, user story
statement, acceptance criteria - Technical requirements and constraints - Dependencies on other stories/epics - Source hints pointing to
original documents <!-- Extract specific story requirements -->
<action>Extract our story ({{epic_num}}-{{story_num}}) details:</action> **STORY FOUNDATION:** - User story statement
(As a, I want, so that) - Detailed acceptance criteria (already BDD formatted) - Technical requirements specific to this story -
Business context and value - Success criteria <!-- Previous story analysis for context continuity -->
<check if="story_num > 1">
<action>Find {{previous_story_num}}: scan {implementation_artifacts} for the story file in epic {{epic_num}} with the highest story number less than {{story_num}}</action>
<action>Load previous story file: {implementation_artifacts}/{{epic_num}}-{{previous_story_num}}-\*.md</action> **PREVIOUS STORY INTELLIGENCE:** -
Dev notes and learnings from previous story - Review feedback and corrections needed - Files that were created/modified and their
patterns - Testing approaches that worked/didn't work - Problems encountered and solutions found - Code patterns established <action>Extract
all learnings that could impact current story implementation</action>
</check>

  <!-- Git intelligence for previous work patterns -->

<check
    if="previous story exists AND git repository detected">
<action>Get last 5 commit titles to understand recent work patterns</action>
<action>Analyze 1-5 most recent commits for relevance to current story: - Files created/modified - Code patterns and conventions used - Library dependencies added/changed - Architecture decisions implemented - Testing approaches used
</action>
<action>Extract actionable insights for current story implementation</action>
</check>
</step>

<step n="3" goal="Architecture analysis for developer guardrails">
  <critical>🏗️ ARCHITECTURE INTELLIGENCE - Extract everything the developer MUST follow!</critical> **ARCHITECTURE DOCUMENT ANALYSIS:** <action>Systematically
  analyze architecture content for story-relevant requirements:</action>

  <!-- Load architecture - single file or sharded -->
  <check if="architecture file is single file">
    <action>Load complete {architecture_content}</action>
  </check>
  <check if="architecture is sharded to folder">
    <action>Load architecture index and scan all architecture files</action>
  </check> **CRITICAL ARCHITECTURE EXTRACTION:** <action>For
  each architecture section, determine if relevant to this story:</action> - **Technical Stack:** Languages, frameworks, libraries with
  versions - **Code Structure:** Folder organization, naming conventions, file patterns - **API Patterns:** Service structure, endpoint
  patterns, data contracts - **Database Schemas:** Tables, relationships, constraints relevant to story - **Security Requirements:**
  Authentication patterns, authorization rules - **Performance Requirements:** Caching strategies, optimization patterns - **Testing
  Standards:** Testing frameworks, coverage expectations, test patterns - **Deployment Patterns:** Environment configurations, build
  processes - **Integration Patterns:** External service integrations, data flows <action>Extract any story-specific requirements that the
  developer MUST follow</action>
  <action>Identify any architectural decisions that override previous patterns</action>
</step>

<step n="4" goal="Web research for latest technical specifics">
  <critical>🌐 ENSURE LATEST TECH KNOWLEDGE - Prevent outdated implementations!</critical> **WEB INTELLIGENCE:** <action>Identify specific
  technical areas that require latest version knowledge:</action>

  <!-- Check for libraries/frameworks mentioned in architecture -->

<action>From architecture analysis, identify specific libraries, APIs, or
frameworks</action>
<action>For each critical technology, research latest stable version and key changes: - Latest API documentation and breaking changes - Security vulnerabilities or updates - Performance improvements or deprecations - Best practices for current version
</action>
**EXTERNAL CONTEXT INCLUSION:** <action>Include in story any critical latest information the developer needs: - Specific library versions and why chosen - API endpoints with parameters and authentication - Recent security patches or considerations - Performance optimization techniques - Migration considerations if upgrading
</action>
</step>

<step n="5" goal="Create comprehensive story file">
  <critical>📝 CREATE ULTIMATE STORY FILE - The developer's master implementation guide!</critical>

<action>Initialize from template.md:
{default_output_file}</action>
<template-output file="{default_output_file}">story_header</template-output>

  <!-- Story foundation from epics analysis -->

<template-output
    file="{default_output_file}">story_requirements</template-output>

  <!-- Developer context section - MOST IMPORTANT PART -->
  <template-output file="{default_output_file}">
  developer_context_section</template-output> **DEV AGENT GUARDRAILS:** <template-output file="{default_output_file}">
  technical_requirements</template-output>
  <template-output file="{default_output_file}">architecture_compliance</template-output>
  <template-output
    file="{default_output_file}">library_framework_requirements</template-output>
  <template-output file="{default_output_file}">
  file_structure_requirements</template-output>
  <template-output file="{default_output_file}">testing_requirements</template-output>

  <!-- Previous story intelligence -->

<check
    if="previous story learnings available">
<template-output file="{default_output_file}">previous_story_intelligence</template-output>
</check>

  <!-- Git intelligence -->

<check
    if="git analysis completed">
<template-output file="{default_output_file}">git_intelligence_summary</template-output>
</check>

  <!-- Latest technical specifics -->
  <check if="web research completed">
    <template-output file="{default_output_file}">latest_tech_information</template-output>
  </check>

  <!-- Project context reference -->

<template-output
    file="{default_output_file}">project_context_reference</template-output>

  <!-- Final status update -->
  <template-output file="{default_output_file}">
  story_completion_status</template-output>

  <!-- CRITICAL: Set status to ready-for-dev -->

<action>Set story Status to: "ready-for-dev"</action>
<action>Add completion note: "Ultimate
context engine analysis completed - comprehensive developer guide created"</action>
</step>

<step n="6" goal="Update sprint status and finalize">
  <action>Validate the newly created story file {story_file} against {installed_path}/checklist.md and apply any required fixes before finalizing</action>
  <action>Save story document unconditionally</action>

  <!-- Update sprint status -->
  <check if="sprint status file exists">
    <action>Update {{sprint_status}}</action>
    <action>Load the FULL file and read all development_status entries</action>
    <action>Find development_status key matching {{story_key}}</action>
    <action>Verify current status is "backlog" (expected previous state)</action>
    <action>Update development_status[{{story_key}}] = "ready-for-dev"</action>
    <action>Update last_updated field to current date</action>
    <action>Save file, preserving ALL comments and structure including STATUS DEFINITIONS</action>
  </check>

<action>Report completion</action>
<output>**🎯 ULTIMATE BMad Method STORY CONTEXT CREATED, {user_name}!**

    **Story Details:**
    - Story ID: {{story_id}}
    - Story Key: {{story_key}}
    - File: {{story_file}}
    - Status: ready-for-dev

    **Next Steps:**
    1. Review the comprehensive story in {{story_file}}
    2. Run dev agents `dev-story` for optimized implementation
    3. Run `code-review` when complete (auto-marks done)
    4. Optional: If Test Architect module installed, run `/bmad:tea:automate` after `dev-story` to generate guardrail tests

    **The developer now has everything needed for flawless implementation!**

  </output>
</step>

</workflow>

---

# Bundled Reference Assets

The following upstream BMAD files are embedded so this Maestro prompt remains self-contained.

## src/bmm/workflows/4-implementation/bmad-create-story/template.md

```md
# Story {{epic_num}}.{{story_num}}: {{story_title}}

Status: ready-for-dev

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a {{role}},
I want {{action}},
so that {{benefit}}.

## Acceptance Criteria

1. [Add acceptance criteria from epics/PRD]

## Tasks / Subtasks

- [ ] Task 1 (AC: #)
  - [ ] Subtask 1.1
- [ ] Task 2 (AC: #)
  - [ ] Subtask 2.1

## Dev Notes

- Relevant architecture patterns and constraints
- Source tree components to touch
- Testing standards summary

### Project Structure Notes

- Alignment with unified project structure (paths, modules, naming)
- Detected conflicts or variances (with rationale)

### References

- Cite all technical details with source paths and sections, e.g. [Source: docs/<file>.md#Section]

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
```

## src/bmm/workflows/4-implementation/bmad-create-story/checklist.md

```md
# 🎯 Story Context Quality Competition Prompt

## **🔥 CRITICAL MISSION: Outperform and Fix the Original Create-Story LLM**

You are an independent quality validator in a **FRESH CONTEXT**. Your mission is to **thoroughly review** a story file that was generated by the create-story workflow and **systematically identify any mistakes, omissions, or disasters** that the original LLM missed.

**Your purpose is NOT just to validate - it's to FIX and PREVENT LLM developer mistakes, omissions, or disasters!**

### **🚨 CRITICAL MISTAKES TO PREVENT:**

- **Reinventing wheels** - Creating duplicate functionality instead of reusing existing
- **Wrong libraries** - Using incorrect frameworks, versions, or dependencies
- **Wrong file locations** - Violating project structure and organization
- **Breaking regressions** - Implementing changes that break existing functionality
- **Ignoring UX** - Not following user experience design requirements
- **Vague implementations** - Creating unclear, ambiguous implementations
- **Lying about completion** - Implementing incorrectly or incompletely
- **Not learning from past work** - Ignoring previous story learnings and patterns

### **🚨 EXHAUSTIVE ANALYSIS REQUIRED:**

You must thoroughly analyze **ALL artifacts** to extract critical context - do NOT be lazy or skim! This is the most important quality control function in the entire development process!

### **🔬 UTILIZE SUBPROCESSES AND SUBAGENTS:**

Use research subagents, subprocesses, or parallel processing if available to thoroughly analyze different artifacts **simultaneously and thoroughly**. Leave no stone unturned!

### **🎯 COMPETITIVE EXCELLENCE:**

This is a COMPETITION to create the **ULTIMATE story context** that makes LLM developer mistakes **IMPOSSIBLE**!

## **🚀 HOW TO USE THIS CHECKLIST**

### **When Running from Create-Story Workflow:**

- The workflow framework will automatically:
  - Load this checklist file
  - Load the newly created story file (`{story_file_path}`)
  - Load workflow variables from `{installed_path}/workflow.md`
  - Execute the validation process

### **When Running in Fresh Context:**

- User should provide the story file path being reviewed
- Load the story file directly
- Load the corresponding workflow.md for variable context
- Proceed with systematic analysis

### **Required Inputs:**

- **Story file**: The story file to review and improve
- **Workflow variables**: From workflow.md (implementation_artifacts, epics_file, etc.)
- **Source documents**: Epics, architecture, etc. (discovered or provided)
- **Validation framework**: The workflow's checklist execution system

---

## **🔬 SYSTEMATIC RE-ANALYSIS APPROACH**

You will systematically re-do the entire story creation process, but with a critical eye for what the original LLM might have missed:

### **Step 1: Load and Understand the Target**

1. **Load the workflow configuration**: `{installed_path}/workflow.md` for variable inclusion
2. **Load the story file**: `{story_file_path}` (provided by user or discovered)
3. **Extract metadata**: epic_num, story_num, story_key, story_title from story file
4. **Resolve all workflow variables**: implementation_artifacts, epics_file, architecture_file, etc.
5. **Understand current status**: What story implementation guidance is currently provided?

**Note:** If running in fresh context, user should provide the story file path being reviewed. If running from create-story workflow, the validation framework will automatically discover the checklist and story file.

### **Step 2: Exhaustive Source Document Analysis**

**🔥 CRITICAL: Treat this like YOU are creating the story from scratch to PREVENT DISASTERS!**
**Discover everything the original LLM missed that could cause developer mistakes, omissions, or disasters!**

#### **2.1 Epics and Stories Analysis**

- Load `{epics_file}` (or sharded equivalents)
- Extract **COMPLETE Epic {{epic_num}} context**:
  - Epic objectives and business value
  - ALL stories in this epic (for cross-story context)
  - Our specific story's requirements, acceptance criteria
  - Technical requirements and constraints
  - Cross-story dependencies and prerequisites

#### **2.2 Architecture Deep-Dive**

- Load `{architecture_file}` (single or sharded)
- **Systematically scan for ANYTHING relevant to this story:**
  - Technical stack with versions (languages, frameworks, libraries)
  - Code structure and organization patterns
  - API design patterns and contracts
  - Database schemas and relationships
  - Security requirements and patterns
  - Performance requirements and optimization strategies
  - Testing standards and frameworks
  - Deployment and environment patterns
  - Integration patterns and external services

#### **2.3 Previous Story Intelligence (if applicable)**

- If `story_num > 1`, load the previous story file
- Extract **actionable intelligence**:
  - Dev notes and learnings
  - Review feedback and corrections needed
  - Files created/modified and their patterns
  - Testing approaches that worked/didn't work
  - Problems encountered and solutions found
  - Code patterns and conventions established

#### **2.4 Git History Analysis (if available)**

- Analyze recent commits for patterns:
  - Files created/modified in previous work
  - Code patterns and conventions used
  - Library dependencies added/changed
  - Architecture decisions implemented
  - Testing approaches used

#### **2.5 Latest Technical Research**

- Identify any libraries/frameworks mentioned
- Research latest versions and critical information:
  - Breaking changes or security updates
  - Performance improvements or deprecations
  - Best practices for current versions

### **Step 3: Disaster Prevention Gap Analysis**

**🚨 CRITICAL: Identify every mistake the original LLM missed that could cause DISASTERS!**

#### **3.1 Reinvention Prevention Gaps**

- **Wheel reinvention:** Areas where developer might create duplicate functionality
- **Code reuse opportunities** not identified that could prevent redundant work
- **Existing solutions** not mentioned that developer should extend instead of replace

#### **3.2 Technical Specification DISASTERS**

- **Wrong libraries/frameworks:** Missing version requirements that could cause compatibility issues
- **API contract violations:** Missing endpoint specifications that could break integrations
- **Database schema conflicts:** Missing requirements that could corrupt data
- **Security vulnerabilities:** Missing security requirements that could expose the system
- **Performance disasters:** Missing requirements that could cause system failures

#### **3.3 File Structure DISASTERS**

- **Wrong file locations:** Missing organization requirements that could break build processes
- **Coding standard violations:** Missing conventions that could create inconsistent codebase
- **Integration pattern breaks:** Missing data flow requirements that could cause system failures
- **Deployment failures:** Missing environment requirements that could prevent deployment

#### **3.4 Regression DISASTERS**

- **Breaking changes:** Missing requirements that could break existing functionality
- **Test failures:** Missing test requirements that could allow bugs to reach production
- **UX violations:** Missing user experience requirements that could ruin the product
- **Learning failures:** Missing previous story context that could repeat same mistakes

#### **3.5 Implementation DISASTERS**

- **Vague implementations:** Missing details that could lead to incorrect or incomplete work
- **Completion lies:** Missing acceptance criteria that could allow fake implementations
- **Scope creep:** Missing boundaries that could cause unnecessary work
- **Quality failures:** Missing quality requirements that could deliver broken features

### **Step 4: LLM-Dev-Agent Optimization Analysis**

**CRITICAL STEP: Optimize story context for LLM developer agent consumption**

**Analyze current story for LLM optimization issues:**

- **Verbosity problems:** Excessive detail that wastes tokens without adding value
- **Ambiguity issues:** Vague instructions that could lead to multiple interpretations
- **Context overload:** Too much information not directly relevant to implementation
- **Missing critical signals:** Key requirements buried in verbose text
- **Poor structure:** Information not organized for efficient LLM processing

**Apply LLM Optimization Principles:**

- **Clarity over verbosity:** Be precise and direct, eliminate fluff
- **Actionable instructions:** Every sentence should guide implementation
- **Scannable structure:** Use clear headings, bullet points, and emphasis
- **Token efficiency:** Pack maximum information into minimum text
- **Unambiguous language:** Clear requirements with no room for interpretation

### **Step 5: Improvement Recommendations**

**For each gap identified, provide specific, actionable improvements:**

#### **5.1 Critical Misses (Must Fix)**

- Missing essential technical requirements
- Missing previous story context that could cause errors
- Missing anti-pattern prevention that could lead to duplicate code
- Missing security or performance requirements

#### **5.2 Enhancement Opportunities (Should Add)**

- Additional architectural guidance that would help developer
- More detailed technical specifications
- Better code reuse opportunities
- Enhanced testing guidance

#### **5.3 Optimization Suggestions (Nice to Have)**

- Performance optimization hints
- Additional context for complex scenarios
- Enhanced debugging or development tips

#### **5.4 LLM Optimization Improvements**

- Token-efficient phrasing of existing content
- Clearer structure for LLM processing
- More actionable and direct instructions
- Reduced verbosity while maintaining completeness

---

## **🎯 COMPETITION SUCCESS METRICS**

**You WIN against the original LLM if you identify:**

### **Category 1: Critical Misses (Blockers)**

- Essential technical requirements the developer needs but aren't provided
- Previous story learnings that would prevent errors if ignored
- Anti-pattern prevention that would prevent code duplication
- Security or performance requirements that must be followed

### **Category 2: Enhancement Opportunities**

- Architecture guidance that would significantly help implementation
- Technical specifications that would prevent wrong approaches
- Code reuse opportunities the developer should know about
- Testing guidance that would improve quality

### **Category 3: Optimization Insights**

- Performance or efficiency improvements
- Development workflow optimizations
- Additional context for complex scenarios

---

## **📋 INTERACTIVE IMPROVEMENT PROCESS**

After completing your systematic analysis, present your findings to the user interactively:

### **Step 5: Present Improvement Suggestions**
```

🎯 **STORY CONTEXT QUALITY REVIEW COMPLETE**

**Story:** {{story_key}} - {{story_title}}

I found {{critical_count}} critical issues, {{enhancement_count}} enhancements, and {{optimization_count}} optimizations.

## **🚨 CRITICAL ISSUES (Must Fix)**

{{list each critical issue with clear, actionable description}}

## **⚡ ENHANCEMENT OPPORTUNITIES (Should Add)**

{{list each enhancement with clear benefit description}}

## **✨ OPTIMIZATIONS (Nice to Have)**

{{list each optimization with benefit description}}

## **🤖 LLM OPTIMIZATION (Token Efficiency & Clarity)**

{{list each LLM optimization that will improve dev agent performance:

- Reduce verbosity while maintaining completeness
- Improve structure for better LLM processing
- Make instructions more actionable and direct
- Enhance clarity and reduce ambiguity}}

```

### **Step 6: Interactive User Selection**

After presenting the suggestions, ask the user:

```

**IMPROVEMENT OPTIONS:**

Which improvements would you like me to apply to the story?

**Select from the numbered list above, or choose:**

- **all** - Apply all suggested improvements
- **critical** - Apply only critical issues
- **select** - I'll choose specific numbers
- **none** - Keep story as-is
- **details** - Show me more details about any suggestion

Your choice:

```

### **Step 7: Apply Selected Improvements**

When user accepts improvements:

- **Load the story file**
- **Apply accepted changes** (make them look natural, as if they were always there)
- **DO NOT reference** the review process, original LLM, or that changes were "added" or "enhanced"
- **Ensure clean, coherent final story** that reads as if it was created perfectly the first time

### **Step 8: Confirmation**

After applying changes:

```

✅ **STORY IMPROVEMENTS APPLIED**

Updated {{count}} sections in the story file.

The story now includes comprehensive developer guidance to prevent common implementation issues and ensure flawless execution.

**Next Steps:**

1. Review the updated story
2. Run `dev-story` for implementation

```

---

## **💪 COMPETITIVE EXCELLENCE MINDSET**

**Your goal:** Improve the story file with dev agent needed context that makes flawless implementation inevitable while being optimized for LLM developer agent consumption. Remember the dev agent will ONLY have this file to use.

**Success Criteria:** The LLM developer agent that processes your improved story will have:

- ✅ Clear technical requirements they must follow
- ✅ Previous work context they can build upon
- ✅ Anti-pattern prevention to avoid common mistakes
- ✅ Comprehensive guidance for efficient implementation
- ✅ **Optimized content structure** for maximum clarity and minimum token waste
- ✅ **Actionable instructions** with no ambiguity or verbosity
- ✅ **Efficient information density** - maximum guidance in minimum text

**Every improvement should make it IMPOSSIBLE for the developer to:**

- Reinvent existing solutions
- Use wrong approaches or libraries
- Create duplicate functionality
- Miss critical requirements
- Make implementation errors

**LLM Optimization Should Make it IMPOSSIBLE for the developer agent to:**

- Misinterpret requirements due to ambiguity
- Waste tokens on verbose, non-actionable content
- Struggle to find critical information buried in text
- Get confused by poor structure or organization
- Miss key implementation signals due to inefficient communication

**Go create the ultimate developer implementation guide! 🚀**
```

## src/bmm/workflows/4-implementation/bmad-create-story/discover-inputs.md

```md
# Discover Inputs Protocol

**Objective:** Intelligently load project files (whole or sharded) based on the workflow's Input Files configuration.

**Prerequisite:** Only execute this protocol if the workflow defines an Input Files section. If no input file patterns are configured, skip this entirely.

---

## Step 1: Parse Input File Patterns

- Read the Input Files table from the workflow configuration.
- For each input group (prd, architecture, epics, ux, etc.), note the **load strategy** if specified.

## Step 2: Load Files Using Smart Strategies

For each pattern in the Input Files table, work through the following substeps in order:

### 2a: Try Sharded Documents First

If a sharded pattern exists for this input, determine the load strategy (defaults to **FULL_LOAD** if not specified), then apply the matching strategy:

#### FULL_LOAD Strategy

Load ALL files in the sharded directory. Use this for PRD, Architecture, UX, brownfield docs, or whenever the full picture is needed.

1. Use the glob pattern to find ALL `.md` files (e.g., `{planning_artifacts}/*architecture*/*.md`).
2. Load EVERY matching file completely.
3. Concatenate content in logical order: `index.md` first if it exists, then alphabetical.
4. Store the combined result in a variable named `{pattern_name_content}` (e.g., `{architecture_content}`).

#### SELECTIVE_LOAD Strategy

Load a specific shard using a template variable. Example: used for epics with `{{epic_num}}`.

1. Check for template variables in the sharded pattern (e.g., `{{epic_num}}`).
2. If the variable is undefined, ask the user for the value OR infer it from context.
3. Resolve the template to a specific file path.
4. Load that specific file.
5. Store in variable: `{pattern_name_content}`.

#### INDEX_GUIDED Strategy

Load index.md, analyze the structure and description of each doc in the index, then intelligently load relevant docs.

**DO NOT BE LAZY** -- use best judgment to load documents that might have relevant information, even if there is only a 5% chance of relevance.

1. Load `index.md` from the sharded directory.
2. Parse the table of contents, links, and section headers.
3. Analyze the workflow's purpose and objective.
4. Identify which linked/referenced documents are likely relevant.
   - _Example:_ If the workflow is about authentication and the index shows "Auth Overview", "Payment Setup", "Deployment" -- load the auth docs, consider deployment docs, skip payment.
5. Load all identified relevant documents.
6. Store combined content in variable: `{pattern_name_content}`.

**When in doubt, LOAD IT** -- context is valuable, and being thorough is better than missing critical info.

---

After applying the matching strategy, mark the pattern as **RESOLVED** and move to the next pattern.

### 2b: Try Whole Document if No Sharded Found

If no sharded matches were found OR no sharded pattern exists for this input:

1. Attempt a glob match on the "whole" pattern (e.g., `{planning_artifacts}/*prd*.md`).
2. If matches are found, load ALL matching files completely (no offset/limit).
3. Store content in variable: `{pattern_name_content}` (e.g., `{prd_content}`).
4. Mark pattern as **RESOLVED** and move to the next pattern.

### 2c: Handle Not Found

If no matches were found for either sharded or whole patterns:

1. Set `{pattern_name_content}` to empty string.
2. Note in session: "No {pattern_name} files found" -- this is not an error, just unavailable. Offer the user a chance to provide the file.

## Step 3: Report Discovery Results

List all loaded content variables with file counts. Example:
```

OK Loaded {prd_content} from 5 sharded files: prd/index.md, prd/requirements.md, ...
OK Loaded {architecture_content} from 1 file: Architecture.md
OK Loaded {epics_content} from selective load: epics/epic-3.md
-- No ux_design files found

```

This gives the workflow transparency into what context is available.
```
