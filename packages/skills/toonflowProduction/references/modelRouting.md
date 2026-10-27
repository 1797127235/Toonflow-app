# 模型特定适配：先查实时宿主能力，再选一个出口

**只读能力发现优先于写提示词**：以当前 Toonflow 节点实际供应商、模式、模型名、有效时长/分辨率、参考类目/数量、原生声轨为准；不支持则换制作计划，经允许后再换模型。以下是格式与能力校验参考，不是自动开放全部接口的承诺。

| 模型 | 导演内部时轴 | 送模型的表达 | 模型适配重点 |
|---|---|---|---|
| Seedance 2.0 | 每镜/每 beat 以毫秒记时 | 镜头编号 + 先后/同时 + 可见动作；不依赖绝对小数时间戳 | 原文保真、参考职责明确、镜头密度保守 |
| Seedance 2.5 | 毫秒完整预算 | 连续整数秒时间段（若当前接入支持），另附毫秒制作清单 | 多模态输入明确职责；同一段别同时要求无法兼容的角度/动作 |
| MiniMax H3 | 毫秒完整预算 | 按 Base / Ref2VA 官方字段；`[Shot 1]` 起，后续镜头 `At 00:SS.mmm` | 4~15 s 整数秒（仍按实时配置）；Ref2VA 先 `subject_definitions`；声音另层 |

## Seedance 2.0
- 当前上传的 Toonflow 调研（2026-10-20）对照火山方舟官方指南：2.0 使用镜序比精细小数秒时间戳可靠。创作过程仍以 `00:00.000` 时轴审阅，但**仅保留镜头顺序、串并行动作和必要节奏**到最终 `model_prompt`。精确时轴在 `director_timeline`，不重复粘到模型正文。
- 若用户特别要求在 2.0 正文内强制毫秒指令，提示可保留数值作说明，但不要保证模型精确执行，优先用户明确授权下的小样 A/B。
- 文字转视频、图像/多参考、首尾帧不是天然等价；参考能力看实际节点，不暗把多视图资料板作为可控首帧。

## Seedance 2.5
- 字节跳动 Seed 团队于 2026-07-31 公开介绍最长单次 30 秒、时间戳编辑和多模态能力，**仅表示模型体系能力上限**，不保证当前 Toonflow 供应商节点可用全部参数。
- 模型提示词多镜按 `0–4s / 4–7s` 类连续块表达，对具体切点的精度不要承诺毫秒级。导演时轴仍用 3 位小数；需精密对嘴时依真实录音/后期配音校时。
- 图片/视频/音频职责逐项声明，尤其区别“锁外观、锁首帧、参考运镜、参考音色”；不得仅写“参考全部”。

## MiniMax H3
官方 MiniMax-H3/H3 Prompt Writing Skill 为**来源格式标准**；当前 H3 附件里的中文经验、动作物理化和口型建议是候选增强，不全部当供应商硬要求。先确定：
- Base T2VA/I2VA/FL2VA/L2VA: 按具体模式必要首行对齐（首/尾图模式首行不能被任意清单顶替），正文顺序 `integrated_multimodal_description` → `overall_soundscape` → `non_diegetic_music`。
- Ref2VA: `subject_definitions` → `summary` → `retention_analysis` → `detailed_description` → `overall_soundscape` → `non_diegetic_music`，每一张参考都明确真实类型与编号及传递职责。
- 总时长和有效配置：H3 官方文档给出 4～15 秒，**整数秒**，输入≤9图、≤3视频、≤3音频，总计≤12文件，文本≤7000字符；其他供应商平台/本地部署需复核。
- 正文保留 `(S1)` / `(S2)` 等说话人绑定、逐字原语言台词；多镜切点按官方 H3 格式。原附件建议 `<d>[Chinese] ...</d>`、Closing Beat、三层声音、细化动作可有选择使用，**不自动规定每个镜头必须只有一句对白或必定静止锁嘴**，以剧情、试验结果与模型语法为准。
- 官方 `h3-prompt-writing` Skill 倾向英文重写字段；本项目中文导演书写可试用，但“中文与英文稳定性完全一致”未经受控验证。保存同事件/同输入的对照版本，不翻译中国对白、不混淆音色。
- I2VA/FL2VA 强制首行格式优先：在**外部投喂清单**逐项列真实素材与用途，模型正文按官方首行开头；Ref2VA 则在首字段 `subject_definitions` 里做参考绑定。绝不为了统一前缀破坏官方首行。
- H3 存在多种 API/ComfyUI 节点，随机种子、LoRA 等若可用属于宿主/工作流参数，不强行写入文本提示词。

## 提示词瘦身方法（不能损伤故事）
按顺序删：未输入的参考、重复外貌、重复环境/音效、空泛“电影感”、泛化负面清单、内部审稿标签。
不能删：关键动作与末态、逐字对白/说话者、必要镜头信息、真实参考职责、由剧情支持的情绪变化、当前风险点。
一个生成段可包含多个镜头，但如果“身份＋多人接触＋长台词＋快速运镜＋换景”同时出现，优先拆段/减少变量，而不是增加强调词。

## 来源（实际制作须按本地版本/能力复核）
- Toonflow 官方仓库：https://github.com/HBAI-Ltd/Toonflow-app
- Toonflow 节点工具开发说明：https://github.com/HBAI-Ltd/Toonflow-app/blob/master/packages/toolScaffold/readme.md
- Seedance 2.5 官方介绍：https://seed.bytedance.com/en/blog/one-take-creation-flexible-referencing-introducing-seedance-2-5
- 火山方舟指南：https://docs.volcengine.com/docs/ark/seedance-2-5-prompt-guide?lang=zh
- MiniMax 官方模型规格：https://platform.minimax.io/docs/guides/video-generation
- MiniMax 官方 Prompt Skill：https://github.com/MiniMax-AI/MiniMax-H3/tree/main/skills/h3-prompt-writing
- Runway 图生视频简洁写法参考：https://help.runwayml.com/hc/en-us/articles/39789879462419-Gen-4-Video-Prompting-Guide
