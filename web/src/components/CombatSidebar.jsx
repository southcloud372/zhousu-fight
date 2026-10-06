import React from 'react'
import { GradeTag } from './Panels.jsx'
import { FxBar, FloatDamage, DomainAura, BeatRow, SealChip } from './Fx.jsx'

/**
 * 左侧战斗栏。
 *
 * 和右侧状态栏对称：战斗相关的数值都收在这里，中间那一栏只留剧情。
 * 战斗中显示敌方档案、本回合行动与伤害计算；不在战斗时显示自己的备战数据。
 */

function EnemyCard({ enemy, fx }) {
  return (
    <div className={`card${fx?.shake ? ` shake-${fx.shake}` : ''}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 3 }}>
        <span style={{ fontFamily: 'var(--font-narr)', fontSize: 16 }}>{enemy.name}</span>
        {enemy.grade && <GradeTag grade={enemy.grade} />}
      </div>

      <div className="bar-wrap">
        <FxBar
          label="血量" cur={enemy.hp} max={enemy.hpMax} cls="hp"
          flashToken={fx?.hpFlash}
        />
        {/* 伤害飘字：落在血条上，不用去读那一行小字 */}
        <FloatDamage
          token={fx?.dmgToken} value={fx?.dmgValue} kind={fx?.dmgKind}
          max={enemy.hpMax}
        />
      </div>

      {/* 连击：压着打的时候有个一直在涨的东西，比一行"造成 N 点伤害"有力得多 */}
      {fx?.combo > 0 && (
        <div className="combo-row">
          <span className="combo-n" key={fx.combo}>{fx.combo}</span>
          <span className="combo-lb">连击</span>
        </div>
      )}
      {fx?.enemyCombo > 0 && (
        <div className="combo-row enemy">
          <span className="combo-n" key={fx.enemyCombo}>{fx.enemyCombo}</span>
          <span className="combo-lb">对方连击</span>
        </div>
      )}

      <DomainAura
        active={fx?.enemyDomain?.active}
        name={fx?.enemyDomain?.name}
        turnsLeft={fx?.enemyDomain?.turnsLeft}
        type={fx?.enemyDomain?.type}
        side="enemy"
      />

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

export function CombatSidebar({ panel, liveCombat, busy, open, fx }) {
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

            <EnemyCard enemy={enemy} fx={live ? fx : null} />

            <div className="combat-vs">— 本 回 合 —</div>

            {/*
              交手机读：引擎算完立刻就在，不用等模型把这一回合演出来。
              放在最上面 —— 玩家按下技能之后，视线第一落点就是这里。
            */}
            {live && (
              <BeatRow beat={live.beat} ticks={live.domainTicks} turn={live.turn} />
            )}

            {/* 规则型领域正在封谁。压在行动栏上方，按招之前就能看见 */}
            {live?.seal?.player && (
              <SealChip seal rules={live.seal.rules} mine />
            )}
            {live?.seal?.enemy && !live.seal.player && (
              <SealChip seal rules={live.seal.rules} mine={false} />
            )}

            {live ? (
              <div className="card" style={{ marginTop: 6 }}>
                <div className="act-line">
                  <span className="lb">我方：</span>{live.actionText}
                </div>
                <div className="act-line enemy">
                  <span className="lb">敌方：</span>{live.enemyActionText}
                </div>
                {/*
                  体术的 breakdown 里没有「咒术伤害 / 术式倍率 / 咒力效率」这三项，
                  原来照术式那一行硬套，体术回合会显示成
                  "undefined × undefined × undefined × 1 × …" —— 玩家每次贴身
                  都在看一串 undefined。这里按实际有哪些项拼。
                */}
                {live.breakdown && (
                  <div className="calc">
                    {[
                      live.breakdown.咒术伤害,
                      live.breakdown.术式倍率,
                      live.breakdown.咒力效率,
                      live.breakdown.体术伤害,
                      live.breakdown.相性,
                      live.breakdown.等级压制,
                      live.breakdown.领域加成,
                      live.breakdown.随机,
                    ].filter((v) => v !== undefined).join(' × ')}
                    {' − '}{live.breakdown.敌方防御} = <b>{live.damage}</b>
                    {live.sureHit && <span className="calc-sure">（必中·无视防御）</span>}
                  </div>
                )}
                {live.crit && (
                  <div className={`crit-chip ${live.crit === 'player' ? 'ours' : 'theirs'}`}>
                    {live.crit === 'player' ? '暴击！抓住破绽' : '被对方抓住破绽'}
                  </div>
                )}
                {live.staggered && (
                  <div className="crit-chip theirs">
                    {live.staggered === 'player' ? '你被打得踉跄，这一手没递出去' : '对方被打断，这一手没能还手'}
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
          <div className={`card${fx?.selfShake ? ` shake-${fx.selfShake}` : ''}`}>
            <DomainAura
              active={fx?.selfDomain?.active}
              name={fx?.selfDomain?.name}
              turnsLeft={fx?.selfDomain?.turnsLeft}
              type={fx?.selfDomain?.type}
              side="self"
            />
            <div className="bar-wrap">
              <FxBar label="血条" cur={panel.hp.cur} max={panel.hp.max} cls="hp" flashToken={fx?.selfHpFlash} />
              {/*
                自己这边的飘字。以前只有敌方血条会飘数字 ——
                挨了一记重的，玩家只能看见血条短了一截，不知道短了多少。
              */}
              <FloatDamage
                token={fx?.selfDmgToken} value={fx?.selfDmgValue}
                kind={fx?.selfDmgKind} max={panel.hp.max}
              />
            </div>
            <FxBar label="咒力" cur={panel.ce.cur} max={panel.ce.max} cls="ce" flashToken={fx?.ceFlash} />
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
