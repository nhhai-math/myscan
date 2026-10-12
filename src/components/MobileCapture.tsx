import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import {
  ArrowLeft, ArrowRight, Camera, Check, CheckCheck, CheckCircle2,
  FileImage, ImagePlus, LoaderCircle, RefreshCw, ScanLine, ShieldCheck,
  Smartphone, Upload, Wifi, WifiOff, X,
} from 'lucide-react'
import './MobileCapture.css'

type Connection = 'loading' | 'ready' | 'error' | 'expired'
type CaptureDocument = { id: string; title: string; pageCount: number }
type PendingPage = { id: string; file: File; preview: string }
type SessionResponse = { document: CaptureDocument; expiresAt?: string }
type UploadResponse = { id?: string; title?: string; pageCount?: number; pages?: unknown[]; document?: CaptureDocument & { pages?: unknown[] } }

class CaptureApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function responseJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new CaptureApiError(
      typeof payload?.error === 'string' ? payload.error : 'Không thể kết nối với myscan. Hãy thử lại.',
      response.status,
    )
  }
  if (!payload) throw new Error('Máy chủ trả về dữ liệu không hợp lệ. Hãy thử kết nối lại.')
  return payload as T
}

function canvasFile(canvas: HTMLCanvasElement, name: string): Promise<File> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) return reject(new Error('Không xử lý được ảnh này. Hãy chụp lại hoặc chọn ảnh khác.'))
      resolve(new File([blob], name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.9)
  })
}

function pageId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `page-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Decode with the browser so phone photo orientation is applied before resize. */
async function prepareImage(file: File): Promise<File> {
  if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name}: ảnh quá lớn. Hãy chọn ảnh dưới 50 MB.`)
  const canvas = document.createElement('canvas')
  let bitmap: ImageBitmap | undefined
  let image: HTMLImageElement | undefined
  let sourceUrl: string | undefined
  try {
    if (typeof createImageBitmap === 'function') {
      try { bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }) } catch { /* Image element supports additional formats on some phones. */ }
    }
    if (!bitmap) {
      sourceUrl = URL.createObjectURL(file)
      image = new Image()
      image.src = sourceUrl
      await image.decode()
    }
    const width = bitmap?.width ?? image?.naturalWidth ?? 0
    const height = bitmap?.height ?? image?.naturalHeight ?? 0
    if (!width || !height) throw new Error('empty image')
    const scale = Math.min(1, 2600 / Math.max(width, height))
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('canvas unavailable')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap ?? image!, 0, 0, canvas.width, canvas.height)
    return await canvasFile(canvas, file.name || 'trang-scan.jpg')
  } catch (error) {
    if (/\.hei[cf]$/i.test(file.name) || /image\/hei[cf]/i.test(file.type)) {
      throw new Error('Trình duyệt chưa đọc được ảnh HEIC này. Hãy chụp trực tiếp hoặc chọn ảnh JPG/PNG; trên iPhone có thể chọn Camera → Định dạng → Tương thích nhất.')
    }
    if (error instanceof Error && error.message.startsWith('Không xử lý')) throw error
    throw new Error(`Không đọc được ảnh “${file.name}”. Hãy chọn ảnh JPG, PNG hoặc chụp lại.`)
  } finally {
    bitmap?.close()
    if (sourceUrl) URL.revokeObjectURL(sourceUrl)
    canvas.width = 0
    canvas.height = 0
  }
}

export function MobileCapture({ token }: { token: string }) {
  const [connection, setConnection] = useState<Connection>('loading')
  const [scanDocument, setScanDocument] = useState<CaptureDocument | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | undefined>()
  const [connectionError, setConnectionError] = useState('')
  const [error, setError] = useState('')
  const [pages, setPages] = useState<PendingPage[]>([])
  const [preparing, setPreparing] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const [cameraStarting, setCameraStarting] = useState(false)
  const [takingPhoto, setTakingPhoto] = useState(false)
  const [latestPreview, setLatestPreview] = useState<string | null>(null)
  const [lastSentCount, setLastSentCount] = useState(0)
  const [retry, setRetry] = useState(0)
  const nativeInput = useRef<HTMLInputElement>(null)
  const galleryInput = useRef<HTMLInputElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const cameraDialogRef = useRef<HTMLDivElement>(null)
  const cameraLaunchButton = useRef<HTMLButtonElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const cameraGeneration = useRef(0)
  const alive = useRef(true)
  const urls = useRef(new Set<string>())
  const busyRef = useRef(false)
  const uploadAbortRef = useRef<AbortController | null>(null)
  const canUseLiveCamera = typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia

  function previewUrl(file: File) {
    const url = URL.createObjectURL(file)
    urls.current.add(url)
    return url
  }

  function releaseUrl(url: string) {
    URL.revokeObjectURL(url)
    urls.current.delete(url)
  }

  function stopCamera() {
    cameraGeneration.current += 1
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setCameraOpen(false)
    setCameraStarting(false)
    window.requestAnimationFrame(() => { if (alive.current) cameraLaunchButton.current?.focus() })
  }

  useEffect(() => {
    alive.current = true
    const ownedUrls = urls.current
    return () => {
      alive.current = false
      cameraGeneration.current += 1
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      uploadAbortRef.current?.abort()
      ownedUrls.forEach((url) => URL.revokeObjectURL(url))
      ownedUrls.clear()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setConnection('loading')
    setConnectionError('')
    fetch(`/api/capture/${encodeURIComponent(token)}`, { signal: controller.signal })
      .then(responseJson<SessionResponse>)
      .then((payload) => {
        if (controller.signal.aborted) return
        if (!payload.document || typeof payload.document.id !== 'string') throw new Error('Không tìm thấy tài liệu được kết nối.')
        setScanDocument(payload.document)
        setExpiresAt(payload.expiresAt)
        setConnection(payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now() ? 'expired' : 'ready')
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        const expired = reason instanceof CaptureApiError && [403, 404, 410].includes(reason.status)
        setConnection(expired ? 'expired' : 'error')
        setConnectionError(reason instanceof Error ? reason.message : 'Không thể kết nối với máy tính.')
      })
    return () => controller.abort()
  }, [token, retry])

  useEffect(() => {
    if (connection !== 'ready' || !expiresAt || !Number.isFinite(Date.parse(expiresAt))) return
    const checkExpiry = () => {
      if (Date.parse(expiresAt) <= Date.now()) {
        setConnection('expired')
        stopCamera()
      }
    }
    const timer = window.setInterval(checkExpiry, 1000)
    return () => window.clearInterval(timer)
  }, [connection, expiresAt])

  useEffect(() => {
    if (!cameraOpen || !videoRef.current || !streamRef.current) return
    const video = videoRef.current
    video.srcObject = streamRef.current
    cameraDialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    video.play().catch(() => {
      if (alive.current) {
        stopCamera()
        setError('Không mở được xem trước camera. Hãy dùng nút “Chụp bằng điện thoại” bên dưới.')
      }
    })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') stopCamera()
      if (event.key !== 'Tab') return
      const buttons = cameraDialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
      if (!buttons?.length) return
      const first = buttons[0]
      const last = buttons[buttons.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    const onVisibility = () => { if (document.hidden) stopCamera() }
    document.addEventListener('keydown', onKey)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [cameraOpen])

  const busy = preparing || uploading || cameraStarting
  const isReady = connection === 'ready'

  async function addImages(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    if (!files.length || busyRef.current || !isReady) return
    if (pages.length + files.length > 20) {
      setError('Mỗi lần gửi tối đa 20 trang. Hãy gửi các trang hiện tại rồi quét tiếp.')
      return
    }
    busyRef.current = true
    setPreparing(true)
    setError('')
    const prepared: PendingPage[] = []
    const failures: string[] = []
    try {
      for (const file of files) {
        if (!alive.current) break
        try {
          const image = await prepareImage(file)
          if (!alive.current) break
          prepared.push({ id: pageId(), file: image, preview: previewUrl(image) })
        } catch (reason) {
          failures.push(reason instanceof Error ? reason.message : 'Không đọc được một ảnh đã chọn.')
        }
      }
      if (alive.current) {
        setPages((current) => [...current, ...prepared])
        setLastSentCount(0)
        if (failures.length) setError(failures.join('\n'))
      }
    } finally {
      busyRef.current = false
      if (alive.current) setPreparing(false)
    }
  }

  async function openCamera() {
    if (busyRef.current || cameraStarting || !isReady) return
    if (pages.length >= 20) {
      setError('Đã đủ 20 trang cho lần gửi này. Hãy gửi trước khi quét thêm.')
      return
    }
    if (!canUseLiveCamera) {
      nativeInput.current?.click()
      return
    }
    const generation = ++cameraGeneration.current
    setCameraStarting(true)
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 2600 }, height: { ideal: 2600 } },
        audio: false,
      })
      if (!alive.current || generation !== cameraGeneration.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      setCameraOpen(true)
    } catch (reason) {
      if (!alive.current || generation !== cameraGeneration.current) return
      const denied = reason instanceof DOMException && ['NotAllowedError', 'PermissionDeniedError'].includes(reason.name)
      setError(denied
        ? 'Camera chưa được cho phép. Bạn có thể bật quyền camera trong trình duyệt hoặc dùng “Chụp bằng điện thoại”.'
        : 'Không mở được camera trong trình duyệt. Hãy dùng “Chụp bằng điện thoại” hoặc chọn ảnh có sẵn.')
    } finally {
      if (alive.current && generation === cameraGeneration.current) setCameraStarting(false)
    }
  }

  async function capturePhoto() {
    const video = videoRef.current
    if (!video || !video.videoWidth || takingPhoto) return
    const generation = cameraGeneration.current
    setTakingPhoto(true)
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 2600 / Math.max(video.videoWidth, video.videoHeight))
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    try {
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Không xử lý được ảnh từ camera.')
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const file = await canvasFile(canvas, `myscan-${Date.now()}.jpg`)
      if (!alive.current || generation !== cameraGeneration.current) return
      const page = { id: pageId(), file, preview: previewUrl(file) }
      setPages((current) => [...current, page])
      setLastSentCount(0)
      stopCamera()
    } catch (reason) {
      if (alive.current) {
        stopCamera()
        setError(reason instanceof Error ? reason.message : 'Chụp chưa thành công. Hãy thử lại.')
      }
    } finally {
      canvas.width = 0
      canvas.height = 0
      if (alive.current) setTakingPhoto(false)
    }
  }

  function removePage(id: string) {
    if (busyRef.current) return
    const page = pages.find((item) => item.id === id)
    if (page) releaseUrl(page.preview)
    setPages((current) => current.filter((item) => item.id !== id))
  }

  async function sendPages() {
    if (busyRef.current || !pages.length || !isReady) return
    busyRef.current = true
    setUploading(true)
    setError('')
    const submitting = [...pages]
    const body = new FormData()
    submitting.forEach((page) => body.append('images', page.file))
    const controller = new AbortController()
    uploadAbortRef.current = controller
    try {
      const response = await fetch(`/api/capture/${encodeURIComponent(token)}/pages`, {
        method: 'POST', body, signal: controller.signal,
      })
      const payload = await responseJson<UploadResponse>(response)
      if (!alive.current) return
      const updated = payload.document ?? payload
      setScanDocument((current) => current && ({
        ...current,
        title: updated.title ?? current.title,
        pageCount: updated.pageCount ?? updated.pages?.length ?? current.pageCount + submitting.length,
      }))
      if (latestPreview) releaseUrl(latestPreview)
      setLatestPreview(previewUrl(submitting[submitting.length - 1].file))
      submitting.forEach((page) => releaseUrl(page.preview))
      setPages([])
      setLastSentCount(submitting.length)
    } catch (reason) {
      if (!alive.current || controller.signal.aborted) return
      if (reason instanceof CaptureApiError && [403, 404, 410].includes(reason.status)) setConnection('expired')
      setError(reason instanceof Error ? reason.message : 'Gửi ảnh chưa thành công. Ảnh đang giữ ở đây; hãy thử lại.')
    } finally {
      busyRef.current = false
      if (uploadAbortRef.current === controller) uploadAbortRef.current = null
      if (alive.current) setUploading(false)
    }
  }

  return (
    <div className="capture-app">
      <header className="capture-header" inert={cameraOpen || undefined}>
        <a className="capture-brand" href="/" aria-label="myscan trang chủ"><span><ScanLine size={23} strokeWidth={2.3} /></span>myscan<span className="capture-brand-label">điện thoại</span></a>
        <span className={`capture-connection ${isReady ? 'capture-connected' : ''}`}>
          {connection === 'loading' ? <LoaderCircle size={14} className="capture-spin" /> : isReady ? <Wifi size={14} /> : <WifiOff size={14} />}
          {isReady ? 'Đã kết nối' : connection === 'loading' ? 'Đang kết nối' : 'Chưa kết nối'}
        </span>
      </header>

      <main className="capture-main" inert={cameraOpen || undefined}>
        {connection === 'loading' && (
          <section className="capture-state-card" aria-live="polite">
            <div className="capture-state-icon"><LoaderCircle className="capture-spin" size={30} /></div>
            <h1>Đang kết nối tài liệu…</h1><p>Chờ một chút, myscan đang chuẩn bị phiên quét của bạn.</p>
          </section>
        )}

        {(connection === 'error' || connection === 'expired') && (
          <section className="capture-state-card" aria-live="polite">
            <div className="capture-state-icon capture-state-warning"><WifiOff size={30} /></div>
            <h1>{connection === 'expired' ? 'Liên kết quét đã hết hiệu lực' : 'Chưa kết nối được'}</h1>
            <p>{connection === 'expired' ? 'Mở tài liệu trên máy tính, tạo mã QR mới và quét lại bằng điện thoại.' : connectionError || 'Kiểm tra kết nối mạng và thử lại.'}</p>
            {!!pages.length && <p className="capture-kept-note">{pages.length} ảnh chưa gửi vẫn đang giữ trong trang này.</p>}
            <button className="capture-button capture-button-primary" type="button" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={18} />Thử kết nối lại</button>
          </section>
        )}

        {isReady && scanDocument && (
          <>
            <div className="capture-intro">
              <p className="capture-eyebrow">TỪ ĐIỆN THOẠI ĐẾN TÀI LIỆU</p>
              <h1>{pages.length ? 'Kiểm tra ảnh vừa chụp' : lastSentCount ? 'Đã nhận. Quét tiếp nhé!' : 'Chụp một trang,\nthêm vào tài liệu.'}</h1>
              <p>{pages.length ? 'Đặt đúng thứ tự, kiểm tra ảnh rồi gửi. Bạn sẽ chỉnh sửa và xuất PDF trên máy tính.' : 'Chụp rõ toàn bộ trang giấy. Ảnh sẽ xuất hiện trên máy tính để bạn chỉnh sửa.'}</p>
            </div>

            <div className="capture-document-card">
              <div className="capture-document-icon"><FileImage size={22} /></div>
              <div className="capture-document-info"><span>TÀI LIỆU ĐANG QUÉT</span><strong>{scanDocument.title || 'Tài liệu mới'}</strong></div>
              <div className="capture-page-count"><strong>{scanDocument.pageCount ?? 0}</strong><span>trang</span></div>
            </div>

            {!!lastSentCount && !pages.length && (
              <div className="capture-success" role="status">
                {latestPreview && <img src={latestPreview} alt="Trang vừa gửi thành công" />}
                <div><strong><CheckCircle2 size={18} />Đã gửi {lastSentCount} trang</strong><p>Ảnh đã được lưu vào tài liệu.<br />Bạn có thể tiếp tục chụp trang tiếp theo.</p></div>
              </div>
            )}

            {error && <div className="capture-error" role="alert"><span>{error}</span><button type="button" aria-label="Đóng thông báo" onClick={() => setError('')}><X size={16} /></button></div>}

            {!!pages.length && (
              <section className="capture-preview-section" aria-label="Ảnh chờ gửi">
                <div className="capture-section-heading"><h2>{pages.length} trang chờ gửi</h2><span><Check size={14} />Ảnh gốc để chỉnh sửa</span></div>
                <div className={`capture-preview-grid ${pages.length === 1 ? 'capture-preview-single' : ''}`}>
                  {pages.map((page, index) => (
                    <figure className="capture-preview" key={page.id}>
                      <img src={page.preview} alt={`Xem trước trang ${index + 1}`} />
                      <figcaption><span>Trang {index + 1}</span><span>{Math.round(page.file.size / 1024)} KB</span></figcaption>
                      <button type="button" className="capture-remove" aria-label={`Bỏ trang ${index + 1} để chụp lại`} disabled={busy} onClick={() => removePage(page.id)}><X size={16} /></button>
                    </figure>
                  ))}
                </div>
                <p className="capture-preview-tip">Ảnh chưa rõ? Bấm × để bỏ trang rồi chụp lại.</p>
                <button className="capture-button capture-button-primary capture-send" type="button" disabled={busy} onClick={sendPages}>
                  {uploading ? <LoaderCircle size={20} className="capture-spin" /> : <Upload size={20} />}
                  {uploading ? 'Đang gửi ảnh…' : `Gửi ${pages.length} trang vào tài liệu`}
                  {!uploading && <ArrowRight size={18} />}
                </button>
              </section>
            )}

            <section className={`capture-actions ${pages.length ? 'capture-actions-compact' : ''}`} aria-label="Chụp hoặc chọn ảnh">
              <button ref={cameraLaunchButton} className="capture-camera-button" type="button" disabled={busy || pages.length >= 20} onClick={openCamera}>
                <span className="capture-camera-icon">{cameraStarting ? <LoaderCircle size={30} className="capture-spin" /> : <Camera size={30} />}</span>
                <strong>{cameraStarting ? 'Đang mở camera…' : pages.length ? 'Chụp thêm trang' : lastSentCount ? 'Quét trang tiếp theo' : 'Chụp tài liệu'}</strong>
                {!pages.length && <span>Dùng camera sau để có ảnh rõ nét</span>}
                <ArrowRight className="capture-camera-arrow" size={20} />
              </button>
              <button className="capture-button capture-gallery-button" type="button" disabled={busy || pages.length >= 20} onClick={() => galleryInput.current?.click()}><ImagePlus size={20} />Chọn ảnh từ thư viện</button>
              {canUseLiveCamera && <button className="capture-native-button" type="button" disabled={busy || pages.length >= 20} onClick={() => nativeInput.current?.click()}><Smartphone size={16} />Chụp bằng điện thoại</button>}
              {preparing && <p className="capture-working" role="status"><LoaderCircle size={16} className="capture-spin" />Đang chuẩn bị ảnh…</p>}
              <input ref={nativeInput} className="capture-hidden-input" type="file" accept="image/*" capture="environment" onChange={addImages} aria-label="Chụp bằng camera điện thoại" disabled={busy || !isReady} />
              <input ref={galleryInput} className="capture-hidden-input" type="file" accept="image/*" multiple onChange={addImages} aria-label="Chọn ảnh tài liệu" disabled={busy || !isReady} />
            </section>

            {!pages.length && !lastSentCount && <div className="capture-tips"><span className="capture-tip-label">MẸO CHỤP RÕ</span><p>Đặt giấy trên nền tối, đủ sáng.<br />Giữ điện thoại song song và lấy trọn bốn góc.</p><div className="capture-paper-illustration" aria-hidden="true"><div><span /><span /><span /><span /></div></div></div>}

            <div className="capture-workflow" aria-label="Quy trình quét"><span className="capture-workflow-done"><CheckCheck size={16} />Kết nối</span><i /><span className="capture-workflow-active"><Camera size={16} />Chụp ảnh</span><i /><span><Upload size={16} />Gửi tài liệu</span></div>
            <p className="capture-footer"><ShieldCheck size={15} />Ảnh được gửi trực tiếp vào tài liệu đã kết nối.</p>
          </>
        )}
      </main>

      {cameraOpen && (
        <div ref={cameraDialogRef} className="capture-live-camera" role="dialog" aria-modal="true" aria-label="Camera chụp tài liệu">
          <video ref={videoRef} className="capture-video" autoPlay playsInline muted />
          <div className="capture-camera-top"><button type="button" aria-label="Đóng camera" onClick={stopCamera}><ArrowLeft size={22} /></button><strong>Chụp tài liệu</strong><span>CAMERA SAU</span></div>
          <div className="capture-camera-guide" aria-hidden="true"><span /><span /><span /><span /></div>
          <div className="capture-camera-bottom"><p>Lấy trọn trang giấy và giữ điện thoại ổn định</p><button className="capture-shutter" type="button" aria-label="Chụp trang giấy" disabled={takingPhoto} onClick={capturePhoto}>{takingPhoto ? <LoaderCircle size={28} className="capture-spin" /> : <span />}</button><span>Chụp rồi xem lại trước khi gửi</span></div>
        </div>
      )}
    </div>
  )
}
