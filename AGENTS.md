# AGENT.md

# Ava Automation

This repository contains tooling for reverse engineering, inspecting and automating my self-hosted Avataria client.

## Goals

- Understand game internals.
- Build debugging tools.
- Improve the existing inspector.
- Automate repetitive tasks.
- Keep the code easy to inspect and modify.

---

# General rules

- Prefer readability over cleverness.
- Keep functions small.
- Comment complex reverse-engineering discoveries.
- Never remove existing functionality unless explicitly requested.
- Preserve backwards compatibility whenever possible.

---

# Reverse engineering

When analysing obfuscated code:

- Preserve original names whenever they are significant.
- Add descriptive comments.
- Never guess behavior if it can be inspected.
- Prefer runtime inspection over assumptions.
- Keep helper functions generic so they remain useful after game updates.

---

# Inspector

The userscript inspector is the most important component.

When modifying it:

- Do not remove existing commands.
- Keep existing public APIs working.
- New features should be additive.
- Avoid breaking saved workflows.

---

# Coding style

- ES6 JavaScript.
- No external dependencies unless requested.
- Prefer descriptive function names.
- Avoid global variables except exported inspector commands.
- Keep comments in English.

---

# Error handling

Helpers should never throw when the game is not fully initialized.

Instead:

- return `null`
- return `false`
- log a useful message

Never crash the userscript.

---

# Automation

Automation should:

- mimic legitimate client behavior whenever possible
- prefer existing game APIs over packet manipulation
- avoid hardcoded timings
- be reusable

---

# Pull requests

Prefer small, focused commits.

Do not perform large refactors unless explicitly requested.

---

# Documentation

Whenever a new discovery is made about the game internals:

- document it
- explain why it works
- reference related classes if known

The repository should gradually become documentation of the game's internal architecture.