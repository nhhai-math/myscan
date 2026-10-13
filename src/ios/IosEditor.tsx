import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { ArrowLeft, Check, LoaderCircle, RotateCw, Undo2 } from 'lucide-react';
import { canvasToBlob, DEFAULT_CORNERS, loadImage, renderScan, rotateImage, validateCorners } from '../lib/image';
import type { ColorMode, EditSettings, Point, Quad } from '../lib/image';
import './IosEditor.css';

export type IosEditorProps = {
  original: Blob;
  initialSettings: EditSettings | null;
  onSave: (blob: Blob, width: number, height: number, settings: EditSettings) => Promise<void>;
  onClose: () => void;
};

const NAMES = ['trên trái', 'trên phải', 'dưới phải', 'dưới trái'];
const FILTERS: { value: ColorMode; label: string }[] = [
  { value: 'color', label: 'Màu gốc' },
  { value: 'grayscale', label: 'Thang xám' },
  { value: 'binary', label: 'Đen trắng' },
];

function copySettings(settings: EditSettings): EditSettings {
  return { ...settings, corners: settings.corners.map((point) => ({ ...point })) as Quad };
}

function safeSettings(settings: EditSettings | null): EditSettings {
  if (settings && [0, 90, 180, 270].includes(settings.rotation)
    && validateCorners(settings.corners) && ['color', 'grayscale', 'binary'].includes(settings.mode)
    && Number.isFinite(settings.brightness) && Math.abs(settings.brightness) <= 60
    && Number.isFinite(settings.contrast) && Math.abs(settings.contrast) <= 60) return copySettings(settings);
  return { rotation: 0, corners: DEFAULT_CORNERS.map((point) => ({ ...point })) as Quad, mode: 'color', brightness: 0, contrast: 0 };
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'Không xử lý được ảnh. Hãy thử lại.';
}

export function IosEditor({ original: originalBlob, initialSettings, onSave, onClose }: IosEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRef = useRef(safeSettings(initialSettings));
  const historyRef = useRef<EditSettings[]>([]);
  const gestureRef = useRef(false);
  const draggingRef = useRef<{ corner: number; pointerId: number } | null>(null);
  const savingRef = useRef(false);
  const [settings, setSettings] = useState(settingsRef.current);
  const [historyCount, setHistoryCount] = useState(0);
  const [original, setOriginal] = useState<HTMLImageElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<HTMLCanvasElement | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const [stageSize, setStageSize] = useState({ width: 350, height: 320 });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const url = URL.createObjectURL(originalBlob);
    setLoading(true);
    setOriginal(null);
    setError('');
    setPreview(null);
    historyRef.current = [];
    setHistoryCount(0);
    gestureRef.current = false;
    const next = safeSettings(initialSettings);
    settingsRef.current = next;
    setSettings(next);
    loadImage(url).then((image) => {
      if (!cancelled) setOriginal(image);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(message(reason));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; URL.revokeObjectURL(url); };
    // Changing tools must never reload or overwrite the immutable original.
  }, [originalBlob]);

  useEffect(() => {
    const element = stageRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setStageSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const source = useMemo(() => original ? rotateImage(original, settings.rotation, 1400) : null, [original, settings.rotation]);
  useEffect(() => {
    if (!source) return;
    setPreviewBusy(true);
    const timer = window.setTimeout(() => {
      try {
        setPreview(renderScan(source, settings.corners, { ...settings, maxEdge: 900 }));
      } catch (reason) {
        setError(message(reason));
      } finally {
        setPreviewBusy(false);
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [source, settings]);

  const displayed = showPreview && preview ? preview : source;
  useEffect(() => {
    const target = canvasRef.current;
    if (!target || !displayed) return;
    target.width = displayed.width;
    target.height = displayed.height;
    target.getContext('2d')?.drawImage(displayed, 0, 0);
  }, [displayed, loading]);

  function remember() {
    historyRef.current = [...historyRef.current.slice(-39), copySettings(settingsRef.current)];
    setHistoryCount(historyRef.current.length);
  }

  function beginGesture() {
    if (savingRef.current || gestureRef.current) return;
    remember();
    gestureRef.current = true;
  }

  function change(next: EditSettings, record = !gestureRef.current) {
    if (savingRef.current) return;
    if (JSON.stringify(next) === JSON.stringify(settingsRef.current)) return;
    if (record) remember();
    settingsRef.current = copySettings(next);
    setSettings(settingsRef.current);
    setError('');
    setInvalid(false);
  }

  function changeCorner(index: number, point: Point) {
    const next = copySettings(settingsRef.current);
    next.corners[index] = { x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) };
    if (!validateCorners(next.corners)) { setInvalid(true); return; }
    change(next);
  }

  function startDrag(event: PointerEvent<HTMLButtonElement>, corner: number) {
    if (savingRef.current) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    beginGesture();
    draggingRef.current = { corner, pointerId: event.pointerId };
    setActiveCorner(corner);
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const dragging = draggingRef.current;
    const rect = imageRef.current?.getBoundingClientRect();
    if (!dragging || dragging.pointerId !== event.pointerId || !rect || !rect.width || !rect.height) return;
    event.preventDefault();
    changeCorner(dragging.corner, { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height });
  }

  function finishDrag(event: PointerEvent<HTMLButtonElement>) {
    if (draggingRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    draggingRef.current = null;
    gestureRef.current = false;
    setActiveCorner(null);
  }

  function moveCornerByKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const movement = delta[event.key];
    if (!movement) return;
    event.preventDefault();
    const point = settingsRef.current.corners[index];
    const step = event.shiftKey ? 0.02 : 0.005;
    changeCorner(index, { x: point.x + movement[0] * step, y: point.y + movement[1] * step });
  }

  function rotate() {
    const previous = settingsRef.current;
    const order = [3, 0, 1, 2];
    const corners = order.map((index) => ({ x: 1 - previous.corners[index].y, y: previous.corners[index].x })) as Quad;
    gestureRef.current = false;
    change({ ...previous, rotation: (previous.rotation + 90) % 360, corners });
  }

  function undo() {
    if (savingRef.current) return;
    const previous = historyRef.current.pop();
    if (!previous) return;
    gestureRef.current = false;
    settingsRef.current = previous;
    setSettings(previous);
    setHistoryCount(historyRef.current.length);
    setError('');
    setInvalid(false);
  }

  async function save() {
    if (!original || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    let fullSource: HTMLCanvasElement | null = null;
    let result: HTMLCanvasElement | null = null;
    const savedSettings = copySettings(settingsRef.current);
    try {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      fullSource = rotateImage(original, savedSettings.rotation, 2600);
      result = renderScan(fullSource, savedSettings.corners, { ...savedSettings, maxEdge: 2600 });
      const blob = await canvasToBlob(result, 'image/jpeg', 0.94);
      await onSave(blob, result.width, result.height, savedSettings);
      onClose();
    } catch (reason) {
      setError(message(reason));
    } finally {
      if (fullSource) { fullSource.width = 0; fullSource.height = 0; }
      if (result) { result.width = 0; result.height = 0; }
      savingRef.current = false;
      setSaving(false);
    }
  }

  function dialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !savingRef.current) { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])
      .filter((element) => element.getClientRects().length > 0);
    const first = elements[0];
    const last = elements[elements.length - 1];
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const disabled = loading || saving || !original;
  const aspect = displayed ? displayed.width / displayed.height : 0.7;
  const fittedWidth = Math.max(1, Math.min(Math.max(1, stageSize.width - 64), Math.max(1, stageSize.height - 64) * aspect));
  const polygon = settings.corners.map(({ x, y }) => `${x * 100},${y * 100}`).join(' ');
  const mask = `M0 0H100V100H0Z M${settings.corners.map(({ x, y }) => `${x * 100} ${y * 100}`).join('L')}Z`;

  return <div className="ios-editor-backdrop">
    <div ref={dialogRef} className="ios-editor" role="dialog" aria-modal="true" aria-labelledby="ios-editor-title" onKeyDown={dialogKeyDown}>
      <header className="ios-editor-header">
        <button ref={closeRef} type="button" onClick={onClose} disabled={saving} aria-label="Đóng trình chỉnh sửa"><ArrowLeft size={21} /></button>
        <h2 id="ios-editor-title">Chỉnh ảnh quét</h2>
        <button type="button" onClick={undo} disabled={disabled || !historyCount} aria-label="Hoàn tác"><Undo2 size={20} /></button>
      </header>
      <section className="ios-editor-workspace" aria-label="Ảnh đang chỉnh sửa">
        <div className="ios-editor-tabs" role="group" aria-label="Chế độ xem ảnh">
          <button type="button" aria-pressed={!showPreview} disabled={disabled} onClick={() => setShowPreview(false)}>Căn 4 góc</button>
          <button type="button" aria-pressed={showPreview} disabled={disabled || !preview} onClick={() => setShowPreview(true)}>Xem kết quả</button>
        </div>
        <div ref={stageRef} className="ios-editor-stage">
          {loading ? <p role="status"><LoaderCircle className="ios-editor-spin" size={24} /> Đang mở ảnh…</p>
            : displayed ? <div ref={imageRef} className="ios-editor-image" style={{ width: fittedWidth, height: fittedWidth / aspect }}>
              <canvas ref={canvasRef} aria-label={showPreview ? 'Ảnh sau khi căn chỉnh và áp dụng bộ lọc' : 'Ảnh gốc với bốn điểm căn góc'} />
              {!showPreview && <>
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true"><path d={mask} fill="rgba(9, 27, 24, .55)" fillRule="evenodd" /><polygon points={polygon} fill="none" stroke="#9ef3ce" strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>
                {settings.corners.map((point, index) => <button
                  key={index} type="button" className={`ios-editor-corner${activeCorner === index ? ' ios-editor-corner-active' : ''}`}
                  style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                  aria-label={`Góc ${NAMES[index]}`} aria-describedby="ios-corner-help" disabled={saving}
                  onPointerDown={(event) => startDrag(event, index)} onPointerMove={moveDrag} onPointerUp={finishDrag} onPointerCancel={finishDrag}
                  onLostPointerCapture={() => { draggingRef.current = null; gestureRef.current = false; setActiveCorner(null); }}
                  onKeyDown={(event) => moveCornerByKey(event, index)}
                >{index + 1}</button>)}
              </>}
              {showPreview && previewBusy && <span className="ios-editor-updating" role="status">Đang cập nhật…</span>}
            </div> : <p>Không mở được ảnh gốc.</p>}
        </div>
        <p id="ios-corner-help" className={`ios-editor-hint${invalid ? ' ios-editor-warning' : ''}`}>
          {showPreview ? 'Trang đã căn thẳng theo bốn góc.' : invalid ? 'Giữ bốn góc quanh trang; các cạnh không được cắt chéo.' : 'Kéo 4 điểm vào góc trang giấy.'}
        </p>
      </section>
      <div className="ios-editor-controls" aria-label="Công cụ chỉnh ảnh">
        <div className="ios-editor-tools">
          <button type="button" disabled={disabled} onClick={rotate}><RotateCw size={19} /> Xoay 90°</button>
          <button type="button" disabled={disabled} onClick={() => { gestureRef.current = false; change(safeSettings(null)); setShowPreview(false); }}>Ảnh gốc</button>
        </div>
        <div className="ios-editor-filters" role="group" aria-label="Bộ lọc màu">
          {FILTERS.map((filter) => <button key={filter.value} type="button" disabled={disabled} aria-pressed={settings.mode === filter.value}
            onClick={() => { gestureRef.current = false; change({ ...settingsRef.current, mode: filter.value }); }}>{filter.label}</button>)}
        </div>
        {(['brightness', 'contrast'] as const).map((key) => <div key={key} className="ios-editor-slider">
          <label htmlFor={`ios-editor-${key}`}>{key === 'brightness' ? 'Độ sáng' : 'Tương phản'} <output htmlFor={`ios-editor-${key}`}>{settings[key]}</output></label>
          <input id={`ios-editor-${key}`} type="range" min="-60" max="60" step="1" value={settings[key]} disabled={disabled}
            onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); beginGesture(); }}
            onPointerUp={() => { gestureRef.current = false; }} onPointerCancel={() => { gestureRef.current = false; }} onLostPointerCapture={() => { gestureRef.current = false; }}
            onBlur={() => { gestureRef.current = false; }} onKeyDown={(event) => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) beginGesture(); }}
            onKeyUp={() => { gestureRef.current = false; }} onChange={(event) => change({ ...settingsRef.current, [key]: Number(event.target.value) })} />
        </div>)}
      </div>
      <footer className="ios-editor-footer">
        <p className={error ? 'ios-editor-error' : ''} role={error ? 'alert' : 'status'}>{error || (saving ? 'Đang xử lý và lưu trang…' : 'Ảnh gốc được giữ lại trên thiết bị.')}</p>
        <button type="button" className="ios-editor-save" onClick={() => void save()} disabled={disabled}>{saving ? <LoaderCircle className="ios-editor-spin" size={19} /> : <Check size={19} />}{saving ? 'Đang lưu…' : 'Lưu trang'}</button>
      </footer>
    </div>
  </div>;
}
