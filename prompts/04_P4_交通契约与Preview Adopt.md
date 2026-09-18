# P4｜交通契约与Preview Adopt
**本文件是后续阶段预案；只有前一阶段验收、用户明确授权后才能执行。**

推荐模型：GPT-5.6 Sol  
推荐推理强度：Extra High（xhigh）  
备选与升级：明确实现可Luna/Max；涉及安全/事务/时间模型的独立审查用Sol/Extra High。实际可用性先核对，不自动修改全局模型配置。

## 执行前
读取AGENTS.md、docs/00、02、03、04、05、06、08及上一阶段status。检查最新main和工作区；创建`feature/p4-04`。如果上一阶段未合并或代码与本包提案不同，先核对真实结构，不猜文件路径。

## 本次范围
完成Provider契约与小规模真实字段探针（凭证具备且授权调用时）；返回候选/错误/来源/新鲜度，不依赖某家API的原始JSON污染domain。
实现无正式写入的Query/Preview和带版本、有效期、幂等的Adopt事务；短时单步Undo不覆盖新事实。
独立CandidateGenerator/RecommendationPolicy：固定测试输入下给真实可解释候选，最多1+2；费用/质量/外部预约条件未知则明确。未确认策略仅配置/接口，不散落硬编码。

## 禁止范围
不自动订票/改签/叫车/改预约；不偷偷用fallback；不承诺所有国家时刻表覆盖；不把fixture作为staging真实交通结果；不把首轮debug当真实旅行保障。

## 验收
过期Preview拒绝；两设备并发采用最多一次；重试不重复Visit；失败整体回滚；无网服务失败不同于无车；候选未采用不改正式Trip；Undo遇到新版本拒绝。

## 交付
执行真实lint/typecheck/tests/build和适用集成验收。更新status与ADR；分逻辑commit、push、创建PR，不自动merge。
最终交回分支/SHA/PR、测试证据、未完成项。只完成P4，不自动执行下一阶段。
