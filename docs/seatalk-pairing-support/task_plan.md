# Task Plan: SeaTalk Channel Pairing Support

## Goal
实现 `openclaw-seatalk` 插件的 `pairing` DM policy 支持，使用户能够通过 CLI 命令动态批准新的 DM 发送者，而不是依赖静态的 `allowFrom` 配置。

## Context
- **Current State**: SeaTalk plugin 只支持 `dmPolicy: "open"` 和 `"allowlist"`
- **Desired State**: 支持 `dmPolicy: "pairing"`，实现动态用户授权工作流
- **Reference Implementation**: `extensions/zalouser` 已完整实现 pairing 功能

## Architecture Overview

### OpenClaw Pairing 机制
```
1. 未授权用户发送消息
2. Plugin 调用 issuePairingChallenge()
   - 生成 6 位 pairing code
   - 存储到 pairing store
   - 回复用户 code 和指令
3. 用户收到 code（如：ABC123）
4. Operator 执行：openclaw pairing approve seatalk ABC123
5. 用户重发消息，通过授权检查
```

### SeaTalk 现有架构
```
SeaTalk Open Platform (webhook)
  ↓
seatalk-relay (WSS 转发)
  ↓
openclaw-seatalk plugin (bot.ts 处理消息)
  ↓ 当前逻辑
handleSeaTalkMessage()
  - dmPolicy check (only "open"/"allowlist")
  - 如果不在 allowFrom，drop message
```

## Phases

### Phase 1: 架构设计与依赖分析 ✅
**Status**: `complete`
**Duration**: 已完成
**Dependencies**: None

**Tasks**:
- [x] 研究 OpenClaw core pairing 机制
- [x] 分析 zalouser 参考实现
- [x] 识别需要修改的文件
- [x] 设计改动方案

**Key Findings**:
- `issuePairingChallenge` 已在 `openclaw/plugin-sdk` export
- zalouser 使用 `createScopedPairingAccess` 创建 pairing helper
- 需要实现 `plugin.pairing` adapter（可选但推荐，用于 CLI 发现）

### Phase 2: 配置 Schema 扩展
**Status**: `pending`
**Estimated Files**: 1 file
**Dependencies**: Phase 1

**Tasks**:
- [ ] 修改 `src/config-schema.ts`
  - [ ] 更新 `DmPolicySchema` 从 `z.enum(["open", "allowlist"])` 到 `z.enum(["open", "allowlist", "pairing"])`
  - [ ] 添加 JSDoc 说明 pairing 模式
- [ ] 验证配置解析正确

**Acceptance Criteria**:
- `dmPolicy: "pairing"` 可以在 `openclaw.json` 中设置且不报错
- TypeScript 类型推导正确

### Phase 3: Bot 消息处理逻辑扩展
**Status**: `pending`
**Estimated Files**: 1 file
**Dependencies**: Phase 2

**Tasks**:
- [ ] 修改 `src/bot.ts` 的 `handleSeaTalkMessage()`
  - [ ] Import `issuePairingChallenge`, `createScopedPairingAccess`
  - [ ] 在 DM policy check 之前创建 `pairing` helper
  - [ ] 使用 `resolveDmGroupAccessWithLists` 替代现有简单 allowlist 检查
  - [ ] 当 `accessDecision.decision === "pairing"` 时调用 `issuePairingChallenge`
    - 传递 `senderId`（数字 ID，如 23170）
    - 传递 `senderIdLine`（可读格式，如 "Your SeaTalk user id: 23170"）
    - 传递 `meta: { name: senderName || undefined }`
    - 传递 `sendPairingReply` 函数（调用 `sendSeaTalkMessage`）
- [ ] 处理 pairing store 的 `allowFrom` 读取（用于已批准用户）
- [ ] 添加日志记录 pairing 事件

**Acceptance Criteria**:
- 未授权用户发送消息时收到 pairing code
- 用户可以使用 `openclaw pairing approve seatalk <code>` 批准
- 批准后用户可以正常发送消息

### Phase 4: Channel Plugin 定义更新
**Status**: `pending`
**Estimated Files**: 1 file
**Dependencies**: Phase 3

**Tasks**:
- [ ] 修改 `src/channel.ts`
  - [ ] 更新 `configSchema.dmPolicy.enum` 包含 `"pairing"`
  - [ ] 添加 `plugin.pairing` adapter（参考 zalouser）
    - 实现 `upsertPairingRequest`
    - 实现 `readAllowFromStore`
    - 实现 `listPendingRequests`
    - 实现 `deletePairingRequest`
  - [ ] 更新 status snapshot 默认 `dmPolicy: "pairing"`

**Acceptance Criteria**:
- `openclaw pairing list` 包含 "seatalk" channel
- `openclaw pairing pending seatalk` 显示待审批请求
- pairing 操作符合 OpenClaw CLI 规范

### Phase 5: Onboarding 流程更新（可选）
**Status**: `pending`
**Estimated Files**: 1 file
**Dependencies**: Phase 4

**Tasks**:
- [ ] 评估是否需要修改 `src/onboarding.ts`
- [ ] 如果需要：更新 onboarding 流程提示 pairing 模式
- [ ] 确保 quickstart 文档提及 pairing 选项

**Acceptance Criteria**:
- Onboarding 流程不阻塞 pairing 配置
- 文档清晰说明三种 dmPolicy 的区别

### Phase 6: 测试与验证
**Status**: `pending`
**Estimated Files**: N/A
**Dependencies**: Phase 5

**Tasks**:
- [ ] 单元测试（如果项目有测试框架）
- [ ] 手动集成测试
  - [ ] 配置 `dmPolicy: "pairing"`
  - [ ] 使用测试账号发送消息
  - [ ] 验证 pairing code 发送
  - [ ] 执行 `openclaw pairing approve seatalk <code>`
  - [ ] 重发消息，确认通过授权
  - [ ] 测试 `openclaw pairing list/pending` 命令
- [ ] Edge cases
  - [ ] 重复 pairing 请求（不重新生成 code）
  - [ ] 过期 code 处理
  - [ ] 错误 code 拒绝

**Acceptance Criteria**:
- 所有测试通过
- 没有回归问题
- 日志清晰可诊断

### Phase 7: 文档更新
**Status**: `pending`
**Estimated Files**: 1-2 files
**Dependencies**: Phase 6

**Tasks**:
- [ ] 更新 `README.md`
  - [ ] 添加 pairing 模式说明
  - [ ] 提供示例配置
  - [ ] 添加 CLI 命令示例
- [ ] 如果有用户文档，同步更新

**Acceptance Criteria**:
- README 清晰说明三种 dmPolicy 模式
- 提供完整的 pairing 工作流示例
- CLI 命令文档完整

## Files to Modify

| File | Purpose | Estimated LOC Change |
|------|---------|---------------------|
| `src/config-schema.ts` | 扩展 dmPolicy enum | +5 |
| `src/bot.ts` | Pairing 逻辑实现 | +60~80 |
| `src/channel.ts` | Plugin pairing adapter | +40~60 |
| `src/onboarding.ts` | Onboarding 提示（可选） | +10~20 |
| `README.md` | 文档更新 | +30~50 |
| **Total** |  | ~145~215 LOC |

## Key Dependencies

### External Imports (from openclaw/plugin-sdk)
- `issuePairingChallenge` - 核心 pairing challenge 函数
- `createScopedPairingAccess` - 创建 channel-scoped pairing helper
- `resolveDmGroupAccessWithLists` - 统一的 DM/Group 访问决策

### Internal Functions
- `sendSeaTalkMessage` - 用于发送 pairing reply
- `handleSeaTalkMessage` - 主消息处理函数（需修改）

## Non-Goals (Out of Scope)
- 修改 seatalk-relay（无需更改）
- 修改 OpenClaw core pairing 机制
- 支持 group pairing（SeaTalk groups 不需要）
- 实现 custom pairing code 格式（使用默认 6 位）

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| 破坏现有 allowlist 功能 | 使用 `resolveDmGroupAccessWithLists`，保持向后兼容 |
| pairing store 权限问题 | 遵循 zalouser 模式，使用标准 SDK 函数 |
| WSS 连接不稳定导致 reply 失败 | 添加错误处理和日志，参考 zalouser `onReplyError` |
| 用户不理解 pairing 流程 | 提供清晰的回复消息和文档 |

## Success Criteria
1. `dmPolicy: "pairing"` 可以正常工作
2. CLI 命令 `openclaw pairing *` 支持 seatalk channel
3. 现有 `open` 和 `allowlist` 模式不受影响
4. 文档完整且易于理解
5. 无性能回归

## Errors Encountered
_None yet_

## Progress Notes
- 2024-12-XX: 完成架构分析，创建 task plan
