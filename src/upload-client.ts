/**
 * #89b 图片参考图上传：复用 StudioPage 的 4 MiB 分块协议
 * （init → PUT chunks → complete），不新增后端端点。
 */
import { postJson } from './api'

export const UPLOAD_CHUNK_SIZE = 4 * 1024 * 1024

type UploadInitResponse = {
  upload_id: string
  chunk_size: number
  filename: string
  size: number
  received: number
  status: 'uploading' | 'ready'
}

type UploadCompleteResponse = {
  upload_id: string
  sha256: string
  size: number
  filename: string
}

function putChunk(
  uploadId: string,
  index: number,
  chunk: Blob,
  onChunkProgress: (loaded: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onChunkProgress(event.loaded)
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      let message = `HTTP ${xhr.status}`
      try {
        const payload = JSON.parse(xhr.responseText) as { error?: string }
        if (payload?.error) message = payload.error
      } catch {
        /* 非 JSON 响应体 */
      }
      reject(new Error(message))
    }
    xhr.onerror = () => reject(new Error('网络中断：分块上传失败，请重试。'))
    xhr.onabort = () => reject(new Error('上传已中断，请重试。'))
    xhr.send(chunk)
  })
}

/** 分块上传完整文件，返回 upload_id（image edit 的 `source_upload_id`）。 */
export async function uploadFileInChunks(
  file: File,
  onProgress?: (percent: number) => void
): Promise<{ uploadId: string; sha256: string | null }> {
  const init = await postJson<UploadInitResponse>('/api/uploads/init', {
    filename: file.name,
    size: file.size
  })
  const chunkSize = init.chunk_size > 0 ? init.chunk_size : UPLOAD_CHUNK_SIZE
  const total = Math.max(1, Math.ceil(file.size / chunkSize))
  for (let index = 0; index < total; index += 1) {
    const start = index * chunkSize
    const end = Math.min(start + chunkSize, file.size)
    const chunk = file.slice(start, end)
    await putChunk(init.upload_id, index, chunk, (loaded) => {
      const percent = file.size > 0 ? Math.min(99, Math.round(((start + loaded) / file.size) * 100)) : 0
      onProgress?.(percent)
    })
  }
  const completed = await postJson<UploadCompleteResponse>(
    `/api/uploads/${encodeURIComponent(init.upload_id)}/complete`,
    {}
  )
  onProgress?.(100)
  return { uploadId: init.upload_id, sha256: typeof completed.sha256 === 'string' ? completed.sha256 : null }
}
