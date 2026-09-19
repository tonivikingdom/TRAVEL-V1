# P5B Staging Readiness Checklist

本文档是 readiness checklist，不是 Staging 或 Production 部署授权。P5B 内部验收通过
也不等于可以邀请真实用户。

## 当前硬阻塞

- [ ] 真实 Mail Provider 和 Git 外凭证未配置；capture mail 不得用于真实 Staging。
- [ ] 真实 Route Provider 未配置；SYNTHETIC candidate 不是真实班次。
- [ ] 真实 ObjectStorage Provider 未配置；本地文件系统 adapter 不可用于 Staging。
- [ ] HTTPS 与受控外部 ingress 未配置。
- [ ] Production/真实用户隐私、数据保留、恢复和备份闸门未完成。

## 允许的当前结论

只能记录“Development/Test 环境 ≤5 synthetic 用户的内部验收基线通过”。
不能宣称真实 Provider 可用、Staging 已可邀请真实用户或 Production ready。
