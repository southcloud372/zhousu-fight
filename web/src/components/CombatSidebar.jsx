import React from 'react'
import { GradeTag } from './Panels.jsx'

/**
 * 左侧战斗栏。
 *
 * 和右侧状态栏对称：战斗相关的数值都收在这里，中间那一栏只留剧情。
 * 战斗中显示敌方档案、本回合行动与伤害计算；不在战斗时显示自己的备战数据。
 */

function MiniBar({ label, cur, max, cls, suffix }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (cur / max) * 100)) : 0
  return (
    <div className="bar">
      <div className="bar-head">
        <span>{label}</span>
        <b>{Math.round(cur).toLocaleString()} / {Math.round(max).toLocaleString()}{suffix}</b>
      </div>
      <div className="bar-track">
        <div className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function EnemyCard({ enemy, round }) {
  return (
    <div className="card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
        <span style={{ fontFamily: 'var(--font-narr)', fontSize: 16 }}>{enemy.name}</span>
        {enemy.grade && <GradeTag grade={enemy.grade} />}
      </div>

      <MiniBar label="血量" cur={enemy.hp} max={enemy.hpMax} cls="hp" />
      {enemy.ceEstimate != null && (
        <div className="kv" style={{ marginTop: 6 }}>
          <span>咒力估算</span>
          <span>{Math.round(enemy.ceEstimate).toLocaleString()}</span>
        </div>
      )}
      <div className="kv">
        <span>状态</span>
        <span><span className={`status-pill s-${enemy.status || '正常'}`}>{enemy.status}</span></span>
      </div>
      {enemy.domain && <div className="kv"><span>领域</span><span>{enemy.domain}</span></div>}
      {enemy.technique && <div className="kv"><span>术式</span><span>{enemy.technique}</span></div>}
    </div>
  )
}

/** 不在战斗时：把自己的战斗数据摆出来备战 */
function Readiness({ panel }) {
  if (!panel) return <div className="combat-empty">尚未创建角色</div>
  const t = panel.technique
  return (
    <>
      <div className="panel">
        <h3>备战</h3>
        <div className="card">
          <div className="kv"><span>生得术式</span><span>{t.name}</span></div>
          <div className="kv">
            <span>倍率 / 冷却</span>
            <span>×{t.multiplier} / {t.cooldown} 回合</span>
          </div>
          <div className="kv">
            <span>冷却状态</span>
            <span style={{ color: t.cdLeft > 0 ? 'var(--blood)' : 'var(--ok)' }}>
              {t.cdLeft > 0 ? `冷却中（剩 ${t.cdLeft}）` : '就绪'}
            </span>
          </div>
          <div className="kv">
            <span>领域</span>
            <span>{panel.domain?.unlocked ? panel.domain.name : '未领悟'}</span>
          </div>
          <div className="kv">
            <span>反转术式</span>
            <span>{panel.reverseCursedTechnique?.level || '未掌握'}</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h3>基础战力</h3>
        <div className="card">
          <div className="kv"><span>咒术伤害</span><span>{(panel.cursedDamage?.value ?? 0).toLocaleString()}</span></div>
          <div className="kv"><span>体术伤害</span><span>{(panel.physicalDamage?.value ?? 0).toLocaleString()}</span></div>
          <div className="kv"><span>咒力效率</span><span>{Math.round((panel.efficiency?.value ?? 0) * 100)}%</span></div>
        </div>
      </div>
    </>
  )
}

export function CombatSidebar({ panel, liveCombat, busy, open }) {
  const live = liveCombat?.panel
  const st = panel?.combat // 服务端的战斗态快照

  // 战斗中的面板优先用实时的那份
  const enemy = live?.enemy || (st?.enemy ? {
    name: st.enemy.name,
    grade: st.enemy.grade,
    hp: st.enemy.hp,
    hpMax: st.enemy.hpMax,
    ceEstimate: st.enemy.ceEstimate,
    status: undefined,
    technique: st.enemy.technique,
    domain: st.enemy.domainActive ? `${st.enemy.domain}（展开中）` : (st.enemy.domain || '未展开'),
  } : null)

  const round = live?.turn ?? st?.turn
  const inCombat = !!enemy

  return (
    <aside className={`combat-side${open ? ' open' : ''}`}>
      <div className="panel">
        <h3>战斗</h3>

        {!inCombat && <Readiness panel={panel} />}

        {inCombat && (
          <>
            <div className="combat-round">
              <span className="no">第 {round} 回合</span>
              {st?.mode && <span className="mode">{{
                manual: '手动', skip: '跳过', narrative: '剧情',
              }[st.mode] || st.mode}</span>}
            </div>

            <EnemyCard enemy={enemy} round={round} />

            <div className="combat-vs">— 本 回 合 —</div>

            {live ? (
              <div className="card" style={{ marginTop: 6 }}>
                <div className="act-line">
                  <span className="lb">我方：</span>{live.actionText}
                </div>
                <div className="act-line enemy">
                  <span className="lb">敌方：</span>{live.enemyActionText}
                </div>
                {live.breakdown && (
                  <div className="calc">
                    {live.breakdown.咒术伤害} × {live.breakdown.术式倍率} × {live.breakdown.咒力效率}
                    {' × '}{live.breakdown.相性} × {live.breakdown.等级压制} × {live.breakdown.随机}
                    {' − '}{live.breakdown.敌方防御} = <b>{live.damage}</b>
                  </div>
                )}
                {live.notes?.length > 0 && (
                  <div style={{ marginTop: 7, fontSize: 11.5, color: 'var(--gold)' }}>
                    {live.notes.map((n, i) => <div key={i}>· {n}</div>)}
                  </div>
                )}
              </div>
            ) : (
              <div className="combat-empty">
                {busy ? '结算中…' : '等待本回合面板'}
              </div>
            )}

            {panel?.combatLog?.length > 1 && (
              <div className="panel" style={{ marginTop: 14 }}>
                <h3>战况记录</h3>
                <div className="card">
                  {panel.combatLog.slice(-6).reverse().map((p) => (
                    <div className="combat-log-item" key={p.turn}>
                      <span className="t">R{p.turn}</span>
                      我方 HP {p.player?.hp} / 敌方 HP {p.enemy?.hp}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 战斗中也把自己这边的关键状态挂着，不用扭头看右边 */}
      {inCombat && panel && (
        <div className="panel">
          <h3>我方</h3>
          <div className="card">
            <MiniBar label="血条" cur={panel.hp.cur} max={panel.hp.max} cls="hp" />
            <MiniBar label="咒力" cur={panel.ce.cur} max={panel.ce.max} cls="ce" />
            <div className="kv" style={{ marginTop: 7 }}>
              <span>状态</span>
              <span><span className={`status-pill s-${panel.status}`}>{panel.status}</span></span>
            </div>
            <div className="kv">
              <span>术式冷却</span>
              <span>{panel.technique?.cdLeft > 0 ? `剩 ${panel.technique.cdLeft}` : '就绪'}</span>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}
