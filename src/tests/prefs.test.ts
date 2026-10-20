// 用户偏好存储测试（用临时目录，不碰真实 .data）
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { decryptSecret, encryptSecret, loadPrefs, maskKey, savePrefs } from '../prefs/store'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'bullrider-prefs-test-'))
}

test('加密→解密往返：原文一致，密文不含明文', async () => {
  const dir = await tempDir()
  try {
    const secret = 'sk-test-1234567890abcdef'
    const blob = await encryptSecret(secret, dir)
    assert.ok(!blob.includes(secret), '密文里不应出现明文 Key')
    assert.equal(await decryptSecret(blob, dir), secret)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('换个密钥目录解密 → 返回 null（文件被拷走即作废）', async () => {
  const dirA = await tempDir()
  const dirB = await tempDir()
  try {
    const blob = await encryptSecret('sk-secret', dirA)
    assert.equal(await decryptSecret(blob, dirB), null)
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('savePrefs/loadPrefs 往返 + Key 只存密文', async () => {
  const dir = await tempDir()
  try {
    await savePrefs({ favorites: [{ code: '600050', name: '中国联通' }], chat: [{ role: 'user', content: 'hi' }] }, dir)
    const p = await loadPrefs(dir)
    assert.equal((p.favorites?.[0] as { code: string }).code, '600050')
    assert.equal((p.chat?.[0] as { content: string }).content, 'hi')

    // 手工写入一条带 Key 的偏好，验证文件里没有明文
    const enc = await encryptSecret('sk-file-test', dir)
    await savePrefs({ llm: { baseUrl: 'https://x/v1', model: 'm', encApiKey: enc } }, dir)
    const raw = await readFile(resolve(dir, 'prefs.json'), 'utf-8')
    assert.ok(!raw.includes('sk-file-test'), 'prefs.json 不应包含明文 Key')
    assert.ok(raw.includes(enc.split('.')[2].slice(0, 20)), '密文应该在文件里')
    const back = await loadPrefs(dir)
    assert.equal(await decryptSecret(back.llm?.encApiKey ?? '', dir), 'sk-file-test')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadPrefs：文件不存在 → 空对象', async () => {
  const dir = await tempDir()
  try {
    assert.deepEqual(await loadPrefs(dir), {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('maskKey：常规/超短/空值', () => {
  assert.equal(maskKey('sk-1234567890abcd'), 'sk-****abcd')
  assert.equal(maskKey('short'), '****')
  assert.equal(maskKey(undefined), undefined)
  assert.equal(maskKey(null), undefined)
})
