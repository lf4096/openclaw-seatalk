# openclaw-seatalk

OpenClaw channel plugin for [SeaTalk](https://seatalk.io/) messaging.

## Features

### Messaging

- **Private chat** — bidirectional text, image, file messaging with bot subscribers
- **Group chat** — receive @mentioned messages, send text/image/file replies; configurable group allow-list and per-sender access control
- **Thread messages** — each DM or group thread runs as an isolated agent session that inherits the parent transcript on first reply; replies are routed back to the originating thread
- **Quoted messages** — inbound messages with `quoted_message_id` are automatically resolved (text + media download) and provided to the AI as context
- **Media handling** — inbound: image/file/video URL download; outbound: image/file base64 upload; video receive-only
- **Typing indicator** — one-shot typing status via SeaTalk API for both private and group chats (configurable: `typing` or `off`)

### Agent Tool

- `group_history` — fetch group chat messages in chronological order with auto-resolved quoted messages
- `group_info` — get group details (name, avatar, member list)
- `group_list` — list groups the bot has joined
- `thread_history` — fetch DM or group thread messages with auto-resolved quoted messages
- `get_message` — retrieve any message by ID

### Infrastructure

- **Gateway modes** — **webhook** (direct HTTP server), **websocket** (official SeaTalk WebSocket, no public URL), or **relay** (WebSocket client via [seatalk-relay](https://github.com/lf4096/seatalk-relay))
- **Security** — SHA256 signature verification for incoming events (webhook/relay modes; websocket mode authenticates the connection itself)
- **Token management** — automatic access token obtain, cache, and refresh
- **Outbound coalescing** — consecutive reply payloads are merged into a single message with automatic markdown-aware chunking at 4000 chars; configurable via `outboundCoalescing`
- **Deduplication** — event ID dedup + per-sender debounce buffer (thread-aware)
- **Access control** — DM policy (`open`/`allowlist`/`pairing`), group policy (`disabled`/`allowlist`/`open`), per-group and per-sender allow-lists
- **Email resolution** — email-to-employee_code lookup for outbound message targets
- **Multi-account** — multiple SeaTalk bot apps in one OpenClaw instance
- **Health probing** — connection health check on startup
- **CLI onboarding** — interactive setup wizard

## Prerequisites

1. Create a Bot App on [SeaTalk Open Platform](https://open.seatalk.io/)
2. Get **App ID**, **App Secret** from Basic Info & Credentials
3. Get **Signing Secret** from Event Callback settings (webhook/relay modes only)
4. Enable Bot capability and set status to **Online**
5. Enable required permissions:
   - **Send Message to Bot User**
   - **Get Employee Code with Email** (for email-to-employee_code resolution)
   - **Set Typing Status in Private Chat** (for DM processing indicator)
   - **Set Typing Status in Group Chat** (for group processing indicator)
   - **Get Chat History** (for group history tool)
   - **Get Group Info** (for group info tool)
   - **Get Joined Group Chat List** (for group list tool)
   - **Get Thread by Thread ID in Private Chat** (for DM thread tool)
   - **Get Thread by Thread ID** (for group thread tool)
6. Configure event delivery in Event Callback settings:
   - **Webhook mode**: set the callback URL to your OpenClaw server (e.g. `https://your-server:3210/callback`)
   - **Relay mode**: set the callback URL to your seatalk-relay service (e.g. `https://relay.example.com/seatalk/callback`)
   - **WebSocket mode**: switch the bot to WebSocket delivery; the gateway must already be connected before the portal "Re-verify" passes

## Installation

### From npm

```bash
openclaw plugins install openclaw-seatalk
```

OpenClaw downloads the package, installs dependencies, and registers the plugin automatically. The plugin will appear in the `openclaw onboard` channel selection.

| Plugin version | OpenClaw version |
|---------------|-----------------|
| 0.2.x | >= 2026.3.22 |
| 0.1.x | < 2026.3.22 |

v0.2.0 migrated to the new plugin SDK (`openclaw/plugin-sdk/*`). If you are running OpenClaw < 2026.3.22, pin to 0.1.x:

```bash
openclaw plugins install openclaw-seatalk@0.1.6
```

### From source (development)

```bash
git clone https://github.com/lf4096/openclaw-seatalk.git
cd openclaw-seatalk
pnpm install
pnpm build
openclaw plugins install -l .
```

## Upgrading

```bash
openclaw plugins update openclaw-seatalk
openclaw gateway restart
```

Upgrading OpenClaw across the 2026.3.22 SDK boundary (e.g. 2026.3.13 -> 2026.3.22):

```bash
openclaw plugins disable openclaw-seatalk
openclaw update
openclaw plugins update openclaw-seatalk
openclaw plugins enable openclaw-seatalk
openclaw gateway restart
```

The plugin must be disabled before upgrading because the old plugin (0.1.x) imports SDK exports removed in OpenClaw >= 2026.3.22. Disabling prevents it from loading during the upgrade.

## Gateway Modes

The plugin supports three gateway modes for receiving SeaTalk events:

### Webhook Mode (default)

The plugin starts an HTTP server to receive SeaTalk Event Callbacks directly. Suitable when the OpenClaw host is publicly reachable or behind a reverse proxy.

```
SeaTalk --HTTP POST-> OpenClaw (webhook server)
```

### WebSocket Mode (official, no public URL)

The plugin opens an outbound WebSocket to SeaTalk's official developer-bot endpoint (`wss://ws-openapi.haiserve.com/ws/bot`) and registers with `appId` + `appSecret`. No public callback URL, relay service, or signing secret is required. Switch the bot to WebSocket in the SeaTalk portal (Event Callback settings); the gateway must already be connected before the portal "Re-verify" passes.

```
SeaTalk WS endpoint <-WebSocket-> OpenClaw (websocket mode)
```

### Relay Mode (recommended for multiple apps sharing one callback)

The plugin connects to a [seatalk-relay](https://github.com/lf4096/seatalk-relay) service as a WebSocket client. The relay service receives webhooks from SeaTalk and forwards events to the plugin. Suitable when OpenClaw runs behind a firewall or NAT without a public address and the official WebSocket mode is not used.

```
SeaTalk API --HTTP POST-> seatalk-relay <-WebSocket-- OpenClaw (relay mode)
```

In relay and websocket modes, outbound messages (sending replies) are still sent directly from the plugin to the SeaTalk API.

## Configuration

You can configure the plugin interactively:

```bash
openclaw configure      # config wizard with SeaTalk channel
```

Or edit the OpenClaw config file directly (`~/.openclaw/openclaw.json`).

### Webhook mode (DM only)

```json5
{
  channels: {
    seatalk: {
      enabled: true,
      mode: "webhook",  // default, can be omitted
      appId: "your_app_id",
      appSecret: "your_app_secret",
      signingSecret: "your_signing_secret",
      webhookPort: 3210,
      webhookPath: "/callback",
      dmPolicy: "open",  // or "allowlist" | "pairing"
      allowFrom: ["*"],  // dmPolicy "open" requires the explicit wildcard
    },
  },
}
```

### WebSocket mode (official, no public URL)

```json5
{
  channels: {
    seatalk: {
      enabled: true,
      mode: "websocket",
      appId: "your_app_id",
      appSecret: "your_app_secret",
      dmPolicy: "allowlist",
      allowFrom: ["alice@company.com"],
    },
  },
}
```

### Relay mode with group chat

```json5
{
  channels: {
    seatalk: {
      enabled: true,
      mode: "relay",
      appId: "your_app_id",
      appSecret: "your_app_secret",
      signingSecret: "your_signing_secret",
      relayUrl: "ws://relay.example.com:8080/ws",
      dmPolicy: "allowlist",
      allowFrom: ["alice@company.com"],
      groupPolicy: "allowlist",      // "disabled" | "allowlist" | "open"
      groupAllowFrom: ["group_abc123"],
      groupSenderAllowFrom: ["alice@company.com"],  // optional sender-level filter
      processingIndicator: "typing", // "typing" (default) | "off"
      tools: {
        groupInfo: true,
        groupHistory: true,
        groupList: true,
        threadHistory: true,
        getMessage: true,
      },
    },
  },
}
```

### Config fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"webhook"` \| `"relay"` \| `"websocket"` | `"webhook"` | Gateway mode |
| `appId` | string | — | SeaTalk App ID |
| `appSecret` | string | — | SeaTalk App Secret |
| `signingSecret` | string | — | SeaTalk Signing Secret (webhook/relay modes only) |
| `webhookPort` | number | `8080` | HTTP port (webhook mode only) |
| `webhookPath` | string | `"/callback"` | HTTP path (webhook mode only) |
| `relayUrl` | string | — | WebSocket URL (relay mode only) |
| `dmPolicy` | `"open"` \| `"allowlist"` \| `"pairing"` | `"allowlist"` | Who can DM the bot (`pairing`: approve via CLI) |
| `allowFrom` | string[] | — | Allowed DM senders (employee codes or emails) |
| `dmThreadSession` | boolean | `true` | Route each DM thread to its own agent session |
| `groupPolicy` | `"disabled"` \| `"allowlist"` \| `"open"` | `"disabled"` | Group chat policy |
| `groupAllowFrom` | string[] | — | Allowed group IDs (when `groupPolicy: "allowlist"`) |
| `groupSenderAllowFrom` | string[] | — | Allowed senders within groups (employee codes or emails) |
| `groupThreadSession` | boolean | `true` | Route each group thread to its own agent session |
| `threadInheritParent` | boolean | `true` | Fork the parent transcript into new thread sessions on first reply |
| `outboundCoalescing` | boolean | `true` | Merge consecutive reply payloads into a single message (4000-char chunking) |
| `processingIndicator` | `"typing"` \| `"off"` | `"typing"` | Show typing status while processing |
| `mediaAllowHosts` | string[] | `["openapi.seatalk.io"]` | Allowed hostnames for inbound media downloads (HTTPS only) |
| `tools.groupInfo` | boolean | `true` | Enable `seatalk` tool `group_info` action |
| `tools.groupHistory` | boolean | `true` | Enable `seatalk` tool `group_history` action |
| `tools.groupList` | boolean | `true` | Enable `seatalk` tool `group_list` action |
| `tools.threadHistory` | boolean | `true` | Enable `seatalk` tool `thread_history` action |
| `tools.getMessage` | boolean | `true` | Enable `seatalk` tool `get_message` action |

### Multi-account

Each account has its own credentials and gateway mode. Top-level fields (e.g. `tools`, `dmPolicy`) serve as defaults that accounts inherit and can override.

```json5
{
  channels: {
    seatalk: {
      dmPolicy: "allowlist",
      tools: { groupHistory: false },
      accounts: {
        production: {
          enabled: true,
          appId: "prod_app_id",
          appSecret: "prod_app_secret",
          signingSecret: "prod_signing_secret",
          mode: "relay",
          relayUrl: "wss://relay.example.com/ws",
          groupPolicy: "open",
        },
        staging: {
          enabled: true,
          appId: "staging_app_id",
          appSecret: "staging_app_secret",
          signingSecret: "staging_signing_secret",
          mode: "webhook",
          webhookPort: 3211,
        },
      },
    },
  },
}
```

## Agent Tool

The plugin registers a `seatalk` agent tool using a `Type.Union` schema (each action defines its own required/optional parameters):

| Action | Description | Required params | Optional params |
|--------|-------------|-----------------|-----------------|
| `group_history` | Fetch recent group messages (chronological order, quoted messages auto-resolved) | `group_id` | `page_size`, `cursor` |
| `group_info` | Get group details (name, members) | `group_id` | — |
| `group_list` | List groups the bot has joined | — | `page_size`, `cursor` |
| `thread_history` | Fetch thread messages (chronological order, quoted messages auto-resolved) | `thread_id` | `group_id`, `employee_code`, `page_size`, `cursor` |
| `get_message` | Get a single message by ID (resolves any message_id or quoted_message_id) | `message_id` | — |

**Quoted messages:** `group_history` and `thread_history` auto-resolve `quoted_message_id` for each message, embedding the result as a `quoted_message` field. Use `get_message` for ad-hoc lookups.

Each action can be individually disabled via the `tools` config.

## Development

Install dependencies:

```bash
pnpm install
```

Build `dist/`:

```bash
pnpm build
```

Format code:

```bash
pnpm format
```

Lint:

```bash
pnpm lint
```

Check formatting and lint:

```bash
pnpm check
```

## Publishing

For npm releases, `prepublishOnly` rebuilds `dist/` automatically:

```bash
npm version patch
npm publish --access public
```

For beta builds, publish with the `beta` dist-tag:

```bash
npm publish --tag beta
```

For ClawHub releases, build first because `prepublishOnly` does not run:

```bash
pnpm build
clawhub package publish .
```

Inspect tarball contents with `npm pack --dry-run`.
