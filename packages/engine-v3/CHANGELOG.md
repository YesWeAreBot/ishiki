# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- The `v3` engine trio as its own plugin, moved out of `koishi-plugin-ishiki`: WorldState context with core memory blocks, JSON OUTPUT tool protocol with per-step `thoughts`, and willingness-based wakeup. Install and enable it to keep using `engine: v3`; the three variants stay independently selectable and mixable with other engines.
- The `v3` engine trio as its own plugin, moved out of `koishi-plugin-ishiki`: WorldState context with core memory blocks, JSON OUTPUT tool protocol with per-step `thoughts`, and willingness-based wakeup. Install and enable it to keep using `engine: v3`; the three variants stay independently selectable and mixable with other engines

### Changed
- The engine tests build the runtime with the host's `pacing` step budget; engine behaviour is unchanged
- Package metadata now carries a description, keywords, repository, homepage, and bug tracker, and declares `ishiki` as a required service for the Koishi market
- Engine tests import agent helpers and the gateway from `koishi-plugin-ishiki`, and the package drops its direct `@yesimagent/gateway` dependency; behaviour is unchanged