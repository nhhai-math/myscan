import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Camera, Check, CheckCircle2,
  Download, FileImage, FileText, LoaderCircle, MoreHorizontal, Plus, ScanLine,
  Share2, Trash2, WifiOff, X,
} from 'lucide-react';
import { openLibrary } from './storage';
import type { OfflineLibrary } from './storage';
import type { IOSDocument, IOSPage } from './types';
import { importScanImage } from './image';
import { IosEditor } from './IosEditor';
import type { EditSettings } from '../lib/image';

function message(error: unknown) {
  return error instanceof Error ? error.message : 'Không hoàn thành được thao tác. Vui lòng thử lại.';
}

function useOfflineShell() {
  const [ready, setReady] = useState(false);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [cacheError, setCacheError] = useState(false);
  useEffect(() => {
    if (!('serviceWorker' in navigator) || !window.isSecureContext) { setCacheError(true); return; }
    let cancelled = false;
    let updating = false;
    let candidate: ServiceWorker | null = null;
    let currentRegistration: ServiceWorkerRegistration | null = null;
    const controllerChange = () => {
      if (updating) window.location.reload();
      else if (currentRegistration) void check(currentRegistration);
    };
    navigator.serviceWorker.addEventListener('controllerchange', controllerChange);
    const check = async (reg: ServiceWorkerRegistration) => {
      const worker = reg.active;
      if (!worker || cancelled) return;
      const channel = new MessageChannel();
      const timer = window.setTimeout(() => { channel.port1.close(); if (!cancelled) setCacheError(true); }, 5000);
      channel.port1.onmessage = (event: MessageEvent) => {
        clearTimeout(timer);
        channel.port1.close();
        if (!cancelled && event.data?.type === 'CACHE_STATUS') {
          setReady(event.data.ready === true && navigator.serviceWorker.controller !== null);
          setCacheError(event.data.ready !== true);
        }
      };
      worker.postMessage({ type: 'GET_CACHE_STATUS' }, [channel.port2]);
    };
    let disposeUpdate: (() => void) | undefined;
    navigator.serviceWorker.register(new URL('./sw.js', document.baseURI).href, { scope: './' })
      .then(async (reg) => {
        if (cancelled) return;
        currentRegistration = reg;
        setRegistration(reg);
        setWaiting(Boolean(reg.waiting));
        const updateFound = () => {
          candidate = reg.installing;
          candidate?.addEventListener('statechange', () => {
            if (cancelled) return;
            setWaiting(Boolean(reg.waiting));
            if (reg.active) void check(reg);
          });
        };
        reg.addEventListener('updatefound', updateFound);
        disposeUpdate = () => reg.removeEventListener('updatefound', updateFound);
        if (reg.installing) updateFound();
        const active = await navigator.serviceWorker.ready;
        if (!cancelled) void check(active);
      }).catch(() => { if (!cancelled) setCacheError(true); });
    // Keep the reload opt-in, including when another tab discovers an update.
    const updateEvent = () => { updating = true; };
    window.addEventListener('myscan-apply-update', updateEvent);
    return () => {
      cancelled = true;
      disposeUpdate?.();
      navigator.serviceWorker.removeEventListener('controllerchange', controllerChange);
      window.removeEventListener('myscan-apply-update', updateEvent);
    };
  }, []);
  const update = () => {
    if (!registration?.waiting) return;
    window.dispatchEvent(new Event('myscan-apply-update'));
    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
  };
  return { ready, waiting, cacheError, update };
}

function Sheet({ title, onClose, children, locked = false, error = '' }: {
  title: string; onClose: () => void; children: ReactNode; locked?: boolean; error?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const lockedRef = useRef(locked);
  closeRef.current = onClose;
  lockedRef.current = locked;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const element = ref.current;
    (element?.querySelector<HTMLElement>('input:not(:disabled), select')
      || element?.querySelector<HTMLElement>('button:not(:disabled), a[href]') || element)?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !lockedRef.current) { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab' || !element) return;
      const controls = Array.from(element.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select, a[href]'))
        .filter((node) => node.getClientRects().length > 0);
      const first = controls[0]; const last = controls[controls.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="ios-backdrop"><section ref={ref} className="ios-sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
    <div className="ios-sheet-heading"><h2>{title}</h2><button className="ios-icon" aria-label="Đóng" disabled={locked} onClick={onClose}><X size={22} /></button></div>
    {error && <div className="ios-error" role="alert">{error}</div>}
    {children}
  </section></div>;
}

function PageImage({ library, document, page, original = false, className = '' }: {
  library: OfflineLibrary; document: IOSDocument; page: IOSPage; original?: boolean; className?: string;
}) {
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false; let url = '';
    setSrc(''); setError('');
    library.getPageImage(document.id, page.id, original).then((blob) => {
      if (!cancelled) { url = URL.createObjectURL(blob); setSrc(url); }
    }).catch((reason: unknown) => { if (!cancelled) setError(message(reason)); });
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [library, document.id, page.id, page.updatedAt, original]);
  return <div className={`ios-page-image ${className}`}>
    {src ? <img src={src} alt={original ? 'Ảnh gốc của trang' : 'Ảnh trang đã lưu'} loading="lazy" decoding="async" onError={() => { setSrc(''); setError('Không đọc được ảnh trang này. Ảnh nguồn vẫn được giữ trong thư viện.'); }} />
      : <span>{error || 'Đang mở trang…'}</span>}
  </div>;
}

type EditorDraft = { document: IOSDocument; page: IOSPage; original: Blob };
type PdfResult = { file: File; url: string };

export function IosApp() {
  const [library, setLibrary] = useState<OfflineLibrary | null>(null);
  const [documents, setDocuments] = useState<IOSDocument[]>([]);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [titleMode, setTitleMode] = useState<'new' | 'rename' | null>(null);
  const [title, setTitle] = useState('');
  const [remove, setRemove] = useState<'document' | 'page' | null>(null);
  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [originalView, setOriginalView] = useState(false);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [paper, setPaper] = useState<'a4' | 'image'>('a4');
  const [pdf, setPdf] = useState<PdfResult | null>(null);
  const [query, setQuery] = useState('');
  const [installHelp, setInstallHelp] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const capture = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const working = useRef(false);
  const shell = useOfflineShell();
  const selected = documents.find((item) => item.id === documentId) ?? null;
  const pageIndex = selected?.pages.findIndex((item) => item.id === pageId) ?? -1;
  const currentPage = selected?.pages[Math.max(0, pageIndex)] ?? null;
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const hasSheet = Boolean(titleMode || remove || originalView || pdfOpen || installHelp);

  useEffect(() => {
    let cancelled = false; let opened: OfflineLibrary | null = null;
    openLibrary().then(async (result) => {
      opened = result;
      const items = await result.listDocuments();
      if (!cancelled) { setLibrary(result); setDocuments(items); }
      else result.close();
    }).catch((reason: unknown) => {
      opened?.close();
      if (!cancelled) setError(message(reason));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; opened?.close(); };
  }, []);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, []);
  useEffect(() => () => { if (pdf) URL.revokeObjectURL(pdf.url); }, [pdf]);

  async function refresh() {
    if (!library) return;
    const items = await library.listDocuments();
    setDocuments(items);
  }
  async function run(label: string, operation: () => Promise<void>) {
    if (working.current) return;
    working.current = true; setBusy(label); setError(''); setNotice('');
    try { await operation(); }
    catch (reason) { setError(message(reason)); }
    finally { working.current = false; setBusy(''); }
  }
  function choose(item: IOSDocument) {
    setDocumentId(item.id); setPageId(item.pages[0]?.id ?? null); setError(''); setNotice('');
  }
  async function importFiles(files: File[]) {
    if (!library || !files.length) return;
    if (files.length > 20) { setError('Chọn tối đa 20 ảnh mỗi lần.'); return; }
    await run('Đang lưu ảnh trên iPhone…', async () => {
      let target = selected;
      if (!target) target = await library.createDocument(`Tài liệu ${new Intl.DateTimeFormat('vi-VN').format(new Date())}`);
      setDocumentId(target.id);
      const failures: string[] = []; let imported = 0;
      for (const file of files) {
        try {
          setBusy(`Đang lưu trang ${imported + 1}…`);
          const image = await importScanImage(file);
          target = await library.addPage(target.id, image.blob, image.width, image.height);
          setPageId(target.pages[target.pages.length - 1].id);
          imported += 1;
        } catch (reason) { failures.push(`${file.name}: ${message(reason)}`); }
      }
      await refresh();
      if (imported) setNotice(`Đã lưu ${imported} trang trên thiết bị này.`);
      if (failures.length) setError(failures.join('\n'));
    });
  }
  async function titleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!library || !titleMode) return;
    await run('Đang lưu tài liệu…', async () => {
      const result = titleMode === 'rename' && selected
        ? await library.renameDocument(selected.id, title)
        : await library.createDocument(title);
      await refresh(); choose(result); setTitleMode(null);
    });
  }
  async function editPage() {
    if (!library || !selected || !currentPage) return;
    await run('Đang mở ảnh gốc…', async () => {
      const original = await library.getPageImage(selected.id, currentPage.id, true);
      setEditor({ document: selected, page: currentPage, original });
    });
  }
  async function savePage(blob: Blob, width: number, height: number, settings: EditSettings) {
    if (!library || !editor) throw new Error('Trang đã đóng. Hãy mở lại tài liệu.');
    await library.saveEditedPage(editor.document.id, editor.page.id, blob, width, height, settings);
    await refresh(); setEditor(null); setNotice('Đã lưu bản scan. Ảnh gốc vẫn được giữ riêng.');
  }
  async function move(delta: -1 | 1) {
    if (!library || !selected || !currentPage) return;
    await run('Đang đổi thứ tự trang…', async () => { await library.movePage(selected.id, currentPage.id, delta); await refresh(); });
  }
  async function confirmDelete() {
    if (!library || !selected) return;
    await run('Đang xóa…', async () => {
      if (remove === 'document') { await library.deleteDocument(selected.id); setDocumentId(null); setPageId(null); }
      else if (currentPage) {
        const updated = await library.deletePage(selected.id, currentPage.id);
        setPageId(updated.pages[Math.min(Math.max(0, pageIndex), updated.pages.length - 1)]?.id ?? null);
      }
      await refresh(); setRemove(null);
    });
  }
  function closePdf() { setPdfOpen(false); setPdf(null); }
  async function preparePdf() {
    if (!library || !selected || !selected.pages.length) return;
    await run('Đang ghép PDF…', async () => {
      const pages = [];
      for (const item of selected.pages) pages.push({ blob: await library.getPageImage(selected.id, item.id), width: item.width, height: item.height });
      const { createDocumentPdf } = await import('./pdf');
      const blob = await createDocumentPdf(selected.title, pages, paper);
      const filename = selected.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'myscan';
      const file = new File([blob], `${filename}.pdf`, { type: 'application/pdf' });
      setPdf({ file, url: URL.createObjectURL(file) });
    });
  }
  function sharePdf() {
    if (!pdf) return;
    // Invoke share directly from this second tap so Safari retains user activation.
    void navigator.share({ files: [pdf.file], title: selected?.title || 'myscan' }).catch((reason: unknown) => {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setError(message(reason));
    });
  }
  const canShare = pdf && typeof navigator.canShare === 'function' && navigator.canShare({ files: [pdf.file] });
  const filtered = documents.filter((item) => item.title.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')));

  return <div className="ios-app">
    <header className="ios-header"><a className="ios-brand" href="#" onClick={(event) => { event.preventDefault(); if (!busy) { setDocumentId(null); setPageId(null); } }} aria-label="myscan, về thư viện">myscan<span>.</span></a>
      <span className={`ios-status ${shell.ready ? 'ready' : ''}`}><span />{!online ? <><WifiOff size={13} /> Offline</> : shell.ready ? 'Sẵn sàng offline' : shell.cacheError ? 'Chưa sẵn sàng offline' : 'Đang chuẩn bị offline'}</span>
    </header>
    <main className="ios-content">
      {busy && <div role="status" className="ios-progress"><LoaderCircle className="ios-spin" size={19} />{busy}</div>}
      {error && !hasSheet && <div className="ios-error" role="alert">{error}<button onClick={() => setError('')} aria-label="Đóng thông báo"><X size={18} /></button></div>}
      {notice && <div className="ios-notice" role="status"><CheckCircle2 size={18} />{notice}</div>}
      {shell.cacheError && <p className="ios-info">Chưa lưu đủ ứng dụng để mở lại khi mất mạng. Kết nối Internet và mở lại trang trước khi quét offline.</p>}
      {shell.waiting && <div className="ios-update">Có phiên bản mới.<button disabled={Boolean(busy || editor || pdfOpen || titleMode)} onClick={shell.update}>Cập nhật</button></div>}
      {loading ? <div className="ios-empty"><LoaderCircle size={30} className="ios-spin" /><h2>Đang mở thư viện</h2></div>
        : !library ? <div className="ios-empty"><FileText size={42} /><h2>Chưa mở được thư viện</h2><p>Dữ liệu hiện có được giữ nguyên. Dùng Safari thông thường và cho phép lưu dữ liệu trang web.</p><button className="ios-primary" onClick={() => window.location.reload()}>Thử lại</button></div>
          : selected ? <>
            <button className="ios-back" disabled={Boolean(busy)} onClick={() => { setDocumentId(null); setPageId(null); setNotice(''); }}><ArrowLeft size={18} />Thư viện</button>
            <div className="ios-document-heading"><div><p className="ios-eyebrow">TÀI LIỆU CỦA BẠN</p><h1>{selected.title}</h1><p>{selected.pages.length} trang · Lưu trên thiết bị này</p></div>
              <button className="ios-icon" disabled={Boolean(busy)} aria-label="Đổi tên tài liệu" onClick={() => { setTitle(selected.title); setTitleMode('rename'); }}><MoreHorizontal /></button></div>
            {currentPage ? <>
              <div className="ios-pagination"><span>Trang {Math.max(0, pageIndex) + 1} / {selected.pages.length}</span><div><button className="ios-icon" aria-label="Trang trước" disabled={Boolean(busy) || pageIndex <= 0} onClick={() => setPageId(selected.pages[pageIndex - 1].id)}><ArrowLeft size={19} /></button><button className="ios-icon" aria-label="Trang sau" disabled={Boolean(busy) || pageIndex >= selected.pages.length - 1} onClick={() => setPageId(selected.pages[pageIndex + 1].id)}><ArrowRight size={19} /></button></div></div>
              <div data-testid="page-preview"><PageImage library={library} document={selected} page={currentPage} /></div>
              <div className="ios-page-actions"><button disabled={Boolean(busy)} onClick={() => setOriginalView(true)}>Ảnh gốc</button><button className="ios-primary" disabled={Boolean(busy)} onClick={() => void editPage()}><ScanLine size={19} />Chỉnh sửa</button></div>
              <div className="ios-reorder"><button className="ios-icon" aria-label="Chuyển trang lên" disabled={Boolean(busy) || pageIndex <= 0} onClick={() => void move(-1)}><ArrowUp size={18} /></button><button className="ios-icon" aria-label="Chuyển trang xuống" disabled={Boolean(busy) || pageIndex >= selected.pages.length - 1} onClick={() => void move(1)}><ArrowDown size={18} /></button><span>Đổi thứ tự trang</span><button className="ios-delete" disabled={Boolean(busy)} onClick={() => setRemove('page')} aria-label="Xóa trang"><Trash2 size={18} /></button></div>
              {selected.pages.length > 1 && <nav className="ios-page-tabs" aria-label="Chọn trang">{selected.pages.map((item, index) => <button key={item.id} className={item.id === currentPage.id ? 'active' : ''} disabled={Boolean(busy)} onClick={() => setPageId(item.id)} aria-label={`Mở trang ${index + 1}`} aria-current={item.id === currentPage.id ? 'page' : undefined}>{index + 1}</button>)}</nav>}
            </> : <div className="ios-empty ios-paper-empty"><ScanLine size={48} /><h2>Thêm trang đầu tiên</h2><p>Lấy trọn bốn góc giấy, tránh bóng và giữ iPhone ổn định khi chụp.</p></div>}
            <div className="ios-add-actions"><button className="ios-primary" disabled={Boolean(busy)} onClick={() => capture.current?.click()}><Camera size={20} />Chụp trang</button><button disabled={Boolean(busy)} onClick={() => gallery.current?.click()}><FileImage size={20} />Thêm ảnh</button></div>
            <button className="ios-export" disabled={Boolean(busy) || !selected.pages.length} onClick={() => { setPdfOpen(true); setPdf(null); }}><FileText size={20} />Xuất PDF<ArrowRight size={18} /></button>
            <button className="ios-delete-document" disabled={Boolean(busy)} onClick={() => setRemove('document')}>Xóa tài liệu này</button>
          </> : <>
            <section className="ios-intro"><p className="ios-eyebrow">SCAN. CHỈNH. HOÀN THIỆN.</p><h1>Giấy tờ gọn lại.<br /><span>Mọi nơi, mọi lúc.</span></h1><p>Quét thành tài liệu PDF ngay trên iPhone.<br />Ảnh và tài liệu được giữ trên thiết bị này.</p></section>
            {!standalone && <button className="ios-install-card" onClick={() => setInstallHelp(true)}><div className="ios-install-icon"><Download size={23} /></div><div><strong>Cài myscan lên iPhone</strong><span>Safari → Chia sẻ → Thêm vào Màn hình chính</span></div><ArrowRight size={18} /></button>}
            <div className="ios-library-title"><h2>Thư viện <span>{documents.length}</span></h2><button className="ios-primary" disabled={Boolean(busy)} onClick={() => { setTitle(''); setTitleMode('new'); }}><Plus size={18} />Tài liệu mới</button></div>
            {documents.length > 4 && <input className="ios-search" aria-label="Tìm tài liệu" placeholder="Tìm theo tên tài liệu" value={query} onChange={(event) => setQuery(event.target.value)} />}
            {filtered.length ? <div className="ios-document-list">{filtered.map((item) => <button className="ios-document-card" key={item.id} disabled={Boolean(busy)} onClick={() => choose(item)}>
              {item.pages[0] ? <PageImage library={library} document={item} page={item.pages[0]} className="ios-thumb" /> : <span className="ios-thumb ios-thumb-empty"><FileText size={26} /></span>}
              <div><h3>{item.title}</h3><p>{item.pages.length} trang · {new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit' }).format(item.updatedAt)}</p></div><ArrowRight size={19} /></button>)}</div>
              : <div className="ios-empty"><div className="ios-empty-icon"><ScanLine size={44} /></div><h2>{query ? 'Chưa có tài liệu phù hợp' : 'Tài liệu đầu tiên, bắt đầu từ đây'}</h2><p>{query ? 'Thử tìm với tên khác.' : 'Chụp giấy tờ hoặc chọn ảnh có sẵn, chỉnh lại rồi ghép thành PDF.'}</p>{!query && <button className="ios-primary" disabled={Boolean(busy)} onClick={() => capture.current?.click()}><Camera size={19} />Bắt đầu quét</button>}</div>}
            <div className="ios-local-note"><Check size={16} />Không cần tài khoản. Quét và xuất PDF offline.</div>
          </>}
      <input hidden ref={capture} type="file" accept="image/*" capture="environment" data-testid="camera-input" disabled={Boolean(busy) || !library} onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; void importFiles(files); }} />
      <input hidden ref={gallery} type="file" accept="image/*" multiple data-testid="gallery-input" disabled={Boolean(busy) || !library} onChange={(event) => { const files = Array.from(event.target.files || []); event.target.value = ''; void importFiles(files); }} />
    </main>
    <footer className="ios-footer">myscan · iPhone · 1.0</footer>
    {titleMode && <Sheet title={titleMode === 'new' ? 'Tài liệu mới' : 'Đổi tên tài liệu'} error={error} locked={Boolean(busy)} onClose={() => setTitleMode(null)}><form onSubmit={(event) => void titleSubmit(event)}><label className="ios-field">Tên tài liệu<input autoFocus required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Ví dụ: Hồ sơ học tập" /></label><button type="submit" className="ios-primary ios-wide" disabled={Boolean(busy) || !title.trim()}>{titleMode === 'new' ? 'Tạo tài liệu' : 'Lưu tên'}</button></form></Sheet>}
    {remove && <Sheet title={remove === 'page' ? 'Xóa trang này?' : 'Xóa tài liệu này?'} error={error} locked={Boolean(busy)} onClose={() => setRemove(null)}><p>{remove === 'page' ? 'Ảnh gốc và bản chỉnh của trang này sẽ bị xóa khỏi thư viện.' : 'Các trang trong tài liệu này sẽ bị xóa khỏi thư viện.'}</p><p>PDF bạn đã lưu vào Tệp vẫn được giữ.</p><button className="ios-danger ios-wide" disabled={Boolean(busy)} onClick={() => void confirmDelete()}>Xác nhận xóa</button></Sheet>}
    {originalView && library && selected && currentPage && <Sheet title="Ảnh gốc" onClose={() => setOriginalView(false)}><PageImage library={library} document={selected} page={currentPage} original /><p className="ios-muted">Ảnh nguồn được giữ riêng và không bị thay đổi khi chỉnh bản scan.</p></Sheet>}
    {editor && <IosEditor original={editor.original} initialSettings={editor.page.edit} onSave={savePage} onClose={() => setEditor(null)} />}
    {pdfOpen && <Sheet title="Hoàn thiện PDF" error={error} onClose={closePdf} locked={Boolean(busy)}>
      {pdf ? <><div className="ios-pdf-ready"><CheckCircle2 size={42} /><h3>PDF đã sẵn sàng</h3><p>{selected?.pages.length} trang theo thứ tự trong tài liệu.</p></div>
        {canShare && <button className="ios-primary ios-wide" onClick={sharePdf}><Share2 size={19} />Chia sẻ / Lưu vào Tệp</button>}
        <a className={`ios-button ios-wide ${canShare ? '' : 'ios-primary'}`} href={pdf.url} download={pdf.file.name}><Download size={19} />Tải PDF</a>
        <a className="ios-pdf-link" href={pdf.url} target="_blank" rel="noopener">Mở PDF để xem</a><p className="ios-muted">Trên iPhone, chọn Chia sẻ → Lưu vào Tệp để giữ PDF ngoài ứng dụng.</p></>
        : <><p>Ghép {selected?.pages.length} trang theo thứ tự hiện tại.</p><label className="ios-field">Khổ trang<select value={paper} onChange={(event) => setPaper(event.target.value as 'a4' | 'image')}><option value="a4">A4 · Giữ tỷ lệ ảnh</option><option value="image">Theo tỷ lệ ảnh</option></select></label><button className="ios-primary ios-wide" disabled={Boolean(busy)} onClick={() => void preparePdf()}><FileText size={19} />Chuẩn bị PDF</button></>}
    </Sheet>}
    {installHelp && <Sheet title="Cài myscan trên iPhone" onClose={() => setInstallHelp(false)}><ol className="ios-install-steps"><li>Mở trang này bằng <strong>Safari</strong>.</li><li>Chạm nút <strong>Chia sẻ</strong>, rồi chọn <strong>Thêm vào Màn hình chính</strong>.</li><li>Chạm <strong>Thêm</strong>. Mở biểu tượng myscan vừa tạo khi còn kết nối Internet.</li><li>Chờ trạng thái <strong>Sẵn sàng offline</strong>, rồi có thể quét và xuất PDF khi mất mạng.</li></ol><p className="ios-muted">Tài liệu lưu trên thiết bị này. Hãy xuất PDF cần giữ vào Tệp; xóa dữ liệu trang web sẽ xóa thư viện.</p><button className="ios-primary ios-wide" onClick={() => setInstallHelp(false)}>Đã hiểu</button></Sheet>}
  </div>;
}
