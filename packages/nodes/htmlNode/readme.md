# HTML / SVG

在画布上挂载一段 HTML 或 SVG 源码，直接渲染，并且可以原地编辑。

- 源码保存在工作区 `assets/<节点ID>/content.html`，画布 JSON 不再内联正文。
- 预览使用 `iframe srcdoc` 并开启 `sandbox="allow-scripts allow-forms allow-modals allow-popups"`（不含 `allow-same-origin`），脚本无法访问编辑器与工作区文件。
- 未选中节点时预览不响应鼠标，避免拖动画布时被页面抢走事件；选中后点顶部「允许交互」即可操作页面里的按钮、表单和脚本。
- 点「编辑」打开源码对话框，左侧改代码、右侧约 350ms 后自动刷新预览，点「应用」写回节点并落盘。
- 输出端口 `html` 为字符串，可连到其他节点；右上角下载按钮导出 `.html` 文件。

## 给 Agent

节点注册了三个工具：

| 工具 | 说明 |
| --- | --- |
| `getHtml` | 读取当前源码 |
| `setHtml` | 整段替换源码 |
| `replaceHtml` | 替换唯一匹配的片段，`find` 出现多次会报错 |

## 安全边界

预览页面运行在无同源权限的沙箱里，可以执行自己的脚本，但拿不到宿主 `window`、Cookie 与工作区文件；外部网络请求由 `referrerpolicy="no-referrer"` 收敛来源信息，不额外拦截。