# OpenCat

**现代化的跨平台数据库客户端 —— 对标 Navicat，支持 SQLite、MySQL/MariaDB 与 PostgreSQL。**

Rust 后端 · React + TypeScript 前端 · 通过 Tauri v2 打包为原生桌面应用。

[![CI](https://github.com/KalebCheng/OpenCat/actions/workflows/ci.yml/badge.svg)](https://github.com/KalebCheng/OpenCat/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.80%2B-orange.svg)](https://www.rust-lang.org)
[![Tauri](https://img.shields.io/badge/tauri-v2-24C8DB.svg)](https://tauri.app)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#从源码构建)

[English](README.md) · **简体中文**

---

## 目录

- [功能](#功能)
- [支持的数据源](#支持的数据源)
- [界面结构](#界面结构)
- [快捷键](#快捷键)
- [快速开始](#快速开始)
- [从源码构建](#从源码构建)
- [项目结构](#项目结构)
- [架构](#架构)
- [数据与安全](#数据与安全)
- [测试](#测试)
- [疑难排查](#疑难排查)
- [已知限制](#已知限制)
- [路线图](#路线图)
- [参与贡献](#参与贡献)
- [许可](#许可)

---

## 功能

### 连接管理
- 任意数量的连接配置，支持分组与颜色标识 —— 生产库不会因为一次误点就连上
- **测试连接**与**保存并连接**分离，先验证再落库
- TLS 模式：`disable` / `prefer` / `require` / `verify-ca` / `verify-full`
- SSH 跳板机配置（主机、私钥、口令）已建模并加密保存 —— 见[已知限制](#已知限制)
- 每条连接可设**只读**：驱动层拒绝写入，界面同时隐藏所有编辑入口
- 分页大小、最大行数、连接超时、额外 DSN 参数均可按连接单独配置

### 对象浏览器
- 懒加载树：数据库 → 模式 → 表/视图 → 列、索引、外键、触发器
- 展示行数、注释、复合索引的列顺序、外键引用目标与级联动作
- 右键菜单：打开数据、设计表、生成 `SELECT`、复制名称、查看 `CREATE`、
  重命名、清空、删除
- 60 秒缓存 + 手动刷新；DDL 执行后自动失效对应子树

### SQL 编辑器
- 基于 CodeMirror 6：语法高亮、括号匹配、能识别当前模式表名的自动补全
- 多语句脚本按分号切分 —— 注释和字符串里的 `;` 不会误切，
  PostgreSQL 的 `$tag$ … $tag$` 块也能正确处理
- **每条语句一个结果页签**，一个脚本的全部输出都能看到
- `Ctrl+Enter` 执行全文，`Ctrl+Shift+Enter` 只执行选中部分
- `EXPLAIN` / `EXPLAIN ANALYZE` / `EXPLAIN QUERY PLAN`，按方言自动切换
- 消息面板：每条语句的耗时、影响行数、`last_insert_id`、服务端通知
- 数据库 / 模式切换器（MySQL 下发 `USE`，PostgreSQL 下发 `SET search_path`），
  可打开与保存 `.sql` 文件

### 数据表格
- 虚拟滚动 —— 十万行也不卡
- 分页、多列排序（Shift 点击追加）、按列过滤 + 原始 `WHERE` 条件框
- **可编辑**：双击单元格，或直接开始输入。每次更新都带上旧值作为丢失更新保护
- 新增 / 删除 / 复制行；自动识别并跳过自增主键，让数据库分配新键
- 二进制值十六进制查看器，JSON 自动格式化
- NULL 以浅灰斜体显示，数值右对齐并使用等宽数字
- 没有主键时：SQLite 回退到 `rowid`；MySQL / PostgreSQL 识别唯一非空索引；
  都没有则明确告知**为什么**不可编辑，而不是静默禁用

### 表设计器
- 可视化编辑列、索引、外键，支持重命名 —— 会记录原始列名，保证生成的 diff 正确
- **实时 SQL 预览**：任何改动都会生成将要执行的语句，可复制、可手动改完再执行
- 计划具有破坏性时红色警告并二次确认
- SQLite 无法原地改列类型，设计器会生成官方的「重建表」脚本
  （建新表 → 拷数据 → 删旧表 → 改名），全程包在事务里

### 导入 / 导出
- 导出为 **CSV、TSV、JSON、SQL INSERT**
- 完整 CSV 方言控制：分隔符、引号、转义符、换行符、NULL 字面量、
  空值即 NULL、UTF-8 BOM
- SQL 导出可带上 `CREATE TABLE` 脚本，并支持多行 `INSERT` 批处理
- 导入向导三步走：选文件 → 映射列 → 确认执行
- 格式自动识别（扩展名 + 内容嗅探，能跳过开头的 SQL 注释）
- 列映射支持**跳过**文件中的某些列
- JSON 导入兼容顶层数组或「对象里有一个数组字段」两种形态

### 其他
- 查询历史（可搜索、可清空、可单条删除）与保存的 SQL 片段
- 深浅色跟随系统或手动固定；强调色可选
- 设置项全部即时生效并持久化
- 界面字体、编辑器字体与字号、Tab 宽度、自动换行均可调

---

## 支持的数据源

| 引擎 | 状态 | 说明 |
|---|---|---|
| **SQLite** | 完整支持 | 文件型；`rowid` 回退让无主键表也可编辑；WAL 模式 |
| **MySQL / MariaDB** | 完整支持 | 通过 `information_schema` 内省；DDL 取自 `SHOW CREATE TABLE` |
| **PostgreSQL** | 完整支持 | 通过 `pg_catalog` 内省；DDL 由内省结果生成 |

三种引擎实现同一个 `Driver` trait、共用同一套类型解码层，因此连接管理、
对象树、数据表格与导入导出的代码完全不区分引擎。

---

## 界面结构

```
┌──────────────────────────────────────────────────────────────┐
│ 标题栏：新建连接 · 新建查询 · 连接状态 · 设置                  │
├───────────────┬──────────────────────────────────────────────┤
│               │ 页签：查询 / 表数据 / 表设计                   │
│  对象浏览器    ├──────────────────────────────────────────────┤
│  ─ 已连接      │ 工具栏：运行 · 选区运行 · 停止 · 解释          │
│    └ 对象树    ├──────────────────────────────────────────────┤
│  ─ 已保存      │ SQL 编辑器（CodeMirror 6）                    │
│               ├──────────────────────────────────────────────┤
│               │ 结果网格 / 消息面板（可拖拽调整高度）           │
├───────────────┴──────────────────────────────────────────────┤
│ 状态栏：连接数 · 当前连接 · 延迟 · 作用域 · 工作区目录          │
└──────────────────────────────────────────────────────────────┘
```

---

## 快捷键

| 快捷键 | 作用 |
|---|---|
| `Ctrl+Enter` | 执行编辑器全文 |
| `Ctrl+Shift+Enter` | 只执行选中部分 |
| `Ctrl+N` | 新建查询页签 |
| `Ctrl+T` | 新建查询页签 |
| `Ctrl+W` | 关闭当前页签 |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换页签 |
| `Ctrl+Shift+N` | 新建连接 |
| `Ctrl+,` | 打开设置 |

数据表格内还支持：方向键移动、`Shift+方向键` 框选矩形区域、`Ctrl+A` 全选、
`Ctrl+C` 以 TSV 复制（可直接粘进 Excel）、`Ctrl+0` 把单元格设为 SQL `NULL`。

---

## 快速开始

### 直接下载安装包

到 [Releases](https://github.com/KalebCheng/OpenCat/releases) 下载对应平台的安装包：

| 平台 | 文件 |
|---|---|
| Windows | `.msi`（Windows Installer）或 `.exe`（NSIS 安装程序） |
| macOS | `.dmg`（通用二进制，Apple 芯片与 Intel 都有） |
| Linux | `.AppImage`（免安装）、`.deb`（Debian/Ubuntu）、`.rpm`（Fedora/RHEL） |

不想等 tag 发布的话，每次推送到 `main` 都会由 `Bundle` workflow 构建同样的安装包，
可以在该次运行的 **Artifacts** 里下载。

### 用随附的示例库试手

`examples/demo.db` 带了一套小而完整的电商 schema —— 120 个客户、15 个产品、
400 张订单、996 条订单明细、一个视图，以及刻意留的"难缠"数据
（NULL、长文本、内嵌 JSON、二进制列）。

1. 启动 OpenCat
2. **新建连接** → 类型选 `SQLite` → **浏览** 选中 `examples/demo.db` →
   **保存并连接**
3. 展开对象树，双击表查看数据，右键 → **设计** 改表结构

### 连接你自己的数据库

在连接对话框里选择引擎，填写主机、端口、用户名、密码，
先点 **测试连接**，再点 **保存并连接**。

---

## 从源码构建

### 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 前端构建 |
| pnpm | ≥ 9 | 包管理器 |
| Rust | ≥ 1.80 | 后端（stable） |
| 平台依赖 | — | 见下 |

**平台依赖**

- **Windows** —— MSVC 工具链
  （`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`），
  或使用 GNU 工具链（见 [Windows 无 MSVC](#windows-无-msvc)）
- **macOS** —— Xcode Command Line Tools
- **Linux** —— `libwebkit2gtk-4.1-dev`、`libgtk-3-dev`、
  `libayatana-appindicator3-dev`、`librsvg2-dev`

### 构建

```bash
pnpm install
pnpm app:build          # 生产打包，产物在 src-tauri/target/release/
pnpm app:dev            # 开发模式，热重载
```

单独执行：

```bash
pnpm build              # 只构建前端
pnpm typecheck          # tsc --noEmit
pnpm icons              # 重新生成图标（需要 Python + Pillow）
cargo test              # 后端测试
cargo clippy --all-targets
```

### Windows 无 MSVC

如果不想装几个 GB 的 Visual Studio，GNU 工具链完全够用：

1. 安装 GNU 版 Rust：
   ```powershell
   rustup toolchain install stable-x86_64-pc-windows-gnu
   rustup default stable-x86_64-pc-windows-gnu
   ```
2. 装一份 MinGW-w64 —— [w64devkit](https://github.com/skeeto/w64devkit/releases)
   是单文件自解压包（约 60 MB），解压到比如 `C:\tools\w64devkit`。
3. 在 `~/.cargo/config.toml` 里告诉 Cargo 用哪一份：
   ```toml
   [target.x86_64-pc-windows-gnu]
   linker = "C:\\tools\\w64devkit\\bin\\gcc.exe"
   ar     = "C:\\tools\\w64devkit\\bin\\ar.exe"
   ```
4. 把 `C:\tools\w64devkit\bin` **和** `%USERPROFILE%\.cargo\bin` 加入 `PATH`。
   后者是 `pnpm app:dev` 能找到 `cargo` 的前提。

WebView2 是 Windows 10/11 的预装组件，无需额外安装。

---

## 项目结构

```
OpenCat/
├── crates/
│   ├── opencat-core/          # 与引擎无关的领域模型
│   │   └── src/
│   │       ├── model.rs       # ConnectionProfile / TableSchema / QueryResult / TablePlan …
│   │       ├── value.rs       # 带类型标签的单元格值
│   │       ├── sql.rs         # 分词切句、标识符引用、只读判定
│   │       ├── workspace.rs   # 原子写 JSON 持久化
│   │       ├── secrets.rs     # AES-256-GCM 密码加密
│   │       └── settings.rs    # 设置 / 历史 / 片段
│   └── opencat-driver/        # 每个引擎一份实现
│       └── src/
│           ├── traits.rs      # 所有引擎实现的 Driver trait
│           ├── common.rs      # 类型映射、字面量渲染、分页 SQL
│           ├── edit.rs        # 行级 INSERT/UPDATE/DELETE 生成
│           ├── ddl.rs         # 表设计器的 DDL 生成（含 SQLite 重建）
│           ├── transfer.rs    # CSV / JSON / SQL 导入导出
│           ├── sqlite.rs      #
│           ├── mysql.rs       #
│           └── postgres.rs    #
├── src-tauri/                 # 桌面外壳
│   └── src/
│       ├── lib.rs             # 启动、插件、窗口创建
│       ├── state.rs           # 工作区 + 活动会话注册表
│       ├── error.rs           # 可序列化的命令错误
│       └── commands/          # 全部 IPC 命令，按用途分模块
├── src/                       # React 前端
│   ├── lib/                   # types.ts（Rust 模型的镜像）、ipc.ts（唯一后端出口）
│   ├── store/                 # zustand：settings / connections / tabs / explorer
│   ├── components/            # 外壳与基础组件
│   │   ├── ui/                # 设计系统：primitives + overlays
│   │   ├── Sidebar.tsx        # 连接列表，挂载对象树
│   │   ├── ObjectTree.tsx     # 懒加载对象树
│   │   └── TabBar.tsx · StatusBar.tsx · TitleBar.tsx · WelcomePane.tsx
│   ├── features/
│   │   ├── connections/       # 连接管理器
│   │   ├── editor/            # SQL 编辑器 + 结果网格
│   │   ├── grid/              # 可编辑数据表格
│   │   ├── designer/          # 表设计器
│   │   ├── transfer/          # 导入 / 导出
│   │   └── settings/          # 设置对话框
│   └── styles/globals.css     # 设计令牌，明暗两套
├── tools/
│   ├── make_icons.py          # 生成图标
│   └── make_demo_db.py        # 生成 examples/demo.db
├── examples/demo.db           # 示例 SQLite 库
└── assets/logo.png            # 图标源文件
```

---

## 架构

### 分层

```
┌─────────────────────────────────────────────────┐
│ React 前端                                       │
│   zustand store ←→ ipc.ts（唯一的后端出口）       │
└────────────────────┬────────────────────────────┘
                     │ Tauri IPC —— 类型即契约
┌────────────────────▼────────────────────────────┐
│ src-tauri —— 命令层                              │
│   参数校验、会话查找、作用域切换、历史记录         │
└────────────────────┬────────────────────────────┘
┌────────────────────▼────────────────────────────┐
│ opencat-driver —— Driver trait                   │
│   三份实现，一个接口                              │
└────────────────────┬────────────────────────────┘
┌────────────────────▼────────────────────────────┐
│ opencat-core —— 与引擎无关的模型与工具            │
└─────────────────────────────────────────────────┘
```

### 几个值得了解的设计决定

**前端只通过 `src/lib/ipc.ts` 访问后端。** 每个 Tauri 命令都有类型化包装，
组件里不会出现裸字符串命令名。所有异常都归一化成
`ErrorPayload { code, message, detail }`，UI 据此决定用 toast 还是弹窗。

**单元格值是带类型标签的，不做字符串化。** 驱动层绝不把数据库值强转成
`String` —— 那会丢掉网格需要的信息：右对齐数字、十六进制查看二进制、
以及最关键的**写回时生成正确的 SQL 字面量**。每一格都是 `Value` 枚举
（`{"t":"int","v":42}`），前端用可辨识联合收窄。

**行编辑用转义字面量，而不是绑定参数。** 绑定参数通常更安全，但这里语句是
**客户端**拼的，而各引擎对参数类型的推断差异极大 —— PostgreSQL 扩展协议往
`date` 槽位绑 `text` 会直接报错。转义正确的字面量在所有引擎上都无歧义，
这也是所有桌面数据库客户端的做法。字符串转义集中在一处：
`opencat_core::sql::escape_literal`。

**更新语句带丢失更新保护。** `WHERE` 里不仅带主键，还带**被修改列的旧值**。
如果期间有别人改过这行，语句影响 0 行，而不是静默覆盖。非 NULL 值用朴素的
`=`，保证能走索引 —— PostgreSQL 的 `IS NOT DISTINCT FROM` 会阻止索引扫描。

**会话池固定为 1 条连接。** 桌面客户端对一个服务器就是一个逻辑会话。
单连接让 `USE` / `SET search_path` 的语义完全可预测；用连接池的话，
下一条语句可能落到另一条连接上，作用域就悄悄丢了。

**持久化用「临时文件 + 重命名」。** 设置、连接、历史都是可读可 diff 的 JSON；
写入先落 `.tmp` 再原子替换，崩溃永远不会留下半个文件。

**DDL 先预览后执行。** 表设计器把 `TablePlan` 交给纯函数生成语句，
用户看到的和执行的是同一份文本。SQLite 那些无法原地表达的改动会展开成
官方的重建流程，并标记为 `destructive`。

---

## 数据与安全

- **密码不以明文落盘。** 使用 AES-256-GCM 加密，密钥是本机独立的 `master.key`
  （平台支持时权限为 `0600`）。算法和版本前缀写进了存储格式，便于日后轮换。
- **密码不回传前端。** 后端返回的配置里密码被替换为掩码，掩码回传时再还原成
  已存储的真实值，所以界面上永远拿不到明文。
- **一切都在本地。** 没有遥测、没有云端同步、没有账号体系。数据写入平台
  的 app-data 目录，状态栏可以直接打开该目录，方便备份。
- **只读连接**在驱动层拒绝写入，数据表格也不会渲染任何编辑入口。
- **服务端超时**：连接建立时下发 `statement_timeout`（PostgreSQL）/
  `max_execution_time`（MySQL），即使客户端被强杀，服务端也不会一直跑。

> `master.key` 依赖文件系统权限保护，而非操作系统钥匙串。若攻击者已经能以你的
> 身份读取用户目录，他同样能读到密钥。这与同类工具的威胁模型一致；
> 接入 Windows Credential Manager / macOS Keychain 已列入路线图。

---

## 测试

```bash
cargo test                      # 后端全部测试
cargo test -p opencat-driver    # 只跑驱动
pnpm typecheck                  # 前端类型检查
pnpm build                      # 前端生产构建
pnpm app:build                  # 完整桌面应用打包
```

当前状态：

| 检查项 | 结果 |
|---|---|
| `cargo test` — `opencat-core` | 16 通过 |
| `cargo test` — `opencat-driver` 单元测试 | 70 通过 |
| `cargo test` — 端到端 SQLite 生命周期 | 4 通过 |
| `cargo test` — SQLite 冒烟测试 | 1 通过 |
| `cargo check -p opencat` | 通过，零警告 |
| `cargo build -p opencat --features custom-protocol` | 产出 `opencat.exe` |
| `pnpm exec tsc --noEmit` | 0 错误 |
| `pnpm exec vite build` | 通过 |

端到端测试（`crates/opencat-driver/tests/end_to_end.rs`）真实地走了一整条链路：
建表 → 内省 → 类型化插入 → 分页读取 → 按主键更新 → **旧值不匹配被拒绝** →
计数 → 搜索 → 导出 CSV/JSON/SQL → 重新解析 CSV → 批量 `INSERT` 回灌 →
重命名 → 清空 → 删除 → 只读会话拒绝写入 → 打开随附的 `examples/demo.db`
并校验其结构。

> 说明：上述验证覆盖编译、链接、单元测试与端到端逻辑，以及
> **窗口创建成功、WebView2 完成初始化**（生成了完整的浏览器配置目录树）。
> 界面本身的视觉效果未在无桌面环境下逐项核对。

---

## 疑难排查

### `pnpm app:dev` 报 `failed to run 'cargo metadata' … program not found`

`cargo` 不在 `PATH` 上。把 `%USERPROFILE%\.cargo\bin`（Windows）或
`~/.cargo/bin` 加进去，然后**新开一个终端** —— 编辑器的集成终端会保留它启动时
的环境快照，新开标签页是不够的。想不重启就生效，可以在当前窗口执行：

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
```

### 应用启动即退出，报 `Failed to setup app: 拒绝访问。 (os error 5)`

WebView2 需要在磁盘上保存浏览器配置，Tauri 默认写到 `app_local_data_dir()`。
该位置不可写时，启动会在任何 OpenCat 代码执行之前就中止。

OpenCat 已处理这种情况：启动时会依次探测 `%LOCALAPPDATA%`、`%APPDATA%`、
`%USERPROFILE%`、`%TEMP%`，最后是项目目录，并让 WebView2 使用第一个可写的位置。
被拒绝的候选位置会打印出来，那是**信息而非错误**。也可以自己指定：

```powershell
$env:WEBVIEW2_USER_DATA_FOLDER = "D:\opencat\webview2"
```

如果 OpenCat 回退到了项目目录，你的连接与设置会保存在
`<项目>/.opencat-data/`（已加入 `.gitignore`）。请勿执行 `git clean -fdx`，
并注意删除项目目录等于删除这些数据。

### 构建通过但窗口始终不出现

先确认进程活着（`Get-Process opencat`），并确认没有另一个实例占着 WebView2
配置目录 —— WebView2 要求配置目录对每个运行实例独占。

---

## 已知限制

- **SSH 隧道尚未建立实际连接。** 跳板机、私钥、口令都已建模、加密并随会话传递，
  但端口转发还没实现 —— 勾选后不会真正建立隧道。
- **没有可视化查询计划。** `EXPLAIN` 返回引擎的文本结果，没有计划树。
- **无 ER 图，无库到库的数据传输。**
- **PostgreSQL 的少数类型**（`money`、自定义域、几何类型）会退化为 `<TYPE>`
  占位文本，而不是结构化展示。常见类型（含数组）均正常。
- **MariaDB 不支持 `max_execution_time`**，会话守卫会静默失败，
  改用客户端超时。
- **表设计器不处理分区表和继承表。**
- **视图**在设计器里只能改名，定义本身请用 SQL 编辑器替换。

---

## 路线图

1. **SSH 隧道** —— 用 `russh` 实现本地端口转发，接上已有的配置项
2. **查询计划可视化** —— 把 `EXPLAIN` 输出渲染成节点树
3. **数据传输** —— 库到库、表到表的批量搬迁
4. **ER 图** —— 从外键自动布局
5. **系统钥匙串** —— 用平台凭证管理器替换 `master.key`
6. **更多引擎** —— SQL Server、Oracle、Redis
7. **国际化** —— i18n 框架与完整本地化界面

---

## 参与贡献

开发流程、代码规范与提交约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
欢迎提 Issue 和 PR。

```bash
pnpm install
pnpm app:dev
cargo test && pnpm typecheck
```

---

## 许可

Apache License 2.0 —— 见 [LICENSE](LICENSE)。

图标与示例数据采用同一许可。
