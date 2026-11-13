# 纸序 · Paperloom

**让文献回到有序的文件夹里。**

Paperloom 是一个面向科研阅读的 Windows 本地文献整理工具：用清晰的文件夹界面浏览 PDF，把新文献放入“待整理”，再让你已有的 AI Agent 按内容完成命名和分类。

它适合这样的日常场景：下载了许多论文，却很难从文件名看出研究了哪种药物、哪种菌、哪种疾病。你可以用一句话说明整理规则，让 Agent 读取正文后把这些信息变成容易检索的文件名。

当前版本：**0.2.1** · Windows x64 · Electron / React · MCP

[下载 Windows 版本](https://github.com/andylauqaq/paperloom/releases) · [报告问题](https://github.com/andylauqaq/paperloom/issues)

## 能做什么

- **直接浏览本地文件夹**：界面显示磁盘上的真实 PDF 和主题目录，可在资源管理器中继续管理。
- **用自己的规则整理**：通过已有 AI Agent 指定中文或英文、命名模板及归档主题。
- **快速查找与打开**：按文件名或目录名搜索，一键打开 PDF 或定位原文件。
- **自动同步文件变化**：外部新增、改名、移动后自动刷新；列表分批加载，每次 100 份。
- **清晰易读的界面**：深色侧栏、浅色内容区和高对比度文字，适合长期浏览。
- **保留 MCP 整理接口**：支持正文分页读取、结构化字段、命名预览、归档历史和撤销。

## 三步开始使用

1. 在 [Releases](https://github.com/andylauqaq/paperloom/releases) 下载 Windows 安装程序，或下载 ZIP 后解压，运行 `Paperloom.exe`。ZIP 内的资源文件需要一起保留。
2. 打开软件，点击左下角“选择工作文件夹”，把新下载的 PDF 放入其中的“待整理”。右上角“放入新文献”可直接打开该目录。
3. 在拥有本地文件访问能力的 AI Agent 中下达整理指令。待整理页面可复制包含当前真实目录的指令，整理完成后界面自动同步。

工作文件夹的结构很简单，主题目录由你的整理规则决定：

```text
你的工作文件夹/
├── 待整理/                  新下载的 PDF
└── literature/             已归档的 PDF
    ├── 肠道菌群与结直肠癌/
    ├── 药物与微生物/
    └── 其他研究主题/
```

首次启动会优先寻找程序附近已有的 `literature`；找不到时使用用户文档目录中的 `Paperloom`。之后可以随时切换工作文件夹。

## 用一句话说明命名规则

下面是**整理指令示例**，实际名称应以论文正文支持的信息为准：

> 请逐篇阅读“待整理”中的 PDF，使用中文，按“药物 + 核心菌种 + 疾病 + 年份”命名，并归档到合适的主题文件夹。菌种保留拉丁学名；正文没有明确支持的信息不要补写。先列出整理计划，得到我的执行指令后再操作。

| 规则 | 适用内容 | 命名结构示例 |
| --- | --- | --- |
| 药物—菌种—疾病 | 干预与微生物研究 | `药物名_菌种学名_疾病名_年份.pdf` |
| 菌群—疾病—研究类型 | 菌群与疾病相关研究 | `核心菌群_疾病名_队列研究_年份.pdf` |
| 年份—作者—短标题 | 通用科研阅读 | `年份_第一作者_短标题.pdf` |
| 自定义 | 特定课题 | `研究主题_主要发现_年份.pdf` |

观察性关联、计算预测、动物干预及临床结果应分别描述。缺失的药物、菌种、年份或研究关系保留为空或标记待核对，避免为套用模板而编造信息。

## AI 如何连接

### 日常文件夹整理

推荐使用你已有、并已获准访问工作文件夹的 Agent，例如 Codex。Paperloom 提供浏览与同步界面；Agent 负责读取、理解及文件操作。相关客户端需要支持本地文件访问或 MCP；仅在电脑上安装聊天应用不会自动接入它的能力。

### MCP 接口

项目保留独立的 MCP 文献库接口，桌面软件运行期间提供以下工具：

| 工具 | 用途 |
| --- | --- |
| `status` / `list_documents` | 查看文献库与分页检索 |
| `read_document` | 按实际页码读取 PDF 正文 |
| `save_metadata` | 保存中英文结构化字段与原文依据 |
| `preview_organization` | 生成命名与归档计划 |
| `apply_organization` / `undo_organization` | 执行或撤销库内整理 |
| `organization_history` | 查看整理历史 |
| `scan_inbox` | 导入已配置下载目录中的 PDF |

MCP 文献库保存在 `%APPDATA%/Paperloom/library/`，与首页直接浏览的工作文件夹是两个独立的数据入口。使用 MCP 前需要先导入 PDF；文件夹首页中新放入的文件不会自动成为 MCP 文献记录。MCP 归档与撤销针对导入的库内副本。

源码启动桌面应用后，兼容标准输入输出 MCP 的客户端可使用以下配置，从项目目录启动入口：

```json
{
  "mcpServers": {
    "paperloom": {
      "command": "node",
      "args": ["<项目绝对路径>/desktop/mcp-entry.mjs"]
    }
  }
}
```

将 `<项目绝对路径>` 替换为实际位置，Windows JSON 路径建议使用 `/`。保持 Paperloom 桌面应用运行；默认连接信息位于 `%APPDATA%/Paperloom/runtime.json`。安装版的入口位于程序资源目录的 `mcp/paperloom-mcp.mjs`，也可以用 Node.js 启动该入口。客户端对 MCP 配置的格式要求可能不同。

## 从源码运行

需要 **Node.js 22.13 或更新版本**和 npm。首次安装依赖后启动：

```powershell
git clone https://github.com/andylauqaq/paperloom.git
cd paperloom
npm ci
npm start
```

常用开发命令：

```powershell
npm test                 # 核心逻辑与本地桥接测试
npm run test:desktop     # 桌面交互回归
npm run package:win      # 构建 Windows x64 安装程序和 ZIP
```

构建产物写入 `release/`，桌面测试报告写入 `test-results/`。依赖版本固定在 `package-lock.json`；测试使用明确标记的合成 PDF。

## 目录与数据

```text
src/              React 界面与样式
core/             文件夹、文献库、PDF 与 AI 适配逻辑
desktop/          Electron 桌面入口与 MCP 服务
scripts/          MCP 打包脚本
tests/            核心与桌面回归测试
```

仓库提供软件源码，个人文献、提取的正文、整理审计记录、运行日志和本机配置均由 `.gitignore` 排除。工作位置保存在 `%APPDATA%/Paperloom/folders.json`。

文件夹浏览在本机进行。使用外部 Agent 或远程模型时，文献内容的处理位置取决于你选择的服务及其设置。扫描版 PDF 若没有可提取文本，需要先完成 OCR。AI 命名是整理建议，涉及科研结论时应核对原文。

欢迎通过 [Issues](https://github.com/andylauqaq/paperloom/issues) 提交问题与建议。报告问题时请优先使用脱敏描述或合成文件。

