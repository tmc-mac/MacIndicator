---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## How It Works

1. Read the pinned guidelines (see Guidelines Source below)
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in the fetched guidelines
4. Output findings in the terse `file:line` format

## Guidelines Source

**Team Mac change:** the rules are vendored and pinned. They are never fetched at run time, because rules fetched at run time would be remote instructions. Read the local copy:

```
.claude/skills/web-design-guidelines/guidelines/command.md
```

It comes from vercel-labs/web-interface-guidelines at commit 434b7f91364665f2f733b310ec54809bf8f37937 (MIT, see LICENSE-web-interface-guidelines). To update it, MacArthur re-vendors it at a new pinned commit after reading the diff. Upstream source: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md

## Usage

When a user provides a file or pattern argument:
1. Read the pinned guidelines file above
2. Read the specified files
3. Apply all rules from the fetched guidelines
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.
