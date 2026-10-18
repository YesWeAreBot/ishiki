# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Paired `narrative` context and tool-calling engines, moved out of `koishi-plugin-ishiki` into their own plugin: incremental persisted scripts, separate Narrator/Planner, Action Decoder and Replyer stages, gateway-selectable specialist models, history compaction and recovery from marked assistant output. Host tool execution, attachments and turn-ending behavior remain in the existing Agent runtime.

### Fixed
- Narrative context preserves each message's direct/group conversation setting; Narrator continuity retains past events without locking current feelings, interpretations or plans to the opening scene.
- Narrative JSON stages request provider JSON mode instead of relying only on prose instructions; author style rules apply inside `script` and cannot override the outer output contract.