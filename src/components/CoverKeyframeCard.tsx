import type { Job } from '../types'

/**
 * #89d: `/job/<id>` cover / keyframe read-back.
 * Values come from `/api/metrics/:id` (studio projection); missing values stay
 * "未设置" and are never inferred from other fields.
 */
export function CoverKeyframeCard({ job }: { job: Job }) {
  return (
    <section className="card p-4 sm:p-5" data-testid="cover-keyframe-section">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold tracking-tight">封面 / 关键帧</h2>
        <p className="text-xs text-apple-subtext">studio 回读 · 只读</p>
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <AssetSlot
          label="封面"
          testId="cover"
          url={job.cover_url ?? job.cover_asset?.url ?? null}
          asset={job.cover_asset ?? null}
        />
        <AssetSlot
          label="关键帧"
          testId="keyframe"
          url={keyframeArtifactUrl(job.keyframe_asset ?? null)}
          asset={job.keyframe_asset ?? null}
        />
      </div>
    </section>
  )
}

/** Same sanitized proxy shape the server emits for covers; empty job → no URL. */
function keyframeArtifactUrl(asset: { source_job: string; name: string } | null): string | null {
  if (!asset?.source_job || !asset.name) return null
  return `/api/studio/jobs/${encodeURIComponent(asset.source_job)}/artifacts/${encodeURIComponent(asset.name)}`
}

function AssetSlot({
  label,
  testId,
  url,
  asset
}: {
  label: string
  testId: string
  url: string | null
  asset: { source_job: string; name: string } | null
}) {
  return (
    <div className="min-w-0" data-testid={`${testId}-slot`}>
      <p className="text-xs font-medium text-apple-text">{label}</p>
      {asset ? (
        <>
          {url ? (
            <img
              src={url}
              alt={`${label}缩略图`}
              data-testid={`${testId}-thumb`}
              className="mt-2 aspect-[16/9] w-full rounded-lg border border-apple-line object-cover"
            />
          ) : (
            <p className="mt-2 text-xs text-apple-subtext">无可用缩略图</p>
          )}
          <p className="num mt-2 break-all text-xs leading-relaxed text-apple-subtext">
            {asset.source_job || '—'} / {asset.name}
          </p>
        </>
      ) : (
        <p className="mt-2 text-sm text-apple-subtext" data-testid={`${testId}-empty`}>
          未设置
        </p>
      )}
    </div>
  )
}
