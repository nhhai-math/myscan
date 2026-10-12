import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Camera, Check, ChevronLeft, ChevronRight, CircleHelp, Download, FilePlus2, FileStack, FileText, FolderOpen, ImagePlus, LayoutGrid, LoaderCircle, LockKeyhole, LogOut, Maximize2, Pencil, Plus, ScanLine, Search, ShieldCheck, Smartphone, Trash2, Upload, X } from 'lucide-react';
import { api, dateLabel, imageUrl } from './api';
import type { ScanDocument, ScanPage } from './api';
import { AuthScreen } from './components/AuthScreen';
import { MobileCapture } from './components/MobileCapture';
import { PairDialog } from './components/PairDialog';
import { ScanEditor } from './components/ScanEditor';
import { useModalFocus } from './lib/useModalFocus';

export default function App() {
  const match = window.location.pathname.match(/^\/capture\/([^/]+)\/?$/);
  return match ? <MobileCapture token={match[1]} /> : <Desktop />;
}

function Desktop() {
  const [auth, setAuth] = useState<{ configured: boolean; authenticated: boolean } | null>(null);
  const [authError, setAuthError] = useState('');
  const [documents, setDocuments] = useState<ScanDocument[]>([]);
  const [document, setDocument] = useState<ScanDocument | null>(null);
  const [pageId, setPageId] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'recent'>('all');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [pairOpen, setPairOpen] = useState(false);
  const [editorPage, setEditorPage] = useState<ScanPage | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [paper, setPaper] = useState('a4');
  const [deletion, setDeletion] = useState<{ type: 'page' | 'document'; page?: ScanPage } | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const selectedId = useRef<string | null>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const modalKey = createOpen ? 'create' : pairOpen ? 'pair' : helpOpen ? 'help' : exportOpen ? 'export' : deletion ? 'delete' : '';
  useModalFocus(modalKey);
  const page = document?.pages.find((item) => item.id === pageId) || document?.pages[0];
  const pageIndex = document?.pages.findIndex((item) => item.id === page?.id) ?? -1;

  const refreshAuth = useCallback(async () => {
    try { setAuth(await api('/api/auth')); setAuthError(''); }
    catch (err) { setAuthError((err as Error).message); }
  }, []);
  useEffect(() => {
    void refreshAuth();
    const unauthorized = () => { setAuth({ configured: true, authenticated: false }); };
    window.addEventListener('myscan:unauthorized', unauthorized);
    return () => window.removeEventListener('myscan:unauthorized', unauthorized);
  }, [refreshAuth]);

  const refresh = useCallback(async () => {
    const result = await api<{ documents: ScanDocument[] }>('/api/documents');
    setDocuments(result.documents);
    const current = selectedId.current;
    if (current) {
      const latest = result.documents.find((item) => item.id === current);
      if (latest) setDocument(latest);
      else { setDocument(null); selectedId.current = null; }
    }
  }, []);

  useEffect(() => {
    if (!auth?.authenticated) return;
    void refresh().catch((err: Error) => setError(err.message));
    const events = new EventSource('/api/events');
    let timer: number;
    events.onmessage = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void refresh().catch((err: Error) => setError(err.message)), 100); };
    events.onerror = () => { /* EventSource reconnects; foreground refresh handles missed updates. */ };
    const foreground = () => { if (window.document.visibilityState === 'visible') void refresh().catch((err: Error) => setError(err.message)); };
    window.document.addEventListener('visibilitychange', foreground);
    return () => { events.close(); window.clearTimeout(timer); window.document.removeEventListener('visibilitychange', foreground); };
  }, [auth?.authenticated, refresh]);

  useEffect(() => {
    if (!document?.pages.some((item) => item.id === pageId)) setPageId(document?.pages[0]?.id || '');
  }, [document, pageId]);
  useEffect(() => { if (!toast) return; const timer = window.setTimeout(() => setToast(''), 3500); return () => window.clearTimeout(timer); }, [toast]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busy || editorPage) return;
      setCreateOpen(false); setPairOpen(false); setHelpOpen(false); setExportOpen(false); setDeletion(null); setZoom(false);
    };
    window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape);
  }, [busy, editorPage]);

  function selectDoc(item: ScanDocument) {
    selectedId.current = item.id; setDocument(item); setPageId(item.pages[0]?.id || ''); setShowOriginal(false); setZoom(false); setError(''); setRenaming(false);
  }
  const home = () => { selectedId.current = null; setDocument(null); setError(''); setRenaming(false); };
  const updateDocument = (item: ScanDocument) => {
    if (selectedId.current === item.id) setDocument(item);
    setDocuments((items) => [item, ...items.filter((previous) => previous.id !== item.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  };
  const perform = async (label: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError('');
    try { await action(); } catch (err) { setError((err as Error).message); }
    finally { setBusy(''); }
  };
  const upload = async (files: FileList | File[]) => {
    if (!document || !files.length) return;
    const docId = document.id;
    if (files.length > 20) { setError('Mỗi lần thêm tối đa 20 ảnh.'); return; }
    await perform('Đang thêm ảnh…', async () => {
      const form = new FormData(); Array.from(files).forEach((file) => form.append('images', file));
      const updated = await api<ScanDocument>(`/api/documents/${docId}/pages`, { method: 'POST', body: form });
      const previous = document.pages.length; updateDocument(updated); setPageId(updated.pages[previous]?.id || ''); setToast(`Đã thêm ${updated.pages.length - previous} trang`);
    });
  };
  const reorder = async (from: number, to: number) => {
    if (!document || to < 0 || to >= document.pages.length || from === to) return;
    const order = document.pages.map((item) => item.id); order.splice(to, 0, order.splice(from, 1)[0]);
    await perform('Đang sắp xếp…', async () => updateDocument(await api<ScanDocument>(`/api/documents/${document.id}`, { method: 'PATCH', body: JSON.stringify({ pageOrder: order }) })));
  };
  const rename = async () => {
    if (!document || !renaming) return;
    const title = titleDraft.trim(); setRenaming(false);
    if (!title || title === document.title) return;
    await perform('Đang lưu tên…', async () => updateDocument(await api<ScanDocument>(`/api/documents/${document.id}`, { method: 'PATCH', body: JSON.stringify({ title }) })));
  };
  const exportPdf = async () => {
    if (!document) return;
    await perform('Đang ghép PDF…', async () => {
      const response = await fetch(`/api/documents/${document.id}/pdf?paper=${paper}`);
      if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Không xuất được PDF.'); }
      const blob = await response.blob(); const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a'); anchor.href = url; anchor.download = `${document.title.replace(/[<>:"/\\|?*]/g, '_')}.pdf`; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 10000); setExportOpen(false); setToast(`Đã xuất PDF gồm ${document.pages.length} trang`);
    });
  };

  if (!auth) return <div className="loading-screen"><span className="brand"><ScanLine />myscan.</span>{authError ? <><p className="error-message">{authError}</p><button className="button secondary" onClick={() => void refreshAuth()}>Kết nối lại</button></> : <><LoaderCircle className="spin" /><p>Đang mở thư viện…</p></>}</div>;
  if (!auth.authenticated) return <AuthScreen configured={auth.configured} onLogin={() => void refreshAuth()} />;
  const totalPages = documents.reduce((sum, item) => sum + item.pages.length, 0);
  const recentDocs = documents.filter((item) => new Date(item.updatedAt).getTime() >= Date.now() - 7 * 86400000);
  const filtered = (tab === 'recent' ? recentDocs : documents).filter((item) => item.title.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')));

  return <div className="app-shell">
    <aside className="sidebar" inert={!!modalKey || !!editorPage || undefined}>
      <button className="brand brand-button" onClick={home}><span className="brand-icon"><ScanLine size={25} /></span>myscan<span className="brand-period">.</span></button>
      <button className="button primary sidebar-create" onClick={() => { setNewTitle(''); setCreateOpen(true); }}><Plus size={18} /> Tài liệu mới</button>
      <div className="nav-label">KHÔNG GIAN CỦA BẠN</div>
      <nav aria-label="Điều hướng"><button className={`nav-item ${!document && tab === 'all' ? 'active' : ''}`} onClick={() => { home(); setTab('all'); }}><LayoutGrid size={18} /> Thư viện <span>{documents.length}</span></button><button className={`nav-item ${!document && tab === 'recent' ? 'active' : ''}`} onClick={() => { home(); setTab('recent'); }}><FolderOpen size={18} /> Gần đây <span>{recentDocs.length}</span></button></nav>
      <div className="nav-label doc-nav-label">TÀI LIỆU GẦN NHẤT</div>
      <div className="recent-list">{documents.slice(0, 5).map((item) => <button key={item.id} className={`recent-item ${document?.id === item.id ? 'selected' : ''}`} onClick={() => selectDoc(item)}><FileText size={17} /><span>{item.title}</span></button>)}{!documents.length && <p className="sidebar-empty">Các bản scan sẽ xuất hiện ở đây.</p>}</div>
      <div className="sidebar-bottom"><div className="local-note"><ShieldCheck size={20} /><div><strong>Lưu trên máy chủ của bạn</strong><span>Ảnh gốc luôn được giữ lại</span></div></div><button className="nav-item" onClick={() => setHelpOpen(true)}><CircleHelp size={18} /> Cách sử dụng</button><button className="nav-item" onClick={() => void perform('Đang khóa thư viện…', async () => { await api('/api/auth/logout', { method: 'POST' }); setAuth({ configured: true, authenticated: false }); home(); })}><LogOut size={17} /> Khóa thư viện</button></div>
    </aside>
    <div className="main-shell" inert={!!modalKey || !!editorPage || undefined}>
      <header className="topbar"><div className="breadcrumb"><span>Không gian làm việc</span><ChevronRight size={14} /><strong>{document ? 'Chỉnh sửa tài liệu' : 'Thư viện tài liệu'}</strong></div><div className="topbar-right"><span className="private-badge"><LockKeyhole size={13} /> Thư viện riêng</span><div className="avatar">M</div></div></header>
      {error && <div className="global-error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="Đóng thông báo lỗi"><X size={16} /></button></div>}
      <input type="file" ref={uploadInput} className="sr-only" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => { if (e.target.files) void upload(e.target.files); e.target.value = ''; }} aria-label="Chọn ảnh để thêm vào tài liệu" />
      {!document ? <main className="library-main">
        <div className="page-heading"><div><div className="eyebrow">SẮP XẾP GỌN. CHIA SẺ DỄ.</div><h1>{tab === 'recent' ? 'Tài liệu gần đây' : 'Thư viện của bạn'}<span className="heading-dot">.</span></h1><p className="muted">Một nơi cho những trang giấy quan trọng.</p></div><button className="button secondary desktop-new" onClick={() => { setNewTitle(''); setCreateOpen(true); }}><FilePlus2 size={17} /> Tạo tài liệu</button></div>
        <section className="scan-hero"><div className="hero-content"><span className="hero-tag"><span /> TỪ ĐIỆN THOẠI ĐẾN TÀI LIỆU</span><h2>Biến trang giấy thành<br />bản scan <em>thật đẹp.</em></h2><p>Chụp trên điện thoại, hoàn thiện trên máy tính.<br />Mọi thứ kết nối chỉ bằng một mã QR.</p><button className="button hero-button" onClick={() => { setNewTitle(''); setCreateOpen(true); }}><ScanLine size={19} /> Bắt đầu quét <ArrowRight size={17} /></button></div><div className="hero-art" aria-hidden="true"><div className="hero-grid" /><div className="hero-paper"><div className="mini-label">TÀI LIỆU CỦA BẠN</div><div className="paper-line wide" /><div className="paper-line" /><div className="paper-line short" /><div className="hero-photo"><div /><span /></div><div className="paper-line" /><div className="paper-line" /><span className="hero-paper-page">01 / 03</span></div><div className="hero-scan-frame"><i /><i /><i /><i /></div><div className="hero-phone"><Smartphone size={19} /><div><strong>Điện thoại đã kết nối</strong><span>Chụp. Chỉnh. Hoàn thiện.</span></div><span className="status-dot" /></div><span className="hero-art-caption">MỘT QUY TRÌNH, MỌI TRANG GIẤY.</span></div></section>
        <div className="library-summary"><span><strong>{documents.length}</strong> tài liệu</span><span><strong>{totalPages}</strong> trang đã lưu</span><span className="summary-last"><ShieldCheck size={15} /> Giữ cả ảnh gốc và bản chỉnh</span></div>
        <div className="library-toolbar"><div className="library-tabs"><button className={tab === 'all' ? 'selected' : ''} onClick={() => setTab('all')}>Tất cả tài liệu <span>{documents.length}</span></button><button className={tab === 'recent' ? 'selected' : ''} onClick={() => setTab('recent')}>7 ngày gần đây</button></div><label className="search-field"><Search size={17} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm tài liệu…" aria-label="Tìm tài liệu" />{query && <button className="icon-button" onClick={() => setQuery('')} aria-label="Xóa tìm kiếm"><X size={14} /></button>}</label></div>
        {filtered.length ? <div className="document-grid">{filtered.map((item) => <button key={item.id} className="document-card" onClick={() => selectDoc(item)}><div className="document-cover">{item.pages[0] ? <img src={imageUrl(item.pages[0], item)} alt="" loading="lazy" /> : <div className="empty-cover"><FileText size={36} strokeWidth={1.3} /><span>Chưa có trang</span></div>}<span className="page-count"><FileStack size={12} /> {item.pages.length} trang</span><span className="card-open"><ArrowRight size={18} /></span></div><div className="document-card-meta"><h3>{item.title}</h3><p>Cập nhật {dateLabel(item.updatedAt)}</p></div></button>)}<button className="new-document-card" onClick={() => { setNewTitle(''); setCreateOpen(true); }}><span><Plus size={23} /></span><strong>Tạo tài liệu mới</strong><p>Bắt đầu từ một trang giấy</p></button></div> : <div className="library-empty"><div className="empty-icon"><FolderOpen size={28} strokeWidth={1.5} /></div><h3>{query ? 'Chưa tìm thấy tài liệu' : tab === 'recent' && documents.length ? 'Chưa có bản scan mới trong 7 ngày' : 'Thư viện đang chờ trang đầu tiên'}</h3><p>{query ? 'Thử một tên khác hoặc xóa từ khóa tìm kiếm.' : 'Tạo tài liệu mới rồi kết nối điện thoại hoặc thêm ảnh có sẵn.'}</p>{!query && <button className="text-button" onClick={() => { setNewTitle(''); setCreateOpen(true); }}>Tạo tài liệu đầu tiên <ArrowRight size={16} /></button>}</div>}
        <footer className="library-footer"><span>myscan · Những trang giấy, một không gian.</span><button onClick={() => setHelpOpen(true)}>Xem quy trình quét <ArrowRight size={14} /></button></footer>
      </main> : <main className={`workspace-main ${dropActive ? 'file-over' : ''}`} onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropActive(true); } }} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropActive(false); }} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setDropActive(false); void upload(e.dataTransfer.files); } }}>
        {dropActive && <div className="file-drop-overlay"><Upload size={38} /><h2>Thả ảnh để thêm trang</h2></div>}
        <div className="document-heading"><div className="document-title-area"><button className="icon-button back-button" onClick={home} aria-label="Trở về thư viện"><ArrowLeft size={20} /></button><div>{renaming ? <input className="title-input" autoFocus maxLength={120} value={titleDraft} onChange={(e) => setTitleDraft(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') setRenaming(false); }} aria-label="Tên tài liệu" /> : <button className="document-title-button" onClick={() => { setTitleDraft(document.title); setRenaming(true); }} title="Đổi tên tài liệu"><h1>{document.title}</h1><Pencil size={15} /></button>}<p className="document-subtitle"><span className="status-dot" /> Đã lưu · {document.pages.length} trang <span className="subtitle-separator">/</span> {dateLabel(document.updatedAt)}</p></div></div><div className="document-heading-actions"><button className="icon-button delete-document" onClick={() => setDeletion({ type: 'document' })} disabled={!!busy} aria-label="Xóa tài liệu"><Trash2 size={17} /></button><button className="button secondary" onClick={() => setPairOpen(true)}><Smartphone size={17} /> Kết nối điện thoại</button><button className="button primary" onClick={() => setExportOpen(true)} disabled={!document.pages.length || !!busy}><Download size={17} /> Xuất PDF</button></div></div>
        <div className="workflow-strip"><span className={document.pages.length ? 'done' : 'current'}><span className="workflow-number">{document.pages.length ? <Check size={12} /> : '1'}</span> Quét & thêm ảnh</span><div /><span className={document.pages.length ? 'current' : ''}><span className="workflow-number">2</span> Chỉnh từng trang</span><div /><span><span className="workflow-number">3</span> Ghép & xuất PDF</span><span className="workflow-note">Ảnh gốc được giữ riêng</span></div>
        {!document.pages.length ? <div className="document-empty"><div className="empty-scan-art"><ScanLine size={78} strokeWidth={1} /><span><Plus size={19} /></span></div><span className="eyebrow">TÀI LIỆU MỚI, TRANG ĐẦU TIÊN</span><h2>Thêm chút giấy.<br />Tạo nên điều gọn gàng.</h2><p>Dùng điện thoại để chụp hoặc chọn ảnh trên máy tính.<br />Bạn có thể thêm nhiều trang vào cùng một tài liệu.</p><div className="empty-options"><button className="import-option" onClick={() => setPairOpen(true)}><span className="option-icon"><Smartphone size={24} /></span><strong>Quét bằng điện thoại</strong><p>Kết nối qua mã QR, chụp và gửi ngay</p><span className="option-link">Kết nối điện thoại <ArrowRight size={16} /></span></button><button className="import-option" onClick={() => uploadInput.current?.click()} disabled={!!busy}><span className="option-icon warm"><ImagePlus size={24} /></span><strong>Thêm ảnh có sẵn</strong><p>JPG, PNG hoặc WebP · tối đa 20 ảnh/lần</p><span className="option-link">Chọn ảnh từ máy <ArrowRight size={16} /></span></button></div><p className="drop-hint"><Upload size={14} /> Bạn cũng có thể kéo và thả ảnh vào đây.</p></div> : <div className="scan-workspace"><aside className="pages-panel"><div className="pages-panel-heading"><strong>Các trang <span>{document.pages.length}</span></strong><button className="icon-button" onClick={() => uploadInput.current?.click()} disabled={!!busy} aria-label="Thêm ảnh"><Plus size={18} /></button></div><p className="pages-tip">Kéo để đổi thứ tự trang</p><div className="page-list">{document.pages.map((item, index) => <div key={item.id} className={`page-thumbnail ${item.id === page?.id ? 'selected' : ''}`} draggable={!busy} onDragStart={(e) => { e.dataTransfer.setData('text/myscan-page', String(index)); e.dataTransfer.effectAllowed = 'move'; }} onDragOver={(e) => { if (e.dataTransfer.types.includes('text/myscan-page')) e.preventDefault(); }} onDrop={(e) => { const from = e.dataTransfer.getData('text/myscan-page'); if (from) { e.preventDefault(); void reorder(Number(from), index); } }}><button className="thumbnail-button" onClick={() => { setPageId(item.id); setShowOriginal(false); setZoom(false); }} aria-label={`Chọn trang ${index + 1}`} aria-pressed={item.id === page?.id}><img src={imageUrl(item, document)} alt={`Bản scan trang ${index + 1}`} /><span>{String(index + 1).padStart(2, '0')}</span></button><div className="thumbnail-controls"><span>Trang {index + 1}</span><button className="icon-button" onClick={() => void reorder(index, index - 1)} aria-label={`Đưa trang ${index + 1} lên`} disabled={index === 0 || !!busy}><ArrowUp size={13} /></button><button className="icon-button" onClick={() => void reorder(index, index + 1)} aria-label={`Đưa trang ${index + 1} xuống`} disabled={index === document.pages.length - 1 || !!busy}><ArrowDown size={13} /></button></div></div>)}</div><button className="add-page-button" onClick={() => uploadInput.current?.click()} disabled={!!busy}><Plus size={16} /> Thêm trang</button></aside><section className="preview-panel"><div className="preview-toolbar"><div className="preview-tabs"><button className={!showOriginal ? 'active' : ''} onClick={() => setShowOriginal(false)}>Bản scan</button><button className={showOriginal ? 'active' : ''} onClick={() => setShowOriginal(true)}>Ảnh gốc</button></div><div className="preview-tools"><span>{page?.width} × {page?.height} px</span><button className={`icon-button ${zoom ? 'active' : ''}`} onClick={() => setZoom(!zoom)} aria-label={zoom ? 'Vừa khung' : 'Phóng to'}><Maximize2 size={17} /></button><button className="icon-button danger" onClick={() => setDeletion({ type: 'page', page })} aria-label="Xóa trang đang xem" disabled={!!busy}><Trash2 size={17} /></button><button className="button small primary" onClick={() => setEditorPage(page || null)} disabled={!!busy}><Pencil size={15} /> Chỉnh sửa</button></div></div><div className={`scan-stage ${zoom ? 'zoomed' : ''}`}>{page && <img className="scan-sheet" src={imageUrl(page, document, showOriginal)} alt={showOriginal ? `Ảnh gốc trang ${pageIndex + 1}` : `Bản scan trang ${pageIndex + 1}`} />}</div><div className="preview-bottom"><span><ShieldCheck size={14} /> {showOriginal ? 'Ảnh gốc được giữ nguyên' : 'Sẵn sàng chỉnh sửa và ghép PDF'}</span><div className="page-navigation"><button className="icon-button" onClick={() => { setPageId(document.pages[pageIndex - 1].id); setZoom(false); }} disabled={pageIndex <= 0} aria-label="Trang trước"><ChevronLeft size={18} /></button><span>Trang <strong>{pageIndex + 1}</strong> / {document.pages.length}</span><button className="icon-button" onClick={() => { setPageId(document.pages[pageIndex + 1].id); setZoom(false); }} disabled={pageIndex >= document.pages.length - 1} aria-label="Trang sau"><ChevronRight size={18} /></button></div></div></section></div>}
      </main>}
    </div>
    {busy && <div className="busy-indicator" role="status"><LoaderCircle className="spin" size={17} />{busy}</div>}
    {toast && <div className="toast" role="status"><span><Check size={14} /></span>{toast}</div>}
    {createOpen && <div className="modal-backdrop"><section className="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="create-title"><button className="icon-button modal-close" onClick={() => setCreateOpen(false)} aria-label="Đóng" disabled={!!busy}><X size={19} /></button><div className="modal-symbol"><FilePlus2 size={25} /></div><h2 id="create-title">Một tài liệu mới.</h2><p className="muted">Đặt tên để dễ tìm lại những trang giấy của bạn.</p><form onSubmit={(e) => { e.preventDefault(); void perform('Đang tạo tài liệu…', async () => { const item = await api<ScanDocument>('/api/documents', { method: 'POST', body: JSON.stringify({ title: newTitle.trim() }) }); updateDocument(item); selectDoc(item); setCreateOpen(false); }); }}><label className="field-label" htmlFor="new-title">Tên tài liệu</label><input id="new-title" className="text-input" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required maxLength={120} placeholder="Ví dụ: Hồ sơ học tập · Tháng 10" autoFocus />{error && <p className="error-message" role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="button secondary" onClick={() => setCreateOpen(false)} disabled={!!busy}>Để sau</button><button className="button primary" disabled={!!busy || !newTitle.trim()}>Tạo tài liệu <ArrowRight size={16} /></button></div></form></section></div>}
    {pairOpen && document && <PairDialog document={document} onClose={() => setPairOpen(false)} />}
    {editorPage && document && <ScanEditor page={{ ...editorPage, originalUrl: imageUrl(editorPage, document, true) }} onClose={() => setEditorPage(null)} onSave={async (blob, edit) => { const form = new FormData(); form.append('image', blob, 'scan.jpg'); form.append('edit', JSON.stringify(edit)); updateDocument(await api<ScanDocument>(`/api/documents/${document.id}/pages/${editorPage.id}/image`, { method: 'PUT', body: form })); setToast('Đã lưu bản scan · ảnh gốc vẫn được giữ lại'); }} />}
    {exportOpen && document && <div className="modal-backdrop"><section className="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="export-title"><button className="icon-button modal-close" onClick={() => setExportOpen(false)} aria-label="Đóng" disabled={!!busy}><X size={19} /></button><div className="modal-symbol"><Download size={24} /></div><h2 id="export-title">Hoàn thiện tài liệu.</h2><p className="muted">Ghép {document.pages.length} trang theo thứ tự hiện tại thành một tệp PDF.</p><label htmlFor="paper-size" className="field-label">Khổ trang PDF</label><select id="paper-size" className="text-input" value={paper} onChange={(e) => setPaper(e.target.value)}><option value="a4">A4 · phù hợp xem và in tài liệu</option><option value="original">Theo tỷ lệ ảnh · giữ trọn trang scan</option></select><div className="export-summary"><FileStack size={22} /><div><strong>{document.title}.pdf</strong><span>{document.pages.length} trang · bản ảnh đã chỉnh sửa</span></div><Check size={18} /></div>{error && <p className="error-message" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" onClick={() => setExportOpen(false)} disabled={!!busy}>Quay lại</button><button className="button primary" onClick={() => void exportPdf()} disabled={!!busy}><Download size={17} /> Tải PDF</button></div></section></div>}
    {deletion && document && <div className="modal-backdrop"><section className="modal compact-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title"><div className="modal-symbol danger"><Trash2 size={24} /></div><h2 id="delete-title">{deletion.type === 'document' ? 'Xóa tài liệu này?' : 'Xóa trang này?'}</h2><p className="muted">{deletion.type === 'document' ? `“${document.title}” và ${document.pages.length} trang sẽ được xóa khỏi máy chủ.` : 'Ảnh gốc và bản đã chỉnh của trang này sẽ được xóa.'}</p><p className="small-note">Thao tác này không thể hoàn tác.</p>{error && <p className="error-message" role="alert">{error}</p>}<div className="modal-actions"><button className="button secondary" onClick={() => setDeletion(null)} disabled={!!busy}>Giữ lại</button><button className="button danger-button" disabled={!!busy} onClick={() => void perform('Đang xóa…', async () => { if (deletion.type === 'document') { await api(`/api/documents/${document.id}`, { method: 'DELETE' }); setDocuments((items) => items.filter((item) => item.id !== document.id)); home(); } else { updateDocument(await api<ScanDocument>(`/api/documents/${document.id}/pages/${deletion.page!.id}`, { method: 'DELETE' })); } setDeletion(null); setToast('Đã xóa'); })}><Trash2 size={16} />{deletion.type === 'document' ? 'Xóa tài liệu' : 'Xóa trang'}</button></div></section></div>}
    {helpOpen && <div className="modal-backdrop"><section className="modal help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title"><button className="icon-button modal-close" onClick={() => setHelpOpen(false)} aria-label="Đóng"><X size={20} /></button><div className="eyebrow">BA BƯỚC, MỘT TÀI LIỆU</div><h2 id="help-title">Quét thật đơn giản.</h2><div className="help-step"><span>01</span><div><h3>Kết nối & chụp</h3><p>Tạo tài liệu, chọn “Kết nối điện thoại” và quét mã QR. Chụp rõ cả bốn góc tờ giấy; ảnh sẽ xuất hiện trên máy tính.</p></div><Smartphone size={25} /></div><div className="help-step"><span>02</span><div><h3>Chỉnh cho thật rõ</h3><p>Chọn trang và “Chỉnh sửa”. Kéo bốn góc theo mép giấy, xoay, chỉnh sáng hoặc chuyển đen trắng rồi lưu.</p></div><Pencil size={24} /></div><div className="help-step"><span>03</span><div><h3>Ghép & chia sẻ</h3><p>Kéo các trang để đổi thứ tự, đặt tên tài liệu và chọn “Xuất PDF”. Ảnh gốc luôn có trong thẻ “Ảnh gốc”.</p></div><FileStack size={25} /></div><p className="small-note">Điện thoại và máy tính cần truy cập cùng máy chủ myscan. Trong LAN, dùng cùng Wi-Fi và cho phép cổng 3000 qua tường lửa mạng riêng. Trên cloud, dùng địa chỉ HTTPS có thể truy cập từ điện thoại.</p><button className="button primary" onClick={() => setHelpOpen(false)}>Bắt đầu thôi <ArrowRight size={17} /></button></section></div>}
  </div>;
}
