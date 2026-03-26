# openclaw-seatalk

OpenClaw channel plugin for [SeaTalk](https://seatalk.io/) messaging.

## Features

### Messaging

- **Private chat** — bidirectional text, image, file messaging with bot subscribers
- **Group chat** — receive @mentioned messages, send text/image/file replies; configurable group allow-list and per-sender access control
- **Thread messages** — full support for DM threads and group threads; replies are routed back to the originating thread
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

- **Dual gateway mode** — **webhook** (direct HTTP server) or **relay** (WebSocket client via [seatalk-relay](https://github.com/lf4096/seatalk-relay))
- **Security** — SHA256 signature verification for all incoming events
- **Token management** — automatic access token obtain, cache, and refresh
- **Deduplication** — event ID dedup + per-sender debounce buffer (thread-aware)
- **Access control** — DM policy (`open`/`allowlist`/`pairing`), group policy (`disabled`/`allowlist`/`open`), per-group and per-sender allow-lists
- **Email resolution** — email-to-employee_code lookup for outbound message targets
- **Multi-account** — multiple SeaTalk bot apps in one OpenClaw instance
- **Health probing** — connection health check on startup
- **CLI onboarding** — interactive setup wizard

## Prerequisites

1. Create a Bot App on [SeaTalk Open Platform](https://open.seatalk.io/)
2. Get **App ID**, **App Secret** from Basic Info & Credentials
3. Get **Signing Secret** from Event Callback settings
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
6. Configure the Event Callback URL:
   - **Webhook mode**: point to your OpenClaw server (e.g. `https://your-server:3210/callback`)
   - **Relay mode**: point to your seatalk-relay service (e.g. `https://relay.example.com/seatalk/callback`)

## Installation

### From npm

```bash
openclaw plugins install openclaw-seatalk
```

OpenClaw downloads the package, installs dependencies, and registers the plugin automatically. The plugin will appear in the `openclaw onboard` channel selection.

To install and pin a specific version:

```bash
openclaw plugins install openclaw-seatalk --pin
```

To update to the latest version (restart the gateway afterwards to apply):

```bash
openclaw plugins update openclaw-seatalk
```

### From source (development)

Clone the repo and link it directly — no build step required. OpenClaw loads TypeScript via Jiti at runtime.

```bash
git clone https://github.com/lf4096/openclaw-seatalk.git
cd openclaw-seatalk
npm install
openclaw plugins install -l .
```

## Gateway Modes

The plugin supports two gateway modes for receiving SeaTalk events:

### Webhook Mode (default)

The plugin starts an HTTP server to receive SeaTalk Event Callbacks directly. Suitable when the OpenClaw host is publicly reachable or behind a reverse proxy.

```
SeaTalk --HTTP POST-> OpenClaw (webhook server)
```

### Relay Mode (recommended for multiple apps)

The plugin connects to a [seatalk-relay](https://github.com/lf4096/seatalk-relay) service as a WebSocket client. The relay service receives webhooks from SeaTalk and forwards events to the plugin. Suitable when OpenClaw runs behind a firewall or NAT without a public address.

```
SeaTalk API --HTTP POST-> seatalk-relay <-WebSocket-- OpenClaw (relay mode)
```

In relay mode, outbound messages (sending replies) are still sent directly from the plugin to the SeaTalk API.

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
      // allowFrom: ["e_12345678", "alice@company.com"],
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
| `mode` | `"webhook"` \| `"relay"` | `"webhook"` | Gateway mode |
| `appId` | string | — | SeaTalk App ID |
| `appSecret` | string | — | SeaTalk App Secret |
| `signingSecret` | string | — | SeaTalk Signing Secret |
| `webhookPort` | number | `8080` | HTTP port (webhook mode only) |
| `webhookPath` | string | `"/callback"` | HTTP path (webhook mode only) |
| `relayUrl` | string | — | WebSocket URL (relay mode only) |
| `dmPolicy` | `"open"` \| `"allowlist"` \| `"pairing"` | `"allowlist"` | Who can DM the bot (`pairing`: approve via `openclaw pairing approve seatalk <code>`; optional static `allowFrom` still applies) |
| `allowFrom` | string[] | — | Allowed DM senders (employee codes or emails) |
| `groupPolicy` | `"disabled"` \| `"allowlist"` \| `"open"` | `"disabled"` | Group chat policy |
| `groupAllowFrom` | string[] | — | Allowed group IDs (when `groupPolicy: "allowlist"`) |
| `groupSenderAllowFrom` | string[] | — | Allowed senders within groups (employee codes or emails) |
| `processingIndicator` | `"typing"` \| `"off"` | `"typing"` | Show typing status while processing |
| `tools.groupInfo` | boolean | `true` | Enable `seatalk` tool `group_info` action |
| `tools.groupHistory` | boolean | `true` | Enable `seatalk` tool `group_history` action |
| `tools.groupList` | boolean | `true` | Enable `seatalk` tool `group_list` action |
| `tools.threadHistory` | boolean | `true` | Enable `seatalk` tool `thread_history` action |
| `tools.getMessage` | boolean | `true` | Enable `seatalk` tool `get_message` action |

**DM pairing (`dmPolicy: "pairing"`)** — Unknown senders get a one-time code in chat; run `openclaw pairing approve seatalk <code>` on the gateway host. Use `openclaw pairing list` / `pairing pending seatalk` to inspect requests. Multi-account: pass `--account <id>` on pairing commands. Optional `notifyApproval` uses the default SeaTalk account’s API client.

Credentials can also be provided via environment variables:

| Env Var | Config Field |
|---------|-------------|
| `SEATALK_APP_ID` | `appId` |
| `SEATALK_APP_SECRET` | `appSecret` |
| `SEATALK_SIGNING_SECRET` | `signingSecret` |

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

```bash
# Install dependencies
pnpm install

# Format code
pnpm format

# Lint
pnpm lint

# Check (format + lint)
pnpm check
```
