<template>
  <el-popover
    v-model:visible="visible"
    trigger="hover"
    placement="top"
    :width="300"
    :offset="10"
    :showArrow="false"
    popperClass="agentContextPopover">
    <template #reference>
      <el-button class="contextButton" text circle :disabled="disabled" :aria-label="usage?.tokens == null ? '查看上下文用量，暂无数据' : `查看上下文用量，已使用 ${contextPercent.toFixed(1)}%`" title="查看上下文用量">
        <el-progress type="circle" :width="14" :strokeWidth="2" :percentage="Math.min(100, contextPercent)" :color="contextColor" :showText="false" />
      </el-button>
    </template>
    <div class="contextUsage">
      <div class="contextHeader"><span>上下文用量</span><span class="contextHint">估算</span></div>
      <template v-if="usage?.tokens != null">
        <div class="contextTokens">
          <span>{{ usage.tokens.toLocaleString() }} / {{ contextWindow.toLocaleString() }} tok</span>
          <span>{{ contextPercent.toFixed(1) }}%</span>
        </div>
        <div v-if="segments.length" class="contextBar" aria-hidden="true">
          <span
            v-for="segment in segments"
            :key="segment.id"
            class="contextSegment"
            :class="{ contextSegmentDimmed: hovered && hovered !== segment.id }"
            :style="{ flexGrow: segment.tokens, background: segmentColor[segment.id] }"
            @mouseenter="hovered = segment.id"
            @mouseleave="hovered = ''" />
          <span v-if="remainder > 0" class="contextRemainder" :style="{ flexGrow: remainder }" />
        </div>
        <el-progress v-else :percentage="Math.min(100, contextPercent)" :color="contextColor" :showText="false" />
        <div v-if="segments.length" class="contextLegend">
          <div
            v-for="segment in segments"
            :key="segment.id"
            class="contextTokens"
            :class="{ contextSegmentDimmed: hovered && hovered !== segment.id }"
            @mouseenter="hovered = segment.id"
            @mouseleave="hovered = ''">
            <span class="contextLabel"><span class="contextSwatch" :style="{ background: segmentColor[segment.id] }" />{{ segment.label }}</span>
            <span>{{ formatTokens(segment.tokens) }}</span>
          </div>
        </div>
      </template>
      <span v-else class="contextHint">{{ usage ? "等待下一次回复更新用量" : "尚无用量数据" }}</span>
      <div v-if="stats" class="contextStats">
        <div class="contextHeader">对话累计用量</div>
        <div class="contextTokens"><span>输入</span><span>{{ inputTokens.toLocaleString() }} tok</span></div>
        <div class="contextTokens"><span>输出</span><span>{{ stats.tokens.output.toLocaleString() }} tok</span></div>
        <div v-if="inputTokens > 0" class="contextTokens"><span>缓存命中</span><span>{{ (stats.tokens.cacheRead / inputTokens * 100).toFixed(1) }}%</span></div>
        <div v-if="stats.tokensPerSecond !== undefined" class="contextTokens"><span>生成速度</span><span>{{ stats.tokensPerSecond.toFixed(1) }} tok/s</span></div>
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { computed, shallowRef } from "vue";
import type { AgentContext, AgentContextSegment, AgentStats } from "@toonflow/server/agent/types";

const segmentColor: Record<AgentContextSegment["id"], string> = {
  system: "#8a8f98",
  rules: "#3aa76d",
  skills: "#d39a3a",
  tools: "#7b6cff",
  mcp: "#d45d9d",
  conversation: "#e15b45",
};

const props = defineProps<{ usage?: AgentContext; stats?: AgentStats; contextWindow: number; disabled: boolean }>();
const visible = defineModel<boolean>("visible", { default: false });
const hovered = shallowRef("");
const segments = computed(() => props.usage?.segments ?? []);
const contextPercent = computed(() => (props.usage?.tokens ?? 0) / props.contextWindow * 100);
const contextColor = computed(() => contextPercent.value >= 90 ? "var(--el-color-danger)" : contextPercent.value >= 75 ? "var(--el-color-warning)" : "var(--el-color-primary)");
const remainder = computed(() => Math.max(0, props.contextWindow - (props.usage?.tokens ?? 0)));
const inputTokens = computed(() => props.stats ? props.stats.tokens.input + props.stats.tokens.cacheRead + props.stats.tokens.cacheWrite : 0);
function formatTokens(value: number) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value.toLocaleString();
}
</script>

<style lang="scss">
.agentContextPopover {
  .contextUsage {
    display: flex;
    flex-direction: column;
    gap: 12px;

    .contextStats {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .contextHeader,
    .contextTokens {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .contextBar {
      display: flex;
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--el-fill-color-dark);
    }

    .contextSegment {
      min-width: 2px;
    }

    .contextRemainder {
      background: transparent;
    }

    .contextSegmentDimmed {
      opacity: 0.35;
    }

    .contextLegend {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .contextLabel {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .contextSwatch {
      width: 8px;
      height: 8px;
      flex: none;
      border-radius: 2px;
    }

    .contextHeader {
      color: var(--el-text-color-primary);
    }

    .contextTokens {
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }

    .contextHint {
      color: var(--el-text-color-secondary);
      font-size: 12px;
    }
  }
}
</style>
