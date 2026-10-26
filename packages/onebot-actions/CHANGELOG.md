# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.2] - 2026-10-26

### Changed
- Package metadata now carries a description, keywords, repository, homepage, and bug tracker, and declares `ishiki` as a required service with `server` optional for the Koishi market
- The `koishi-plugin-ishiki` peer dependency now accepts any `0.0.x` release instead of only `0.0.1`

## [0.0.1] - 2026-10-25

### Added
- OneBot v11 action pack for ishiki: a catalog generated from the NapCat and SnowLuma OpenAPI documents, exposed as `onebot://actions` and as `list_actions` / `get_action` / `search_actions` / `list_categories`.
- `query_action` (read-only actions) and `invoke_action` (any action) selected by the profile's `mode`: `docs`, `read`, or `write`.
- Backend selection (`napcat` or `snowluma`) fixes the action set, parameter shape, and read-only classification; actions that only one backend implements stay out of the other's catalog.
- Resource URLs (`asset:`, `artifact:`, `local:`, `workspace:`, `skill:`, `mcp:`) are converted into `base64://` for parameters that accept inline media, and published through the Koishi HTTP service for parameters that require a URL.
- `denyActions` plus a built-in deny list covers `bot_exit`, `set_restart`, `send_packet`, and the credential actions.
- The OneBot v11 action pack now ships as the standalone `koishi-plugin-ishiki-onebot-actions` package with its own catalog generator and tests

### Changed
- Development depends on `koishi-plugin-ishiki` through `workspace:^`

### Fixed
- File retrieval instructions use metadata file IDs and the backend's private/group file URL actions, with temporary URLs passed directly between tools in one codemode execution.
- File retrieval instructions use metadata file IDs and the backend's private/group file URL actions, with temporary URLs passed directly between tools in one codemode execution

[Unreleased]: https://github.com/YesWeAreBot/ishiki/compare/koishi-plugin-ishiki-onebot-actions@0.0.2...HEAD
[0.0.2]: https://github.com/YesWeAreBot/ishiki/releases/tag/koishi-plugin-ishiki-onebot-actions@0.0.2
