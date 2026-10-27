# drama-to-toonflow/1.0.0 交接契约

这是 **编剧 Skill 与 Toonflow Skill 唯一共同语言**。两边必须使用同一 `contract_version`；不要让自然语言摘要取代已锁定的剧本。场景与节拍属于故事层，不直接等于视频调用或镜头个数。

## 最小 JSON 结构
```json
{
  "contract_version": "drama-to-toonflow/1.0.0",
  "project_id": "真实项目代号",
  "episode_id": "E001",
  "script_version": "v1.0",
  "script_status": "locked",
  "script_file": "相对此 JSON 所在目录的正式剧本路径",
  "script_sha256": "完整 UTF-8 剧本文件的 SHA-256",
  "speech": {"hanzi_per_second": 7, "scope": "本项目估时基线；待试读确认"},
  "scenes": [{
    "scene_id": "E001-S01",
    "heading": "内·地点·日",
    "purpose": "一句话观众变化",
    "begin_state": {"positions": {}, "props": {}},
    "beats": [{
      "beat_id": "E001-S01-B01",
      "order": 1,
      "event": "可见动作/信息变化",
      "source_text": "必须可在剧本逐字找到的短句",
      "dialogue": [
        {"line_id": "E001-S01-D01", "speaker": "角色",
         "text": "逐字台词", "channel": "dialogue"}
      ]
    }],
    "end_state": {"positions": {}, "props": {}},
    "directorial_intent": {
      "hard": ["剧本中有根据、不能删的可见信息"],
      "soft": ["可替代机位/运镜/节奏的导演建议"],
      "six_channels_intent": {
        "expression": "必要表情/视线触发链或 null",
        "action": "必须能看懂的动作过程或 null",
        "environment": "有因果的环境变化或 null",
        "cinematography": "特写目的和可选运镜或 null",
        "sound": "必须听见的事件/台词/音效或 null",
        "spatial": "站位、眼神线、接触/道具状态或 null"
      },
      "sensory": {"sight": null, "hearing": null, "touch_proxy": null,
                  "smell_proxy": null, "taste_proxy": null},
      "pacing_priority": "强调哪个节拍的反应和兑现；不强制固定比例"
    },
    "asset_needs": [],
    "questions": [],
    "handoff_to_next": "下场是否连续；换场则明确重置"
  }]
}
```

## 事实与变更边界
- `script_status` 仅 `draft | locked`。Toonflow 可接 `draft` 做只读预演，不得标记生成就绪；生成准备仅用 `locked` 且文件哈希匹配者。
- `source_text` 必须是原剧本的真实字串；对白 `line_id` 唯一，`text` 必须精确存在于正文对应说话人的一行，保留汉字、称呼、标点、OS/VO 类型。
- `beat_id` 的 `order` 在**同一场内**从 1 连续递增；`scene_id/beat_id/line_id` 不因镜头/生成段变化而重编号。
- `begin_state/end_state` 是人物世界位置与重要道具状态，不是画面像素坐标；只写会影响连贯性的项，未知标记 `null` 或 `待核`，不猜道具归属。
- `hard` 必须可以回到某一 beat 和原文；`soft` 不得充当剧本事实。`proposal` 不进入锁定包，另列建议单。
- `asset_needs` 只列需要的**资产规格与用途**，如角色面容、场景全景、道具外形；绝不可填虚构的 Toonflow 节点 ID 或 `{{ref N}}`。
- `speech.hanzi_per_second=7` 用于特定项目的中文对白初步预算，按中文汉字数（排除标点、空格、英数）估；英文、数字、语气、停顿、叠话需另行试读。不是锁定语速，也不能据此删对白。
- 一场多段、一段多镜均正常；制作 Skill 自行产出带 `scene_id / beat_id / line_id` 追踪的 `shot/segment`。模型时间线不写回改剧本。
- 引用规则：Toonflow `asset_id + 采用版 + 来源节点/端口 + 宿主顺序 → {{ref N}} → 供应商图/视频/音频类型序号`。任何映射不确定则挡下生成。

## 双边验收
- 编剧：来源事实、台词逐字、道具起终、情绪/观众价值明确，锁包与剧本哈希匹配。
- Toonflow：每条 `beat_id` 都被覆盖；镜头/生成段顺序不逆转剧情；`line_id` 唯一且完全对应；时间账闭合；参考标签无虚构/错序；无声称已经采用的未采用媒体。
- 发生改稿：改变文件/哈希和剧本版本，标记受影响的 `beat_id` 与其后确有依赖的镜头/参考；非相关段继续可用，不全片重做。
