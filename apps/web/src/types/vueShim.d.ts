// 供不支持 Vue 语言插件的工具（裸 tsc、静态分析器）解析 .vue 导入。
// vue-tsc 会按真实单文件组件类型检查，此处通配声明只作为兜底。
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>;
  export default component;
}
