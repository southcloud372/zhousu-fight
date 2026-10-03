import React from 'react'

/**
 * 对话流里的询问块。
 *
 * 取代原先的独立弹窗 —— 弹出式对话框会把玩家从叙事里拽出来，
 * 而且盖住正文。改成和旁白一样插在日志里，选项走底部那一栏，
 * 视觉上和"选择行动"是一回事。
 */
export function Inquiry({ inquiry }) {
  if (!inquiry) return null
  const tone = inquiry.tone || 'normal'
  return (
    <div className={`inquiry ${tone}`}>
      <div className="inquiry-h">
        <span className="inquiry-tag">{inquiry.tag}</span>
        <span className="inquiry-title">{inquiry.title}</span>
      </div>

      {inquiry.lines?.length > 0 && (
        <div className="inquiry-body">
          {inquiry.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {inquiry.hint && <div className="inquiry-hint">{inquiry.hint}</div>}
    </div>
  )
}

/** 询问块 + 它的选项，一起进日志 */
export function InquiryEntry({ entry }) {
  return <Inquiry inquiry={entry.inquiry} />
}
