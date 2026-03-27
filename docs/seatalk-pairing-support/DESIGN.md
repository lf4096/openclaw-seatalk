# SeaTalk Pairing Support - Design Overview

## Goals

Enable `openclaw-seatalk` to support `dmPolicy: "pairing"` for dynamic DM authorization without manually maintaining `allowFrom`.

## Workflow

### User experience

```
1. A new user messages the SeaTalk bot
   ↓
2. Bot replies:
   "Your SeaTalk user id: 23170

   To approve this pairing request, run:
   openclaw pairing approve seatalk ABC123"
   ↓
3. Operator runs: openclaw pairing approve seatalk ABC123
   ↓
4. User sends again; message is handled successfully
```

### Technical flow

```
handleSeaTalkMessage()
  ↓
Create scoped pairing access
  ↓
Read storeAllowFrom (approved users)
  ↓
Call resolveDmGroupAccessWithLists()
  ├─ "allow" → handle message
  ├─ "pairing" → issuePairingChallenge() → send code
  └─ "deny" → drop message
```

## Core changes

### 1. Config schema (`src/config-schema.ts`)

```typescript
// Before
export const DmPolicySchema = z.enum(["open", "allowlist"]);

// After
export const DmPolicySchema = z.enum(["open", "allowlist", "pairing"]);
```

### 2. Bot message handler (`src/bot.ts`)

```typescript
// New imports
import {
  issuePairingChallenge,
  createScopedPairingAccess,
  resolveDmGroupAccessWithLists,
} from "openclaw/plugin-sdk";

// Inside handleSeaTalkMessage()
export async function handleSeaTalkMessage(...) {
  // 1. Create pairing helper
  const pairing = createScopedPairingAccess({
    core,
    channel: "seatalk",
    accountId: "default", // or actual accountId
  });

  // 2. Read pairing store allowFrom
  const configAllowFrom = (config.channels?.seatalk?.allowFrom ?? []).map(String);
  const storeAllowFrom = dmPolicy !== "allowlist" && (dmPolicy !== "open" || needsCommandAuth)
    ? await pairing.readAllowFromStore().catch(() => [])
    : [];

  // 3. Single access decision
  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy,
    groupPolicy: "disabled", // SeaTalk: no group policy needed for this path
    allowFrom: configAllowFrom,
    groupAllowFrom: [],
    storeAllowFrom,
    isSenderAllowed: (allowFrom) => allowFrom.includes(senderId),
  });

  // 4. Pairing path
  if (accessDecision.decision === "pairing") {
    await issuePairingChallenge({
      channel: "seatalk",
      senderId,
      senderIdLine: `Your SeaTalk user id: ${senderId}`,
      meta: { name: senderName || undefined },
      upsertPairingRequest: pairing.upsertPairingRequest,
      onCreated: () => {
        log(`seatalk pairing request sender=${senderId}`);
      },
      sendPairingReply: async (text) => {
        await sendSeaTalkMessage(chatId, text, config);
      },
      onReplyError: (err) => {
        log(`seatalk pairing reply failed for ${senderId}: ${String(err)}`);
      },
    });
    return; // Do not process the message body yet
  }

  // 5. Deny path
  if (accessDecision.decision !== "allow") {
    log(`Blocked seatalk sender ${senderId} (dmPolicy=${dmPolicy})`);
    return;
  }

  // 6. Continue with authorized message handling...
}
```

### 3. Plugin definition (`src/channel.ts`)

```typescript
export const seatalkPlugin: ChannelPlugin<SeaTalkConfigSchema> = {
  // ... existing fields

  // Updated config schema
  configSchema: {
    dmPolicy: {
      type: "string",
      enum: ["open", "allowlist", "pairing"],
      default: "pairing", // recommended default
    },
    // ...
  },

  // New pairing adapter
  pairing: {
    upsertPairingRequest: async (params) => {
      const pairing = createScopedPairingAccess({
        core: params.core,
        channel: "seatalk",
        accountId: params.accountId,
      });
      return await pairing.upsertPairingRequest(params);
    },
    readAllowFromStore: async (params) => {
      const pairing = createScopedPairingAccess({
        core: params.core,
        channel: "seatalk",
        accountId: params.accountId,
      });
      return await pairing.readAllowFromStore();
    },
    listPendingRequests: async (params) => {
      const pairing = createScopedPairingAccess({
        core: params.core,
        channel: "seatalk",
        accountId: params.accountId,
      });
      return await pairing.listPendingRequests();
    },
    deletePairingRequest: async (params) => {
      const pairing = createScopedPairingAccess({
        core: params.core,
        channel: "seatalk",
        accountId: params.accountId,
      });
      return await pairing.deletePairingRequest(params.id);
    },
  },
};
```

## CLI examples

```bash
# List channels that support pairing (should include seatalk)
openclaw pairing list

# List pending requests
openclaw pairing pending seatalk

# Approve a user
openclaw pairing approve seatalk ABC123

# Reject a user
openclaw pairing reject seatalk DEF456

# Clear all pending requests
openclaw pairing clear seatalk
```

## Configuration examples

### Basic

```json
{
  "channels": {
    "seatalk": {
      "enabled": true,
      "mode": "relay",
      "dmPolicy": "pairing",
      "relay": {
        "url": "wss://seatalk-relay.example.com/ws",
        "authToken": "..."
      }
    }
  }
}
```

### Config `allowFrom` plus pairing store

Static IDs stay in `allowFrom`; users approved through pairing are stored in the pairing store.

```json
{
  "channels": {
    "seatalk": {
      "dmPolicy": "pairing",
      "allowFrom": ["11111", "22222"]
    }
  }
}
```

## Backward compatibility

| Setting | Behavior | Compatibility |
|--------|----------|---------------|
| `dmPolicy: "open"` | Any user can message | Unchanged |
| `dmPolicy: "allowlist"` | Only `allowFrom` users | Unchanged |
| `dmPolicy: "pairing"` | `allowFrom` plus pairing approvals | New |

## Test plan

### Manual

1. Edit `~/.openclaw/openclaw.json`, set `dmPolicy: "pairing"`.
2. Restart the OpenClaw gateway.
3. Message the bot from a test SeaTalk account.
4. Confirm a pairing code reply.
5. Run `openclaw pairing pending seatalk` and verify the request.
6. Run `openclaw pairing approve seatalk <code>`.
7. Send again from the test account.
8. Confirm the message is handled.

### Edge cases

- Repeat requests (do not mint a new code unnecessarily).
- Mix of config `allowFrom` and store `allowFrom`.
- WSS disconnect: reply fails (log error).
- Approve with a wrong code fails as expected.

## Effort estimate

| Phase | Files | LOC | Time |
|-------|-------|-----|------|
| Config schema | 1 | ~5 | 5 min |
| Bot logic | 1 | ~80 | 30 min |
| Plugin adapter | 1 | ~60 | 20 min |
| Testing | — | — | 30 min |
| Documentation | 1 | ~50 | 15 min |
| **Total** | 4 | ~195 | ~1.5 h |

## Reference implementations

In the **openclaw** repo:

- **Zalouser** — `extensions/zalouser/`
  - `src/monitor.ts` (message handling with pairing)
  - `src/channel.ts` (plugin pairing adapter)
- **Core pairing** — `src/pairing/`
  - `pairing-challenge.ts` — `issuePairingChallenge`
  - `scoped-access.ts` — `createScopedPairingAccess`

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Regressions for allowlist | Low | High | Use shared `resolveDmGroupAccessWithLists` |
| WSS reply failures | Medium | Medium | Error handling; operators use `pairing pending` |
| Users confused by flow | Medium | Low | Clear reply copy and docs |
| Pairing store permissions | Low | Medium | Follow standard SDK patterns |

## Success criteria

- `dmPolicy: "pairing"` works end-to-end.
- `openclaw pairing *` supports `seatalk`.
- Existing `open` / `allowlist` behavior unchanged.
- Documentation complete.
- Tests pass.
</think>
Fixing the invalid JSON in the mixed-config example.

<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>
StrReplace