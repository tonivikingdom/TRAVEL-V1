# ADR-0004：P1B2 站内通知与私有对象存储边界

- 状态：Accepted for P1B2
- 日期：2026-09-18

## 背景

P1B2 需要在没有 Trip/P2、正式 Attachment API、Push 或云对象存储选择的前提下，建立可复用的
站内通知与私有二进制基础设施。实现必须维持 P1A 的 owner 隔离，并避免把 Development/Test
文件系统细节固化到 application 或 domain。

## 决策

1. `NotificationEvent` 是 PostgreSQL 私有资源，使用 `(ownerUserId, dedupeKey)` 唯一约束提供
   可信生产者幂等。HTTP 只提供当前用户的稳定分页列表和 owner-only dismiss；不提供公共创建。
2. 新建 `packages/storage`，以流式 `put/open/delete/stat/exists` port 隔离 provider。
   `packages/application` 编排 owner、配额、状态与完整性，`packages/persistence` 保存元数据。
3. `StoredObject` 不保存 binary；只有 `READY` 可读。key 使用服务端 UUID，displayName 不参与路径。
4. Development/Test 使用隔离私有 root 的 Local Filesystem adapter：临时文件、实际长度/SHA-256、
   atomic rename、失败清理，并拒绝绝对路径、traversal、编码绕过与 symlink。
5. 总配额预留在 PostgreSQL 事务中，以 owner 的 advisory transaction lock 串行化；PENDING 与
   READY 均计入，FAILED/DELETED 释放配额。单文件限制和 MIME allowlist 在 application 校验。
6. O-09 限额通过环境配置。Development/Test 可用明确 SYNTHETIC 默认值；Staging/Production
   必须显式配置，但真实 provider 未经授权前保持 `OBJECT_STORAGE_PROVIDER_UNCONFIGURED`。
7. Compose 用独立命名卷验证写入、API 容器重建后持久性和删除，不暴露调试下载端点。
8. `StoredObject` 查询以 `(ownerUserId, objectId)` 为边界；不存在与属于其他 owner 的 ID
   对外统一为 `NOT_FOUND`。ADMIN 没有跨 owner 探测或读取例外。
9. 正式 Attachment/upload API 或 Staging/Production ObjectStorage 启用前，必须实现 stale
   PENDING reservation 的 expiry/reconciliation，并清理 provider 侧 orphan temporary/object。
   在该机制完成前，崩溃后遗留的 PENDING 可能持续占用 quota，因此这是上线硬闸门。

## 后果

- 未来 S3-compatible adapter 可复用同一 application 契约；当前本地适配器不能用于
  Staging/Production。
- 通知记录保留 dismissed 证据，客户端未来可依据 `dismissedAt` 显示或过滤。
- 数据库元数据与文件系统写入不是单一跨资源事务；失败路径将元数据标为 FAILED 并尽力清理
  文件，只有完整写入且元数据转换为 READY 后才能读取。
- 当前 P1B2 没有公开上传入口；PENDING reconciliation 不在本轮扩展实现，但不得在缺少该机制时
  开放正式 Attachment/upload 或 Staging/Production 存储。
- 本 ADR 不授权 P2、正式 Attachment API、文件解析、Push、真实云 provider 或 Production。
