import React, { useCallback, useEffect, useState } from 'react'
import * as api from '../api.js'
import { GradeTag } from './Panels.jsx'

export function SaveModal({ sessionId, onLoad, onClose }) {
  const [saves, setSaves] = useState([])
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const refresh = useCallback(async () => {
    try {
      const r = await api.listSaves()
      setSaves(r.saves || [])
    } catch (e) {
      setErr(e.message)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const doSave = async () => {
    setBusy(true); setErr(''); setMsg('')
    try {
      const r = await api.saveGame(sessionId, name)
      setMsg(`已保存：${r.name}`)
      setName('')
      await refresh()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const doLoad = async (id) => {
    setBusy(true); setErr('')
    try {
      const r = await api.loadSave(id)
      onLoad(r)
    } catch (e) {
      setErr(e.message)
      setBusy(false)
    }
  }

  const doDelete = async (id) => {
    setBusy(true); setErr('')
    try {
      await api.deleteSave(id)
      await refresh()
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>存档</h2>
        <div className="hint">
          读档会复制成一份新会话，当前进度不受影响。
        </div>

        {sessionId ? (
          <div className="free-input" style={{ marginBottom: 16 }}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="存档名（留空自动命名）"
              onKeyDown={(e) => e.key === 'Enter' && doSave()}
              disabled={busy}
            />
            <button onClick={doSave} disabled={busy}>保存</button>
          </div>
        ) : (
          <div className="hint" style={{ marginBottom: 16 }}>
            还没有进行中的游戏，只能读取已有存档。
          </div>
        )}

        {msg && <div style={{ color: 'var(--ok)', fontSize: 12.5, marginBottom: 10 }}>{msg}</div>}
        {err && <div style={{ color: 'var(--blood-bright)', fontSize: 12.5, marginBottom: 10 }}>{err}</div>}

        {saves.length === 0 ? (
          <div style={{ color: 'var(--ink-faint)', fontSize: 13, padding: '10px 0' }}>还没有任何存档。</div>
        ) : (
          saves.map((s) => (
            <div className="trow" key={s.id} style={{ alignItems: 'center' }}>
              <span className="tn">
                <b>{s.name}</b>
                <div className="tr" style={{ marginTop: 3 }}>
                  {s.playerName} · <GradeTag grade={s.grade} /> · {s.date}（第{s.day}天）· 第{s.turn}回合
                </div>
              </span>
              <button
                className="pick-btn"
                style={{ width: 62, padding: '5px 0', fontSize: 12.5 }}
                onClick={() => doLoad(s.id)}
                disabled={busy}
              >
                读取
              </button>
              <button
                className="pick-btn"
                style={{ width: 62, padding: '5px 0', fontSize: 12.5, borderColor: 'var(--line)', color: 'var(--ink-dim)' }}
                onClick={() => doDelete(s.id)}
                disabled={busy}
              >
                删除
              </button>
            </div>
          ))
        )}

        <button className="choice" style={{ marginTop: 12, textAlign: 'center' }} onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  )
}
