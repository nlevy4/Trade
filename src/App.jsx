import { useState } from "react";
import TradeTracker from "./TradeTracker.jsx";
import SignalDashboard from "./SignalDashboard.jsx";

const COLORS = {
  bg: "#0A0C10",
  panel: "#12151B",
  border: "#1E232B",
  text: "#E7E9ED",
  dim: "#6B7280",
  muted: "#8B92A0",
};

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export default function App() {
  const [tab, setTab] = useState("tracker");

  return (
    <div style={{ fontFamily: SANS, background: COLORS.bg, minHeight: "100vh", padding: "16px 16px 0" }}>
      {/* Top nav */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 16, borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 12 }}>
        {[
          { id: "tracker", label: "Trade Tracker" },
          { id: "signals", label: "Signal Broadcast" },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{
              background: tab === t.id ? COLORS.text : "none",
              color: tab === t.id ? COLORS.bg : COLORS.muted,
              border: tab === t.id ? "none" : `1px solid ${COLORS.border}`,
              borderRadius: 6, padding: "6px 16px", fontSize: 13, fontWeight: 600,
              cursor: "pointer", transition: "all .15s",
            }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "tracker" ? <TradeTracker /> : <SignalDashboard />}
    </div>
  );
}
