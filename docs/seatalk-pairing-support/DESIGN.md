# SeaTalk Pairing Support - Design Overview

## 目标
让 `openclaw-seatalk` 支持 `dmPolicy: "pairing"`，实现动态 DM 授权，无需手动维护 `allowFrom` 配置。

## 工作流程

### 用户视角
```
1. 新用户发送消息到 SeaTalk bot
   ↓
2. Bot 回复：
   "Your SeaTalk user id: 23170
   
   To approve this pairing request, run:
   openclaw pairing approve seatalk ABC123"
   ↓
3. Operator 执行：openclaw pairing approve seatalk ABC123
   ↓
4. 用户重发消息，成功处理
```

### 技术流程
```
handleSeaTalkMessage()
  ↓
创建 scoped pairing access
  ↓
读取 storeAllowFrom（已批准用户）
  ↓
调用 resolveDmGroupAccessWithLists()
  ├─ "allow" → 处理消息
  ├─ "pairing" → issuePairingChallenge() → 发送 code
  └─ "deny" → drop message
```

## 核心改动

### 1. Config Schema (`src/config-schema.ts`)
```typescript
// Before
export const DmPolicySchema = z.enum(["open", "allowlist"]);

// After
export const DmPolicySchema = z.enum(["open", "allowlist", "pairing"]);
```

### 2. Bot Message Handler (`src/bot.ts`)
```typescript
// 新增 imports
import {
  issuePairingChallenge,
  createScopedPairingAccess,
  resolveDmGroupAccessWithLists,
  DM_GROUP_ACCESS_REASON,
} from "openclaw/plugin-sdk";

// 在 handleSeaTalkMessage() 中
export async function handleSeaTalkMessage(...) {
  // 1. 创建 pairing helper
  const pairing = createScopedPairingAccess({
    core,
    channel: "seatalk",
    accountId: "default", // or actual accountId
  });

  // 2. 读取 pairing store allowFrom
  const configAllowFrom = (config.channels?.seatalk?.allowFrom ?? []).map(String);
  const storeAllowFrom = dmPolicy !== "allowlist" && (dmPolicy !== "open" || needsCommandAuth)
    ? await pairing.readAllowFromStore().catch(() => [])
    : [];

  // 3. 统一决策
  const accessDecision = resolveDmGroupAccessWithLists({
    isGroup: false,
    dmPolicy,
    groupPolicy: "disabled", // SeaTalk 目前不需要 group
    allowFrom: configAllowFrom,
    groupAllowFrom: [],
    storeAllowFrom,
    isSenderAllowed: (allowFrom) => allowFrom.includes(senderId),
  });

  // 4. 处理 pairing
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
    return; // 不处理消息
  }

  // 5. 处理 deny
  if (accessDecision.decision !== "allow") {
    log(`Blocked seatalk sender ${senderId} (dmPolicy=${dmPolicy})`);
    return;
  }

  // 6. 继续处理已授权消息...
}
```

### 3. Plugin Definition (`src/channel.ts`)
```typescript
export const seatalkPlugin: ChannelPlugin<SeaTalkConfigSchema> = {
  // ... existing fields

  // 更新 config schema
  configSchema: {
    dmPolicy: {
      type: "string",
      enum: ["open", "allowlist", "pairing"],
      default: "pairing", // 推荐默认
    },
    // ...
  },

  // 新增 pairing adapter
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

## CLI 命令示例

```bash
# 查看支持 pairing 的 channels（应包含 seatalk）
openclaw pairing list

# 查看待审批请求
openclaw pairing pending seatalk

# 批准用户
openclaw pairing approve seatalk ABC123

# 拒绝用户
openclaw pairing reject seatalk DEF456

# 清除所有待审批
openclaw pairing clear seatalk
```

## 配置示例

### 用户配置
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

### 混合使用 config + pairing
```json
{
  "channels": {
    "seatalk": {
      "dmPolicy": "pairing",
      "allowFrom": ["11111", "22222"],  // 静态长期用户
      // 动态用户通过 pairing 批准，存储在 pairing store
    }
  }
}
```

## 向后兼容

| 配置 | 行为 | 兼容性 |
|------|------|--------|
| `dmPolicy: "open"` | 所有用户可发送 | ✅ 继续工作 |
| `dmPolicy: "allowlist"` | 仅 allowFrom 可发送 | ✅ 继续工作 |
| `dmPolicy: "pairing"` | allowFrom + pairing 批准 | ✅ 新功能 |

## 测试计划

### 手动测试步骤
1. 修改 `~/.openclaw/openclaw.json`，设置 `dmPolicy: "pairing"`
2. 重启 OpenClaw gateway
3. 使用测试 SeaTalk 账号发送消息
4. 验证收到 pairing code 回复
5. 执行 `openclaw pairing pending seatalk`，确认看到请求
6. 执行 `openclaw pairing approve seatalk <code>`
7. 测试账号重发消息
8. 验证消息成功处理

### Edge Cases
- ✅ 重复请求（不重新生成 code）
- ✅ 混合 config allowFrom + store allowFrom
- ✅ WSS 断开时 reply 失败（log error）
- ✅ 错误 code 批准失败

## 预估工作量

| 阶段 | 文件数 | LOC | 时间 |
|------|--------|-----|------|
| Config schema | 1 | ~5 | 5分钟 |
| Bot logic | 1 | ~80 | 30分钟 |
| Plugin adapter | 1 | ~60 | 20分钟 |
| Testing | - | - | 30分钟 |
| Documentation | 1 | ~50 | 15分钟 |
| **Total** | 4 | ~195 | ~1.5小时 |

## 参考实现
- **Zalouser**: `/Users/jianhua/workspace/github/openclaw/extensions/zalouser/`
  - `src/monitor.ts:255-426` - Message handling with pairing
  - `src/channel.ts:100-150` - Plugin pairing adapter
- **Core Pairing**: `/Users/jianhua/workspace/github/openclaw/src/pairing/`
  - `pairing-challenge.ts` - issuePairingChallenge function
  - `scoped-access.ts` - createScopedPairingAccess helper

## 风险评估

| 风险 | 可能性 | 影响 | 缓解措施 |
|------|--------|------|----------|
| 破坏现有 allowlist | 低 | 高 | 使用统一的 resolveDmGroupAccessWithLists |
| WSS reply 失败 | 中 | 中 | 添加错误处理，用户可通过 CLI 查看 pending |
| 用户不理解流程 | 中 | 低 | 清晰的回复文本和文档 |
| Pairing store 权限 | 低 | 中 | 遵循标准 SDK 模式 |

## 成功标准
✅ `dmPolicy: "pairing"` 配置可用
✅ CLI 命令 `openclaw pairing *` 支持 seatalk
✅ 现有 `open`/`allowlist` 不受影响
✅ 文档完整
✅ 所有测试通过
