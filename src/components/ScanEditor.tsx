import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { ArrowLeft, Check, LoaderCircle, RotateCcw, RotateCw, Undo2 } from 'lucide-react';
import {
  canvasToBlob,
  DEFAULT_CORNERS,
  loadImage,
  renderScan,
  rotateImage,
  validateCorners,
} from '../lib/image';
import type { ColorMode, EditSettings, Point, Quad } from '../lib/image';
import './ScanEditor.css';

export type { EditSettings } from '../lib/image';

export type ScanEditorPage = {
  id: string;
  originalUrl: string;
  imageUrl: string;
  width: number;
  height: number;
  edit?: EditSettings | null;
};

export type ScanEditorProps = {
  page: ScanEditorPage;
  onSave: (blob: Blob, edit: EditSettings) => Promise<void>;
  onClose: () => void;
};

const CORNER_NAMES = ['trên trái', 'trên phải', 'dưới phải', 'dưới trái'];
const COLOR_MODES: { value: ColorMode; label: string; sample: string }[] = [
  { value: 'color', label: 'Màu gốc', sample: 'color' },
  { value: 'grayscale', label: 'Thang xám', sample: 'gray' },
  { value: 'binary', label: 'Đen trắng', sample: 'binary' },
];

function cloneCorners(corners: Quad): Quad {
  return corners.map((point) => ({ ...point })) as Quad;
}

function initialSettings(settings: EditSettings | null | undefined): EditSettings {
  if (settings && [0, 90, 180, 270].includes(settings.rotation)
    && validateCorners(settings.corners)
    && ['color', 'grayscale', 'binary'].includes(settings.mode)
    && Number.isFinite(settings.brightness) && settings.brightness >= -60 && settings.brightness <= 60
    && Number.isFinite(settings.contrast) && settings.contrast >= -60 && settings.contrast <= 60) {
    return { ...settings, corners: cloneCorners(settings.corners) };
  }
  return { rotation: 0, corners: cloneCorners(DEFAULT_CORNERS), mode: 'color', brightness: 0, contrast: 0 };
}

function rotatedCorners(corners: Quad, clockwise: boolean): Quad {
  const order = clockwise ? [3, 0, 1, 2] : [1, 2, 3, 0];
  return order.map((index) => {
    const { x, y } = corners[index];
    return clockwise ? { x: 1 - y, y: x } : { x: y, y: 1 - x };
  }) as Quad;
}

function copyCanvas(target: HTMLCanvasElement | null, source: HTMLCanvasElement | null) {
  if (!target || !source) return;
  target.width = source.width;
  target.height = source.height;
  target.getContext('2d')?.drawImage(source, 0, 0);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Không xử lý được ảnh. Hãy thử lại.';
}

export function ScanEditor({ page, onSave, onClose }: ScanEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null);
  const thumbnailRef = useRef<HTMLCanvasElement>(null);
  const draggingRef = useRef<{ corner: number; pointerId: number } | null>(null);
  const [original, setOriginal] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [rotation, setRotation] = useState(0);
  const [corners, setCorners] = useState<Quad>(() => cloneCorners(DEFAULT_CORNERS));
  const cornersRef = useRef(corners);
  const [mode, setMode] = useState<ColorMode>('color');
  const [brightness, setBrightness] = useState(0);
  const [contrast, setContrast] = useState(0);
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<HTMLCanvasElement | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [invalidCorner, setInvalidCorner] = useState(false);
  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const [stageSize, setStageSize] = useState({ width: 700, height: 600 });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setOriginal(null);
    setPreview(null);
    setError('');
    const saved = initialSettings(page.edit);
    setRotation(saved.rotation);
    cornersRef.current = saved.corners;
    setCorners(saved.corners);
    setMode(saved.mode);
    setBrightness(saved.brightness);
    setContrast(saved.contrast);
    setShowPreview(false);
    loadImage(page.originalUrl)
      .then((image) => {
        if (!cancelled) setOriginal(image);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [page.id, page.originalUrl]);

  useEffect(() => { cornersRef.current = corners; }, [corners]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const source = useMemo(() => original ? rotateImage(original, rotation, 1600) : null, [original, rotation]);

  useEffect(() => {
    if (!source) return;
    setPreviewBusy(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      try {
        const rendered = renderScan(source, corners, { mode, brightness, contrast, maxEdge: 1000 });
        if (!cancelled) {
          setPreview(rendered);
          setError('');
        }
      } catch (reason) {
        if (!cancelled) setError(errorMessage(reason));
      } finally {
        if (!cancelled) setPreviewBusy(false);
      }
    }, 90);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, corners, mode, brightness, contrast]);

  const displayed = showPreview && preview ? preview : source;
  useEffect(() => { copyCanvas(displayRef.current, displayed); }, [displayed, loading]);
  useEffect(() => { copyCanvas(thumbnailRef.current, preview); }, [preview, loading]);

  const aspect = displayed ? displayed.width / displayed.height : page.width / Math.max(1, page.height);
  const fittedWidth = Math.max(1, Math.min(
    Math.max(1, stageSize.width - 72),
    Math.max(1, stageSize.height - 72) * (aspect || 1),
    displayed?.width ?? 700,
  ));

  function changeCorner(index: number, point: Point) {
    const next = cloneCorners(cornersRef.current);
    next[index] = { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
    if (!validateCorners(next)) {
      setInvalidCorner(true);
      return;
    }
    setInvalidCorner(false);
    cornersRef.current = next;
    setCorners(next);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, corner: number) {
    if (saving) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingRef.current = { corner, pointerId: event.pointerId };
    setActiveCorner(corner);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const dragging = draggingRef.current;
    const rect = imageRef.current?.getBoundingClientRect();
    if (!dragging || dragging.pointerId !== event.pointerId || !rect) return;
    event.preventDefault();
    changeCorner(dragging.corner, {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    });
  }

  function stopDrag(event: PointerEvent<HTMLButtonElement>) {
    if (draggingRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    draggingRef.current = null;
    setActiveCorner(null);
  }

  function moveCornerByKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    };
    const delta = deltas[event.key];
    if (!delta) return;
    event.preventDefault();
    const step = event.shiftKey ? 0.02 : 0.005;
    const point = cornersRef.current[index];
    changeCorner(index, { x: point.x + delta[0] * step, y: point.y + delta[1] * step });
  }

  function rotate(clockwise: boolean) {
    const next = rotatedCorners(cornersRef.current, clockwise);
    cornersRef.current = next;
    setCorners(next);
    setRotation((current) => (current + (clockwise ? 90 : 270)) % 360);
    setInvalidCorner(false);
  }

  function reset() {
    const next = cloneCorners(DEFAULT_CORNERS);
    cornersRef.current = next;
    setCorners(next);
    setRotation(0);
    setMode('color');
    setBrightness(0);
    setContrast(0);
    setShowPreview(false);
    setInvalidCorner(false);
    setError('');
  }

  async function save() {
    if (!original || saving) return;
    setSaving(true);
    setError('');
    try {
      // Yield so the saving status paints before processing the full image.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const fullSource = rotateImage(original, rotation, 2600);
      const result = renderScan(fullSource, cornersRef.current, { mode, brightness, contrast, maxEdge: 2600 });
      const blob = await canvasToBlob(result, 'image/jpeg', 0.94);
      await onSave(blob, { rotation, corners: cloneCorners(cornersRef.current), mode, brightness, contrast });
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  }

  function dialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !saving) {
      event.preventDefault();
      onClose();
    }
    if (event.key !== 'Tab') return;
    const elements = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]');
    const visible = Array.from(elements ?? []).filter((element) => element.getClientRects().length > 0);
    if (!visible.length) {
      event.preventDefault();
      return;
    }
    const first = visible[0];
    const last = visible[visible.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const polygon = corners.map(({ x, y }) => `${x * 100},${y * 100}`).join(' ');
  const maskPath = `M0 0H100V100H0Z M${corners.map(({ x, y }) => `${x * 100} ${y * 100}`).join('L')}Z`;
  const disabled = loading || saving || !original;

  return (
    <div className="editor-backdrop">
      <div className="editor-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="editor-title" onKeyDown={dialogKeyDown}>
        <header className="editor-header">
          <button ref={closeRef} className="editor-back" type="button" onClick={onClose} disabled={saving} aria-label="Đóng trình chỉnh sửa">
            <ArrowLeft size={19} />
          </button>
          <div>
            <div className="editor-eyebrow">HOÀN THIỆN TRANG QUÉT</div>
            <h2 id="editor-title">Chỉnh sửa ảnh</h2>
          </div>
          <button className="editor-reset" type="button" onClick={reset} disabled={disabled}>
            <Undo2 size={16} /> <span>Khôi phục ảnh gốc</span>
          </button>
        </header>

        <div className="editor-body">
          <section className="editor-workspace" aria-label="Ảnh đang chỉnh sửa">
            <div className="editor-view-tabs" role="group" aria-label="Chế độ xem ảnh">
              <button type="button" aria-pressed={!showPreview} onClick={() => setShowPreview(false)} disabled={disabled}>Căn góc</button>
              <button type="button" aria-pressed={showPreview} onClick={() => setShowPreview(true)} disabled={disabled || !preview}>Kết quả</button>
            </div>
            <div className="editor-stage" ref={stageRef}>
              {loading ? (
                <div className="editor-loading" role="status"><LoaderCircle className="editor-spin" size={27} /><span>Đang mở ảnh gốc…</span></div>
              ) : displayed ? (
                <div className="editor-image" ref={imageRef} style={{ width: fittedWidth, height: fittedWidth / (aspect || 1) }}>
                  <canvas ref={displayRef} aria-label={showPreview ? 'Ảnh sau khi căn chỉnh và áp dụng bộ lọc' : 'Ảnh gốc với bốn điểm căn góc'} />
                  {!showPreview && (
                    <>
                      <svg className="editor-crop-overlay" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                        <path d={maskPath} fill="rgba(13, 25, 35, .56)" fillRule="evenodd" />
                        <polygon points={polygon} fill="rgba(118, 238, 205, .025)" stroke="#83ecd1" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                      </svg>
                      {corners.map((point, index) => (
                        <button
                          key={index}
                          type="button"
                          className={`editor-corner${activeCorner === index ? ' editor-corner-active' : ''}`}
                          style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                          aria-label={`Góc ${CORNER_NAMES[index]}. Dùng phím mũi tên để chỉnh.`}
                          aria-describedby="editor-corner-help"
                          disabled={saving}
                          onPointerDown={(event) => startDrag(event, index)}
                          onPointerMove={moveDrag}
                          onPointerUp={stopDrag}
                          onPointerCancel={stopDrag}
                          onLostPointerCapture={() => { draggingRef.current = null; setActiveCorner(null); }}
                          onKeyDown={(event) => moveCornerByKey(event, index)}
                        >{index + 1}</button>
                      ))}
                    </>
                  )}
                  {showPreview && previewBusy && <div className="editor-preview-updating" role="status"><LoaderCircle className="editor-spin" size={16} /> Đang cập nhật…</div>}
                </div>
              ) : (
                <div className="editor-loading"><span>Không mở được ảnh.</span></div>
              )}
            </div>
            <p id="editor-corner-help" className={`editor-stage-help${invalidCorner ? ' editor-stage-help-warning' : ''}`}>
              {showPreview ? 'Trang giấy được căn thẳng theo bốn góc đã chọn.' : invalidCorner ? 'Giữ bốn góc quanh trang giấy; các cạnh không được cắt chéo.' : 'Kéo 4 điểm vào góc trang giấy. Dùng phím mũi tên để căn chính xác.'}
            </p>
          </section>

          <aside className="editor-controls" aria-label="Công cụ chỉnh ảnh">
            <div className="editor-control-section">
              <div className="editor-section-heading"><h3>Hướng trang</h3><span>{rotation}°</span></div>
              <div className="editor-rotate-row">
                <button type="button" onClick={() => rotate(false)} disabled={disabled}><RotateCcw size={18} /> Xoay trái</button>
                <button type="button" onClick={() => rotate(true)} disabled={disabled}><RotateCw size={18} /> Xoay phải</button>
              </div>
            </div>
            <div className="editor-control-section">
              <h3>Màu sắc</h3>
              <div className="editor-filters" role="group" aria-label="Bộ lọc màu">
                {COLOR_MODES.map((filter) => (
                  <button key={filter.value} type="button" aria-pressed={mode === filter.value} onClick={() => setMode(filter.value)} disabled={disabled}>
                    <span className={`editor-filter-sample editor-filter-${filter.sample}`} aria-hidden="true"><i /><i /><i /></span>
                    <span>{filter.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="editor-control-section editor-tones">
              <div className="editor-slider-heading"><label htmlFor="editor-brightness">Độ sáng</label><output htmlFor="editor-brightness">{brightness > 0 ? '+' : ''}{brightness}</output></div>
              <input id="editor-brightness" type="range" min="-60" max="60" step="1" value={brightness} onChange={(event) => setBrightness(Number(event.target.value))} disabled={disabled} />
              <div className="editor-slider-heading"><label htmlFor="editor-contrast">Tương phản</label><output htmlFor="editor-contrast">{contrast > 0 ? '+' : ''}{contrast}</output></div>
              <input id="editor-contrast" type="range" min="-60" max="60" step="1" value={contrast} onChange={(event) => setContrast(Number(event.target.value))} disabled={disabled} />
            </div>
            <div className="editor-control-section editor-preview-section">
              <div className="editor-section-heading"><h3>Xem trước</h3>{previewBusy && <LoaderCircle className="editor-spin" size={15} aria-label="Đang cập nhật xem trước" />}</div>
              <button className="editor-preview-thumb" type="button" onClick={() => setShowPreview(true)} disabled={disabled || !preview} aria-label="Mở ảnh kết quả lớn">
                <canvas ref={thumbnailRef} />
              </button>
              <p>Ảnh gốc được giữ lại để bạn chỉnh sửa bất cứ lúc nào.</p>
            </div>
          </aside>
        </div>

        <footer className="editor-footer">
          <div className="editor-footer-status">
            {error ? <p role="alert" className="editor-error">{error}</p> : <p role="status">{saving ? 'Đang xử lý và lưu trang…' : 'Căn góc · làm rõ · lưu vào tài liệu'}</p>}
          </div>
          <button className="editor-cancel" type="button" onClick={onClose} disabled={saving}>Hủy</button>
          <button className="editor-save" type="button" onClick={() => void save()} disabled={disabled}>
            {saving ? <LoaderCircle className="editor-spin" size={18} /> : <Check size={18} />}
            {saving ? 'Đang lưu…' : 'Lưu trang'}
          </button>
        </footer>
      </div>
    </div>
  );
}
