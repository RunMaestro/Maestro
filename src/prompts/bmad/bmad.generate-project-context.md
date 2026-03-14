---
name: generate-project-context
description: 'Create project-context.md with AI rules. Use when the user says "generate project context" or "create project context"'
---

# Generate Project Context Workflow

**Goal:** Create a concise, optimized `project-context.md` file containing critical rules, patterns, and guidelines that AI agents must follow when implementing code. This file focuses on unobvious details that LLMs need to be reminded of.

**Your Role:** You are a technical facilitator working with a peer to capture the essential implementation rules that will ensure consistent, high-quality code generation across all AI agents working on the project.

---

## WORKFLOW ARCHITECTURE

This uses **micro-file architecture** for disciplined execution:

- Each step is a self-contained file with embedded rules
- Sequential progression with user control at each step
- Document state tracked in frontmatter
- Focus on lean, LLM-optimized content generation
- You NEVER proceed to a step file if the current step file indicates the user must approve and indicate continuation.

---

## INITIALIZATION

### Configuration Loading

Load config from `{project-root}/_bmad/bmm/config.yaml` and resolve:

- `project_name`, `output_folder`, `user_name`
- `communication_language`, `document_output_language`, `user_skill_level`
- `date` as system-generated current datetime
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`
- ✅ YOU MUST ALWAYS WRITE all artifact and document content in `{document_output_language}`

### Paths

- `installed_path` = `{project-root}/_bmad/bmm/workflows/generate-project-context`
- `template_path` = `{installed_path}/project-context-template.md`
- `output_file` = `{output_folder}/project-context.md`

---

## EXECUTION

Load and execute `{project-root}/_bmad/bmm/workflows/generate-project-context/steps/step-01-discover.md` to begin the workflow.

**Note:** Input document discovery and initialization protocols are handled in step-01-discover.md.

---

# Bundled Reference Assets

The following upstream BMAD files are embedded so this Maestro prompt remains self-contained.

## src/bmm/workflows/generate-project-context/project-context-template.md

```md
---
project_name: '{{project_name}}'
user_name: '{{user_name}}'
date: '{{date}}'
sections_completed: ['technology_stack']
existing_patterns_found: { { number_of_patterns_discovered } }
---

# Project Context for AI Agents

_This file contains critical rules and patterns that AI agents must follow when implementing code in this project. Focus on unobvious details that agents might otherwise miss._

---

## Technology Stack & Versions

_Documented after discovery phase_

## Critical Implementation Rules

_Documented after discovery phase_
```

## src/bmm/workflows/generate-project-context/steps/step-01-discover.md

```md
# Step 1: Context Discovery & Initialization

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input
- ✅ ALWAYS treat this as collaborative discovery between technical peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on discovering existing project context and technology stack
- 🎯 IDENTIFY critical implementation rules that AI agents need
- ⚠️ ABSOLUTELY NO TIME ESTIMATES - AI development speed has fundamentally changed
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 📖 Read existing project files to understand current context
- 💾 Initialize document and update frontmatter
- 🚫 FORBIDDEN to load next step until discovery is complete

## CONTEXT BOUNDARIES:

- Variables from workflow.md are available in memory
- Focus on existing project files and architecture decisions
- Look for patterns, conventions, and unique requirements
- Prioritize rules that prevent implementation mistakes

## YOUR TASK:

Discover the project's technology stack, existing patterns, and critical implementation rules that AI agents must follow when writing code.

## DISCOVERY SEQUENCE:

### 1. Check for Existing Project Context

First, check if project context already exists:

- Look for file at `{project_knowledge}/project-context.md or {project-root}/**/project-context.md`
- If exists: Read complete file to understand existing rules
- Present to user: "Found existing project context with {number_of_sections} sections. Would you like to update this or create a new one?"

### 2. Discover Project Technology Stack

Load and analyze project files to identify technologies:

**Architecture Document:**

- Look for `{planning_artifacts}/architecture.md`
- Extract technology choices with specific versions
- Note architectural decisions that affect implementation

**Package Files:**

- Check for `package.json`, `requirements.txt`, `Cargo.toml`, etc.
- Extract exact versions of all dependencies
- Note development vs production dependencies

**Configuration Files:**

- Look for project language specific configs ( example: `tsconfig.json`)
- Build tool configs (webpack, vite, next.config.js, etc.)
- Linting and formatting configs (.eslintrc, .prettierrc, etc.)
- Testing configurations (jest.config.js, vitest.config.ts, etc.)

### 3. Identify Existing Code Patterns

Search through existing codebase for patterns:

**Naming Conventions:**

- File naming patterns (PascalCase, kebab-case, etc.)
- Component/function naming conventions
- Variable naming patterns
- Test file naming patterns

**Code Organization:**

- How components are structured
- Where utilities and helpers are placed
- How services are organized
- Test organization patterns

**Documentation Patterns:**

- Comment styles and conventions
- Documentation requirements
- README and API doc patterns

### 4. Extract Critical Implementation Rules

Look for rules that AI agents might miss:

**Language-Specific Rules:**

- TypeScript strict mode requirements
- Import/export conventions
- Async/await vs Promise usage patterns
- Error handling patterns specific to the language

**Framework-Specific Rules:**

- React hooks usage patterns
- API route conventions
- Middleware usage patterns
- State management patterns

**Testing Rules:**

- Test structure requirements
- Mock usage conventions
- Integration vs unit test boundaries
- Coverage requirements

**Development Workflow Rules:**

- Branch naming conventions
- Commit message patterns
- PR review requirements
- Deployment procedures

### 5. Initialize Project Context Document

Based on discovery, create or update the context document:

#### A. Fresh Document Setup (if no existing context)

Copy template from `{installed_path}/project-context-template.md` to `{output_folder}/project-context.md`
Initialize frontmatter fields.

#### B. Existing Document Update

Load existing context and prepare for updates
Set frontmatter `sections_completed` to track what will be updated

### 6. Present Discovery Summary

Report findings to user:

"Welcome {{user_name}}! I've analyzed your project for {{project_name}} to discover the context that AI agents need.

**Technology Stack Discovered:**
{{list_of_technologies_with_versions}}

**Existing Patterns Found:**

- {{number_of_patterns}} implementation patterns
- {{number_of_conventions}} coding conventions
- {{number_of_rules}} critical rules

**Key Areas for Context Rules:**

- {{area_1}} (e.g., TypeScript configuration)
- {{area_2}} (e.g., Testing patterns)
- {{area_3}} (e.g., Code organization)

{if_existing_context}
**Existing Context:** Found {{sections}} sections already defined. We can update or add to these.
{/if_existing_context}

Ready to create/update your project context. This will help AI agents implement code consistently with your project's standards.

[C] Continue to context generation"

## SUCCESS METRICS:

✅ Existing project context properly detected and handled
✅ Technology stack accurately identified with versions
✅ Critical implementation patterns discovered
✅ Project context document properly initialized
✅ Discovery findings clearly presented to user
✅ User ready to proceed with context generation

## FAILURE MODES:

❌ Not checking for existing project context before creating new one
❌ Missing critical technology versions or configurations
❌ Overlooking important coding patterns or conventions
❌ Not initializing frontmatter properly
❌ Not presenting clear discovery summary to user

## NEXT STEP:

After user selects [C] to continue, load `{project-root}/_bmad/bmm/workflows/generate-project-context/steps/step-02-generate.md` to collaboratively generate the specific project context rules.

Remember: Do NOT proceed to step-02 until user explicitly selects [C] from the menu and discovery is confirmed and the initial file has been written as directed in this discovery step!
```

## src/bmm/workflows/generate-project-context/steps/step-02-generate.md

````md
# Step 2: Context Rules Generation

## MANDATORY EXECUTION RULES (READ FIRST):

- 🛑 NEVER generate content without user input
- ✅ ALWAYS treat this as collaborative discovery between technical peers
- 📋 YOU ARE A FACILITATOR, not a content generator
- 💬 FOCUS on unobvious rules that AI agents need to be reminded of
- 🎯 KEEP CONTENT LEAN - optimize for LLM context efficiency
- ⚠️ ABSOLUTELY NO TIME ESTIMATES - AI development speed has fundamentally changed
- ✅ YOU MUST ALWAYS SPEAK OUTPUT In your Agent communication style with the config `{communication_language}`
- ✅ YOU MUST ALWAYS WRITE all artifact and document content in `{document_output_language}`

## EXECUTION PROTOCOLS:

- 🎯 Show your analysis before taking any action
- 📝 Focus on specific, actionable rules rather than general advice
- ⚠️ Present A/P/C menu after each major rule category
- 💾 ONLY save when user chooses C (Continue)
- 📖 Update frontmatter with completed sections
- 🚫 FORBIDDEN to load next step until all sections are complete

## COLLABORATION MENUS (A/P/C):

This step will generate content and present choices for each rule category:

- **A (Advanced Elicitation)**: Use discovery protocols to explore nuanced implementation rules
- **P (Party Mode)**: Bring multiple perspectives to identify critical edge cases
- **C (Continue)**: Save the current rules and proceed to next category

## PROTOCOL INTEGRATION:

- When 'A' selected: Execute skill:bmad-advanced-elicitation
- When 'P' selected: Execute {project-root}/\_bmad/core/workflows/bmad-party-mode/workflow.md
- PROTOCOLS always return to display this step's A/P/C menu after the A or P have completed
- User accepts/rejects protocol changes before proceeding

## CONTEXT BOUNDARIES:

- Discovery results from step-1 are available
- Technology stack and existing patterns are identified
- Focus on rules that prevent implementation mistakes
- Prioritize unobvious details that AI agents might miss

## YOUR TASK:

Collaboratively generate specific, critical rules that AI agents must follow when implementing code in this project.

## CONTEXT GENERATION SEQUENCE:

### 1. Technology Stack & Versions

Document the exact technology stack from discovery:

**Core Technologies:**
Based on user skill level, present findings:

**Expert Mode:**
"Technology stack from your architecture and package files:
{{exact_technologies_with_versions}}

Any critical version constraints I should document for agents?"

**Intermediate Mode:**
"I found your technology stack:

**Core Technologies:**
{{main_technologies_with_versions}}

**Key Dependencies:**
{{important_dependencies_with_versions}}

Are there any version constraints or compatibility notes agents should know about?"

**Beginner Mode:**
"Here are the technologies you're using:

**Main Technologies:**
{{friendly_description_of_tech_stack}}

**Important Notes:**
{{key_things_agents_need_to_know_about_versions}}

Should I document any special version rules or compatibility requirements?"

### 2. Language-Specific Rules

Focus on unobvious language patterns agents might miss:

**TypeScript/JavaScript Rules:**
"Based on your codebase, I notice some specific patterns:

**Configuration Requirements:**
{{typescript_config_rules}}

**Import/Export Patterns:**
{{import_export_conventions}}

**Error Handling Patterns:**
{{error_handling_requirements}}

Are these patterns correct? Any other language-specific rules agents should follow?"

**Python/Ruby/Other Language Rules:**
Adapt to the actual language in use with similar focused questions.

### 3. Framework-Specific Rules

Document framework-specific patterns:

**React Rules (if applicable):**
"For React development, I see these patterns:

**Hooks Usage:**
{{hooks_usage_patterns}}

**Component Structure:**
{{component_organization_rules}}

**State Management:**
{{state_management_patterns}}

**Performance Rules:**
{{performance_optimization_requirements}}

Should I add any other React-specific rules?"

**Other Framework Rules:**
Adapt for Vue, Angular, Next.js, Express, etc.

### 4. Testing Rules

Focus on testing patterns that ensure consistency:

**Test Structure Rules:**
"Your testing setup shows these patterns:

**Test Organization:**
{{test_file_organization}}

**Mock Usage:**
{{mock_patterns_and_conventions}}

**Test Coverage Requirements:**
{{coverage_expectations}}

**Integration vs Unit Test Rules:**
{{test_boundary_patterns}}

Are there testing rules agents should always follow?"

### 5. Code Quality & Style Rules

Document critical style and quality rules:

**Linting/Formatting:**
"Your code style configuration requires:

**ESLint/Prettier Rules:**
{{specific_linting_rules}}

**Code Organization:**
{{file_and_folder_structure_rules}}

**Naming Conventions:**
{{naming_patterns_agents_must_follow}}

**Documentation Requirements:**
{{comment_and_documentation_patterns}}

Any additional code quality rules?"

### 6. Development Workflow Rules

Document workflow patterns that affect implementation:

**Git/Repository Rules:**
"Your project uses these patterns:

**Branch Naming:**
{{branch_naming_conventions}}

**Commit Message Format:**
{{commit_message_patterns}}

**PR Requirements:**
{{pull_request_checklist}}

**Deployment Patterns:**
{{deployment_considerations}}

Should I document any other workflow rules?"

### 7. Critical Don't-Miss Rules

Identify rules that prevent common mistakes:

**Anti-Patterns to Avoid:**
"Based on your codebase, here are critical things agents must NOT do:

{{critical_anti_patterns_with_examples}}

**Edge Cases:**
{{specific_edge_cases_agents_should_handle}}

**Security Rules:**
{{security_considerations_agents_must_follow}}

**Performance Gotchas:**
{{performance_patterns_to_avoid}}

Are there other 'gotchas' agents should know about?"

### 8. Generate Context Content

For each category, prepare lean content for the project context file:

#### Content Structure:

```markdown
## Technology Stack & Versions

{{concise_technology_list_with_exact_versions}}

## Critical Implementation Rules

### Language-Specific Rules

{{bullet_points_of_critical_language_rules}}

### Framework-Specific Rules

{{bullet_points_of_framework_patterns}}

### Testing Rules

{{bullet_points_of_testing_requirements}}

### Code Quality & Style Rules

{{bullet_points_of_style_and_quality_rules}}

### Development Workflow Rules

{{bullet_points_of_workflow_patterns}}

### Critical Don't-Miss Rules

{{bullet_points_of_anti_patterns_and_edge_cases}}
```
````

### 9. Present Content and Menu

After each category, show the generated rules and present choices:

"I've drafted the {{category_name}} rules for your project context.

**Here's what I'll add:**

[Show the complete markdown content for this category]

**What would you like to do?**
[A] Advanced Elicitation - Explore nuanced rules for this category
[P] Party Mode - Review from different implementation perspectives
[C] Continue - Save these rules and move to next category"

### 10. Handle Menu Selection

#### If 'A' (Advanced Elicitation):

- Execute skill:bmad-advanced-elicitation with current category rules
- Process enhanced rules that come back
- Ask user: "Accept these enhanced rules for {{category}}? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'P' (Party Mode):

- Execute party-mode workflow with category rules context
- Process collaborative insights on implementation patterns
- Ask user: "Accept these changes to {{category}} rules? (y/n)"
- If yes: Update content, then return to A/P/C menu
- If no: Keep original content, then return to A/P/C menu

#### If 'C' (Continue):

- Save the current category content to project context file
- Update frontmatter: `sections_completed: [...]`
- Proceed to next category or step-03 if complete

## APPEND TO PROJECT CONTEXT:

When user selects 'C' for a category, append the content directly to `{output_folder}/project-context.md` using the structure from step 8.

## SUCCESS METRICS:

✅ All critical technology versions accurately documented
✅ Language-specific rules cover unobvious patterns
✅ Framework rules capture project-specific conventions
✅ Testing rules ensure consistent test quality
✅ Code quality rules maintain project standards
✅ Workflow rules prevent implementation conflicts
✅ Content is lean and optimized for LLM context
✅ A/P/C menu presented and handled correctly for each category

## FAILURE MODES:

❌ Including obvious rules that agents already know
❌ Making content too verbose for LLM context efficiency
❌ Missing critical anti-patterns or edge cases
❌ Not getting user validation for each rule category
❌ Not documenting exact versions and configurations
❌ Not presenting A/P/C menu after content generation

## NEXT STEP:

After completing all rule categories and user selects 'C' for the final category, load `{project-root}/_bmad/bmm/workflows/generate-project-context/steps/step-03-complete.md` to finalize the project context file.

Remember: Do NOT proceed to step-03 until all categories are complete and user explicitly selects 'C' for each!

```

```
