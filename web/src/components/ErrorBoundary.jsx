import React from 'react'

/**
 * 渲染期异常的兜底。
 *
 * React 里未捕获的渲染异常会卸载整棵树 —— 表现就是白屏，玩家什么都看不到。
 * 之前 StatusPanel 拿到形状不对的 panel 就是这样崩的：
 * 一个字段读取失败，整局游戏直接没了。
 * 有这层之后至少还能看到"哪一块坏了 + 怎么继续"，而不是一片空白。
 */
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[界面异常]', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="err" style={{ marginTop: 80 }}>
        <b>界面崩了一块</b>
        <div style={{ fontFamily: 'var(--font-narr)', color: 'var(--ink-dim)', marginBottom: 10 }}>
          {String(this.state.error?.message || this.state.error)}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--ink-faint)', marginBottom: 14 }}>
          游戏进度没有丢，服务端还在。点下面的按钮重试；如果反复出现，刷新页面会自动接回当前进度。
        </div>
        <button className="choice" onClick={() => this.setState({ error: null })}>
          重试渲染
        </button>
        <button className="choice" onClick={() => window.location.reload()}>
          刷新页面
        </button>
      </div>
    )
  }
}
