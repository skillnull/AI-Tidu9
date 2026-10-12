# 九门赛博提督

**九门赛博提督·智能协作中枢**

九门赛博提督是面向全领域场景的智能协作中枢，以目标驱动内外部 Agent、模型、工具、知识与专家协同执行，交付可验证的业务结果。

[English](./docs/README.en.md)

## 当前状态

项目正在从早期AI规则包重构为独立的超级Agent平台，目前处于工程基础阶段，尚不建议用于生产环境。

## 核心方向

- 作为虚拟模型接入Codex、Cursor、CLI及其他客户端。
- 独立运行Agent任务，不受宿主呈现能力限制。
- 在质量、成本、隐私、额度和可用性之间动态调度模型。
- 通过能力补全组合低成本模型与专家模型。
- 在运行时保护密钥和敏感内容。
- 同时服务个人、团队和企业，不限制使用者继续探索AI能力。

## 本地开发

需要 Node.js 22.14 或更高版本。

```bash
npm install
npm run check
npm test
node packages/tidu/dist/cli/index.js --help
```

正式npm包名为 `@skillnull/tidu`，安装后的命令保持为 `tidu`：

```bash
npx @skillnull/tidu start
```

启动后打开终端输出的本地地址，即可进入只读配置中心并查看运行时、存储和当前配置状态。

分支、Commit、PR、版本和发布规则见 [贡献指南](./docs/CONTRIBUTING.md)。规则由本地脚本和GitHub Actions共同校验。

## 发版计划

开发阶段和验收状态见 [发版计划](./docs/RELEASE_PLAN.md)。该临时文件将在 `v1.0.0` 最终验收后删除，实际发布历史将保留在 [变更记录](./docs/CHANGELOG.md) 和Git Tag中。

模块边界和当前限制见 [架构基线](./docs/architecture.md)。

## 开源协议

本项目使用 [GNU Affero General Public License v3.0 only](./LICENSE)。品牌和署名规则见 [商标政策](./docs/TRADEMARKS.md) 与 [NOTICE](./NOTICE)。
