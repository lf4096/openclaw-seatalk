# Changelog

## 1.1.1

- Fix the gateway exiting on the first inbound message with OpenClaw 2026.7.2-beta.6 or newer.
- Return the message id from outbound sends, so deliveries are no longer reported as unconfirmed.
- Strip the leading group mention before command detection.
- Reply instead of dropping the message when the agent binding does not resolve.

## 1.1.0

- Add official SeaTalk WebSocket event mode (`mode: "websocket"`).
- Seed the thread root message on a thread session's first turn.
- Add the plugin manifest display name and `install.clawhubSpec` so the ClawHub Plugin Inspector validates without warnings.

## 1.0.1

- Fix every reply spawning a new per-message thread session.
- Resolve `media://` store URIs on outbound media sends.

## 1.0.0

- Require OpenClaw 2026.6.1 or newer.
- Rebuild inbound handling on OpenClaw's message kernel.
- Detect group vs direct chats from the recipient id, dropping the internal `group:` prefix.
- Keep the typing indicator visible for the whole reply.
- Fix the SeaTalk agent tool not being registered on recent OpenClaw.
- Fix the empty pairing approval message.

## 0.4.1

- Fix group replies being sent as DMs when the agent omits an explicit target.

## 0.4.0

- Route DM and group threads to isolated agent sessions; new threads fork the parent transcript on first reply.
- Outbound messages from agent-initiated sends now stay in the originating thread.
- Switch to structured logging across all inbound and outbound paths.

## 0.3.3

- Publish bundled JS only (`dist/*.js`), fixing install failure on OpenClaw versions that require compiled runtime output for TypeScript entries.
- Re-declare `openclaw.setupEntry` so the channel appears in onboarding before configuration.
- Drop `SEATALK_*` env-var credential fallback.

## 0.3.2

- Detect half-open relay connections: reconnect after 75s of inbound silence; enable TCP keep-alive (60s).

## 0.3.1

- Update OpenClaw compatibility and remove SDK deprecation warnings.

## 0.3.0

- Support forwarded messages.
- Outbound coalescing: consecutive reply payloads are merged into a single message with automatic markdown-aware chunking at 4000 chars, configurable via `outboundCoalescing`.
- Pairing mode for DM access control with interactive approval flow (`dmPolicy: "pairing"`). Thanks @edvardchen.
- Inbound media URL allowlist gate and MIME detection fallback for extensionless URLs. Thanks @edvardchen.
- Retry on rate-limit with exponential backoff and include `x-rid` in all error messages.

## 0.2.1

- Remove `setupEntry` to avoid plugin id mismatch when channel is unconfigured.
- Add ClawHub compatibility metadata (`compat.pluginApi`).

## 0.2.0

- Migrate to new plugin SDK subpath imports. Requires OpenClaw >= 2026.3.22.

## 0.1.6

- Reuse cached API client in probe to avoid token rate limiting.

## 0.1.5

- Align plugin id with manifest.
- Bump minimum Node.js to >= 22.16.0.

## 0.1.4

- Exclude signingSecret from resolved account to prevent leaking in status output.

## 0.1.3

- Split local file read into media-local.ts to avoid security scan false positive.
- Add install metadata to package.json.

## 0.1.2

- Align plugin manifest id with npm package name.

## 0.1.1

- Use os.homedir() for media path resolution to avoid security scan false positive.

## 0.1.0

- Initial release.
