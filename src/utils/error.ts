// utils/error.ts
import { serializeError } from "serialize-error";
import { isAxiosError } from "axios";

export interface NormalizedError {
  name: string;
  message: string;
  code?: string;
  status?: number;
  stack?: string;
  cause?: NormalizedError;
  responseData?: unknown;
  meta?: Record<string, unknown>;
}

/**
 * 从各种供应商返回的错误体中提取最有意义的文本信息
 */
function extractProviderMessage(data: unknown): string | undefined {
  if (data === null || data === undefined) return undefined;
  if (typeof data === "string") return data || undefined;
  if (typeof data !== "object") return undefined;

  const record = data as Record<string, any>;

  // OpenAI / 通用格式
  if (typeof record.error?.message === "string" && record.error.message) {
    return record.error.message;
  }
  // 通用 message / detail / failReason
  for (const key of ["failReason", "message", "detail", "msg", "status_msg", "status_msg", "reason", "error_msg"]) {
    const val = record[key];
    if (typeof val === "string" && val) return val;
    if (typeof val === "object" && val && typeof val.message === "string" && val.message) {
      return val.message;
    }
  }
  // 有些供应商把错误直接放在 data 里
  if (typeof record.data === "string" && record.data) return record.data;
  if (typeof record.data?.message === "string" && record.data.message) return record.data.message;
  if (typeof record.data?.failReason === "string" && record.data.failReason) return record.data.failReason;

  return undefined;
}

export function normalizeError(error: unknown): NormalizedError {
  // Axios 特殊处理
  if (isAxiosError(error)) {
    const responseData = error.response?.data;
    return {
      name: "AxiosError",
      message: extractProviderMessage(responseData) || error.message,
      code: error.code,
      status: error.response?.status,
      stack: error.stack,
      responseData,
      meta: {
        url: error.config?.url,
        method: error.config?.method,
      },
    };
  }

  // 普通 Error，用 serialize-error 处理
  if (error instanceof Error) {
    const serialized = serializeError(error);
    // 尝试从 cause 提取更具体的供应商错误信息
    const causeNormalized = error.cause ? normalizeError(error.cause) : undefined;
    const providerMessage = causeNormalized?.message;

    return {
      name: serialized.name || "Error",
      message: providerMessage || serialized.message || "未知错误",
      code: (serialized as any).code,
      stack: serialized.stack,
      cause: causeNormalized,
      responseData: causeNormalized?.responseData ?? (serialized as any).responseData,
      meta: {
        ...extractMeta(serialized),
        ...(causeNormalized?.meta ?? {}),
      },
    };
  }

  // 非 Error
  return {
    name: "UnknownError",
    message: String(error),
    meta: { raw: serializeError(error) },
  };
}

/**
 * 创建一个保留原始错误 cause 的新 Error
 * 用于必须在中间层重新抛错、但又不想丢失上下文的场景
 */
export function createError(message: string, original?: unknown): Error {
  const normalized = original ? normalizeError(original) : undefined;
  const err = new Error(message, { cause: normalized });
  return err;
}

// 提取自定义属性
function extractMeta(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const standardKeys = ["name", "message", "stack", "cause"];
  const meta: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (!standardKeys.includes(key) && value !== undefined) {
      meta[key] = value;
    }
  }

  return Object.keys(meta).length > 0 ? meta : undefined;
}

export default normalizeError;
