// AI 端点安全解析：服务端已保存的 Key 必须固定发送到保存时的端点。
// 请求里临时携带 Key 时，才允许同时指定新的 OpenAI 兼容端点。

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface StoredLlmConfig {
  baseUrl?: string
  model?: string
  apiKey?: string
}

export type LlmConfigResult =
  | { ok: true; config: LlmConfig }
  | { ok: false; reason: string }

export function normalizeLlmBaseUrl(raw: string | undefined): string | null {
  const baseUrl = raw?.trim().replace(/\/+$/, '')
  if (!baseUrl) return null
  try {
    const url = new URL(baseUrl)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null
    return baseUrl
  } catch {
    return null
  }
}

export function isSameLlmEndpoint(a: string | undefined, b: string | undefined): boolean {
  const left = normalizeLlmBaseUrl(a)
  const right = normalizeLlmBaseUrl(b)
  return Boolean(left && right && left === right)
}

export function requiresNewKeyForEndpointChange(input: {
  currentBaseUrl?: string
  nextBaseUrl?: string
  hasStoredKey: boolean
  hasNewKey: boolean
}): boolean {
  return input.hasStoredKey
    && !input.hasNewKey
    && !isSameLlmEndpoint(input.currentBaseUrl, input.nextBaseUrl)
}

function validate(config: StoredLlmConfig): LlmConfigResult {
  const rawBaseUrl = config.baseUrl?.trim()
  const baseUrl = normalizeLlmBaseUrl(config.baseUrl)
  const apiKey = config.apiKey?.trim()
  const model = config.model?.trim()
  if (rawBaseUrl && !baseUrl) {
    return { ok: false, reason: '模型端点只支持不含账号密码的 HTTP/HTTPS 地址' }
  }
  if (!baseUrl || !apiKey || !model) {
    return { ok: false, reason: '请先保存 OpenAI 兼容端点地址、API Key 和模型名' }
  }
  return { ok: true, config: { baseUrl, apiKey, model } }
}

/**
 * 请求显式带 Key 时使用请求配置；否则完全使用服务端保存的配置。
 * 这样请求方无法让已保存 Key 跟随任意 baseUrl 发往第三方地址。
 */
export function resolveLlmConfig(
  requested: Partial<LlmConfig>,
  stored: StoredLlmConfig,
): LlmConfigResult {
  if (requested.apiKey?.trim()) {
    return validate({ baseUrl: requested.baseUrl, model: requested.model, apiKey: requested.apiKey })
  }
  return validate(stored)
}
