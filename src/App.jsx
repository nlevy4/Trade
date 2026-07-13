import TradeTracker from "./TradeTracker.jsx";

const COLORS = {
  bg: "#0A0C10",
};

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export default function App() {
  return (
    <div style={{ fontFamily: SANS, background: COLORS.bg, minHeight: "100vh", padding: "16px 16px 0" }}>
      <TradeTracker />
    </div>
  );
}
