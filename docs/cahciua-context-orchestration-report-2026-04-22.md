# Kairos vs Cahciua 上下文编排对比报告

日期：2026-04-22
范围：`/root/kairos-runtime`（当前实现） vs `/root/kairos-runtime/EXAMPLE/Cahciua`（参考实现）

## 1. 结论摘要

你这边“分不清谁是谁”不是单点问题，而是多处身份信息在编排链路里被弱化/丢失叠加导致：

1. **身份主键不稳定地进入 Prompt**（大量场景只剩显示名，且匿名/频道消息会变成 `unknown`）。
2. **消息归并策略会把不同发送者折叠**（`chatId:userId` 归并键 + `unknown` 发送者）。
3. **会话切分/召回偏语义，非拓扑优先**（容易把“说同一话题”的不同人混到同一会话上下文）。
4. **冷/热路径身份字段不一致**（热路径有 `username`，召回路径常退化成空 username + userId 字符串）。

`Cahciua` 在“谁是谁”上更稳，核心不是模型更强，而是它把身份作为一等结构化数据在全链路保真（Adaptation → Projection → Rendering），并且避免了语义会话切分对身份边界的干扰。

## 2. 对比矩阵（身份相关）

### 2.1 入口层（Telegram -> 内部消息）

- Kairos（当前）
  - `userbot-adapter` 对非 `PeerUser` 直接写成 `userId="unknown"`。
  - 回复目标解析只完整覆盖 `PeerUser`，频道/群实体回复目标容易丢。
  - 证据：`src/state-daemon/telegram/userbot-adapter.ts`（`userId` 回退 `unknown`，reply target 分支）。

- Cahciua
  - Bot API 侧优先 `sender_chat`（匿名管理员/频道发言不丢身份）。
  - GramJS 侧 `PeerUser/PeerChannel/PeerChat` 都映射为稳定 id 字符串。
  - 证据：`EXAMPLE/Cahciua/src/telegram/message/grammy.ts`、`.../gramjs.ts`。

### 2.2 中间状态层（会话/上下文存储）

- Kairos（当前）
  - `eventNormalizer` 用 `chatId:userId` 归并窗口 60s；若 `userId=unknown`，不同人可被合并。
  - 会话分配依赖 embedding + reranker + semantic recall，线程拓扑（reply chain）不是唯一主导。
  - 会话过期阈值 1 分钟，归档后依赖召回；召回路径中身份元数据进一步简化。
  - 证据：`src/state-daemon/gateway/eventNormalizer.ts`、`.../context/core/store.ts`。

- Cahciua
  - DCP 纯函数管线：事件先 canonical 化再 reducer，保持事件级身份与顺序。
  - Projection 显式维护 `users` 状态，检测改名并插入 `name_change` 系统事件。
  - reply 会快照 `replyToSender/replyToPreview/replyToContent`，身份与引用链更稳。
  - 证据：`EXAMPLE/Cahciua/src/adaptation/index.ts`、`.../projection/reduce.ts`、`.../projection/types.ts`。

### 2.3 渲染到 Prompt 层

- Kairos（当前）
  - XML 只给 `speaker`，其来源优先显示名，缺少稳定 `sender_id` 属性。
  - 召回消息在 VFS 客户端里常退化成 `username=""`、`replyToUserId=""`。
  - 证据：`src/state-daemon/utils/messageXml.ts`、`.../context/assembler.ts`、`.../storage/vfs/client.ts`。

- Cahciua
  - Rendering 保留 message id、sender、reply 链、name_change 事件，并把 mention 节点带 `uid`。
  - Driver 按时间线合并 RC + TR，不做“语义重分桶”后再喂模型。
  - 证据：`EXAMPLE/Cahciua/src/rendering/index.ts`、`.../driver/merge.ts`。

## 3. 直接导致“认错人”的高风险点（Kairos）

1. **`unknown` 身份坍缩**
   - 触发条件：匿名管理员、频道身份发言、非用户实体发送。
   - 结果：归并器/会话器把多人的消息视为同一 speaker。

2. **Prompt 中缺稳定身份键**
   - 只有 `speaker="显示名"`，同名用户或改名用户易混淆。

3. **语义召回覆盖身份边界**
   - 话题相近时，召回结果可能跨人跨线程。

4. **热路径与召回路径身份字段不对齐**
   - 一部分上下文是“有 name/handle”，另一部分是“空 name + id 字符串”，模型视角不一致。

## 4. 改造建议（按优先级）

### P0（先做，最快止血）

1. **把稳定 sender id 打进 XML**
   - 在 `<message>` / `<current_message>` 增加 `sender_id="<userId>"`，`speaker` 只做展示。

2. **修复非 PeerUser 身份**
   - `userbot-adapter` 不再回退 `unknown`；对 `PeerChannel/PeerChat` 生成稳定 id（如 `-100...` / `-...`）。

3. **禁用 `unknown` 参与消息归并**
   - `eventNormalizer` 对 `userId=unknown` 直接不 merge。

### P1（结构性提升）

4. **引入“改名事件”或身份版本化**
   - 参照 Cahciua 的 `user_renamed` 思路，把 displayName 变化显式写入上下文事件。

5. **回复链优先于语义切分**
   - 会话归属上把 `reply_to` 设为硬约束，语义仅作无 reply 时兜底。

6. **统一热/冷路径身份模型**
   - VFS 召回结构补齐 `username/usernameHandle/replyToUserId`，避免上下文身份字段断层。

### P2（架构演进）

7. **把“上下文构造”从策略脚本升级为确定性流水线**
   - 吸收 DCP 思路：Adaptation（保真）→ Projection（纯 reducer）→ Rendering（稳定 XML）→ Driver（副作用/工具循环）。

## 5. 为什么 Cahciua 看起来“更会认人”

简化成一句话：
**Cahciua 把身份当作结构化真值贯穿全链路；Kairos 目前把身份更多当作展示字段和召回过滤条件。**
前者天然抗“同名/改名/匿名/跨线程”，后者在这些场景下会累积误差。

## 6. 附：关键证据路径

- Kairos
  - `src/state-daemon/telegram/userbot-adapter.ts`
  - `src/state-daemon/gateway/eventNormalizer.ts`
  - `src/state-daemon/gateway/context/core/store.ts`
  - `src/state-daemon/utils/messageXml.ts`
  - `src/state-daemon/gateway/context/assembler.ts`
  - `src/state-daemon/storage/vfs/client.ts`

- Cahciua
  - `EXAMPLE/Cahciua/src/telegram/message/grammy.ts`
  - `EXAMPLE/Cahciua/src/telegram/message/gramjs.ts`
  - `EXAMPLE/Cahciua/src/adaptation/index.ts`
  - `EXAMPLE/Cahciua/src/projection/reduce.ts`
  - `EXAMPLE/Cahciua/src/rendering/index.ts`
  - `EXAMPLE/Cahciua/src/driver/merge.ts`
  - `EXAMPLE/Cahciua/dcp-updates.md`
