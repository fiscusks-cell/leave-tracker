import { useState, useEffect, useRef } from "react";

// ---------- theme (Stripe palette) ----------
const INK = "#0A2540";        // Stripe dark navy
const INK_SOFT = "#425466";   // Stripe slate
const PAPER = "#F6F9FC";      // Stripe light background
const RULE = "#E6EBF1";       // Stripe border
const BLURPLE = "#635BFF";    // Stripe brand purple
const WARN = "#983705";       // Stripe warning text
const OVER = "#CD3D64";       // Stripe critical text
const CHIP_BG = "#EBEEF1";    // Stripe neutral badge
const KS_BG = "#F5F4FF";      // blurple tint
const KS_INK = "#4B44C0";     // blurple text
const CARD_SHADOW = "0 1px 3px rgba(50,50,93,0.06), 0 1px 2px rgba(0,0,0,0.04)";
const BTN_SHADOW = "0 1px 2px rgba(0,0,0,0.12)";

// ---------- time off types (QuickBooks-style) ----------
const TYPES = [
  { key: "pto",      label: "Paid time off",   accrues: true },
  { key: "vacation", label: "Annual leave",    accrues: true },
  { key: "sick",     label: "Sick pay",        accrues: true },
  { key: "holiday",  label: "Holiday pay",     accrues: false },
  { key: "unpaid",   label: "Unpaid time off", accrues: false },
];
const typeLabel = (k) => TYPES.find((t) => t.key === k)?.label || k;
const ANNUAL_KEYS = ["vacation", "pto"]; // types subject to Kosovo annual-leave rules

const METHODS = [
  { key: "year_start",  label: "At beginning of year" },
  { key: "anniversary", label: "On anniversary date" },
  { key: "pay_period",  label: "Each pay period" },
  { key: "per_hour",    label: "Per hour worked" },
];

const PAY_FREQ = [
  { key: "weekly", label: "Weekly" }, { key: "biweekly", label: "Every other week" },
  { key: "semimonthly", label: "Twice a month" }, { key: "monthly", label: "Monthly" },
];

// Kosovo fixed-date public holidays (MM-DD). Movable ones (Eid al-Fitr,
// Eid al-Adha, Catholic & Orthodox Easter Monday) must be adjusted manually.
const KS_HOLIDAYS_FIXED = ["01-01", "01-07", "02-17", "04-09", "05-01", "05-09", "12-25"];

const defaultPolicy = (enabled) => ({
  enabled,
  unlimited: false,
  method: "year_start",
  hoursPerYear: 160,       // Kosovo minimum: 20 working days x 8h
  perHourRate: 0.05,
  maxBalance: 0,
  carryover: "kosovo",     // none | limited | all | kosovo (use by 30 June)
  carryoverMax: 40,
  openingBalance: 0,
});

const DEFAULT_EMPLOYEES = [1, 2, 3, 4, 5, 6].map((i) => ({
  id: "emp" + i,
  name: "Employee " + i,
  hireDate: "",
  hoursPerDay: 8,
  hoursPerWeek: 40,
  payFrequency: "monthly",
  // Kosovo fields
  experienceYears: 0,      // total career experience (+1 day per 5 years)
  harmful: false,          // harmful/difficult conditions → 30-day base
  extraDays: false,        // mother w/ child <3, single parent, disability → +2 days
  firstEmployment: false,  // Art. 35: 6-month rule + proportional first year
  policies: {
    pto: defaultPolicy(false),
    vacation: defaultPolicy(true),
    sick: { ...defaultPolicy(true), hoursPerYear: 160, carryover: "none" },
  },
}));

const STORAGE_KEY = "leave-tracker-v2";
const thisYear = new Date().getFullYear();

// ---------- helpers ----------
const fmtDate = (iso) => {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
const hrs = (n) => {
  const r = Math.round(n * 100) / 100;
  return (Number.isInteger(r) ? r : r.toFixed(2)) + "h";
};
const asDays = (h, perDay) => {
  const d = Math.round((h / (perDay || 8)) * 10) / 10;
  return (Number.isInteger(d) ? d : d.toFixed(1)) + "d";
};

function yearFraction(year) {
  const now = new Date();
  if (year !== now.getFullYear()) return 1;
  const start = new Date(year, 0, 1);
  return Math.min(1, (now - start) / (new Date(year + 1, 0, 1) - start));
}

// Completed months of work within `year`, from hire date up to `asOf`
function monthsWorkedInYear(hireISO, year, full) {
  const hire = new Date(hireISO + "T00:00:00");
  const from = hire.getFullYear() === year ? hire : new Date(year, 0, 1);
  const to = full || year < thisYear ? new Date(year, 11, 31) : year > thisYear ? new Date(year, 11, 31) : new Date();
  if (to < from) return 0;
  let m = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
  if (to.getDate() < from.getDate()) m -= 1;
  return Math.max(0, Math.min(12, m));
}

// Art. 35 eligibility: 6 months of uninterrupted work
function eligibilityDate(emp) {
  if (!emp.firstEmployment || !emp.hireDate) return null;
  const d = new Date(emp.hireDate + "T00:00:00");
  d.setMonth(d.getMonth() + 6);
  return d;
}

// Kosovo statutory annual leave entitlement in working days
function kosovoEntitlementDays(emp) {
  const base = emp.harmful ? 30 : 20;
  const seniority = Math.floor((emp.experienceYears || 0) / 5);
  const extra = emp.extraDays ? 2 : 0;
  return { base, seniority, extra, total: base + seniority + extra };
}

// Hours accrued for a policy in a given year
function accruedHours(policy, emp, typeKey, year, full) {
  if (!policy || !policy.enabled || policy.unlimited) return 0;

  // Kosovo Art. 35/37: first employment → proportional (1/12 per month) in hire year
  if (ANNUAL_KEYS.includes(typeKey) && emp.firstEmployment && emp.hireDate) {
    const hireYear = Number(emp.hireDate.slice(0, 4));
    if (year < hireYear) return 0;
    if (year === hireYear) {
      return policy.hoursPerYear * (monthsWorkedInYear(emp.hireDate, year, full) / 12);
    }
  }

  const f = full ? 1 : yearFraction(year);
  switch (policy.method) {
    case "year_start": return policy.hoursPerYear;
    case "anniversary": {
      if (!emp.hireDate) return policy.hoursPerYear;
      const hd = new Date(emp.hireDate + "T00:00:00");
      if (year <= hd.getFullYear()) return 0;
      if (full) return policy.hoursPerYear;
      return new Date(year, hd.getMonth(), hd.getDate()) <= new Date() ? policy.hoursPerYear : 0;
    }
    case "pay_period": return policy.hoursPerYear * f;
    case "per_hour": return f * 52 * (emp.hoursPerWeek || 40) * (policy.perHourRate || 0);
    default: return 0;
  }
}

// ---------- app ----------
export default function LeaveTracker() {
  const [employees, setEmployees] = useState(DEFAULT_EMPLOYEES);
  const [entries, setEntries] = useState([]);
  const [baseYear, setBaseYear] = useState(thisYear);
  const [year, setYear] = useState(thisYear);
  const [loaded, setLoaded] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [tab, setTab] = useState("log");
  const [showForm, setShowForm] = useState(false);
  const saveTimer = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get(STORAGE_KEY);
        if (res && res.value) {
          const d = JSON.parse(res.value);
          if (d.employees) setEmployees(d.employees.map((e) => ({ ...DEFAULT_EMPLOYEES[0], ...e })));
          if (d.entries) setEntries(d.entries);
          if (d.baseYear) setBaseYear(d.baseYear);
        }
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!loaded) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        await window.storage.set(STORAGE_KEY, JSON.stringify({ employees, entries, baseYear }));
        setStorageOk(true);
      } catch (e) { setStorageOk(false); }
    }, 400);
    return () => clearTimeout(saveTimer.current);
  }, [employees, entries, baseYear, loaded]);

  // ----- balance engine -----
  const usedIn = (empId, typeKey, y) =>
    entries.filter((e) => e.empId === empId && e.type === typeKey && e.year === y)
      .reduce((s, e) => s + e.hours, 0);

  // Hours used before 1 July of year y (FIFO — carried hours are consumed first)
  const usedBeforeJuly = (empId, typeKey, y) =>
    entries.filter((e) => e.empId === empId && e.type === typeKey && e.year === y &&
      e.start && e.start < `${y}-07-01`).reduce((s, e) => s + e.hours, 0);

  const balance = (emp, typeKey) => {
    const p = emp.policies?.[typeKey];
    if (!p || !p.enabled) return null;
    if (p.unlimited) return { unlimited: true, used: usedIn(emp.id, typeKey, year) };

    let carry = p.openingBalance || 0;
    for (let y = baseYear; y < year; y++) {
      let effCarry = carry;
      if (p.carryover === "kosovo") {
        effCarry = Math.min(carry, usedBeforeJuly(emp.id, typeKey, y)); // expired 30 June
      }
      const end = effCarry + accruedHours(p, emp, typeKey, y, true) - usedIn(emp.id, typeKey, y);
      if (p.carryover === "none") carry = 0;
      else if (p.carryover === "limited") carry = Math.min(Math.max(end, 0), p.carryoverMax || 0);
      else carry = Math.max(end, p.carryover === "all" ? end : 0); // kosovo & all keep end (kosovo floors at 0)
      if (p.carryover === "kosovo") carry = Math.max(end, 0);
    }
    if (year < baseYear) carry = 0;

    // 30 June expiry in the viewed year
    let expired = 0;
    let carryDeadline = null;
    if (p.carryover === "kosovo" && carry > 0) {
      const pastJuly = year < thisYear || (year === thisYear && new Date() >= new Date(year, 6, 1));
      if (pastJuly) {
        const eff = Math.min(carry, usedBeforeJuly(emp.id, typeKey, year));
        expired = carry - eff;
        carry = eff;
      } else {
        carryDeadline = `30 Jun ${year}`;
      }
    }

    const accrued = accruedHours(p, emp, typeKey, year, false);
    let gross = carry + accrued;
    let capped = false;
    if (p.maxBalance > 0 && gross > p.maxBalance) { gross = p.maxBalance; capped = true; }
    const used = usedIn(emp.id, typeKey, year);
    return { carry, accrued, gross, used, available: gross - used, capped, expired, carryDeadline };
  };

  const updateEmployee = (id, patch) =>
    setEmployees((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  const updatePolicy = (empId, typeKey, patch) =>
    setEmployees((prev) => prev.map((e) => {
      if (e.id !== empId) return e;
      const cur = e.policies?.[typeKey] || defaultPolicy(false);
      return { ...e, policies: { ...e.policies, [typeKey]: { ...cur, ...patch } } };
    }));

  // One-click Kosovo statutory setup for an employee
  const applyKosovo = (emp) => {
    const ent = kosovoEntitlementDays(emp);
    updatePolicy(emp.id, "vacation", {
      enabled: true, unlimited: false, method: "year_start",
      hoursPerYear: ent.total * (emp.hoursPerDay || 8),
      carryover: "kosovo", maxBalance: 0,
    });
    updatePolicy(emp.id, "sick", {
      enabled: true, unlimited: false, method: "year_start",
      hoursPerYear: 20 * (emp.hoursPerDay || 8),
      carryover: "none", maxBalance: 0,
    });
  };

  const addEntry = (entry) => {
    setEntries((prev) => [...prev, { ...entry, id: "e" + Date.now() }]);
    if (entry.year < baseYear) setBaseYear(entry.year);
    setShowForm(false);
  };
  const deleteEntry = (id) => setEntries((prev) => prev.filter((e) => e.id !== id));

  const years = Array.from(new Set([thisYear - 1, thisYear, thisYear + 1, ...entries.map((e) => e.year)])).sort();

  return (
    <div style={{ background: PAPER, minHeight: "100vh", color: INK, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Ubuntu, sans-serif" }}>
      <div className="max-w-4xl mx-auto px-4 py-8">

        <div style={{ height: 4, borderRadius: 4, background: "linear-gradient(90deg, #635BFF 0%, #80E9FF 50%, #FF80B5 100%)" }} />
        <div className="flex flex-wrap items-end justify-between gap-4 pb-5 pt-6">
          <div>
            <div className="text-xs font-semibold uppercase tracking-widest" style={{ color: BLURPLE }}>Team time off ledger · Kosovo</div>
            <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.15, marginTop: 4, color: INK }}>
              Time Off {year}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}
              className="px-3 py-2 rounded text-sm" style={{ border: `1px solid ${RULE}`, background: "white", color: INK }}>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <button onClick={() => setShowForm(true)}
              className="px-4 py-2 rounded-md text-sm font-semibold"
              style={{ background: BLURPLE, color: "white", boxShadow: BTN_SHADOW }}>
              Log time off
            </button>
          </div>
        </div>

        <div className="pb-3 text-xs" style={{ color: INK_SOFT }}>
          Applies Labour Law No. 03/L-212 rules: 20-working-day minimum (30 for harmful conditions), +1 day per 5 years of experience,
          +2 days for mothers with children under 3 / single parents / persons with disabilities, the 6-month first-employment rule (Art. 35),
          carryover usable until 30 June of the next year, and fixed public holidays excluded from day counts.
        </div>

        {!storageOk && (
          <div className="mt-3 px-3 py-2 rounded text-sm" style={{ background: "#FCEDB9", color: WARN }}>
            Changes couldn't be saved — they'll stay for this session only.
          </div>
        )}

        <div className="mt-2 space-y-3">
          {employees.map((emp) => {
            const isOpen = expanded === emp.id;
            const enabledTypes = TYPES.filter((t) => t.accrues && emp.policies?.[t.key]?.enabled);
            const empEntries = entries.filter((e) => e.empId === emp.id && e.year === year)
              .sort((a, b) => (a.start || "").localeCompare(b.start || ""));
            const elig = eligibilityDate(emp);
            const notYetEligible = elig && elig > new Date();

            return (
              <div key={emp.id} className="rounded-lg px-4"
                style={{ background: "white", border: `1px solid ${RULE}`, boxShadow: CARD_SHADOW }}>
                <div className="py-4 flex flex-wrap items-center gap-x-4 gap-y-2 cursor-pointer"
                  onClick={() => { setExpanded(isOpen ? null : emp.id); setTab("log"); }}>
                  <div className="w-44 shrink-0">
                    <div className="font-semibold text-sm">{emp.name}</div>
                    <div className="text-xs mt-0.5" style={{ color: INK_SOFT }}>
                      {emp.hireDate ? `Hired ${fmtDate(emp.hireDate)}` : "No hire date"} · {emp.hoursPerDay}h/day
                    </div>
                  </div>

                  <div className="flex-1 flex flex-wrap gap-2 min-w-48">
                    {notYetEligible && (
                      <span className="px-2.5 py-1 rounded-full text-xs font-semibold" style={{ background: KS_BG, color: KS_INK }}>
                        Annual leave locked until {fmtDate(elig.toISOString().slice(0, 10))} (Art. 35)
                      </span>
                    )}
                    {enabledTypes.length === 0 && (
                      <span className="text-xs" style={{ color: INK_SOFT }}>No paid policies — open to set up</span>
                    )}
                    {enabledTypes.map((t) => {
                      const b = balance(emp, t.key);
                      if (!b) return null;
                      const badge = b.unlimited ? { bg: CHIP_BG, fg: "#545969" }
                        : b.available < 0 ? { bg: "#FFE7EB", fg: OVER }
                        : b.available <= emp.hoursPerDay * 2 ? { bg: "#FCEDB9", fg: WARN }
                        : { bg: "#D7F7C2", fg: "#0E6245" };
                      return (
                        <span key={t.key} className="px-2.5 py-1 rounded-full text-xs font-semibold"
                          style={{ background: badge.bg, color: badge.fg, fontVariantNumeric: "tabular-nums" }}>
                          {t.label}: {b.unlimited ? "unlimited" : `${asDays(b.available, emp.hoursPerDay)} (${hrs(b.available)})`}
                        </span>
                      );
                    })}
                  </div>

                  <div className="text-xs shrink-0 underline" style={{ color: INK_SOFT }}>{isOpen ? "Close" : "Details"}</div>
                </div>

                {isOpen && (
                  <div className="pb-5">
                    <div className="flex gap-4 text-sm mb-3">
                      {[["log", "Time off log"], ["policies", "Policies & Kosovo rules"]].map(([k, l]) => (
                        <button key={k} onClick={() => setTab(k)} className="pb-1 font-semibold"
                          style={{ color: tab === k ? BLURPLE : INK_SOFT, borderBottom: tab === k ? `2px solid ${BLURPLE}` : "2px solid transparent" }}>
                          {l}
                        </button>
                      ))}
                    </div>
                    {tab === "log" ? (
                      <LogView emp={emp} empEntries={empEntries} balance={balance} deleteEntry={deleteEntry} year={year} />
                    ) : (
                      <PolicyView emp={emp} updateEmployee={updateEmployee} updatePolicy={updatePolicy} applyKosovo={applyKosovo} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="pt-4 text-xs" style={{ color: INK_SOFT }}>
          This tracker is a working tool, not legal advice — confirm edge cases with the Labour Inspectorate or your legal advisor.
          Movable public holidays (Eid al-Fitr, Eid al-Adha, Easter Mondays) aren't auto-excluded; adjust hours manually for those.
        </div>
      </div>

      {showForm && (
        <LeaveForm employees={employees} balance={balance} onSave={addEntry} onClose={() => setShowForm(false)} />
      )}
    </div>
  );
}

// ---------- log view ----------
function LogView({ emp, empEntries, balance, deleteEntry, year }) {
  const enabled = TYPES.filter((t) => t.accrues && emp.policies?.[t.key]?.enabled);
  return (
    <div>
      {enabled.length > 0 && (
        <table className="w-full text-sm mb-4" style={{ fontVariantNumeric: "tabular-nums" }}>
          <thead>
            <tr className="text-xs uppercase tracking-wide text-left" style={{ color: INK_SOFT }}>
              <th className="py-1 font-semibold">Policy</th>
              <th className="py-1 font-semibold text-right">Carried in</th>
              <th className="py-1 font-semibold text-right">Accrued</th>
              <th className="py-1 font-semibold text-right">Used</th>
              <th className="py-1 font-semibold text-right">Available</th>
            </tr>
          </thead>
          <tbody>
            {enabled.map((t) => {
              const b = balance(emp, t.key);
              if (!b) return null;
              if (b.unlimited) return (
                <tr key={t.key} style={{ borderTop: `1px dashed ${RULE}` }}>
                  <td className="py-1.5">{t.label}</td>
                  <td className="py-1.5 text-right" colSpan={2} style={{ color: INK_SOFT }}>Unlimited</td>
                  <td className="py-1.5 text-right">{hrs(b.used)}</td>
                  <td className="py-1.5 text-right">—</td>
                </tr>
              );
              return (
                <tr key={t.key} style={{ borderTop: `1px dashed ${RULE}` }}>
                  <td className="py-1.5">
                    {t.label}
                    {b.capped ? <span className="text-xs" style={{ color: WARN }}> (at max)</span> : ""}
                    {b.carryDeadline ? <span className="text-xs" style={{ color: KS_INK }}> — carried hours expire {b.carryDeadline}</span> : ""}
                    {b.expired > 0 ? <span className="text-xs" style={{ color: WARN }}> — {hrs(b.expired)} expired 30 Jun</span> : ""}
                  </td>
                  <td className="py-1.5 text-right">{hrs(b.carry)}</td>
                  <td className="py-1.5 text-right">{hrs(b.accrued)}</td>
                  <td className="py-1.5 text-right">{hrs(b.used)}</td>
                  <td className="py-1.5 text-right font-semibold" style={{ color: b.available < 0 ? OVER : INK }}>
                    {hrs(b.available)} <span className="font-normal" style={{ color: INK_SOFT }}>({asDays(b.available, emp.hoursPerDay)})</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {empEntries.length === 0 ? (
        <div className="text-sm" style={{ color: INK_SOFT }}>No time off logged for {emp.name} in {year}.</div>
      ) : (
        <table className="w-full text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
          <tbody>
            {empEntries.map((e) => (
              <tr key={e.id} style={{ borderTop: `1px dashed ${RULE}` }}>
                <td className="py-1.5 pr-3">{fmtDate(e.start)}{e.end && e.end !== e.start ? ` – ${fmtDate(e.end)}` : ""}</td>
                <td className="py-1.5 pr-3" style={{ color: INK_SOFT }}>{typeLabel(e.type)}{e.note ? ` · ${e.note}` : ""}</td>
                <td className="py-1.5 pr-3 text-right font-semibold">{hrs(e.hours)}</td>
                <td className="py-1.5 text-right w-16">
                  <button onClick={() => deleteEntry(e.id)} className="text-xs underline" style={{ color: OVER }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- policy & Kosovo rules editor ----------
function PolicyView({ emp, updateEmployee, updatePolicy, applyKosovo }) {
  const inp = { border: `1px solid ${RULE}`, background: "white" };
  const lbl = "block text-xs font-semibold uppercase tracking-wide";
  const ent = kosovoEntitlementDays(emp);
  const elig = eligibilityDate(emp);

  return (
    <div>
      {/* schedule & Kosovo employee facts */}
      <div className="flex flex-wrap gap-4 items-end pb-4" style={{ borderBottom: `1px solid ${RULE}` }}>
        <div>
          <label className={lbl} style={{ color: INK_SOFT }}>Name</label>
          <input value={emp.name} onChange={(e) => updateEmployee(emp.id, { name: e.target.value })}
            className="mt-1 px-2 py-1.5 rounded text-sm w-40" style={inp} />
        </div>
        <div>
          <label className={lbl} style={{ color: INK_SOFT }}>Hire date</label>
          <input type="date" value={emp.hireDate} onChange={(e) => updateEmployee(emp.id, { hireDate: e.target.value })}
            className="mt-1 px-2 py-1.5 rounded text-sm" style={inp} />
        </div>
        <div>
          <label className={lbl} style={{ color: INK_SOFT }}>Total experience (yrs)</label>
          <input type="number" min="0" step="1" value={emp.experienceYears}
            onChange={(e) => updateEmployee(emp.id, { experienceYears: Math.max(0, Number(e.target.value) || 0) })}
            className="mt-1 px-2 py-1.5 rounded text-sm w-24" style={inp} />
        </div>
        <div>
          <label className={lbl} style={{ color: INK_SOFT }}>Hours / day</label>
          <input type="number" min="1" step="0.5" value={emp.hoursPerDay}
            onChange={(e) => updateEmployee(emp.id, { hoursPerDay: Math.max(1, Number(e.target.value) || 8) })}
            className="mt-1 px-2 py-1.5 rounded text-sm w-20" style={inp} />
        </div>
        <div>
          <label className={lbl} style={{ color: INK_SOFT }}>Pay schedule</label>
          <select value={emp.payFrequency} onChange={(e) => updateEmployee(emp.id, { payFrequency: e.target.value })}
            className="mt-1 px-2 py-1.5 rounded text-sm" style={inp}>
            {PAY_FREQ.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
        </div>
      </div>

      {/* Kosovo statutory panel */}
      <div className="rounded-lg p-4 my-4" style={{ background: KS_BG, color: KS_INK }}>
        <div className="text-sm font-semibold">Kosovo Labour Law entitlement (Law No. 03/L-212)</div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 mt-2 text-sm">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={emp.harmful}
              onChange={(e) => updateEmployee(emp.id, { harmful: e.target.checked })} />
            Harmful/difficult conditions (30-day base)
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={emp.extraDays}
              onChange={(e) => updateEmployee(emp.id, { extraDays: e.target.checked })} />
            Mother w/ child &lt;3 · single parent · disability (+2 days)
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={emp.firstEmployment}
              onChange={(e) => updateEmployee(emp.id, { firstEmployment: e.target.checked })} />
            First employment / break &gt;5 working days (Art. 35)
          </label>
        </div>
        <div className="mt-3 text-sm" style={{ fontVariantNumeric: "tabular-nums" }}>
          Base {ent.base}d + seniority {ent.seniority}d + special categories {ent.extra}d ={" "}
          <strong>{ent.total} working days</strong> ({ent.total * emp.hoursPerDay}h at {emp.hoursPerDay}h/day)
          {emp.firstEmployment && (
            <div className="mt-1 text-xs">
              First-year entitlement accrues at 1/12 per month worked; leave can be used only after 6 months of uninterrupted work
              {elig ? ` — eligible from ${fmtDate(elig.toISOString().slice(0, 10))}` : " — set a hire date to compute the eligibility date"}.
            </div>
          )}
        </div>
        <button onClick={() => applyKosovo(emp)}
          className="mt-3 px-3 py-1.5 rounded-md text-sm font-semibold"
          style={{ background: BLURPLE, color: "white", boxShadow: BTN_SHADOW }}>
          Apply statutory policies ({ent.total}d annual + 20d sick)
        </button>
        <div className="text-xs mt-2">
          Sets annual leave to {ent.total} days granted at the start of the year with unused days usable until 30 June of the next year,
          and sick pay to 20 working days at full salary, reset each year. You can still fine-tune below.
        </div>
      </div>

      {/* policy editors */}
      <div className="grid gap-4 md:grid-cols-3">
        {TYPES.filter((t) => t.accrues).map((t) => {
          const p = emp.policies?.[t.key] || defaultPolicy(false);
          return (
            <div key={t.key} className="rounded-lg p-3" style={{ border: `1px solid ${RULE}`, background: "white", boxShadow: CARD_SHADOW }}>
              <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer">
                <input type="checkbox" checked={p.enabled}
                  onChange={(e) => updatePolicy(emp.id, t.key, { enabled: e.target.checked })} />
                {t.label}
              </label>

              {p.enabled && (
                <div className="mt-3 space-y-3 text-sm">
                  <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: INK_SOFT }}>
                    <input type="checkbox" checked={p.unlimited}
                      onChange={(e) => updatePolicy(emp.id, t.key, { unlimited: e.target.checked })} />
                    Unlimited (track usage only)
                  </label>

                  {!p.unlimited && (
                    <>
                      <div>
                        <label className={lbl} style={{ color: INK_SOFT }}>Hours are accrued</label>
                        <select value={p.method} onChange={(e) => updatePolicy(emp.id, t.key, { method: e.target.value })}
                          className="mt-1 w-full px-2 py-1.5 rounded text-sm" style={inp}>
                          {METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
                        </select>
                      </div>

                      {p.method === "per_hour" ? (
                        <div>
                          <label className={lbl} style={{ color: INK_SOFT }}>Hours per hour worked</label>
                          <input type="number" min="0" step="0.001" value={p.perHourRate}
                            onChange={(e) => updatePolicy(emp.id, t.key, { perHourRate: Math.max(0, Number(e.target.value) || 0) })}
                            className="mt-1 w-full px-2 py-1.5 rounded text-sm" style={inp} />
                        </div>
                      ) : (
                        <div>
                          <label className={lbl} style={{ color: INK_SOFT }}>Hours per year</label>
                          <input type="number" min="0" step="1" value={p.hoursPerYear}
                            onChange={(e) => updatePolicy(emp.id, t.key, { hoursPerYear: Math.max(0, Number(e.target.value) || 0) })}
                            className="mt-1 w-full px-2 py-1.5 rounded text-sm" style={inp} />
                          <div className="text-xs mt-1" style={{ color: INK_SOFT }}>= {asDays(p.hoursPerYear, emp.hoursPerDay)} at {emp.hoursPerDay}h/day</div>
                        </div>
                      )}

                      <div>
                        <label className={lbl} style={{ color: INK_SOFT }}>Maximum balance (0 = none)</label>
                        <input type="number" min="0" step="1" value={p.maxBalance}
                          onChange={(e) => updatePolicy(emp.id, t.key, { maxBalance: Math.max(0, Number(e.target.value) || 0) })}
                          className="mt-1 w-full px-2 py-1.5 rounded text-sm" style={inp} />
                      </div>

                      <div>
                        <label className={lbl} style={{ color: INK_SOFT }}>Year-end carryover</label>
                        <select value={p.carryover} onChange={(e) => updatePolicy(emp.id, t.key, { carryover: e.target.value })}
                          className="mt-1 w-full px-2 py-1.5 rounded text-sm" style={inp}>
                          <option value="kosovo">Carry over — use by 30 June (Kosovo)</option>
                          <option value="none">Reset each year</option>
                          <option value="limited">Carry over up to a limit</option>
                          <option value="all">Carry over everything</option>
                        </select>
                        {p.carryover === "limited" && (
                          <input type="number" min="0" step="1" value={p.carryoverMax}
                            onChange={(e) => updatePolicy(emp.id, t.key, { carryoverMax: Math.max(0, Number(e.target.value) || 0) })}
                            className="mt-2 w-full px-2 py-1.5 rounded text-sm" style={inp} placeholder="Max hours carried" />
                        )}
                      </div>

                      <div>
                        <label className={lbl} style={{ color: INK_SOFT }}>Opening balance (hours)</label>
                        <input type="number" step="0.5" value={p.openingBalance}
                          onChange={(e) => updatePolicy(emp.id, t.key, { openingBalance: Number(e.target.value) || 0 })}
                          className="mt-1 w-full px-2 py-1.5 rounded text-sm" style={inp} />
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="text-xs mt-3" style={{ color: INK_SOFT }}>
        Holiday pay and unpaid time off are always loggable and never reduce paid balances. Under the Labour Law,
        annual leave cannot be waived, and unused leave is compensated in money only on termination.
      </div>
    </div>
  );
}

// ---------- log time off form ----------
function LeaveForm({ employees, balance, onSave, onClose }) {
  const [empId, setEmpId] = useState(employees[0]?.id || "");
  const [type, setType] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [hours, setHours] = useState("");
  const [note, setNote] = useState("");
  const [autoHours, setAutoHours] = useState(true);
  const [holidaysSkipped, setHolidaysSkipped] = useState(0);

  const emp = employees.find((e) => e.id === empId);
  const availableTypes = emp ? TYPES.filter((t) => !t.accrues || emp.policies?.[t.key]?.enabled) : [];

  useEffect(() => {
    if (emp && !availableTypes.find((t) => t.key === type)) setType(availableTypes[0]?.key || "");
  }, [empId]); // eslint-disable-line

  // auto hours: weekdays minus fixed Kosovo public holidays, × hours/day
  useEffect(() => {
    if (!autoHours || !start || !emp) return;
    const s = new Date(start + "T00:00:00");
    const e = new Date((end || start) + "T00:00:00");
    if (e < s) return;
    let days = 0, skipped = 0;
    const d = new Date(s);
    while (d <= e) {
      const wd = d.getDay();
      if (wd !== 0 && wd !== 6) {
        const mmdd = String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
        if (KS_HOLIDAYS_FIXED.includes(mmdd)) skipped++;
        else days++;
      }
      d.setDate(d.getDate() + 1);
    }
    setHours(String(days * (emp.hoursPerDay || 8)));
    setHolidaysSkipped(skipped);
  }, [start, end, empId, autoHours]); // eslint-disable-line

  const valid = empId && type && start && Number(hours) > 0;
  const b = emp && type ? balance(emp, type) : null;
  const goesNegative = b && !b.unlimited && b.available != null && Number(hours) > b.available;

  // Art. 35: block-worthy warning if annual leave starts before eligibility
  const elig = emp ? eligibilityDate(emp) : null;
  const beforeEligible = elig && ANNUAL_KEYS.includes(type) && start &&
    new Date(start + "T00:00:00") < elig;

  const save = () => {
    if (!valid) return;
    onSave({
      empId, type, start, end: end || start, hours: Number(hours),
      note: note.trim(), year: new Date(start + "T00:00:00").getFullYear(),
    });
  };

  const inp = { border: `1px solid ${RULE}` };
  const lbl = "block text-xs font-semibold uppercase tracking-wide";

  return (
    <div className="fixed inset-0 flex items-center justify-center p-4"
      style={{ background: "rgba(20,30,25,0.45)", zIndex: 50 }} onClick={onClose}>
      <div className="w-full max-w-md rounded-xl p-5 max-h-full overflow-y-auto"
        style={{ background: "white", color: INK, boxShadow: "0 13px 27px -5px rgba(50,50,93,0.25), 0 8px 16px -8px rgba(0,0,0,0.3)" }}
        onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-0.01em", color: INK }}>Log time off</h2>

        <label className={lbl + " mt-4"} style={{ color: INK_SOFT }}>Employee</label>
        <select value={empId} onChange={(e) => setEmpId(e.target.value)}
          className="mt-1 w-full px-3 py-2 rounded text-sm" style={inp}>
          {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>

        <label className={lbl + " mt-3"} style={{ color: INK_SOFT }}>Time off type</label>
        <select value={type} onChange={(e) => setType(e.target.value)}
          className="mt-1 w-full px-3 py-2 rounded text-sm" style={inp}>
          {availableTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        {b && !b.unlimited && (
          <div className="text-xs mt-1" style={{ color: INK_SOFT }}>
            Available: {hrs(b.available)} ({asDays(b.available, emp.hoursPerDay)})
          </div>
        )}

        <div className="flex gap-3 mt-3">
          <div className="flex-1">
            <label className={lbl} style={{ color: INK_SOFT }}>First day</label>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded text-sm" style={inp} />
          </div>
          <div className="flex-1">
            <label className={lbl} style={{ color: INK_SOFT }}>Last day</label>
            <input type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded text-sm" style={inp} />
          </div>
        </div>

        <div className="mt-3 w-32">
          <label className={lbl} style={{ color: INK_SOFT }}>Hours</label>
          <input type="number" min="0.5" step="0.5" value={hours}
            onChange={(e) => { setHours(e.target.value); setAutoHours(false); }}
            className="mt-1 w-full px-3 py-2 rounded text-sm" style={inp} />
        </div>
        <div className="text-xs mt-1" style={{ color: INK_SOFT }}>
          Weekends and fixed Kosovo public holidays are excluded automatically
          {holidaysSkipped > 0 ? ` (${holidaysSkipped} holiday${holidaysSkipped > 1 ? "s" : ""} skipped in this range)` : ""}.
          Adjust manually for movable holidays (Eids, Easter Mondays) or partial days.
        </div>

        {beforeEligible && (
          <div className="mt-3 px-3 py-2 rounded text-sm" style={{ background: KS_BG, color: KS_INK }}>
            Under Art. 35, {emp.name} gains the right to use annual leave from {fmtDate(elig.toISOString().slice(0, 10))} —
            this booking starts earlier. You can still save it if you've agreed an exception, but it may not be compliant.
          </div>
        )}
        {goesNegative && (
          <div className="mt-3 px-3 py-2 rounded text-sm" style={{ background: "#FFE7EB", color: OVER }}>
            This takes {emp.name}'s {typeLabel(type).toLowerCase()} balance negative — double-check before saving.
          </div>
        )}

        <label className={lbl + " mt-3"} style={{ color: INK_SOFT }}>Note (optional)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Summer holiday"
          className="mt-1 w-full px-3 py-2 rounded text-sm" style={inp} />

        <div className="flex justify-end gap-3 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded text-sm" style={{ border: `1px solid ${RULE}` }}>Cancel</button>
          <button onClick={save} disabled={!valid}
            className="px-4 py-2 rounded-md text-sm font-semibold"
            style={{ background: valid ? BLURPLE : "#C0C8D2", color: "white", boxShadow: valid ? BTN_SHADOW : "none" }}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
