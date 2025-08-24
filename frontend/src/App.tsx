import { useEffect, useMemo, useRef, useState } from "react";
import { v4 as uuidV4 } from "uuid";

const API = import.meta.env.VITE_API_URL || "http://localhost:4000";

type Status = "upcoming" | "active" | "ended" | "sold_out";
type SaleStatus = {
  productId: string;
  productDescription: string,
  status: Status;
  startsAt: number;
  endsAt: number;
  stock: number;
  sold: number;
};

type PurchaseCheck = { purchased: boolean; orderId?: string | null };

function clsx(...xs: Array<string | false | undefined>) {
  return xs.filter(Boolean).join(" ");
}

function msLeft(target: number) {
  return Math.max(0, target - Date.now());
}

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts = [
    h > 0 ? `${h}h` : null,
    h > 0 || m > 0 ? `${m}m` : null,
    `${sec}s`,
  ].filter(Boolean);
  return parts.join(" ");
}

function useTicker(ms = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

function Badge({ status }: { status: Status }) {
  const label =
    status === "upcoming"
      ? "Upcoming"
      : status === "active"
      ? "Active"
      : status === "sold_out"
      ? "Sold Out"
      : "Ended";

  return (
    <span
      className={clsx(
        "badge",
        status === "active" && "badge--active",
        status === "upcoming" && "badge--upcoming",
        status === "sold_out" && "badge--danger",
        status === "ended" && "badge--muted"
      )}
    >
      {label}
    </span>
  );
}

function ProgressBar({ sold, total }: { sold: number; total: number }) {
  const pct = Math.min(100, Math.round((sold / Math.max(1, total)) * 100));
  return (
    <div className="progress">
      <div className="progress__bar" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function App() {
  // state
  const [sale, setSale] = useState<SaleStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);

  const [userId, setUserId] = useState("");
  const [checkingUser, setCheckingUser] = useState(false);
  const [userPurchased, setUserPurchased] = useState<PurchaseCheck | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ orderId: string } | null>(null);

  const [csrfToken, setCsrfToken] = useState<string | null>(null);

  // live ticker for countdown & auto-refresh
  useTicker(1000);

  // load sale status
  async function loadStatus() {
    try {
      setLoadingStatus(true);
      const r = await fetch(`${API}/api/status`, { credentials: "include" });
      const j: SaleStatus = await r.json();
      setSale(j);
    } catch (e) {
      setToast("Failed to load sale status. Check API URL.");
    } finally {
      setLoadingStatus(false);
    }
  }

    useEffect(() => {
      (async () => {
          try {
            const r = await fetch(`${API}/api/csrf`, { credentials: "include" });
            const j = await r.json();
            setCsrfToken(j.csrfToken);
          } catch {}
      })();
    }, []);

  useEffect(() => {
    loadStatus();
    const t = setInterval(loadStatus, 3000);
    return () => clearInterval(t);
  }, []);

  // debounced check if user already purchased
  const checkTimer = useRef<number | null>(null);
  useEffect(() => {
    setUserPurchased(null);
    if (checkTimer.current) window.clearTimeout(checkTimer.current);
    if (!userId.trim()) return;
    checkTimer.current = window.setTimeout(async () => {
      try {
        setCheckingUser(true);
        const r = await fetch(`${API}/api/purchase/${encodeURIComponent(userId)}`);
        const j: PurchaseCheck = await r.json();
        setUserPurchased(j);
      } catch {
        // ignore
      } finally {
        setCheckingUser(false);
      }
    }, 500);
  }, [userId]);

  // derived values
  const now = Date.now();
  const startsAt = sale?.startsAt ?? 0;
  const endsAt = sale?.endsAt ?? 0;
  const total = (sale?.sold ?? 0) + (sale?.stock ?? 0);

  const countdownLabel = useMemo(() => {
    if (!sale) return "";
    if (sale.status === "upcoming") return `Starts in ${formatDuration(msLeft(startsAt))}`;
    if (sale.status === "active") return `Ends in ${formatDuration(msLeft(endsAt))}`;
    return "";
  }, [sale, startsAt, endsAt, now]);

  const canBuy =
    sale?.status === "active" &&
    !submitting &&
    !!userId.trim() &&
    !(userPurchased?.purchased);

  // purchase
  async function buy() {
    if (!canBuy || !csrfToken) return;
    setSubmitting(true);
    setToast(null);

    const uuid = uuidV4();
    try {
      const r = await fetch(`${API}/api/purchase`, {
        method: "POST",
        credentials: "include", 
        headers: {
          "Content-Type": "application/json",
          "Correlation-Id": uuid,
          "X-CSRF-Token": csrfToken, 
        },
        body: JSON.stringify({ userId }),
      });

      const body = await r.json();

      if (r.status === 200) {
        setReceipt({ orderId: body.orderId });
        setUserPurchased({ purchased: true, orderId: body.orderId });
        setToast("Success! You secured the item.");
      } else if (r.status === 409) {
        setUserPurchased({ purchased: true, orderId: body.orderId });
        setToast("You already purchased this item.");
      } else if (r.status === 410) {
        setToast("Sold out.");
      } else if (r.status === 403) {
        setToast("Sale is not active.");
      } else if (r.status === 503) {
        setToast("High demand — please try again.");
      } else {
        setToast("Unexpected error. Please try again.");
      }
    } catch {
      setToast("Network error. Check the backend and try again.");
    } finally {
      setSubmitting(false);
      loadStatus();
    }
  }

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <span className="brand__logo">⚡</span>
          <span className="brand__name">FlashDrop</span>
        </div>
        <div className="header__right">
          {sale && <Badge status={sale.status} />}
        </div>
      </header>

      <main className="main">
        <section className="card card--hero">
          <div className="hero__left">
            <h1>Limited Edition — One per user</h1>
            <p className="muted">
              {loadingStatus ? "Loading status…" : countdownLabel || "—"}
            </p>

            <div className="stock">
              <div className="stock__top">
                <div>
                  <strong>Remaining:</strong> {sale?.stock ?? "—"}
                </div>
                <div>
                  <strong>Sold:</strong> {sale?.sold ?? "—"}
                </div>
                <div>
                  <strong>Total:</strong> {total || "—"}
                </div>
              </div>
              <ProgressBar sold={sale?.sold ?? 0} total={total} />
            </div>

            <div className="form">
              <label htmlFor="uid">Your user ID (email/username)</label>
              <div className="form__row">
                <input
                  id="uid"
                  placeholder="e.g. alice@example.com"
                  value={userId}
                  onChange={(e) => setUserId(e.target.value)}
                  disabled={submitting}
                />
                <button
                  className="btn"
                  onClick={buy}
                  disabled={!canBuy}
                  title={!canBuy ? "Enter user ID or sale inactive" : "Buy Now"}
                >
                  {submitting ? "Processing…" : "Buy Now"}
                </button>
              </div>
              {checkingUser && <p className="info">Checking purchase status…</p>}
              {userPurchased?.purchased && (
                <p className="success">
                  You already purchased. Order: <code>{userPurchased.orderId}</code>
                </p>
              )}
            </div>

            <div className="notes">
              <p className="muted small">
                • One unit per user • Window:{" "}
                {sale
                  ? `${new Date(sale.startsAt).toLocaleString()} – ${new Date(
                      sale.endsAt
                    ).toLocaleString()}`
                  : "—"}
              </p>
            </div>
          </div>

          <div className="hero__right">
            <div className="product">
              <div className="product__image">🎁</div>
              <div className="product__meta">
                <h3>{sale?.productId ?? "—"}: Limited Edition</h3>
                <p className="muted">
                  {sale?.productDescription ?? "-"}
                </p>
              </div>
            </div>
          </div>

          {/* overlays */}
          {sale?.status === "sold_out" && (
            <div className="overlay">
              <div className="overlay__badge">SOLD OUT</div>
            </div>
          )}
          {sale?.status === "ended" && (
            <div className="overlay">
              <div className="overlay__badge">ENDED</div>
            </div>
          )}
          {sale?.status === "upcoming" && (
            <div className="overlay overlay--soft">
              <div className="overlay__badge">UPCOMING</div>
            </div>
          )}
        </section>

        {/* receipt modal */}
        {receipt && (
          <div className="modal" role="dialog" aria-modal="true">
            <div className="modal__card">
              <h3>🎉 Purchase Confirmed</h3>
              <p>
                Your order ID: <code>{receipt.orderId}</code>
              </p>
              <div className="modal__actions">
                <button className="btn btn--secondary" onClick={() => setReceipt(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* toast */}
        {toast && (
          <div className="toast" onClick={() => setToast(null)} role="status">
            {toast}
          </div>
        )}
      </main>

      <footer className="footer"></footer>
    </div>
  );
}
