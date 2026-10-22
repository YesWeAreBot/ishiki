# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- OneBot v11 action pack for ishiki: a catalog generated from the NapCat and SnowLuma OpenAPI documents, exposed as `onebot://actions` and as `list_actions` / `get_action` / `search_actions` / `list_categories`.
- `query_action` (read-only actions) and `invoke_action` (any action) selected by the profile's `mode`: `docs`, `read`, or `write`.
- Backend selection (`napcat` or `snowluma`) fixes the action set, parameter shape, and read-only classification; actions that only one backend implements stay out of the other's catalog.
- Resource URLs (`asset:`, `artifact:`, `local:`, `workspace:`, `skill:`, `mcp:`) are converted into `base64://` for parameters that accept inline media, and published through the Koishi HTTP service for parameters that require a URL.
- `denyActions` plus a built-in deny list covers `bot_exit`, `set_restart`, `send_packet`, and the credential actions.
- The OneBot v11 action pack now ships as the standalone `koishi-plugin-ishiki-onebot-actions` package with its own catalog generator and tests

### Fixed

- File retrieval instructions use metadata file IDs and the backend's private/group file URL actions, with temporary URLs passed directly between tools in one codemode execution.
- File retrieval instructions use metadata file IDs and the backend's private/group file URL actions, with temporary URLs passed directly between tools in one codemode execution
