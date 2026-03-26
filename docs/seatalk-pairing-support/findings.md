# Findings: SeaTalk Pairing Support Analysis

## Research Date
2024-12-XX

## Key Discoveries

### 1. OpenClaw Pairing 架构

#### Core Mechanism (`src/pairing/`)
```typescript
// openclaw/src/pairing/pairing-challenge.ts
export async function issuePairingChallenge(params: PairingChallengeParams): Promise<{
  created: boolean;
  code?: string;
}>;

// 参数结构
type PairingChallengeParams = {
  channel: string;           // "seatalk"
  senderId: string;           // 用户 ID
  senderIdLine: string;       // 可读 ID（给用户看）
  meta?: Record<string, string | undefined>; // 存储用户 name 等
  upsertPairingRequest: (params) => Promise<{ code: string; created: boolean }>;
  sendPairingReply: (text: string) => Promise<void>;
  buildReplyText?: (params) => string; // 可选，自定义回复文本
  onCreated?: (params: { code: string }) => void;
  onReplyError?: (err: unknown) => void;
};
```

#### Pairing Store
- 位置：`~/.openclaw/pairing/` 或 config 指定路径
- 每个 channel 独立存储
- 格式：JSON，包含 pending requests 和 approved allowFrom

#### CLI Commands
```bash
openclaw pairing list                    # 列出支持 pairing 的 channels
openclaw pairing pending <channel>       # 查看待审批请求
openclaw pairing approve <channel> <code> # 批准用户
openclaw pairing reject <channel> <code>  # 拒绝用户
openclaw pairing clear <channel>          # 清除所有待审批
```

### 2. Zalouser 参考实现

#### Config Schema (`extensions/zalouser/src/config-schema.ts`)
```typescript
export const DmPolicySchema = z.enum(["open", "allowlist", "pairing"]);
// 默认值：pairing
```

#### Message Handling Pattern (`extensions/zalouser/src/monitor.ts:255-426`)
```typescript
async function handleZalouserMessage(...) {
  // 1. 创建 scoped pairing access
  const pairing = createScopedPairingAccess({
    core,
    channel: "zalouser",
    accountId: account.accountId,
  });

  // 2. 读取 store allowFrom（仅当需要时）
  const storeAllowFrom =
    !isGroup && dmPolicy !== "allowlist" && (dmPolicy !== "open" || shouldComputeCommandAuth)
      ? await pairing.readAllowFromStore().catch(() => [])
      : [];

  // 3. 统一决策
  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup,
    dmPolicy,
    groupPolicy,
    allowFrom: configAllowFrom,
    groupAllowFrom: configGroupAllowFrom,
    storeAllowFrom,
    isSenderAllowed: (allowFrom) => isSenderAllowed(senderId, allowFrom),
  });

  // 4. 处理 pairing decision
  if (!isGroup && accessDecision.decision === "pairing") {
    await issuePairingChallenge({
      channel: "zalouser",
      senderId,
      senderIdLine: `Your Zalo user id: ${senderId}`,
      meta: { name: senderName || undefined },
      upsertPairingRequest: pairing.upsertPairingRequest,
      onCreated: () => {
        logVerbose(core, runtime, `zalouser pairing request sender=${senderId}`);
      },
      sendPairingReply: async (text) => {
        await sendMessageZalouser(chatId, text, { profile: account.profile });
        statusSink?.({ lastOutboundAt: Date.now() });
      },
      onReplyError: (err) => {
        logVerbose(core, runtime, `zalouser pairing reply failed for ${senderId}: ${String(err)}`);
      },
    });
    return; // 重要：pairing 后直接返回，不处理消息
  }

  // 5. 处理其他 deny cases
  if (!isGroup && accessDecision.decision !== "allow") {
    if (accessDecision.reasonCode === DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED) {
      logVerbose(core, runtime, `Blocked zalouser DM from ${senderId} (dmPolicy=disabled)`);
    } else {
      logVerbose(core, runtime, `Blocked unauthorized zalouser sender ${senderId} (dmPolicy=${dmPolicy})`);
    }
    return;
  }

  // 6. 继续处理已授权消息...
}
```

#### Plugin Definition (`extensions/zalouser/src/channel.ts:100-150`)
```typescript
export const zalouserPlugin: ChannelPlugin<ZalouserConfigSchema> = {
  // ... other fields
  configSchema: {
    type: "object",
    properties: {
      dmPolicy: {
        type: "string",
        enum: ["open", "allowlist", "pairing"],
        default: "pairing", // 默认启用 pairing
      },
      // ...
    },
  },
  pairing: {
    upsertPairingRequest: async (params) => {
      const pairing = createScopedPairingAccess({
        core: params.core,
        channel: "zalouser",
        accountId: params.accountId,
      });
      return await pairing.upsertPairingRequest(params);
    },
    readAllowFromStore: async (params) => {
      const pairing = createScopedPairingAccess({
        core: params.core,
        channel: "zalouser",
        accountId: params.accountId,
      });
      return await pairing.readAllowFromStore();
    },
    listPendingRequests: async (params) => {
      const pairing = createScopedPairingAccess({
        core: params.core,
        channel: "zalouser",
        accountId: params.accountId,
      });
      return await pairing.listPendingRequests();
    },
    deletePairingRequest: async (params) => {
      const pairing = createScopedPairingAccess({
        core: params.core,
        channel: "zalouser",
        accountId: params.accountId,
      });
      return await pairing.deletePairingRequest(params.id);
    },
  },
};
```

### 3. SeaTalk 现有实现分析

#### Config Schema (`src/config-schema.ts`)
```typescript
export const DmPolicySchema = z.enum(["open", "allowlist"]);
// ❌ 缺少 "pairing"
```

#### Message Handling (`src/bot.ts:210-313`)
```typescript
export async function handleSeaTalkMessage(...) {
  // 当前简单的 allowlist 检查
  if (dmPolicy === "allowlist") {
    const isAllowed = (allowFrom ?? [])
      .map((v) => String(v))
      .some((allowed) => allowed === senderId);

    if (!isAllowed) {
      log(`sender ${senderId} not in allowlist, dropping`);
      return; // ❌ 直接 drop，没有 pairing 流程
    }
  }
  // 继续处理消息...
}
```

#### Plugin Definition (`src/channel.ts:40-60`)
```typescript
configSchema: {
  dmPolicy: {
    type: "string",
    enum: ["open", "allowlist"], // ❌ 缺少 "pairing"
  },
},
// ❌ 没有 plugin.pairing adapter
```

### 4. SDK 可用工具

#### From `openclaw/plugin-sdk/index.ts`
```typescript
// Pairing
export { issuePairingChallenge } from "../pairing/pairing-challenge.js";
export { createScopedPairingAccess } from "../pairing/scoped-access.js";

// Access Control
export { resolveDmGroupAccessWithLists } from "../channels/dm-group-access.js";
export { DM_GROUP_ACCESS_REASON } from "../channels/dm-group-access.js";

// Utilities
export { logVerbose } from "../runtime/runtime-env.js";
```

#### `createScopedPairingAccess` 返回对象
```typescript
interface ScopedPairingAccess {
  upsertPairingRequest: (params: { id: string; meta?: PairingMeta }) => Promise<{
    code: string;
    created: boolean;
  }>;
  readAllowFromStore: () => Promise<string[]>;
  listPendingRequests: () => Promise<Array<{
    id: string;
    code: string;
    createdAt: number;
    meta?: PairingMeta;
  }>>;
  deletePairingRequest: (id: string) => Promise<void>;
}
```

### 5. SeaTalk 特殊注意事项

#### Sender ID 格式
- SeaTalk 使用数字 ID（如 `"23170"`）
- 需要确保 `senderId` 是 string 类型（pairing store key）
- `senderIdLine` 示例：`"Your SeaTalk user id: 23170"`

#### Message Sending
- 使用 `sendSeaTalkMessage(chatId, text, config)` 发送回复
- 需要处理 send 失败情况（relay disconnected）
- 建议添加 `onReplyError` handler

#### WSS Relay 考虑
- Pairing reply 可能在 WSS 重连时失败
- 建议 log 清晰的错误信息
- 用户可以通过 `openclaw pairing pending` 查看 code

### 6. 向后兼容性

#### 配置迁移
- 现有 `dmPolicy: "allowlist"` 配置继续工作
- 现有 `dmPolicy: "open"` 配置继续工作
- 用户可以选择迁移到 `"pairing"` 或保持现有设置

#### AllowFrom 组合
- `dmPolicy: "pairing"` 时：
  - `config.allowFrom` (静态配置) + `storeAllowFrom` (pairing 批准) 合并
  - 两者都生效
  - 用户可以混合使用（config 放长期用户，pairing 处理新用户）

### 7. 测试场景

#### 基本 Pairing 流程
1. 配置 `dmPolicy: "pairing"`，`allowFrom: []`
2. 新用户发送消息
3. 验证收到 pairing code 回复
4. `openclaw pairing pending seatalk` 显示请求
5. `openclaw pairing approve seatalk <code>` 批准
6. 用户重发消息，成功处理

#### 重复请求处理
1. 用户发送第一条消息，收到 code ABC123
2. 用户不等待批准，再发一条消息
3. **预期**：不重新生成 code，silent drop（zalouser 行为）
   - `upsertPairingRequest` 返回 `created: false`
   - `issuePairingChallenge` 返回 `{ created: false }`，不发送第二次回复

#### 混合 AllowFrom
1. 配置 `dmPolicy: "pairing"`，`allowFrom: ["11111"]`
2. 用户 11111 发送消息 → 直接通过（config allowlist）
3. 用户 22222 发送消息 → 触发 pairing
4. 批准用户 22222
5. 用户 22222 再发送 → 通过（store allowlist）

#### CLI 命令验证
```bash
# 发现 seatalk channel
openclaw pairing list
# 应包含 "seatalk"

# 查看待审批
openclaw pairing pending seatalk
# 应显示 pending 用户和 code

# 批准
openclaw pairing approve seatalk ABC123
# 应显示成功消息

# 拒绝
openclaw pairing reject seatalk DEF456
# 应显示成功消息

# 清除所有待审批
openclaw pairing clear seatalk
# 应清空 pending list
```

## Open Questions
1. ~~SeaTalk sender name 是否总是可用？~~
   - **Answer**: 从现有代码看，`senderName` 可能为空，使用 `meta: { name: senderName || undefined }` 兼容
2. ~~Relay WSS 断开时如何处理 pairing reply 失败？~~
   - **Answer**: 添加 `onReplyError` handler，log 错误；用户可通过 CLI 查看 pending requests
3. ~~是否需要在 onboarding 流程中提示 pairing 模式？~~
   - **Answer**: 可选，建议在 README 中说明；onboarding 可保持现有流程（default 仍为 "open"）

## References
- OpenClaw Pairing Core: `/Users/jianhua/workspace/github/openclaw/src/pairing/`
- Zalouser Implementation: `/Users/jianhua/workspace/github/openclaw/extensions/zalouser/`
- Plugin SDK Exports: `/Users/jianhua/workspace/github/openclaw/src/plugin-sdk/index.ts`
- Current SeaTalk Bot: `/Users/jianhua/workspace/github/openclaw-seatalk/src/bot.ts`
