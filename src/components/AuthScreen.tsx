import { useState } from 'react';
import { ArrowRight, FileStack, LoaderCircle, LockKeyhole, ScanLine, Smartphone } from 'lucide-react';
import { api } from '../api';

export function AuthScreen({ configured, onLogin }: { configured: boolean; onLogin(): void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <main className="auth-layout">
    <div className="auth-story">
      <a className="brand" href="/"><span className="brand-icon"><ScanLine size={26} /></span>myscan<span className="brand-period">.</span></a>
      <div className="auth-story-body"><span className="eyebrow">TÀI LIỆU TRONG TẦM TAY</span><h1>Từ một lần chụp.<br />Đến một tài liệu<br /><em>chỉn chu.</em></h1><p>Điện thoại để quét. Máy tính để hoàn thiện.<br />Mọi trang giấy, gọn trong một nơi.</p>
        <div className="auth-papers" aria-hidden="true"><div className="auth-paper back" /><div className="auth-paper front"><span className="paper-brand">myscan.</span><div className="paper-line wide" /><div className="paper-line" /><div className="paper-line short" /><div className="paper-block" /><div className="paper-line" /><div className="paper-line" /><span className="paper-stamp"><ScanLine size={25} /> SẴN SÀNG ĐỂ CHIA SẺ</span></div><div className="auth-badge"><CheckMark /> Mỗi trang đều rõ ràng</div></div>
      </div><span className="auth-foot">QUÉT TÀI LIỆU THEO CÁCH CỦA BẠN</span>
    </div>
    <section className="auth-panel">
      <div className="auth-form-wrap"><div className="modal-symbol"><LockKeyhole size={25} /></div><h2>{configured ? 'Chào bạn trở lại.' : 'Bắt đầu với myscan.'}</h2><p className="muted">{configured ? 'Nhập mật khẩu để mở thư viện tài liệu của bạn.' : 'Đặt mật khẩu để bảo vệ thư viện trên máy tính và mạng LAN.'}</p>
        <form onSubmit={async (e) => {
          e.preventDefault(); setError('');
          if (!configured && password !== confirmation) { setError('Hai mật khẩu chưa trùng nhau.'); return; }
          setBusy(true);
          try { await api(`/api/auth/${configured ? 'login' : 'setup'}`, { method: 'POST', body: JSON.stringify({ password }) }); setPassword(''); setConfirmation(''); onLogin(); }
          catch (err) { setError((err as Error).message); } finally { setBusy(false); }
        }}>
          <label htmlFor="password" className="field-label">Mật khẩu quản lý</label><input id="password" className="text-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={configured ? 'current-password' : 'new-password'} minLength={configured ? 1 : 8} maxLength={256} required autoFocus placeholder={configured ? 'Nhập mật khẩu của bạn' : 'Ít nhất 8 ký tự'} />
          {!configured && <><label htmlFor="password-confirm" className="field-label">Nhập lại mật khẩu</label><input id="password-confirm" className="text-input" type="password" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} autoComplete="new-password" required maxLength={256} placeholder="Xác nhận mật khẩu" /></>}
          {error && <div className="error-message" role="alert">{error}</div>}
          <button className="button primary auth-submit" disabled={busy}>{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowRight size={18} />}{configured ? 'Mở thư viện' : 'Tạo thư viện của tôi'}</button>
        </form>
        <div className="auth-features"><span><Smartphone size={17} /> Kết nối qua QR</span><span><FileStack size={17} /> Ghép nhiều trang PDF</span></div><p className="small-note">Ảnh gốc và tài liệu được lưu trên máy chủ chạy myscan. Điện thoại chỉ cần trình duyệt.</p>
      </div>
    </section>
  </main>;
}

function CheckMark() { return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>; }
