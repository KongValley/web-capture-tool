# 网页抓取工具

基于 Electron 的桌面抓包 / 爬虫工具：内嵌真实浏览器加载并登录目标站点，抓取**全部请求与响应体、Cookie、Storage、页面 HTML**，并提供数据提取、自动翻页、反爬伪装与多种导出格式。

专为 **Windows 7 SP1 32 位** 老机器适配（Electron 22.3.27 / Chromium 108 / ia32），同时可在 Windows 10/11 直接运行，绿色免安装。

---

## 功能

| 分类 | 能做什么 |
|---|---|
| 抓取 | 全部请求的方法 / URL / 类型 / 状态 / 耗时 / 大小 / 远端 IP；请求头与请求体；响应头与响应体（含二进制 base64）；原始头（含 `Set-Cookie`）；重定向链；失败原因；WebSocket 收发帧 |
| 页面数据 | 页面 HTML、`document.cookie`、`localStorage`、`sessionStorage`、Cookie 存储（含 httpOnly）、标题 |
| 拦截与过滤 | 屏蔽图片/媒体/字体；关键字屏蔽；仅记录 XHR/Fetch；CDP 网络限速（3G / 慢速） |
| 反爬伪装 | UA 预设与自定义、自定义请求头注入、HTTP/SOCKS 代理 |
| 数据提取 | CSS 选择器批量提取（`标题=.t` / `链接=a@href` / `正文=@html`）导出 CSV/JSON；页面清单（链接/图片/表单/表格）；表格转 CSV |
| 自动化 | 自动滚动到底（无限加载页面）；自动翻页 N 页（自动识别「下一页」，可随时停止） |
| 结果处理 | 导出全部 JSON、HAR（可直接拖进 Chrome DevTools）、当前页 HTML、Cookie JSON；响应体批量落盘；复制 cURL；请求重放 |

抓取走 Chrome DevTools Protocol（挂在视图的调试器上），不受页面 CSP 限制，也不需要往页面里注入脚本。

---

## 环境要求

- 开发：Node.js 与 npm（本项目在 Node 24 + npm 12 下开发）
- 运行（打包版）：Windows 7 SP1 32/64 位 或 Windows 10/11，无需安装 Node

> **Windows 7 注意**：必须已安装 **SP1** 与 SHA-2 代码签名补丁（KB4474419，配套服务栈 KB4490628），否则 Electron 22 无法启动。这是 Chromium 的硬性要求，没有替代方案。

---

## 快速开始

```bash
npm install
npm_config_arch=ia32 node node_modules/electron/install.js   # 拉取 32 位运行时（npm 会拦 postinstall）
npm start
```

窗口上半部分是**真实浏览器视图**（可直接输入网址、登录、操作页面），右侧面板是抓包列表与详情。

### 界面说明

三行工具栏：

1. **地址与总控**：前进/后退/刷新、网址输入、打开、暂停抓取、清空、页面数据、导出全部/HTML/Cookie、请求计数与状态
2. **拦截与伪装**：资源拦截模式、关键字、仅记 XHR/Fetch、限速、UA、请求头、代理
3. **自动化与提取**：自动滚动、自动翻页、停止、CSS 提取、页面清单、响应体存盘、导出 HAR、设置

点击请求列表任一行展开详情（概要 / 失败 / 重定向链 / 请求头 / 请求体 / 响应头 / 响应体），详情顶部可**复制 cURL** 或**请求重放**。

---

## 抓取与导出

- **登录**：直接在视图里登录即可；Cookie 与 localStorage 保存在持久分区，重启后仍保持登录态。
- **导出全部**：页面数据 + Cookie + 全部请求记录（含响应体）+ WebSocket 帧，输出为单个 JSON。
- **HAR**：标准 1.2 格式，可用 Chrome DevTools 的 Network 面板直接导入查看。
- **响应体存盘**：选择目录后按 `序号_方法_主机路径.扩展名` 写入文件，重名自动追加 `-1`、`-2`，二进制响应体按原始字节写出。
- **重放**：用抓到的原始请求头与请求体重新发送一次，结果就地展示（响应体截断到 1MB），不会混入抓包列表。

设置项（拦截/限速/UA/请求头/代理）中，**拦截、UA、请求头、代理**刷新页面后生效；**限速**立即生效；**仅记 XHR/Fetch** 立即生效。所有设置重启后保留。

---

## 数据提取与自动化

**CSS 提取**：填入行选择器（如 `.item`）与字段（每行 `名称=选择器[@属性]`），提取结果可预览前 20 行并导出 CSV/JSON。选择器为 `:self` 时取行元素本身；`@href` / `@src` 会自动解析成绝对地址。

**页面清单**：一次性取出页面上的链接、图片、表单、表格，导出 JSON 或把表格合并导出为 CSV。

**自动滚动**：反复滚动到底并等待内容加载，连续两轮高度不再增长即停止（默认 5 轮，最大 50 轮）。

**自动翻页**：自动识别「下一页」（优先 `a[rel=next]`，其次按文案匹配），按设定的间隔翻页，最多 100 页，可随时点「停止」。

---

## 无显卡 / 老旧机器

工具会读取 Chromium 上报的 GPU 状态：若没有可用的硬件加速（驱动缺失、显卡过老、虚拟机、远程桌面），会自动开启软件渲染并在面板顶部给出提示条，点「立即重启」即可生效。GPU 进程反复异常退出时同样会触发。

- **核显照常走硬件加速**（Intel HD/UHD、AMD APU 等），不会被判定为「无显卡」。判定依据是 Chromium 实际上报的合成状态，与是否独显无关。
- 判定采用**双次采样**：启动瞬间的状态可能是瞬时的，两次采样都判定为软件渲染才会写入配置，避免误改。
- 也可手动控制：工具栏「设置」里勾选「强制软件渲染」，或在命令行加 `--software-rendering`。

「设置」对话框中还会显示当前 `gpu_compositing` 原始值、判定结论与 GPU 进程异常次数，便于排查。

---

## 配置文件

设置保存在 Electron 的 `userData` 目录下：

- 打包版：`%APPDATA%\web-capture-tool\settings.json`
- 开发态：`%APPDATA%\Electron\settings.json`

内容包括抓取设置、软件渲染开关、面板宽度与窗口位置尺寸。写入采用 300ms 防抖 + 临时文件原子替换；文件损坏时会改名保留为 `settings.bad-<时间戳>.json` 并回退默认值，不会静默丢弃。

---

## 自检与打包

```bash
npm run selftest        # 67 项断言：抓取 / 提取 / 自动化 / 存盘 / 持久化 / 图标 / UI
npm run selftest:sw     # 同一套断言在软件渲染下再跑一遍（等价于无显卡机器）
npm run icon            # 重新生成 build/icon.ico 与 build/icon-128.ico
npm run pack            # 打包 → dist/web-capture-tool-win32-ia32/ 与同名 .zip
```

自检会在本地起一个测试服务器并驱动真实窗口完成全链路验证；运行期间配置会改道到系统临时目录（`wct-selftest-settings`），不影响你的真实配置。脚本弹出的系统保存/目录对话框无法自动化，对应功能通过传入路径参数绕过验证。

打包产出的 exe 内嵌自绘图标（`build/icon.ico`，7 个尺寸）；若某些环境对 256 尺寸解析异常，可把 `pack:dir` 的 `--icon` 换成 `build/icon-128.ico`。

---

## 目录结构

```
main.js         主进程装配：窗口/视图/IPC/启动
state.js        共享状态与常量（含面板与工具栏高度约定）
capture.js      CDP 抓取：Network.* 事件 → 记录，请求重放
settings.js     抓取设置唯一写入口（applySetting）+ 拦截器
automation.js   自动滚动 / 自动翻页
extract.js      页面侧采集：HTML/Storage/CSS 提取/页面清单
format.js       纯函数：请求头合并 / cURL / CSV / HAR
files.js        落盘：保存对话框、文本写入、响应体批量导出
store.js        设置持久化（userData/settings.json）
gpu.js          GPU 状态判定
make-icon.js    图标生成器（零依赖，代码绘制）
index.html      面板界面与样式（深色 token 化）
renderer.js     面板逻辑（列表/详情/模态框/轻提示）
selftest.js     --selftest 全链路自检
```

模块依赖单向：所有模块只 `require('./state')`，禁止反向依赖 `main.js`。

---

## 已知限制

- 启动开发态与打包态的 `userData` 目录名不同（`Electron` vs `web-capture-tool`），配置不互通。
- Cookie、localStorage 等站点数据位于 `userData` 的持久分区内，清理该分区会同时清掉登录态。
- 抓取记录上限 5000 条、单条响应体 32MB、响应体总量 256MB、WebSocket 帧 2000 条，超出后按策略截断或丢弃并给出提示。
- 代理仅验证配置已生效（`resolveProxy`），真实链路可用性取决于代理服务本身。
- 系统保存/目录对话框需要人工点选，无法纳入自动化测试。
