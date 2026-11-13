// Client half of dsh-doctor: the 体检 section in Settings.
//
// Mounted onto `settings.section` (a list slot: id / order / label are the only
// options). Everything it shows comes from the host half over
// /api/dsh-doctor/*; this file never touches the profile on disk.
//
// The panel is three layers, matching DESIGN.md:
//   status   — what diagnose reported, how fresh it is, which profile/port
//   findings — one row per check: code, evidence, fixability, actions
//   ledger   — repair journals, rollback, and the "manual compensation" items
//   policy   — the ladder switches (auto safe / confirm deps / confirm full)

window.__ModuleLoader__.load({
  id: 'dsh-doctor',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/api/dsh-doctor'
    const HEADERS = { 'x-dsh-doctor': '1' }

    // Only the 14 theme tokens that actually exist. `label-tertiary` is not one
    // of them (cost-meter references it and falls back to nothing).
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      layer: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    const STATUS = {
      error: { label: '阻塞', color: C.error },
      warn: { label: '警告', color: C.warn },
      info: { label: '提示', color: C.idle },
    }

    const BADGE = {
      auto: { text: '可自修', color: C.success },
      confirm: { text: '需选档', color: C.warn },
      handoff: { text: '交给 AI', color: C.brand },
      info: { text: '仅说明', color: C.muted },
    }

    const SCOPES = [
      { value: 'safe', label: 'safe', note: '补建缺失目录与文件、修 allowBuilds 占位符；每一步都进 journal，可回滚' },
      { value: 'deps', label: 'deps', note: 'safe + pnpm install --fix-lockfile；锁文件与依赖变更只能标记为需手动补偿' },
      { value: 'full', label: 'full', note: 'deps + 停残留 DSH 进程；不可逆，端口健康时会自动跳过' },
    ]

    const DEFAULT_LADDER = { autoSafe: false, confirmDeps: true, confirmFull: true, handoff: true, showInfo: false }

    const STEP_MARK = { applied: '✓', skipped: '⊘', failed: '✕', info: '·' }
    const UNDO_LABEL = { 'restore-file': '恢复原文件', 'delete-file': '删除新建文件', 'remove-dir': '删除新建目录', manual: '需手动补偿' }

    const S = {
      panel: {
        padding: '24px 28px 32px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        color: C.text,
        fontSize: 13,
        lineHeight: 1.6,
        maxWidth: 960,
      },
      card: {
        border: '1px solid ' + C.border,
        borderRadius: 10,
        padding: '14px 16px',
        background: C.layer,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      h: { fontSize: 14, fontWeight: 600, color: C.text, margin: 0 },
      row: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      actions: { display: 'flex', gap: 6, flexShrink: 0, alignItems: 'flex-start', flexWrap: 'wrap' },
      btn: {
        appearance: 'none',
        border: '1px solid ' + C.borderStrong,
        background: 'transparent',
        color: C.text,
        borderRadius: 7,
        padding: '3px 10px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
      },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 },
      dot: (color) => ({ width: 8, height: 8, borderRadius: 4, background: color, marginTop: 7, flexShrink: 0 }),
      badge: (color) => ({
        color,
        border: '1px solid ' + color,
        borderRadius: 999,
        padding: '0 7px',
        fontSize: 11,
        lineHeight: '17px',
        whiteSpace: 'nowrap',
      }),
      banner: (color) => ({ border: '1px solid ' + color, color, borderRadius: 8, padding: '8px 12px' }),
      chip: (active) => ({
        border: '1px solid ' + (active ? C.brand : C.border),
        color: active ? C.brand : C.muted,
        background: 'transparent',
        borderRadius: 999,
        padding: '2px 10px',
        fontSize: 12,
        cursor: 'pointer',
      }),
      textarea: {
        width: '100%',
        boxSizing: 'border-box',
        minHeight: 150,
        resize: 'vertical',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12,
        lineHeight: 1.55,
        color: C.text,
        background: C.layer2,
        border: '1px solid ' + C.border,
        borderRadius: 8,
        padding: 10,
      },
    }

    const btn = (label, onClick, opts) => {
      const o = opts || {}
      return h(
        'button',
        {
          type: 'button',
          onClick,
          disabled: Boolean(o.disabled),
          title: o.title,
          style: {
            ...S.btn,
            ...(o.primary ? { borderColor: C.brand, color: C.brand } : null),
            ...(o.danger ? { borderColor: C.error, color: C.error } : null),
            opacity: o.disabled ? 0.45 : 1,
            cursor: o.disabled ? 'default' : 'pointer',
          },
        },
        label,
      )
    }

    const fmtTime = (iso) => {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return String(iso)
      return date.toLocaleString('zh-CN', { hour12: false })
    }

    async function call(path, options) {
      const o = options || {}
      const init = { method: o.method || 'GET', headers: { ...HEADERS } }
      if (o.body !== undefined) {
        init.body = JSON.stringify(o.body)
        init.headers['content-type'] = 'application/json'
      }
      const response = await fetch(API + path, init)
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!data || typeof data !== 'object') throw new Error('HTTP ' + response.status + '（响应不是 JSON）')
      return { ...data, httpStatus: response.status }
    }

    // Mirrors lib/codes.mjs fixableBy() so the per-row 修复 button matches what
    // the server will actually do for the currently selected scope.
    const isFixable = (finding, scope) => {
      if (!finding || finding.ignored) return false
      if (finding.fixability === 'auto') return true
      if (finding.fixability === 'confirm') return finding.suggestedScope === scope || scope === 'full'
      return false
    }

    function DoctorPanel(props) {
      const [state, setState] = useState(null)
      const [report, setReport] = useState(null)
      const [phase, setPhase] = useState('idle') // idle | diagnosing
      const [scope, setScope] = useState('safe')
      const [confirming, setConfirming] = useState(null)
      const [job, setJob] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [handoff, setHandoff] = useState(null)
      const [journal, setJournal] = useState(null)
      const [filter, setFilter] = useState('all')
      const [pendingRollback, setPendingRollback] = useState('')
      const alive = useRef(true)

      useEffect(() => {
        alive.current = true
        return () => {
          alive.current = false
        }
      }, [])

      const loadState = useCallback(async () => {
        try {
          const data = await call('/state')
          if (!alive.current) return
          setState(data)
          if (data.job && data.job.state === 'running') setJob(data.job)
        } catch (e) {
          if (alive.current) setError(String((e && e.message) || e))
        }
      }, [])

      const runDiagnose = useCallback(async () => {
        setPhase('diagnosing')
        setError('')
        setNotice('')
        setHandoff(null)
        try {
          const data = await call('/diagnose')
          if (!alive.current) return
          if (data.available === false) {
            setReport(null)
            setError(data.reason || 'dsh-doctor 服务不可用')
          } else if (data.ok === false) {
            setError(data.error || '体检失败')
          } else {
            setReport(data)
          }
        } catch (e) {
          if (alive.current) setError(String((e && e.message) || e))
        } finally {
          if (alive.current) setPhase('idle')
        }
      }, [])

      useEffect(() => {
        loadState()
        runDiagnose()
      }, [loadState, runDiagnose])

      // Poll only while a job is running, and stop as soon as it settles.
      const jobId = job && job.state === 'running' ? job.id : ''
      useEffect(() => {
        if (!jobId) return undefined
        let stopped = false
        const tick = async () => {
          try {
            const data = await call('/job?id=' + encodeURIComponent(jobId))
            if (stopped || !alive.current) return
            if (data.ok && data.job) {
              setJob(data.job)
              if (data.job.state !== 'running') {
                setNotice(data.job.state === 'done' ? '修复任务已完成，账本已更新' : '修复任务失败，详见下方任务卡')
                await loadState()
                setReport((prev) => (prev ? { ...prev, stale: true } : prev))
              }
            }
          } catch {
            // transient network hiccup: keep polling until the job settles
          }
        }
        const timer = setInterval(tick, 900)
        tick()
        return () => {
          stopped = true
          clearInterval(timer)
        }
      }, [jobId, loadState])

      const doFix = useCallback(async (target) => {
        setConfirming(null)
        setError('')
        setNotice('')
        try {
          const data = await call('/fix', { method: 'POST', body: { scope: target, confirm: true } })
          if (!data.ok || !data.jobId) {
            setError(
              data.reason === 'busy'
                ? '已有修复任务在跑，先等它结束'
                : data.reason === 'confirm-required'
                  ? '该档需要确认后执行'
                  : data.reason || data.error || '启动修复失败',
            )
            return
          }
          setJob({ id: data.jobId, state: 'running', phase: 'starting', steps: [] })
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [])

      const requestFix = useCallback(
        (target) => {
          const ladder = (state && state.ladder) || DEFAULT_LADDER
          const needsConfirm =
            target === 'deps' ? ladder.confirmDeps !== false : target === 'full' ? ladder.confirmFull !== false : false
          if (needsConfirm) {
            setConfirming(target)
            return
          }
          doFix(target)
        },
        [state, doFix],
      )

      const toggleIgnore = useCallback(
        async (finding) => {
          try {
            const data = await call('/ignore', { method: 'POST', body: { code: finding.code, ignored: !finding.ignored } })
            if (!data.ok) return
            setReport((prev) =>
              prev
                ? { ...prev, findings: prev.findings.map((item) => (item.code === finding.code ? { ...item, ignored: !finding.ignored } : item)) }
                : prev,
            )
            await loadState()
          } catch (e) {
            setError(String((e && e.message) || e))
          }
        },
        [loadState],
      )

      const askHandoff = useCallback(async (finding) => {
        setError('')
        setNotice('')
        try {
          const data = await call('/handoff', {
            method: 'POST',
            body: {
              code: finding.code,
              kind: finding.kind,
              status: finding.status,
              title: finding.title,
              detail: finding.detail,
              fixHint: finding.fixHint,
              note: finding.note,
            },
          })
          if (!data.ok) {
            setError(data.error || data.reason || '生成交接文本失败')
            return
          }
          setHandoff({ code: finding.code, text: data.text, deduped: Boolean(data.deduped) })
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [])

      const copyHandoff = useCallback(async () => {
        if (!handoff) return
        try {
          await navigator.clipboard.writeText(handoff.text)
          setNotice('交接文本已复制，粘贴到对话里即可（面板不会自动发送）')
        } catch {
          setNotice('复制失败，请手动选中文本框内容复制')
        }
      }, [handoff])

      const rollback = useCallback(
        async (id) => {
          setPendingRollback('')
          setError('')
          setNotice('')
          try {
            const data = await call('/rollback', { method: 'POST', body: { id } })
            if (!data.ok || !data.result) {
              setError(data.reason === 'unknown-journal' ? '账本不存在或已被清理' : data.error || '回滚失败')
              return
            }
            const result = data.result
            setNotice(
              '回滚完成：撤销 ' + result.undoneCount + ' 项，失败 ' + result.failedCount + ' 项，需手动补偿 ' + result.manualCount + ' 项',
            )
            setJournal(null)
            await loadState()
          } catch (e) {
            setError(String((e && e.message) || e))
          }
        },
        [loadState],
      )

      const openJournal = useCallback(async (id) => {
        try {
          const data = await call('/journal?id=' + encodeURIComponent(id))
          if (data.ok) setJournal(data.journal)
          else setError(data.error || '读取账本失败')
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [])

      const patchLadder = useCallback(async (key, value) => {
        try {
          const data = await call('/ladder', { method: 'POST', body: { patch: { [key]: value } } })
          if (data.ok) setState((prev) => (prev ? { ...prev, ladder: data.ladder } : prev))
        } catch (e) {
          setError(String((e && e.message) || e))
        }
      }, [])

      const ladder = (state && state.ladder) || DEFAULT_LADDER
      const doctorAvailable = Boolean(state && state.doctor && state.doctor.available)
      const findings = (report && report.findings) || []
      const counts = (report && report.counts) || {}
      const busy = phase === 'diagnosing' || Boolean(jobId)
      const fixable = findings.filter((finding) => isFixable(finding, scope))
      const ignoredCodes = (state && state.ignored) || []
      const journals = (state && state.journals) || []
      const target = (state && state.env) || {}

      const visible = useMemo(() => {
        let list = findings
        const showInfo = Boolean(ladder.showInfo)
        if (filter === 'ignored') return list.filter((finding) => finding.ignored)
        if (filter === 'fixable') return list.filter((finding) => !finding.ignored && isFixable(finding, scope))
        if (filter === 'error' || filter === 'warn' || filter === 'info') {
          return list.filter((finding) => finding.status === filter && !finding.ignored)
        }
        list = list.filter((finding) => !finding.ignored)
        if (!showInfo) list = list.filter((finding) => finding.status !== 'info')
        return list
      }, [findings, filter, ladder.showInfo, scope])

      // ---- pieces -----------------------------------------------------------

      const header = h(
        'div',
        { style: { ...S.row, justifyContent: 'space-between', alignItems: 'flex-start' } },
        h(
          'div',
          null,
          h('div', { style: { fontSize: 16, fontWeight: 600 } }, '体检'),
          h(
            'div',
            { style: { ...S.muted, fontSize: 12 } },
            '只读诊断 + 分级修复。诊断本身不写任何文件，修复全部经由 dsh-doctor 的 journal。',
          ),
        ),
        h(
          'div',
          { style: S.actions },
          btn(phase === 'diagnosing' ? '体检中…' : '重新体检', runDiagnose, { disabled: busy, primary: true }),
          btn('刷新状态', loadState, { disabled: false }),
        ),
      )

      const banners = []
      if (error) banners.push(h('div', { key: 'error', style: S.banner(C.error) }, error))
      if (notice) banners.push(h('div', { key: 'notice', style: S.banner(C.brand) }, notice))
      if (state && !doctorAvailable) {
        banners.push(
          h(
            'div',
            { key: 'no-doctor', style: S.banner(C.warn) },
            h('div', null, '未检测到 dsh-doctor 服务。'),
            h(
              'div',
              { style: { fontSize: 12, opacity: 0.9 } },
              '请先在「插件」页安装 @jorinyang/dsh-doctor 并重启 DSH；本面板只做展示与编排，不自行诊断或修复。',
            ),
          ),
        )
      }
      if (report && report.stale) {
        banners.push(h('div', { key: 'stale', style: S.banner(C.warn) }, '上次修复已改变 profile，当前结论可能过期，建议重新体检。'))
      }

      const statusCard = h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: { fontWeight: 600 } }, '结论概览'),
          h('div', { style: { ...S.muted, ...S.mono, fontSize: 11 } }, (target.profile || '—') + ' · :' + (target.port || '—')),
        ),
        report
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h(
                'div',
                { style: S.row },
                h('span', { style: S.badge(C.success) }, '通过 ' + (counts.pass || 0)),
                h('span', { style: S.badge(C.warn) }, '警告 ' + (counts.warn || 0)),
                h('span', { style: S.badge(C.error) }, '阻塞 ' + (counts.fail || 0)),
                h('span', { style: { ...S.muted, fontSize: 12 } }, '共 ' + (counts.total || 0) + ' 项 · ' + fmtTime(report.ranAt)),
              ),
              h('div', { style: { fontSize: 12 } }, report.summary || ''),
            )
          : h('div', { style: S.muted }, phase === 'diagnosing' ? '正在体检（会调用 dsh --dump-config，通常几秒）…' : '还没有结论，点右上角「重新体检」。'),
      )

      const scopeCard = h(
        'div',
        { style: S.card },
        h('div', { style: { fontWeight: 600 } }, '修复档位'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
          SCOPES.map((item) =>
            h(
              'label',
              {
                key: item.value,
                style: { ...S.row, alignItems: 'flex-start', cursor: 'pointer', gap: 8 },
              },
              h('input', {
                type: 'radio',
                name: 'dsh-doctor-scope',
                checked: scope === item.value,
                onChange: () => setScope(item.value),
                style: { marginTop: 4 },
              }),
              h(
                'div',
                null,
                h('div', { style: { fontWeight: 500 } }, item.label),
                h('div', { style: { ...S.muted, fontSize: 12 } }, item.note),
              ),
            ),
          ),
        ),
        h(
          'div',
          { style: { ...S.row, justifyContent: 'space-between' } },
          h(
            'div',
            { style: { ...S.muted, fontSize: 12 } },
            report ? '该档位下可修 ' + fixable.length + ' 项 / 共 ' + findings.filter((f) => !f.ignored).length + ' 项' : '先体检再修复',
          ),
          btn('按 ' + scope + ' 档修复', () => requestFix(scope), {
            disabled: !report || busy || !doctorAvailable || fixable.length === 0,
            primary: true,
          }),
        ),
        confirming
          ? h(
              'div',
              { style: { border: '1px solid ' + C.warn, borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', { style: { fontWeight: 600 } }, '确认按 ' + confirming + ' 档修复？'),
              h(
                'div',
                { style: { fontSize: 12 } },
                confirming === 'deps'
                  ? '会执行 pnpm install --fix-lockfile：依赖与锁文件变更无法自动回滚，只能记「需手动补偿」。'
                  : '会先探端口，DSH 健康则跳过；否则尝试停止残留 dsh 进程，这一步不可逆。',
              ),
              h(
                'div',
                { style: S.actions },
                btn('确认修复', () => doFix(confirming), { primary: true }),
                btn('取消', () => setConfirming(null)),
              ),
            )
          : null,
      )

      const chips = [
        ['all', '全部'],
        ['error', '阻塞'],
        ['warn', '警告'],
        ['info', '提示'],
        ['fixable', '可修'],
        ['ignored', '已忽略'],
      ]

      const findingRows = visible.map((finding) => {
        const status = STATUS[finding.status] || STATUS.info
        const badge = BADGE[finding.fixability] || BADGE.info
        return h(
          'div',
          { key: finding.code, style: { borderTop: '1px solid ' + C.border, padding: '10px 0', display: 'flex', gap: 10 } },
          h('span', { style: S.dot(status.color) }),
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
            h(
              'div',
              { style: S.row },
              h('span', { style: { ...S.mono, ...S.muted } }, finding.code),
              h('span', { style: { fontWeight: 500 } }, finding.title || finding.kind),
              h('span', { style: S.badge(badge.color) }, badge.text),
              finding.ignored ? h('span', { style: S.badge(C.muted) }, '已忽略') : null,
            ),
            h('div', { style: { wordBreak: 'break-word' } }, finding.detail),
            finding.fixHint ? h('div', { style: { ...S.muted, fontSize: 12 } }, '建议：' + finding.fixHint) : null,
            finding.note ? h('div', { style: { ...S.muted, fontSize: 12 } }, finding.note) : null,
          ),
          h(
            'div',
            { style: S.actions },
            isFixable(finding, scope) && !finding.ignored ? btn('修复', () => requestFix(scope), { disabled: busy }) : null,
            finding.fixability === 'handoff' ? btn('交给 AI', () => askHandoff(finding), { disabled: !ladder.handoff }) : null,
            btn(finding.ignored ? '恢复' : '忽略', () => toggleIgnore(finding)),
          ),
        )
      })

      const findingCard = h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: { fontWeight: 600 } }, '结论'),
          h(
            'div',
            { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
            chips.map(([value, label]) =>
              h('button', { key: value, type: 'button', onClick: () => setFilter(value), style: S.chip(filter === value) }, label),
            ),
          ),
        ),
        visible.length
          ? h('div', null, findingRows)
          : h('div', { style: S.muted }, report ? '这一栏没有可显示的项。' : '暂无数据。'),
        h(
          'div',
          { style: { ...S.muted, fontSize: 11, borderTop: '1px solid ' + C.border, paddingTop: 8 } },
          'auto：各档都能修；confirm：需选到对应档位；handoff：dsh-doctor 不具备该修复能力，只生成可粘贴的交接上下文。',
        ),
      )

      const stepRows = ((job && job.steps) || []).map((step, index) =>
        h(
          'div',
          { key: String(index) + '-' + step.kind, style: { display: 'flex', gap: 8, fontSize: 12, alignItems: 'flex-start' } },
          h('span', { style: { color: step.status === 'failed' ? C.error : step.status === 'applied' ? C.success : C.muted, width: 12 } }, STEP_MARK[step.status] || '·'),
          h(
            'div',
            { style: { minWidth: 0 } },
            h('span', { style: { ...S.mono, ...S.muted } }, step.kind + ' '),
            h('span', { style: { wordBreak: 'break-word' } }, step.detail),
          ),
        ),
      )

      const jobCard = job
        ? h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: { ...S.row, justifyContent: 'space-between' } },
              h('div', { style: { fontWeight: 600 } }, '修复任务 ' + job.id),
              h(
                'span',
                { style: S.badge(job.state === 'done' ? C.success : job.state === 'failed' ? C.error : C.brand) },
                job.state === 'done' ? '已完成' : job.state === 'failed' ? '失败' : job.phase || 'running',
              ),
            ),
            job.scope ? h('div', { style: { ...S.muted, fontSize: 12 } }, '档位 ' + job.scope + ' · 开始于 ' + fmtTime(job.createdAt)) : null,
            stepRows.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, stepRows) : h('div', { style: S.muted }, '正在执行…'),
            job.summary ? h('div', { style: { fontSize: 12 } }, job.summary) : null,
            job.error ? h('div', { style: { color: C.error, fontSize: 12 } }, job.error) : null,
            h(
              'div',
              { style: S.actions },
              job.journalId ? btn('查看账本', () => openJournal(job.journalId)) : null,
              job.journalId ? btn('回滚本次', () => rollback(job.journalId), { danger: true }) : null,
            ),
          )
        : null

      const journalRows = journals.map((entry) =>
        h(
          'div',
          { key: entry.id, style: { borderTop: '1px solid ' + C.border, padding: '8px 0', display: 'flex', gap: 10, alignItems: 'flex-start' } },
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h(
              'div',
              { style: S.row },
              h('span', { style: S.mono }, entry.id),
              h('span', { style: S.badge(C.brand) }, entry.scope || '?'),
              h('span', { style: { ...S.muted, fontSize: 12 } }, entry.entries + ' 项'),
              entry.manual > 0 ? h('span', { style: S.badge(C.error) }, '需手动补偿 ' + entry.manual) : null,
            ),
            h('div', { style: { ...S.muted, fontSize: 11 } }, fmtTime(entry.createdAt) + ' · ' + (entry.kinds || []).join(', ')),
          ),
          h(
            'div',
            { style: S.actions },
            btn('详情', () => openJournal(entry.id)),
            pendingRollback === entry.id
              ? btn('确认回滚', () => rollback(entry.id), { danger: true })
              : btn('回滚', () => setPendingRollback(entry.id)),
          ),
        ),
      )

      const journalDetail = journal
        ? h(
            'div',
            { style: { border: '1px solid ' + C.border, borderRadius: 8, padding: 12, display: 'flex', flexDirection: 'column', gap: 6 } },
            h(
              'div',
              { style: { ...S.row, justifyContent: 'space-between' } },
              h('div', { style: { fontWeight: 600 } }, '账本 ' + journal.id),
              btn('收起', () => setJournal(null)),
            ),
            h('div', { style: { ...S.muted, fontSize: 11 } }, fmtTime(journal.createdAt) + ' · ' + journal.scope + ' · ' + journal.profile),
            (journal.entries || []).map((entry, index) =>
              h(
                'div',
                { key: String(index), style: { fontSize: 12, display: 'flex', gap: 8, alignItems: 'flex-start' } },
                h(
                  'span',
                  { style: { color: entry.undo && entry.undo.type === 'manual' ? C.error : C.muted, flexShrink: 0 } },
                  (UNDO_LABEL[entry.undo && entry.undo.type] || '其他'),
                ),
                h('span', { style: { wordBreak: 'break-word' } }, entry.kind + ' · ' + entry.detail),
              ),
            ),
          )
        : null

      const journalCard = h(
        'div',
        { style: S.card },
        h(
          'div',
          { style: { ...S.row, justifyContent: 'space-between' } },
          h('div', { style: { fontWeight: 600 } }, '修复账本'),
          h('div', { style: { ...S.muted, fontSize: 11 } }, '回滚按 LIFO 逐条撤销；「需手动补偿」不会被假装成已回滚'),
        ),
        journalRows.length ? h('div', null, journalRows) : h('div', { style: S.muted }, '还没有修复记录。'),
        journalDetail,
      )

      const ladderRows = [
        ['autoSafe', 'safe 档自动修复', '开启后体检发现可自修项就直接按 safe 修，不再点按钮（默认关）'],
        ['confirmDeps', 'deps 档必须确认', '执行 pnpm install 前二次确认（默认开，建议保持）'],
        ['confirmFull', 'full 档必须确认', 'full 会尝试停进程，不可逆（默认开，建议保持）'],
        ['handoff', '允许交给 AI', '为修不动的结论生成可粘贴的交接上下文（默认开；不会自动新建会话、不会自动发送）'],
        ['showInfo', '显示提示级结论', '默认只显示阻塞与警告，勾上后连 info 一起列出'],
      ]

      const ladderCard = h(
        'div',
        { style: S.card },
        h('div', { style: { fontWeight: 600 } }, '阶梯策略'),
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
          ladderRows.map(([key, label, note]) =>
            h(
              'label',
              { key, style: { display: 'flex', gap: 8, alignItems: 'flex-start', cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: Boolean(ladder[key]),
                onChange: (event) => patchLadder(key, event.target.checked),
                style: { marginTop: 4 },
              }),
              h(
                'div',
                null,
                h('div', { style: { fontWeight: 500 } }, label),
                h('div', { style: { ...S.muted, fontSize: 12 } }, note),
              ),
            ),
          ),
        ),
        ignoredCodes.length
          ? h(
              'div',
              { style: { borderTop: '1px solid ' + C.border, paddingTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } },
              h('span', { style: { ...S.muted, fontSize: 12 } }, '已忽略：'),
              ignoredCodes.map((code) =>
                h(
                  'button',
                  {
                    key: code,
                    type: 'button',
                    onClick: () => toggleIgnore({ code, ignored: true }),
                    style: S.chip(false),
                    title: '点一下恢复',
                  },
                  code + ' ×',
                ),
              ),
            )
          : null,
      )

      const handoffCard = handoff
        ? h(
            'div',
            { style: S.card },
            h(
              'div',
              { style: { ...S.row, justifyContent: 'space-between' } },
              h('div', { style: { fontWeight: 600 } }, '交给 AI · ' + handoff.code),
              btn('关闭', () => setHandoff(null)),
            ),
            handoff.deduped ? h('div', { style: { ...S.muted, fontSize: 12 } }, '同一结论 30 分钟内已生成过，文本未重复记账。') : null,
            h('textarea', { readOnly: true, value: handoff.text, style: S.textarea, spellCheck: false }),
            h(
              'div',
              { style: S.actions },
              btn('复制', copyHandoff, { primary: true }),
              h('span', { style: { ...S.muted, fontSize: 11 } }, '只复制到剪贴板，不会投喂给任何会话。'),
            ),
          )
        : null

      const footer = h(
        'div',
        { style: { ...S.muted, fontSize: 11, borderTop: '1px solid ' + C.border, paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 2 } },
        h('div', null, '诊断：dsh-doctor 的 runDiagnostic（只读）。修复：runRepair(safe|deps|full)，每次可逆改动都写 journal。'),
        h('div', null, 'deps 会改 lockfile、full 会停进程，这两类在账本里永远标「需手动补偿」，不显示成已回滚。'),
        h('div', null, '状态文件：<DSH_HOME>/storages/dsh-doctor/state.json（阶梯策略、忽略列表、尝试记录）。'),
      )

      return h(
        'div',
        { style: S.panel },
        header,
        banners,
        statusCard,
        scopeCard,
        jobCard,
        findingCard,
        handoffCard,
        journalCard,
        ladderCard,
        footer,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'dsh-doctor',
              order: 50,
              label: '体检',
            },
            DoctorPanel,
          ),
        )
      },
    }
  },
})
