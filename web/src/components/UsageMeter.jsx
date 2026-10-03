import React, { useState } from 'react'

/** 12345 → 12.3k，避免左上角被长数字撑开 */
function short(n) {
  if (n < 1000) return String(n)
  if (n < 1e6) return (n / 1000).toFixed(n < 1e4 ? 1 : 0) + 'k'
  return (n / 1e6).toFixed(2) + 'M'
}

function money(cost, currency) {
  if (cost === null || cost === undefined) return '—'
  if (cost === 0) return `${currency}0`
  if (cost < 0.01) return `${currency}${cost.toFixed(4)}`
  if (cost < 1) return `${currency}${cost.toFixed(3)}`
  return `${currency}${cost.toFixed(2)}`
}

const ZERO = {
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
  total: 0, calls: 0, cost: null, currency: '¥',
  priceConfigured: false, byModel: {},
}

/**
 * 左上角的实时用量表。
 *
 * usage 为 null 时显示 0 而不是隐藏 —— 开始界面和开局选卡那几屏也要能看到它，
 * 否则玩家压根不知道这功能在哪，而开局生成恰恰是最花钱的一步。
 * 点击展开明细（也支持悬停；触屏没有 hover，所以点击是必需的）。
 */
export function UsageMeter({ usage }) {
  const [open, setOpen] = useState(false)
  const u = usage || ZERO
  const idle = !usage // 还没开始跑，只有零值
  const estimated = !!u.estimated

  return (
    <div
      className="usage"
      role="button"
      tabIndex={0}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen((v) => !v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) }
      }}
    >
      <span className="usage-dot" data-live={estimated ? '1' : '0'} />
      <span className="usage-tok" title="本局累计 token">
        {estimated ? '≈' : ''}{short(u.total)} tok
      </span>
      <span className="usage-cost" title={u.priceConfigured ? '本局累计费用' : '未配置单价，见 .env'}>
        {money(u.cost, u.currency)}
      </span>

      {open && (
        <div className="usage-pop">
          <div className="usage-pop-h">
            本局用量{estimated && <span className="usage-est">生成中·估算</span>}
          </div>

          {idle ? (
            <div style={{ color: 'var(--ink-faint)', fontSize: 11.5, lineHeight: 1.7 }}>
              还没开始。点「开始生成」后这里会实时累计 token 与费用。
            </div>
          ) : (
            <>
              <div className="kv"><span>输入</span><span>{u.input.toLocaleString()}</span></div>
              <div className="kv"><span>输出</span><span>{u.output.toLocaleString()}</span></div>
              {u.cacheRead > 0 && (
                <div className="kv"><span>缓存命中</span><span>{u.cacheRead.toLocaleString()}</span></div>
              )}
              {u.cacheWrite > 0 && (
                <div className="kv"><span>缓存写入</span><span>{u.cacheWrite.toLocaleString()}</span></div>
              )}
              <div className="kv"><span>调用次数</span><span>{u.calls}</span></div>
              <div className="usage-pop-sep" />
              <div className="kv"><span>合计</span><span>{u.total.toLocaleString()} tok</span></div>
              <div className="kv">
                <span>费用</span>
                <span style={{ color: u.priceConfigured ? 'var(--gold)' : 'var(--ink-faint)' }}>
                  {money(u.cost, u.currency)}
                </span>
              </div>
              {!u.priceConfigured && (
                <div className="usage-warn">未配置单价，金额不显示。在 .env 里填 PRICE_* 即可。</div>
              )}
              {Object.keys(u.byModel || {}).length > 0 && (
                <>
                  <div className="usage-pop-sep" />
                  {Object.entries(u.byModel).map(([model, mu]) => (
                    <div className="kv" key={model} style={{ fontSize: 11 }}>
                      <span>{model}</span>
                      <span>{(mu.input + mu.output).toLocaleString()} · {mu.calls} 次</span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
