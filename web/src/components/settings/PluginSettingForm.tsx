// 单个插件的设置对话框 —— 点击卡片上的「设置」齿轮按钮弹出，按 widget 分发 controls.tsx
// 行组件渲染全部受支持控件（text/password/textarea/number/toggle/select/folder），提交前做
// required/pattern/min-max/select 成员前置校验（全部通过才发起 PUT，避免 all-or-nothing 请求半路失败）。

import { useCallback, useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, ClipboardCopy, QrCode, Settings2, X } from 'lucide-react'
import QRCode from 'qrcode'
import { copyText } from '../../lib/copy'
import type { I18nKey } from '../../lib/i18n'
import { useI18n } from '../../lib/i18n'
import type { PluginAuthResponse, PluginDto, SettingFieldDto } from '../../lib/types'
import { usePluginAuthMutation } from '../../hooks/usePlugins'
import { FsPicker } from '../dialogs/fs-picker'
import { NumberFieldRow, SetRow, SetSelect, SetSwitch, TextAreaFieldRow, TextFieldRow } from './controls'

export interface PluginSettingsDialogProps {
  plugin: PluginDto
  authSupported?: boolean
  saving?: boolean
  /** 校验通过后提交；`onDone` 供成功回调（用于关闭对话框）。 */
  onSave: (entries: Record<string, string>, onDone: () => void) => void
}

/** 单条设置项前置校验：required → number/min/max → pattern → select 成员。首个失败项即返回。 */
function validateField(field: SettingFieldDto, raw: string): I18nKey | null {
  const value = raw.trim()
  if (field.required && value === '') return 'plugins.err.required'
  if (value === '') return null
  if (field.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return 'plugins.err.number'
    if (field.min !== null && n < field.min) return 'plugins.err.min'
    if (field.max !== null && n > field.max) return 'plugins.err.max'
  }
  if (field.pattern) {
    let ok = true
    try {
      ok = new RegExp(field.pattern).test(value)
    } catch {
      ok = true // 插件提供的正则非法：不阻塞提交
    }
    if (!ok) return 'plugins.err.pattern'
  }
  if (field.widget === 'select' && field.options.length > 0 && !field.options.some((o) => o.value === value)) {
    return 'plugins.err.select'
  }
  return null
}

export function PluginSettingsDialog({ plugin, authSupported = false, saving, onSave }: PluginSettingsDialogProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>(() => ({ ...plugin.settingsValues }))
  const [errors, setErrors] = useState<Partial<Record<string, I18nKey>>>({})

  // 每次打开都从插件当前已保存值重置表单（丢弃上次未提交的编辑）。
  useEffect(() => {
    if (open) {
      setValues({ ...plugin.settingsValues })
      setErrors({})
    }
  }, [open, plugin])

  function valueOf(field: SettingFieldDto): string {
    return values[field.key] ?? field.default ?? ''
  }

  function setValue(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }))
    setErrors((prev) => {
      if (!(key in prev)) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  function submit() {
    const nextErrors: Partial<Record<string, I18nKey>> = {}
    for (const field of plugin.settings) {
      const err = validateField(field, valueOf(field))
      if (err) nextErrors[field.key] = err
    }
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    // 插件升级/更换设置项后，后端可能仍返回旧版本残留键（例如旧的
    // username/password）。只提交当前 manifest 声明的字段，避免后端因未知键
    // 拒绝整次保存；同时把默认值展开，确保默认配置也能被稳定落库。
    const entries = Object.fromEntries(plugin.settings.map((field) => [field.key, valueOf(field)]))
    onSave(entries, () => setOpen(false))
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="icon-btn sm text-text3" title={t('plugins.configure')} aria-label={t('plugins.configure')}>
          <Settings2 size={14} />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="wbackdrop show" />
        <Dialog.Content
          asChild
          onPointerDownOutside={(e) => {
            // 表单对话框：点击外部不关闭（防误触丢失编辑，兼根治 Radix Select-in-Dialog
            // 展开时点内部元素被误判为 outside 而连带关闭的已知问题）。关闭路径：✕ / 取消 / Esc。
            e.preventDefault()
          }}
        >
          <div className="dialog show">
            <header className="dlg-head">
              <Dialog.Title asChild>
                <b>{t('plugins.settingsTitle', { name: plugin.name })}</b>
              </Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="icon-btn sm" aria-label={t('common.close')}>
                  <X size={16} />
                </button>
              </Dialog.Close>
            </header>
            <Dialog.Description className="sr-only">{plugin.description || plugin.name}</Dialog.Description>
            <div className="dlg-body">
              <div className="set-group" style={{ marginBottom: 0 }}>
                {plugin.settings.map((field) => (
                  <div className="plugin-field" key={field.key}>
                    <SettingFieldRow field={field} value={valueOf(field)} onChange={(v) => setValue(field.key, v)} />
                    {field.helperScript && <HelperScriptButton field={field} />}
                    {errors[field.key] && <p className="px-4 pb-2 text-[11px] text-danger">{t(errors[field.key]!)}</p>}
                  </div>
                ))}
              </div>
              {authSupported && <PluginAuthSection plugin={plugin} />}
            </div>
            <footer className="dlg-foot">
              <Dialog.Close asChild>
                <button type="button" className="btn ghost">
                  {t('common.cancel')}
                </button>
              </Dialog.Close>
              <button type="button" className="btn primary" disabled={saving} onClick={submit}>
                {saving ? t('common.loading') : t('plugins.saveSettings')}
              </button>
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function PluginAuthSection({ plugin }: { plugin: PluginDto }) {
  const { t } = useI18n()
  const authMut = usePluginAuthMutation()
  const [site, setSite] = useState('')
  const [input, setInput] = useState('')
  const [sessionId, setSessionId] = useState('')
  const [authRef, setAuthRef] = useState('')
  const [response, setResponse] = useState<PluginAuthResponse | null>(null)
  const { mutateAsync, isPending, reset } = authMut

  // 对话框重新打开或页面刷新后，从插件/FD 认证存储恢复登录状态或未完成的二维码会话。
  useEffect(() => {
    let active = true
    void mutateAsync({
      identity: plugin.identity,
      request: { action: 'status', site: '' },
    }).then((result) => {
      if (!active) return
      setResponse(result)
      setSessionId(result.status === 'pending' ? result.sessionId : '')
      setAuthRef(result.status === 'success' ? result.authRef || '' : '')
    }).catch(() => {
      // 没有已保存登录态是正常的，静默回到二维码登录入口。
      if (active) reset()
    })
    return () => {
      active = false
    }
  }, [mutateAsync, plugin.identity, reset])

  const submit = useCallback(async (nextInput = input) => {
    const action = sessionId ? 'poll' : 'begin'
    const result = await mutateAsync({
      identity: plugin.identity,
      request: { action, site, sessionId, input: nextInput },
    })
    setResponse(result)
    setSessionId(result.status === 'pending' ? result.sessionId || sessionId : '')
    setAuthRef(result.status === 'success' ? result.authRef || '' : '')
  }, [input, mutateAsync, plugin.identity, sessionId, site])

  // 插件返回二维码挑战后，认证会话自动轮询，不再要求用户手动点击检查状态。
  useEffect(() => {
    if (!sessionId || response?.status !== 'pending' || response.challengeType?.toLowerCase() !== 'qrcode') return
    const timer = window.setInterval(() => {
      if (!isPending) void submit()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [isPending, response?.challengeType, response?.status, sessionId, submit])

  const cancel = useCallback(async () => {
    if (sessionId) {
      await mutateAsync({
        identity: plugin.identity,
        request: { action: 'cancel', site, sessionId },
      }).catch(() => undefined)
    }
    setSessionId('')
    setAuthRef('')
    setResponse(null)
    setInput('')
    reset()
  }, [mutateAsync, plugin.identity, reset, sessionId, site])

  const logout = useCallback(async () => {
    const result = await mutateAsync({
      identity: plugin.identity,
      request: { action: 'logout', site: '', authRef },
    })
    setSessionId('')
    setAuthRef('')
    setResponse(result)
  }, [authRef, mutateAsync, plugin.identity])

  const challenge = response?.challenge ?? ''
  const challengeIsImage = challenge.startsWith('data:image/') || response?.challengeType?.startsWith('image/')
  const isLoggedIn = response?.status === 'success' && Boolean(authRef)
  // pending 是正常的等待状态，即使之前的请求曾失败，也不能把本次提示染成错误红色。
  const messageClass = response?.status === 'error' || (!response && authMut.isError)
    ? 'text-danger'
    : response?.status === 'success'
      ? 'text-success'
      : 'text-text2'
  const displayMessage = response?.message || (authMut.isError && !response ? authMut.error?.message || t('plugins.authFailed') : '')
  return (
    <section className="mt-4 rounded-lg border border-line bg-surface2 p-4">
      <div className="mb-2 flex items-center gap-2">
        <QrCode size={15} className="text-accent" />
        <b className="text-[13px]">{t('plugins.authButton')}</b>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-text2">{t('plugins.authDescription')}</p>
      <div className="flex flex-col gap-2">
        <input className="input" value={site} onChange={(event) => setSite(event.target.value)} placeholder={t('plugins.authSitePlaceholder')} disabled={isPending} />
        <input className="input" value={input} onChange={(event) => setInput(event.target.value)} placeholder={t('plugins.authInputPlaceholder')} disabled={isPending} />
        {challenge && (
          <div className="rounded-lg bg-surface p-3 text-[12px] text-text2">
            {challengeIsImage ? (
              <img src={challenge} alt={t('plugins.authChallenge')} className="mx-auto max-h-56 max-w-56" />
            ) : response?.challengeType?.toLowerCase() === 'qrcode' ? (
              <QrChallenge value={challenge} alt={t('plugins.authChallenge')} />
            ) : (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all">{challenge}</pre>
            )}
          </div>
        )}
        {displayMessage && (
          <p className={`text-[12px] ${messageClass}`}>
            {displayMessage}
          </p>
        )}
        <div className="flex justify-end gap-2">
          {sessionId && <button type="button" className="btn ghost sm" onClick={() => void cancel()} disabled={isPending}>{t('common.cancel')}</button>}
          {isLoggedIn && <button type="button" className="btn ghost sm" onClick={() => void logout()} disabled={isPending}>{t('plugins.authLogout')}</button>}
          {!isLoggedIn && !(sessionId && response?.status === 'pending' && response.challengeType?.toLowerCase() === 'qrcode') && (
            <button type="button" className="btn primary sm" onClick={() => void submit()} disabled={isPending}>
              {isPending ? t('common.loading') : sessionId ? t('plugins.authPoll') : t('plugins.authBegin')}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

function QrChallenge({ value, alt }: { value: string; alt: string }) {
  const [src, setSrc] = useState('')
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    setSrc('')
    setError(false)
    void QRCode.toDataURL(value, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 240,
    }).then((dataUrl) => {
      if (active) setSrc(dataUrl)
    }).catch(() => {
      if (active) setError(true)
    })
    return () => {
      active = false
    }
  }, [value])

  if (src) return <img src={src} alt={alt} className="mx-auto h-60 w-60 rounded bg-white p-2" />
  if (error) return <a className="break-all text-accent underline" href={value} target="_blank" rel="noreferrer">{value}</a>
  return <p className="text-center text-[12px] text-text3">生成二维码…</p>
}

function SettingFieldRow({
  field,
  value,
  onChange,
}: {
  field: SettingFieldDto
  value: string
  onChange: (v: string) => void
}) {
  const { t } = useI18n()
  const title = (
    <>
      {field.title || field.key}
      {field.required && <span className="ml-0.5 text-danger">*</span>}
    </>
  )
  const desc = field.description || undefined
  switch (field.widget) {
    case 'password':
      return <TextFieldRow title={title} desc={desc} value={value} onCommit={onChange} password />
    case 'textarea':
      return <TextAreaFieldRow title={title} desc={desc} value={value} onCommit={onChange} rows={field.key === 'cookies' ? 2 : 4} />
    case 'number':
      return (
        <NumberFieldRow
          title={title}
          desc={desc}
          value={Number(value || '0')}
          onCommit={(n) => onChange(String(n))}
          min={field.min ?? undefined}
          max={field.max ?? undefined}
        />
      )
    case 'toggle':
      return (
        <SetRow title={title} desc={desc}>
          <SetSwitch checked={value === 'true'} onCheckedChange={(v) => onChange(v ? 'true' : 'false')} />
        </SetRow>
      )
    case 'select':
      return (
        <SetRow title={title} desc={desc}>
          <SetSelect
            value={value}
            onValueChange={onChange}
            options={field.options}
            placeholder={t('plugins.selectPlaceholder')}
          />
        </SetRow>
      )
    case 'folder':
      return (
        <SetRow title={title} desc={desc}>
          <div className="dir-row" style={{ width: 260, flexShrink: 0 }}>
            <input
              className="text-input"
              spellCheck={false}
              placeholder={t('plugins.folderPlaceholder')}
              value={value}
              onChange={(e) => onChange(e.target.value)}
            />
            <FsPicker value={value} onChange={onChange} />
          </div>
        </SetRow>
      )
    case 'text':
    default:
      return <TextFieldRow title={title} desc={desc} value={value} onCommit={onChange} />
  }
}

/** 字段级辅助脚本复制按钮：仅复制文本到剪贴板（绝不执行），供用户粘贴到目标
 *  网站的开发者工具 Console 运行（典型用途：提取 cookie）。 */
function HelperScriptButton({ field }: { field: SettingFieldDto }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <div className="px-4 pb-2">
      <button
        type="button"
        className="btn ghost sm"
        onClick={() => {
          copyText(field.helperScript ?? '')
          setCopied(true)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setCopied(false), 2500)
        }}
      >
        {copied ? <Check size={13} /> : <ClipboardCopy size={13} />}
        {copied ? t('plugins.helperCopied') : field.helperLabel || t('plugins.copyHelper')}
      </button>
    </div>
  )
}
