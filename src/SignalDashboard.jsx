import { useState } from "react";
import { Activity, Users, Radio, CheckCircle, XCircle, Copy, Trash2, Zap } from "lucide-react";

const COLORS = {
  bg: "#0A0C10",
  panel: "#12151B",
  panel2: "#161A21",
  border: "#1E232B",
  text: "#E7E9ED",
  dim: "#6B7280",
  muted: "#8B92A0",
  green: "#22C55E",
  red: "#F0506E",
  amber: "#F2A93B",
  blue: "#60A5FA",
};

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

function fmt(v) {
  const abs = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${v >= 0 ? '+' : '-'}$${abs}`;
}

const MOCK_SIGNALS = [
  { id: 1, time: '10:32:14', symbol: 'SPY', side: 'buy',  qty: 2,   price: 542.10, delivered: 1, total: 1 },
  { id: 2, time: '11:05:47', symbol: 'AAPL', side: 'sell', qty: 10,  price: 213.40, delivered: 1, total: 1 },
  { id: 3, time: '13:21:03', symbol: 'QQQ', side: 'buy',  qty: 5,   price: 471.80, delivered: 1, total: 1 },
];

const MOCK_SUBSCRIBERS = [
  { id: 1, name: 'My Schwab (Roth)', broker: 'Schwab', status: 'active',  addedDate: '2026-06-15', tradesReceived: 12 },
];

export default function SignalDashboard() {
  const [serverUrl, setServerUrl]       = useState('http://localhost:3001');
  const [serverOnline]                  = useState(false);
  const [signals]                       = useState(MOCK_SIGNALS);
  const [subscribers, setSubscribers]   = useState(MOCK_SUBSCRIBERS);
  const [showAddSub, setShowAddSub]     = useState(false);
  const [showSetup, setShowSetup]       = useState(false);
  const [newSubName, setNewSubName]     = useState('');
  const [copied, setCopied]             = useState(false);

  const inviteLink = `${serverUrl}/connect?ref=owner`;

  const copyInvite = () => {
    navigator.clipboard.writeText(inviteLink).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const removeSubscriber = (id) => {
    if (!window.confirm('Remove this subscriber?')) return;
    setSubscribers(s => s.filter(sub => sub.id !== id));
  };

  const addSubscriber = () => {
    if (!newSubName.trim()) return;
    setSubscribers(s => [...s, {
      id: Date.now(), name: newSubName.trim(), broker: 'Schwab',
      status: 'pending', addedDate: new Date().toISOString().slice(0, 10), tradesReceived: 0,
    }]);
    setNewSubName('');
    setShowAddSub(false);
  };

  return (
    <div style={{ background: COLORS.bg, color: COLORS.text, fontFamily: SANS, minHeight: 600, padding: 24, borderRadius: 12 }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: 1.5, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 4 }}>
            Robinhood → Schwab
          </div>
          <h1 style={{ fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>Signal Broadcast</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '7px 14px', fontSize: 12.5 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: serverOnline ? COLORS.green : COLORS.red }} />
            <span style={{ color: serverOnline ? COLORS.green : COLORS.red, fontWeight: 600 }}>
              {serverOnline ? 'Server online' : 'Server offline'}
            </span>
          </div>
          <button onClick={() => setShowSetup(s => !s)}
            style={{ background: showSetup ? COLORS.panel2 : COLORS.text, color: showSetup ? COLORS.muted : COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
            {showSetup ? 'Close' : 'Setup'}
          </button>
        </div>
      </div>

      {/* Setup panel */}
      {showSetup && (
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 18, marginBottom: 20 }}>
          <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 14 }}>Server configuration</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: COLORS.dim, marginBottom: 5 }}>Signal server URL</div>
              <input value={serverUrl} onChange={e => setServerUrl(e.target.value)}
                style={{ width: '100%', background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '8px 10px', fontSize: 12.5, fontFamily: MONO, boxSizing: 'border-box', outline: 'none' }} />
            </div>
            <button style={{ background: COLORS.text, color: COLORS.bg, border: 'none', borderRadius: 6, padding: '9px 16px', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
              Test connection
            </button>
          </div>

          <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: 14 }}>
            <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 10 }}>How to start the server</div>
            <div style={{ fontSize: 12, color: COLORS.muted, lineHeight: 1.7, marginBottom: 10 }}>
              The signal server is a small Node.js process that polls your Robinhood trades and broadcasts them to subscribers.
              Run it once and leave it open in a terminal while you trade.
            </div>
            <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: '10px 14px', fontFamily: MONO, fontSize: 12, color: COLORS.text, lineHeight: 1.8 }}>
              <div style={{ color: COLORS.dim }}>{'# install once'}</div>
              <div>npm install</div>
              <div style={{ color: COLORS.dim, marginTop: 6 }}>{'# start the server'}</div>
              <div>node server.js</div>
            </div>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
        <MiniStat icon={<Users size={13} />}  label="Subscribers"   value={subscribers.filter(s => s.status === 'active').length} />
        <MiniStat icon={<Radio size={13} />}  label="Signals sent"  value={signals.length} />
        <MiniStat icon={<Zap size={13} />}    label="Last signal"   value={signals.length ? signals[signals.length - 1].time : '—'} mono />
        <MiniStat icon={<Activity size={13} />} label="Pending"     value={subscribers.filter(s => s.status === 'pending').length} color={COLORS.amber} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>

        {/* Subscribers */}
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase' }}>Subscribers</div>
            <button onClick={() => setShowAddSub(s => !s)}
              style={{ background: 'none', border: `1px solid ${COLORS.border}`, color: COLORS.muted, borderRadius: 5, padding: '4px 10px', fontSize: 12, cursor: 'pointer' }}>
              + Add
            </button>
          </div>

          {showAddSub && (
            <div style={{ background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: 7, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 11, color: COLORS.dim, marginBottom: 8 }}>
                Give your subscriber this link to connect their Schwab account:
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                <div style={{ flex: 1, background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: '6px 9px', fontSize: 11, fontFamily: MONO, color: COLORS.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {inviteLink}
                </div>
                <button onClick={copyInvite}
                  style={{ background: copied ? COLORS.green : COLORS.panel2, color: copied ? COLORS.bg : COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: '6px 10px', fontSize: 11.5, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                  <Copy size={11} />{copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div style={{ fontSize: 11, color: COLORS.dim, marginBottom: 6 }}>Or add manually:</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={newSubName} onChange={e => setNewSubName(e.target.value)}
                  placeholder="Label (e.g. Nick's Schwab)"
                  onKeyDown={e => e.key === 'Enter' && addSubscriber()}
                  style={{ flex: 1, background: COLORS.panel, color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 5, padding: '6px 9px', fontSize: 12, fontFamily: SANS, outline: 'none' }} />
                <button onClick={addSubscriber} disabled={!newSubName.trim()}
                  style={{ background: COLORS.text, color: COLORS.bg, border: 'none', borderRadius: 5, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: newSubName.trim() ? 'pointer' : 'default', opacity: newSubName.trim() ? 1 : 0.5 }}>
                  Add
                </button>
              </div>
            </div>
          )}

          {subscribers.length === 0 ? (
            <div style={{ fontSize: 12, color: COLORS.dim, padding: '12px 0' }}>No subscribers yet. Add one above.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {subscribers.map(sub => (
                <div key={sub.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 9 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                      {sub.name}
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 10.5, fontWeight: 500, color: sub.status === 'active' ? COLORS.green : COLORS.amber }}>
                        {sub.status === 'active' ? <CheckCircle size={10} /> : <XCircle size={10} />}
                        {sub.status}
                      </span>
                    </div>
                    <div style={{ fontSize: 10.5, color: COLORS.dim, fontFamily: MONO, marginTop: 2 }}>
                      {sub.broker} · added {sub.addedDate} · {sub.tradesReceived} trades received
                    </div>
                  </div>
                  <button onClick={() => removeSubscriber(sub.id)}
                    style={{ background: 'none', border: 'none', color: COLORS.dim, cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}>
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Signal log */}
        <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 18 }}>
          <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 14 }}>Signal log</div>
          {signals.length === 0 ? (
            <div style={{ fontSize: 12, color: COLORS.dim }}>No signals broadcast yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[...signals].reverse().map(sig => (
                <div key={sig.id} style={{ borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 9 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13, fontWeight: 700, fontFamily: MONO }}>{sig.symbol}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: sig.side === 'buy' ? 'rgba(34,197,94,0.12)' : 'rgba(240,80,110,0.12)', color: sig.side === 'buy' ? COLORS.green : COLORS.red }}>
                        {sig.side.toUpperCase()}
                      </span>
                    </div>
                    <span style={{ fontSize: 11, fontFamily: MONO, color: COLORS.dim }}>{sig.time}</span>
                  </div>
                  <div style={{ fontSize: 10.5, color: COLORS.dim, fontFamily: MONO, marginTop: 3 }}>
                    {sig.qty} × ${sig.price.toFixed(2)} · delivered {sig.delivered}/{sig.total} subscribers
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 14, padding: '10px 12px', background: COLORS.bg, borderRadius: 7, fontSize: 11.5, color: COLORS.dim, lineHeight: 1.6 }}>
            <span style={{ color: COLORS.amber, fontWeight: 600 }}>Note:</span> Signal log and execution are handled by the backend server. This view shows a preview — start the server to go live.
          </div>
        </div>
      </div>

      {/* How it works */}
      <div style={{ marginTop: 20, background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: 18 }}>
        <div style={{ fontSize: 11, letterSpacing: 1, color: COLORS.dim, textTransform: 'uppercase', marginBottom: 12 }}>How it works</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          {[
            { n: '1', title: 'You trade on Robinhood', desc: 'The server polls your account every 10s for new trades.' },
            { n: '2', title: 'Signal is broadcast', desc: 'New trade detected → signal sent to all active subscribers.' },
            { n: '3', title: 'Subscriber executes', desc: 'Each subscriber\'s Schwab account places the same order using their own API credentials.' },
            { n: '4', title: 'Everyone\'s in control', desc: 'Subscribers authorize their own connection. You never hold their credentials.' },
          ].map(step => (
            <div key={step.n} style={{ background: COLORS.bg, borderRadius: 7, padding: '12px 14px' }}>
              <div style={{ fontSize: 10, color: COLORS.dim, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 5 }}>Step {step.n}</div>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{step.title}</div>
              <div style={{ fontSize: 11.5, color: COLORS.muted, lineHeight: 1.6 }}>{step.desc}</div>
            </div>
          ))}
        </div>
      </div>

      <style>{`
        @media (max-width: 680px) {
          .sig-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </div>
  );
}

function MiniStat({ icon, label, value, mono, color }) {
  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10.5, color: COLORS.dim, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        {icon}{label}
      </div>
      <div style={{ fontSize: 19, fontWeight: 700, fontFamily: mono ? MONO : undefined, color: color || COLORS.text }}>{value}</div>
    </div>
  );
}
