# BayesNet — 离散贝叶斯网络精确推断后端

纯本地运行的离散贝叶斯网络精确推断系统：TypeScript + Node.js（内置 `node:sqlite`）。
仅提供 HTTP API、CLI、虚构网络夹具和自动化测试；不含网页、语言模型训练或任何外部推断服务调用。

## 范围

- 有限状态离散变量与状态集合
- 有向无环依赖（DAG）与每个父状态组合一行、逐行归一化的条件概率表（CPT）
- 网络版本（草稿/活跃/归档）、观测证据、查询方案与冻结结果
- 自行实现的因子乘法、证据限制、边缘化与变量消元（Variable Elimination）
- 返回查询变量的联合后验、证据概率 `P(evidence)` 及逐步消元摘要
- 独立核验器：对小网络枚举完整联合分布
- 全程**对数空间**（`log-sum-exp`）防止下溢；确定性零概率保持为 `log(0)`，不添加任何 epsilon
- 因子单元预算超限返回 `RESOURCE_EXHAUSTED`，绝不误判为不可能事件
- 报告明确区分观测条件 `P(Q|E)` 与因果干预 `do(E)`

## 明确拒绝的非法输入

| 情况 | 错误码 |
| --- | --- |
| 有向环 | `CYCLE` |
| 重复状态 | `DUPLICATE_STATE` |
| 未知父变量 | `MISSING_PARENT` |
| CPT 缺行 / 子状态缺失 | `CPT_MISSING_ROW` |
| CPT 多余行 / 非法父状态 | `CPT_EXTRA_ROW` |
| 和不为 1 或全零行 | `CPT_NOT_NORMALIZED` |
| 负概率 | `NEGATIVE_PROBABILITY` |
| 未知变量或状态的证据 | `ILLEGAL_EVIDENCE` |
| 零概率证据 | 结果中 `impossible: true`、`evidenceProbability: 0` |
| 因子规模超预算 | `RESOURCE_EXHAUSTED` |

父变量顺序不影响数值：CPT 按 `parentStates` 映射解析，父序置换有专门测试。

## 环境要求

- Node.js >= 22.5（开发环境为 Node 25，使用内置实验模块 `node:sqlite`，运行时自动加 `--no-warnings`）
- Windows / macOS / Linux
- 无需系统级 SQLite、无需联网安装原生模块

## 安装与构建

```powershell
npm install
npm run build
```

## 测试

```powershell
npm test
```

测试覆盖（共 41 个用例，5 个套件）：

- 因子乘法、限制、边缘化、零概率语义
- 独立节点、链、共同原因、碰撞点、确定性 XOR、不可能证据
- 小网络完整联合枚举与 VE 结果一致性
- 后验归一、证据插入顺序不变、所有合法消元顺序一致、父序置换
- 极小概率（`1e-6` 十重证据）的数值稳定性
- 资源预算不足错误码
- 事务回滚（计划插入后推断失败则不留记录）
- 幂等键重复提交返回同一冻结结果
- 关闭重开后的持久化、旧版本归档隔离、版本比较
- API 参数校验、错误码、分页与 malformed JSON

测试使用临时目录 `./data/test-*` / `./data/api-test`（注入时钟与随机 ID），由 Jest 清理。

## 端到端演示（可重复）

```powershell
npm run demo
```

演示会重建独立的 `./data/demo` 数据库，展示建网前后计数、校验、证据存取、
边缘查询、逐步消元解释、幂等重放以及资源不足的预期失败。

## 启动 HTTP API

```powershell
npm start
```
- 只监听 `127.0.0.1`，端口自动分配（`BN_PORT` 可指定首选端口，占用时仍自动选择）。
- 实际端口写入 `./data/server.port`。
- 数据默认存放于 `./data/bayesnet.sqlite`（可用 `BN_DATA_DIR` / `BN_DB` 覆盖，仍在本项目内）。

### 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/networks?limit=&offset=` | 分页列出网络 |
| POST | `/networks` | 创建并校验网络 |
| GET | `/networks/:id` | 网络详情 |
| POST | `/networks/:id/validate` | 重新校验 |
| GET | `/networks/:id/versions` | 版本链分页 |
| POST | `/networks/:id/revisions` | 由旧版本派生新版本（旧版本归档） |
| POST | `/compare` | 比较两个版本的节点差异 |
| GET/POST | `/networks/:id/evidence` | 证据分页 / 保存证据 |
| GET | `/networks/:id/plans` | 查询方案分页 |
| GET | `/networks/:id/results` | 冻结结果分页 |
| POST | `/networks/:id/queries` | 执行查询（支持 `idempotencyKey`） |
| POST | `/networks/:id/verify` | 用完整枚举独立核验 |

错误响应统一为 `{ "ok": false, "error": { "code", "message", "details" } }`。

### curl 示例

```powershell
$port = Get-Content ./data/server.port
Invoke-RestMethod "http://127.0.0.1:$port/health"
```

```json
POST /networks/:id/queries
{
  "name": "wet-given-rain",
  "plan": {
    "variables": ["W"],
    "evidence": { "R": "r1" },
    "ordering": "min-fill",
    "factorCellBudget": 1000000,
    "idempotencyKey": "run-001"
  }
}
```

## CLI

构建后可用 `node dist/cli/index.js <command>`（或 `npm link` 后使用 `bn`）：

```powershell
node dist/cli/index.js init-fixture --name chain
node dist/cli/index.js create --file network.json
node dist/cli/index.js validate --id chain
node dist/cli/index.js show --id chain
node dist/cli/index.js list --limit 20
node dist/cli/index.js evidence --id chain --name rained --set R=r1
node dist/cli/index.js query  --id chain --vars W --evidence-name rained --ordering min-fill --key run-001
node dist/cli/index.js explain --id chain --vars S,W --set R=r1
node dist/cli/index.js revise --id chain --file network-v2.json
node dist/cli/index.js compare --a chain --b chain-v2
```

关键命令打印操作前后的计数或状态（网络状态、证据数、冻结结果数）。
`explain` 输出每一步合并了哪些因子、消元前后单元数、顺序与峰值规模。

## 停止与清理（只管理本项目进程/文件）

- 前台服务：在终端按 `Ctrl+C`（SIGINT/SIGTERM 优雅关闭）。
- 通过端口文件停止本项目服务并清理临时目录：

```powershell
npm run clean
```

`clean` 只按 `./data/server.port` 查找监听进程，并只删除 `./data/demo`、
`./data/api-test` 与 `./data/test-*`；不会删除主数据库，也不触碰其他项目。

## 持久化与迁移

- 所有写入在 SQLite 事务中完成；推断抛错时事务回滚。
- 模式迁移使用 `CREATE TABLE IF NOT EXISTS`，可重复执行（有专门测试）。
- 冻结结果连同网络版本号存储，归档版本拒绝新查询，旧结果保持隔离。

## 目录结构

```
src/
  inference/factor.ts        因子表示、乘法、限制、边缘化
  inference/network.ts       DAG/CPT 校验、CPT 因子构造
  inference/elimination.ts   变量消元 + 启发式顺序 + 单元预算
  inference/enumeration.ts   全联合枚举独立核验器
  fixtures.ts                六类虚构网络 + 稀有事件网络
  db.ts repository.ts        SQLite 迁移与仓库
  service.ts                 用例编排、幂等、版本、事务
  api.ts server.ts           本机 HTTP API
  cli/index.ts               命令行
tests/                       Jest 自动化测试
scripts/demo.js clean.js     可重复演示 / 项目内清理
```
