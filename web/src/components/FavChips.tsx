// 收藏股票速选条：点 chip 直接选中并加载，✕ 删除。四个页面共用。
import type { FavStock } from '../lib/favorites'

export default function FavChips({ favs, current, onSelect, onRemove, emptyHint }: {
  favs: FavStock[]
  current?: string
  onSelect: (code: string) => void
  onRemove: (code: string) => void
  emptyHint?: string
}) {
  if (favs.length === 0) {
    return emptyHint ? <p className="fav-empty">{emptyHint}</p> : null
  }
  return (
    <div className="fav-chips" role="list" aria-label="收藏股票">
      {favs.map((f) => (
        <span key={f.code} className={`fav-chip${f.code === current ? ' active' : ''}`} role="listitem">
          <button type="button" className="fav-pick" onClick={() => onSelect(f.code)} title={`选择 ${f.code}`}>
            {f.name || f.code}
            <small className="num">{f.code}</small>
          </button>
          <button type="button" className="fav-del" aria-label={`删除收藏 ${f.name || f.code}`} onClick={() => onRemove(f.code)}>✕</button>
        </span>
      ))}
    </div>
  )
}
