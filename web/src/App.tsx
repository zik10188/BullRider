import { useCallback, useEffect, useState } from 'react'
import QuoteView from './components/QuoteView'
import BacktestView from './components/BacktestView'
import PaperView from './components/PaperView'
import ScreenerView from './components/ScreenerView'
import RealView from './components/RealView'
import ChatView from './components/ChatView'
import { hydrateFavorites } from './lib/favorites'
import { hydrateQueryHistory } from './lib/query-history'
import { hydrateLastSymbol } from './lib/last-symbol'

type View = 'quote' | 'screener' | 'backtest' | 'paper' | 'real' | 'chat'

const NAV: Array<{ id: View; label: string }> = [
  { id: 'quote', label: '行情' },
  { id: 'screener', label: '选股推荐' },
  { id: 'backtest', label: '回测' },
  { id: 'paper', label: '模拟盘' },
  { id: 'real', label: '实盘记录' },
  { id: 'chat', label: 'AI 教练' },
]

function viewFromHash(): View {
  const h = window.location.hash.replace(/^#\/?/, '') as View
  return NAV.some((n) => n.id === h) ? h : 'quote'
}

export default function App() {
  const [view, setViewState] = useState<View>(viewFromHash)

  const setView = useCallback((v: View) => {
    setViewState(v)
    window.location.hash = `/${v}`
  }, [])

  // tab 同步到 URL：支持刷新保持 + 前进后退
  useEffect(() => {
    const onHash = () => setViewState(viewFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 启动时水合用户偏好（收藏、查询历史、上次查询的股票）
  useEffect(() => {
    void hydrateFavorites()
    void hydrateQueryHistory()
    void hydrateLastSymbol()
  }, [])

  return (
    <div className="app">
      <h1 className="sr-only">BullRider 量化信号与风险管理工具</h1>
      <header className="topbar">
        <a className="brand" href="#/quote" aria-label="BullRider 首页">
          <span className="brand-mark" aria-hidden="true">
            {/* 与 favicon 同款"牛角势"图形（金底反色版） */}
            <svg viewBox="0 0 64 64" width="26" height="26" aria-hidden="true">
              <path d="M28 28 C20 26 14 20 12 10" stroke="#131A2A" stroke-width="6" fill="none" stroke-linecap="round"/>
              <path d="M36 28 C44 26 50 20 52 10" stroke="#131A2A" stroke-width="6" fill="none" stroke-linecap="round"/>
              <path d="M18 52 L29 41 L35 45 L48 30" stroke="#131A2A" stroke-width="5.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
          <span className="brand-name" translate="no">
            BULLRIDER
            <small>量化信号与风控</small>
          </span>
        </a>
        <nav className="nav" aria-label="主导航">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-btn${view === item.id ? ' active' : ''}`}
              aria-current={view === item.id ? 'page' : undefined}
              onClick={() => setView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="content" id="main">
        {view === 'quote' && <QuoteView />}
        {view === 'screener' && <ScreenerView />}
        {view === 'backtest' && <BacktestView />}
        {view === 'paper' && <PaperView />}
        {view === 'real' && <RealView />}
        {view === 'chat' && <ChatView />}
      </main>
    </div>
  )
}
