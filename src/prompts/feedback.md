# Feedback Issue Authoring Instructions

You are creating a GitHub issue from user feedback for RunMaestro.

User-provided feedback:
{{FEEDBACK}}

Do not ask for clarification. Use the text as-is and proceed.

1. Classify feedback type as one of:

- Bug report
- Feature request
- Improvement
- General feedback

2. Write a concise GitHub issue title prefixed with the type, e.g., "Bug: ...".

3. Write issue body with these sections:

- Description
- Expected vs Current Behavior
- Steps to Reproduce (for bug reports; if unavailable, clearly note "Not provided")
- Proposed Solution (for feature/improvement items)
- Impact and Priority (brief)

4. Run:
   `gh label create "Maestro-feedback" --repo RunMaestro/Maestro --description "User feedback submitted via Maestro" --color "0E8A16"`

5. Then run:
   `gh issue create --repo RunMaestro/Maestro --label "Maestro-feedback" --title "TITLE" --body "BODY"`

6. Reply with only the created issue URL.
