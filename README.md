# 离散贝叶斯网络精确推断后端

纯本地运行的离散贝叶斯网络（Bayesian Network）精确推断后端。使用 **TypeScript + Node.js（内置 `node:sqlite`）**，零第三方运行时依赖；不提供网页、不训练模型、不调用任何外部推断服务。

## 能力范围

- 管理有限状态离散变量及状态集合、有向依赖（父变量）、条件概率表（CPT）。
- 网络多版本冻结存储、观测证据集、查询方案与冻结查询结果（SQLite 持久化）。
- 自行实现：因子乘法、证据限制（restriction）、边缘化、变量消元（Variable Elimination）。
- 返回查询变量的**联合后验**、**证据概率 P(e)**、逐步消元摘要（参与因子、中间规模、消元顺序）。
- 数值策略：因子全程以**自然对数概率**存储，乘法变加法，求和使用 log-sum-exp；零概率为 `-Infinity`，**绝不加 epsilon 伪造后验**。
- 校验：无环（DAG）、状态无重复、CPT 每个父状态组合恰好一行且归一、无负概率、证据变量/状态合法。
- 零概率证据返回 `impossible: true`、`P(e)=0`；因子规模超预算返回 `RESOURCE_EXHAUSTED`，**不会误判为不可能事件**。
- 消元顺序可选 `minFill` / `minDegree` / 自定义；不同合法顺序数学结果一致（有自动化测试核对）。
- 语义边界：观测证据是条件化 `P(X|e)`，**不是因果干预 `do(e)`**；API、CLI 和冻结结果中均明确声明。
- API 提供参数校验、明确错误码、分页；重复提交使用 `idempotencyKey` 幂等；HTTP 仅绑定 `127.0.0.1` 自动空闲端口。

## 环境要求

- Node.js >= 22（推荐 24/25；需要内置实验性模块 `node:sqlite`，运行时会出现一条 ExperimentalWarning，可忽略）。

## 安装

```powershell
npm install
```

## 构建

```powershell
npm run build
```

## 自动化测试

```powershell
npm test
```

共 28 个测试，覆盖：

- 独立节点、链、共同原因、碰撞点、确定性 XOR、不可能证据六种夹具；
- 对小网穷举全部联合分布作为独立核验；后验归一；证据顺序不变；父序置换数值不变；
- 极小概率（1e-300）数值稳定；资源预算报错与错误码；
- 事务回滚、重启持久化、旧版本隔离、重复迁移幂等、查询幂等、分页、证据跨版本拒绝；
- HTTP API 全流程、错误码、回环绑定校验。

## 可重复端到端演示

```powershell
npm run demo
```

演示自动重建 `.bayes-demo/` 下的数据库（时间/ID 注入、结果可重复），逐段展示先验/后验、消元步骤、不可能证据、资源不足、版本比较和幂等。

## 启动 API 服务

```powershell
npm start
```

- 仅监听 `http://127.0.0.1:<自动端口>`，启动后在终端打印实际端口，并写入 `.bayes/server.pid`。
- 数据库与所有临时文件都在项目目录 `.bayes/` 内。

停止（只终止 pid 文件记录的**本项目**进程）：

```powershell
npm run stop
```

### 主要 HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/fixtures` | 虚构网络夹具清单 |
| POST | `/networks` | 建网（严格校验，失败整体回滚） |
| POST | `/networks/:id/fixture/:name` | 载入内置夹具 |
| GET | `/networks/:id?version=N` | 读取某版本网络 |
| GET | `/networks/:id/versions` | 版本列表 |
| GET | `/networks/:id/compare?v1=1&v2=2` | 比较版本差异 |
| POST | `/evidence` | 保存证据集 |
| POST | `/query` | 联合后验查询（冻结结果） |
| POST | `/networks/:id/marginal/:var` | 单变量边缘分布 |
| POST | `/explain` | 逐步消元解释 + 策略/边界声明 |
| POST | `/enumerate` | 穷举联合分布（小网独立核验用） |
| GET | `/networks/:id/results?page=1&limit=20` | 冻结结果分页 |
| GET | `/results/:queryId` | 读取单个冻结结果 |

查询请求示例：

```json
{
  "networkId": "demo",
  "queryVars": ["C"],
  "evidence": { "B": "t" },
  "ordering": "minFill",
  "maxFactorRows": 100000,
  "idempotencyKey": "optional-unique-key"
}
```

错误响应统一为 `{ "error": { "code": "...", "message": "...", "details": ... } }`，
代码包括 `VALIDATION`、`NOT_FOUND`、`DUPLICATE_STATE`、`DUPLICATE_VARIABLE`、`CYCLE`、
`CPT_MISSING_ROW`、`CPT_NEGATIVE_PROB`、`CPT_NOT_NORMALIZED`、`BAD_EVIDENCE`、
`IMPOSSIBLE_EVIDENCE`、`RESOURCE_EXHAUSTED`、`VERSION_MISMATCH`、`CONFLICT`。

## CLI

```powershell
node dist/cli.js fixtures
node dist/cli.js list
node dist/cli.js load-fixture <networkId> <fixtureName>
node dist/cli.js validate <networkId> [--version N]
node dist/cli.js evidence <networkId> Var=State [Var=State ...] [--evidence-id ID]
node dist/cli.js query <networkId> <Var> [Var ...] [--evidence-id ID] [--evidence-json '{"V":"s"}'] [--order minFill|minDegree|X,Y] [--budget N]
node dist/cli.js marginal <networkId> <Var> [同上选项]
node dist/cli.js explain <networkId> <Var> [...]
node dist/cli.js enumerate <networkId>
node dist/cli.js compare <networkId> <v1> [v2]
node dist/cli.js serve [--port 0]
node dist/cli.js stop
```

建网、证据等写操作会在终端打印操作前后状态。

## 项目结构

- `src/factor.ts`：因子（对数表）、乘法、证据限制、边缘化、笛卡尔积。
- `src/network.ts`：DAG/状态/CPT 校验与因子构建。
- `src/inference.ts`：变量消元、启发式顺序、证据校验、穷举核验。
- `src/mathutil.ts`：log-sum-exp、归一化。
- `src/db.ts`：SQLite 迁移（可重复执行）、事务、分页、持久化。
- `src/service.ts`：建网/版本/证据/查询/冻结/比较编排与幂等。
- `src/server.ts`：仅回环的 HTTP API。
- `src/cli.ts`：命令行。
- `src/fixtures.ts`：六套虚构概率网络。
- `src/test/`：推断、校验、持久化、HTTP 测试。

## 清理

删除 `node_modules/`、`dist/`、`.bayes/`、`.bayes-test/`、`.bayes-demo/` 即可完全清理；所有数据均限制在本项目目录内。
