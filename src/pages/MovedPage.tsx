import { Link } from '../router'
import { NEW_ENTRIES, movedPageFor } from '../moved-pages'

export function MovedPage({ path }: { path: string }) {
  const moved = movedPageFor(path)
  if (!moved) return null

  const primary = NEW_ENTRIES.find((entry) => entry.to === moved.primaryTo) ?? NEW_ENTRIES[0]

  return (
    <div className="card p-8" data-testid="moved-page">
      <p className="text-xs font-medium uppercase tracking-wide text-apple-subtext">旧链接 · 页面已迁移</p>
      <h1 className="mt-2 text-lg font-semibold">{moved.title}</h1>
      <p className="mt-2 text-sm text-apple-subtext">
        <code className="rounded bg-black/[0.05] px-1 py-0.5 text-xs">{moved.path}</code> 原本是「{moved.oldName}」。
      </p>
      <p className="mt-3 max-w-2xl text-sm leading-6 text-apple-subtext">{moved.reason}</p>

      <Link
        to={primary.to}
        className="mt-5 inline-block rounded-lg bg-apple-text px-3 py-1.5 text-xs font-medium text-white"
      >
        前往{primary.label}
      </Link>

      <h2 className="mt-8 text-sm font-semibold">全部新入口</h2>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2" data-testid="moved-page-entries">
        {NEW_ENTRIES.map((entry) => (
          <li key={entry.to}>
            <Link
              to={entry.to}
              className="flex items-baseline justify-between gap-3 rounded-lg border border-black/[0.08] px-3 py-2 hover:bg-black/[0.03]"
            >
              <span className="text-sm font-medium">{entry.label}</span>
              <span className="text-right text-xs text-apple-subtext">{entry.note}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
