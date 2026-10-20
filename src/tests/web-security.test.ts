// AI 端点配置安全测试：已保存 Key 不能被请求方改道到任意地址
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isSameLlmEndpoint,
  normalizeLlmBaseUrl,
  requiresNewKeyForEndpointChange,
  resolveLlmConfig,
} from '../web/llm-config'

const stored = {
  baseUrl: 'https://api.example.com/v1/',
  model: 'saved-model',
  apiKey: 'sk-stored',
}

test('已保存 Key：忽略请求里的恶意 baseUrl，固定使用保存的端点和模型', () => {
  const r = resolveLlmConfig({
    baseUrl: 'https://attacker.example/collect',
    model: 'attacker-model',
  }, stored)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.config.baseUrl, 'https://api.example.com/v1')
  assert.equal(r.config.model, 'saved-model')
  assert.equal(r.config.apiKey, 'sk-stored')
})

test('临时 Key：允许使用请求指定的端点，并去掉末尾斜杠', () => {
  const r = resolveLlmConfig({
    baseUrl: 'https://custom.example/v1/',
    model: 'custom-model',
    apiKey: 'sk-temp',
  }, stored)
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.config.baseUrl, 'https://custom.example/v1')
  assert.equal(r.config.model, 'custom-model')
  assert.equal(r.config.apiKey, 'sk-temp')
})

test('端点只允许 HTTP/HTTPS，并拒绝携带账号密码', () => {
  const ftp = resolveLlmConfig({}, { ...stored, baseUrl: 'ftp://example.com/v1' })
  assert.equal(ftp.ok, false)
  const credentials = resolveLlmConfig({}, { ...stored, baseUrl: 'https://user:pass@example.com/v1' })
  assert.equal(credentials.ok, false)
})

test('端点规范化：尾斜杠不影响比较，不同域名视为换端点', () => {
  assert.equal(normalizeLlmBaseUrl(' https://api.example.com/v1/ '), 'https://api.example.com/v1')
  assert.equal(isSameLlmEndpoint('https://api.example.com/v1', 'https://api.example.com/v1/'), true)
  assert.equal(isSameLlmEndpoint('https://api.example.com/v1', 'https://other.example/v1'), false)
})

test('修改已保存 Key 的端点时必须重新输入 Key', () => {
  const base = { currentBaseUrl: 'https://api.example.com/v1', hasStoredKey: true }
  assert.equal(requiresNewKeyForEndpointChange({ ...base, nextBaseUrl: 'https://other.example/v1', hasNewKey: false }), true)
  assert.equal(requiresNewKeyForEndpointChange({ ...base, nextBaseUrl: 'https://other.example/v1', hasNewKey: true }), false)
  assert.equal(requiresNewKeyForEndpointChange({ ...base, nextBaseUrl: 'https://api.example.com/v1/', hasNewKey: false }), false)
})

test('没有请求 Key 也没有保存 Key 时返回明确错误', () => {
  const r = resolveLlmConfig({}, { baseUrl: 'https://api.example.com/v1', model: 'm' })
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /API Key/)
})
