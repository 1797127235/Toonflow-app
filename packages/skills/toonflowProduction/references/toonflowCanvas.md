# Toonflow 画布操作：能力探测 + 双向回读 + 不伪造素材

仅在 Toonflow 真正提供以下能力时按其**实时 schema**执行；这是基于上传版 `workflow/references/canvasExecution.md` 和 Toonflow 官方工具脚手架的适配规则，而非对本聊天有任何 Toonflow 连接的声称。

## 发现
- `getCanvas({})` 取当前画布概览；按需要 `include: ["nodeTypes", "canvases"]`；
- `findCanvasNodes` 定位节点；`getCanvasNodes` 按 ID 与字段/文本偏移读取；`getCanvasEdges` 查入出边；`getNodeTools` 获取指定节点的实际动作/参数；
- 分页 `hasMore/nextCursor` 不能忽略。内容过大按 `path + textOffset/valueOffset` 补读。记录画布、节点和版本，不能从聊天历史虚构。
- 运行工具只受实时 schema 支配；旧技能的节点名/端口名未必仍有效。

## 参考顺序与映射（执行前要回读）
1. 查询生成节点真实入边，并读取每个来源节点**实际媒体输出**和媒体类型；缺少/生成中/未采用的来源不得编成可用参考。
2. 查询实际输入端口、顺序字段（如适用 `referenceOrder`），根据真实输入顺序形成 host ordinal。保存映射：
   `asset_key + 资产采用版本 → source_node_id:source_port → media_type → target_node_id:target_port → host_order → {{ref N}} → provider_type_order`。
3. 宿主统一引用号与供应商按图/视频/音频各自排序**可能不同**。不能证明适配器实际转换成功时停在待核验，不把同为数字 1 当成同一媒体。
4. 清单开头列：
   - `Ref 1 / 资产名 / 类型 / 实际文件或节点 / 采用版 / 用途（首帧/尾帧/身份/场景/道具/音色/动作） / 保留范围`；
   - 标记哪些属性**不取用**，避免背景/造型跨模态串入。
5. **已验证**的执行正文才可出现 `{{ref N}}`；若模型需要 `<Picture N>` 或 `@Image N`，此为编译产物，清单仍保留人类可追溯的 `{{ref N}}` 映射，不把目标方言混写。

## 受控写入与生成
- `addNode` 按真实可用 node type 新增。它不代表可用的任意 `data` 写入；按返回 `node.id` 查询 `getNodeTools`，再调用其 schema 指定的 `node:setText` / `node:setPrompt` 等。
- 生成节点 `prompt` 为唯一模型提示词输入；不要再用相连 STRING 节点把整本剧本重复追加到 prompt。若不清楚自动附加逻辑，先检查连接或暂停。
- 已授权后再调用实际 `node:generateImage` / `node:generateVideo`，并记录返回任务/前一输出、输入版本、完整配置、来源引用、提示词快照。
- 回读真实结果，不把“提交成功”说成“视频已经生成”，不把“生成成功”自动当成“用户采用”；保留失败和候选版本。
- 局部改脚本/提示词/参考时创建返修票，只复核受影响的下游镜头及与之直接相接的状态，不连带删改无关已采用产物。

## 无可用工具或项目现场
只交**待绑定文本包**，标注 `not_submittable`，真实节点 ID、图像引用、媒体链接填 `unknown`。不要生成假 `{{ref 1}}`，也不要宣称已读取或写入画布。
