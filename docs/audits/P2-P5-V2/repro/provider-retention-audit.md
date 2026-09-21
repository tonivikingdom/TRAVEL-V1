# Provider retention / attribution audit commands

以下命令只盘点本地 schema/code，不调用外部 Provider：

```powershell
rg -n "candidatePayload|selectedSnapshot|latestSnapshot|expiresAt" prisma packages apps
rg -n "routeCandidateSnapshot\.(delete|deleteMany)|FlightBinding.*retention|attribution" packages apps scripts
rg -n "provider.*SYNTHETIC|GOOGLE_CONSUMER_EXPERIMENTAL|AERODATABOX" packages/providers apps docs
```

在固定 baseline 上，Route snapshot 有 adoption expiry 但只有 P5B synthetic reset 删除；Flight snapshot 没有字段级 retention/cleanup。正式 enable provider 前，应把命令结果与账户实际合同、官方当期条款和 UI attribution requirement 对齐，并记录 reviewer/date。
