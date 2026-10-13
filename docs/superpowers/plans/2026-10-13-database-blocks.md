# Database Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a separate typed database block without changing CSV tables.
**Architecture:** JSON schema and records live in database cell source, using stable IDs. A separate UI module handles properties and views; existing Store validation, encryption and autosave persist the complete source.
**Tech Stack:** Python stdlib, vanilla ES modules, existing Playwright.
**Spec:** docs/superpowers/specs/2026-10-13-database-blocks.md

## Global Constraints

Preserve existing CSV table handlers and source. Six types: text, select, multi-select, number, date, checkbox. Max 50 columns, 1000 rows, 100 options per column, 20000 text characters, 500000 source characters. Use 32 lowercase hex IDs and current LAN HTTP compatible newId. Verification uses isolated fixtures.

## Review Focus

- Autosave clones must not lose later edits in an open choice dialog.
- Renaming/reordering/deleting properties or options must preserve associations.
- Invalid JSON, dates, numeric types and foreign IDs must be rejected atomically.
- Long Chinese text and narrow screens must preserve multiline editing and scroll.
- Encrypted restart/backup/export must retain schema, labels and view settings.

### Task 1: Model and server persistence

**Files:** static/database-core.mjs, database_blocks.py, store.py, tests/database.test.mjs, tests/test_database.py.
**Interfaces:** createDatabase(), parseDatabase(source), validateDatabase(data), visibleRows(data, search), databaseCSV(data), databaseHTML(data); Python validate_database(source), database_markdown(source).

- [x] Write tests for typed values, stable choice IDs, view semantics, safe exports, invalid payload atomicity and encrypted backup/restart.
- [x] Run focused Node/Python tests and verify RED.
- [x] Implement strict schema validation and pure view/export model; recognize database type in Store without touching table validation.
- [x] Run focused tests and verify GREEN.

### Task 2: Notebook integration and UI

**Files:** static/database-ui.mjs, static/database.css, static/notebook.js, static/notebook-export.mjs, static/index.html, static/cell-export.html, server.py.
**Interfaces:** DatabaseUI(nb).html(cell), .click(event), .input(event), .change(event), .dispose().

- [x] Add browser test for separate block, all six types, property lifecycle, multichoice repeated edits, multiline paste, view/filter/sort, reload, PDF, responsive layout and old table source equality.
- [x] Verify RED with missing new block.
- [x] Implement grouped toolbar, inline typed editors, property and choice dialogs, persistent view settings, selection deletion, pagination and CSV export; wire separate event selectors.
- [x] Verify GREEN plus existing UI regression.

### Task 3: Review and release

**Files:** README.md, CHANGELOG.md, package.json/package-lock.json, .github/workflows/checks.yml.

- [x] Document v0.13.0 feature and backup compatibility, add database UI to CI.
- [x] Run syntax, formatting, full Node/Python, build and both new/existing browser suites.
- [x] Independent whole-branch review; fix material findings and rerun relevant checks.
- [ ] Commit and integrate clean branch, push; confirm GitHub checks before deployment handoff. Report handoff separately from live deployment.
