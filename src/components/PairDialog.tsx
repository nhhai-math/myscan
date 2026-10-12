import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Link, LoaderCircle, Smartphone, X } from 'lucide-react';
import { api } from '../api';
import type { PairSession, ScanDocument } from '../api';

interface Connection { origins: string[]; publicUrl?: string | null; host: string; port: number }

export function PairDialog({ document, onClose }: { document: ScanDocument; onClose(): void }) {
  const [session, setSession] = useState<PairSession | null>(null);
  const [origins, setOrigins] = useState<string[]>([]);
  const [origin, setOrigin] = useState('');
  const [qr, setQr] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<PairSession>(`/api/documents/${document.id}/pair`, { method: 'POST' }),
      api<Connection>('/api/connection'),
    ]).then(([pair, connection]) => {
      if (!alive) {
        void api(`/api/documents/${document.id}/pair/${pair.token}`, { method: 'DELETE' }).catch(() => {});
        return;
      }
      const current = window.location.origin;
      const currentIsLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
      const options = Array.from(new Set([
        ...(connection.publicUrl ? [connection.publicUrl] : []),
        ...(!currentIsLocal ? [current] : []),
        ...connection.origins,
      ]));
      setSession(pair); setOrigins(options); setOrigin(options[0] || '');
    }).catch((err: Error) => { if (alive) setError(err.message); });
    return () => { alive = false; };
  }, [document.id]);

  let link = '';
  try {
    const address = new URL(origin);
    if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error();
    if (session) link = new URL(session.path, address.origin).href;
  } catch { /* Editable address can temporarily be incomplete. */ }

  useEffect(() => {
    let alive = true;
    setQr('');
    if (link) QRCode.toDataURL(link, { width: 288, margin: 2, color: { dark: '#103a32', light: '#ffffff' } })
      .then((data) => { if (alive) setQr(data); }).catch(() => { if (alive) setError('Không tạo được mã QR. Bạn có thể sao chép liên kết.'); });
    return () => { alive = false; };
  }, [link]);

  useEffect(() => {
    if (!session) return;
    const tick = async () => {
      if (new Date(session.expiresAt).getTime() <= Date.now()) { setExpired(true); return; }
      try { setSession(await api<PairSession>(`/api/documents/${document.id}/pair/${session.token}`)); }
      catch (err) { setError((err as Error).message); }
    };
    const timer = window.setInterval(() => { void tick(); }, 2000);
    return () => window.clearInterval(timer);
  }, [document.id, session?.token, session?.expiresAt]);

  const finish = async () => {
    setClosing(true);
    try { if (session) await api(`/api/documents/${document.id}/pair/${session.token}`, { method: 'DELETE' }); onClose(); }
    catch (err) { setError((err as Error).message); setClosing(false); }
  };

  const copy = async () => {
    try { await navigator.clipboard.writeText(link); setCopied(true); window.setTimeout(() => setCopied(false), 2200); }
    catch { setError('Hãy chọn và sao chép liên kết ở ô bên dưới.'); }
  };

  return <div className="modal-backdrop" role="presentation">
    <section className="modal pair-modal" role="dialog" aria-modal="true" aria-labelledby="pair-title">
      <button className="icon-button modal-close" onClick={onClose} aria-label="Thu nhỏ kết nối"><X size={20} /></button>
      <div className="modal-symbol"><Smartphone size={25} /></div>
      <div className="eyebrow">MÁY TÍNH + ĐIỆN THOẠI</div>
      <h2 id="pair-title">Đưa máy quét vào túi bạn.</h2>
      <p className="muted">Quét mã QR bằng điện thoại để thêm ảnh vào <strong>{document.title}</strong>.</p>
      <div className="pair-qr">
        {expired ? <p>Phiên kết nối đã hết hạn.<br />Đóng và tạo mã QR mới.</p> : qr ? <img src={qr} alt="Mã QR kết nối điện thoại với tài liệu" /> : <LoaderCircle className="spin" size={30} />}
      </div>
      <div className={`connection-status ${session?.openedAt ? 'connected' : ''}`}>
        <span className="status-dot" />{expired ? 'Phiên đã hết hạn' : session?.lastUploadAt ? `Đã nhận ${session.uploadedCount || 0} trang từ điện thoại` : session?.openedAt ? 'Điện thoại đã kết nối · sẵn sàng chụp' : 'Đang chờ điện thoại kết nối'}
      </div>
      <label className="field-label" htmlFor="connection-address">Địa chỉ máy tính hoặc máy chủ</label>
      {origins.length > 1 && <select className="text-input origin-select" value={origins.includes(origin) ? origin : ''} onChange={(e) => { if (e.target.value) setOrigin(e.target.value); }} aria-label="Chọn địa chỉ mạng">
        <option value="" disabled>Địa chỉ tùy chỉnh</option>{origins.map((value) => <option key={value}>{value}</option>)}
      </select>}
      <input id="connection-address" className="text-input" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="http://192.168.1.10:3000 hoặc https://…" autoComplete="off" />
      <div className="link-field"><Link size={15} /><input aria-label="Liên kết quét trên điện thoại" readOnly value={link} /><button className="icon-button" onClick={copy} disabled={!link} aria-label="Sao chép liên kết">{copied ? <Check size={17} /> : <Copy size={17} />}</button></div>
      <p className="small-note">Trong LAN, điện thoại và máy tính cần dùng cùng Wi-Fi. Nếu chạy trên cloud, nhập địa chỉ HTTPS mà điện thoại truy cập được. Mã QR có hiệu lực 2 giờ.</p>
      {error && <div className="error-message" role="alert">{error}</div>}
      <div className="modal-actions"><button className="button secondary" onClick={finish} disabled={closing}>{closing && <LoaderCircle size={16} className="spin" />}Dừng kết nối</button><button className="button primary" onClick={onClose}>Tiếp tục chỉnh tài liệu</button></div>
    </section>
  </div>;
}
