import { useState, useEffect, useMemo, useCallback } from "react";
import { Calendar, User, Briefcase, Clock, Check, X, Settings, LogOut, Plus, Trash2, Users, AlertCircle, MapPin, CalendarPlus } from "lucide-react";

// ---------- helpers ----------
const pad = (n) => String(n).padStart(2, "0");
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const fmtLong = (d) =>
  d.toLocaleDateString("pt-BR", { weekday: "long", day: "2-digit", month: "long" });
const fmtShort = (d) => d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
const weekdayShort = (d) => d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");

const nextDays = (n) => {
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < n; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    out.push(d);
  }
  return out;
};

// Preencha com a URL do seu backend depois de publicá-lo (ver README do backend).
// Enquanto ficar vazio, o app usa o armazenamento interno como modo de teste.
const API_BASE_URL = "https://agenda-vistorias-798s.onrender.com";
const useBackend = Boolean(API_BASE_URL);

const CONFIG_KEY = "config:capacity";
const DEFAULT_CAPACITY = 2;

async function apiFetch(path, options) {
  return fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
}

// ---------- configuração de capacidade ----------
async function fetchConfig() {
  if (useBackend) {
    try {
      const res = await apiFetch("/api/config");
      return await res.json();
    } catch {
      return { default: DEFAULT_CAPACITY, overrides: {} };
    }
  }
  try {
    const res = await window.storage.get(CONFIG_KEY, true);
    return res ? JSON.parse(res.value) : { default: DEFAULT_CAPACITY, overrides: {} };
  } catch {
    return { default: DEFAULT_CAPACITY, overrides: {} };
  }
}
async function saveConfig(cfg) {
  if (useBackend) {
    await apiFetch("/api/config", { method: "PUT", body: JSON.stringify(cfg) });
    return;
  }
  await window.storage.set(CONFIG_KEY, JSON.stringify(cfg), true);
}

// ---------- agendamentos ----------
async function fetchDayAppointments(dateKey) {
  if (useBackend) {
    try {
      const res = await apiFetch(`/api/appointments/${dateKey}`);
      return await res.json();
    } catch {
      return [];
    }
  }
  try {
    const res = await window.storage.get(`appointments:${dateKey}`, true);
    return res ? JSON.parse(res.value) : [];
  } catch {
    return [];
  }
}

async function fetchAllAppointments() {
  if (useBackend) {
    try {
      const res = await apiFetch("/api/appointments");
      return await res.json(); // [{date, list}]
    } catch {
      return [];
    }
  }
  let keys = [];
  try {
    const res = await window.storage.list("appointments:", true);
    keys = res?.keys ?? [];
  } catch {
    keys = [];
  }
  const list = await Promise.all(
    keys.map(async (k) => {
      const dateStr = k.replace("appointments:", "");
      return { date: dateStr, list: await fetchDayAppointments(dateStr) };
    })
  );
  return list.filter((e) => e.list.length > 0).sort((a, b) => a.date.localeCompare(b.date));
}

// cria um agendamento; o backend confere a capacidade no servidor (evita condição de corrida)
async function createAppointment(dateKey, payload, cfg) {
  if (useBackend) {
    try {
      const res = await apiFetch("/api/appointments", {
        method: "POST",
        body: JSON.stringify({ date: dateKey, ...payload }),
      });
      if (res.status === 409) {
        const body = await res.json();
        return { ok: false, count: body.count, capacity: body.capacity };
      }
      const appointment = await res.json();
      return { ok: true, appointment };
    } catch {
      return { ok: false, count: null, capacity: null };
    }
  }
  const live = await fetchDayAppointments(dateKey);
  const cap = capacityFor(cfg, dateKey);
  if (live.length >= cap) {
    return { ok: false, count: live.length, capacity: cap };
  }
  const appointment = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    ...payload,
    createdAt: new Date().toISOString(),
  };
  await window.storage.set(`appointments:${dateKey}`, JSON.stringify([...live, appointment]), true);
  return { ok: true, appointment };
}

async function deleteAppointment(dateKey, id) {
  if (useBackend) {
    await apiFetch(`/api/appointments/${dateKey}/${id}`, { method: "DELETE" });
    return;
  }
  const list = await fetchDayAppointments(dateKey);
  await window.storage.set(`appointments:${dateKey}`, JSON.stringify(list.filter((a) => a.id !== id)), true);
}

function capacityFor(cfg, dateKey) {
  if (!cfg) return DEFAULT_CAPACITY;
  return cfg.overrides?.[dateKey] ?? cfg.default ?? DEFAULT_CAPACITY;
}

// ---------- .ics export (Google Calendar / iOS Calendar) ----------
function parseTimeParts(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/(\d{1,2})\s*[h:]\s*(\d{0,2})/i);
  if (!m) return null;
  const h = Math.min(23, parseInt(m[1], 10) || 0);
  const min = Math.min(59, parseInt(m[2] || "0", 10) || 0);
  return { h, min };
}
function icsDateStamp(d) {
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}
function icsEscape(s = "") {
  return String(s).replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}
function buildICS(appointment, dateKey) {
  const day = fromKey(dateKey);
  const parts = parseTimeParts(appointment.time);
  let dtStartLine, dtEndLine;
  if (parts) {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), parts.h, parts.min);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    dtStartLine = `DTSTART:${icsDateStamp(start)}`;
    dtEndLine = `DTEND:${icsDateStamp(end)}`;
  } else {
    const y = day.getFullYear();
    const mo = pad(day.getMonth() + 1);
    const da = pad(day.getDate());
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    dtStartLine = `DTSTART;VALUE=DATE:${y}${mo}${da}`;
    dtEndLine = `DTEND;VALUE=DATE:${next.getFullYear()}${pad(next.getMonth() + 1)}${pad(next.getDate())}`;
  }
  const descBits = [];
  if (appointment.notes) descBits.push(appointment.notes);
  descBits.push(`Solicitado por: ${appointment.name} (${appointment.email})`);
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Caderno de Agendamentos//PT",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${appointment.id}@caderno-agendamentos`,
    `DTSTAMP:${icsDateStamp(new Date())}`,
    dtStartLine,
    dtEndLine,
    `SUMMARY:${icsEscape(appointment.service)}`,
    appointment.local ? `LOCATION:${icsEscape(appointment.local)}` : null,
    `DESCRIPTION:${icsEscape(descBits.join(" — "))}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean);
  return lines.join("\r\n");
}
function downloadICS(appointment, dateKey) {
  const ics = buildICS(appointment, dateKey);
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${appointment.service.replace(/\s+/g, "-").toLowerCase()}-${dateKey}.ics`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- shared visual bits ----------
function Stamp({ visible, label = "AGENDA CHEIA" }) {
  return (
    <div
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "scale(1) rotate(-8deg)" : "scale(1.4) rotate(-8deg)",
        transition: "opacity 240ms ease, transform 240ms ease",
        pointerEvents: "none",
      }}
      className="absolute inset-0 flex items-center justify-center"
    >
      <div
        style={{
          border: "3px solid #B23A2E",
          color: "#B23A2E",
          fontFamily: "'Fraunces', serif",
          fontWeight: 700,
          letterSpacing: "0.12em",
          padding: "10px 22px",
          borderRadius: "6px",
          background: "rgba(251,247,236,0.9)",
        }}
        className="text-lg md:text-2xl"
      >
        {label}
      </div>
    </div>
  );
}

function Ribbon({ text }) {
  return (
    <div
      style={{
        background: "#B08D57",
        color: "#FBF7EC",
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: "11px",
        letterSpacing: "0.08em",
      }}
      className="inline-block px-2 py-1 rounded-sm uppercase"
    >
      {text}
    </div>
  );
}

// ---------- Login ----------
function Login({ onEnter }) {
  const [screen, setScreen] = useState("vistoriador"); // 'vistoriador' | 'admin'
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const isAdmin = screen === "admin";
  const role = isAdmin ? "admin" : "vistoriador";

  return (
    <div className="min-h-full flex items-center justify-center px-4" style={{ background: "#24352C" }}>
      <div
        style={{ background: "#FBF7EC", borderRadius: "10px", boxShadow: "0 20px 60px rgba(0,0,0,0.35)" }}
        className="w-full max-w-md p-8"
      >
        <div className="flex items-center gap-2 mb-1">
          <div style={{ width: 10, height: 10, borderRadius: 999, background: "#B23A2E" }} />
          <span
            style={{ fontFamily: "'JetBrains Mono', monospace", color: "#8a8272", fontSize: 12, letterSpacing: "0.1em" }}
          >
            CADERNO DE AGENDAMENTOS
          </span>
        </div>
        <h1
          style={{ fontFamily: "'Fraunces', serif", color: "#24211C" }}
          className="text-3xl md:text-4xl font-semibold mb-1"
        >
          {isAdmin ? "Acesso administrativo" : "Entrar na agenda"}
        </h1>
        <p style={{ fontFamily: "'Inter', sans-serif", color: "#8a8272" }} className="text-sm mb-6">
          {isAdmin ? "Área restrita para gerenciar a agenda." : "Marque sua vistoria ou elaboração de croqui."}
        </p>

        <label style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide">
          Nome
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Seu nome"
          style={{ borderBottom: "1px solid rgba(36,33,28,0.25)", fontFamily: "'Inter', sans-serif" }}
          className="w-full bg-transparent py-2 mb-4 outline-none text-[#24211C]"
        />

        <label style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide">
          Email
        </label>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="voce@email.com"
          type="email"
          style={{ borderBottom: "1px solid rgba(36,33,28,0.25)", fontFamily: "'Inter', sans-serif" }}
          className="w-full bg-transparent py-2 mb-8 outline-none text-[#24211C]"
        />

        <button
          disabled={!name.trim() || !email.trim()}
          onClick={() => onEnter({ name: name.trim(), email: email.trim(), role })}
          style={{
            background: !name.trim() || !email.trim() ? "#c9c2ae" : "#B23A2E",
            fontFamily: "'Fraunces', serif",
          }}
          className="w-full text-[#FBF7EC] rounded-md py-3 font-semibold tracking-wide transition-colors"
        >
          Entrar
        </button>

        <div className="flex items-center justify-center mt-5">
          <button
            onClick={() => setScreen(isAdmin ? "vistoriador" : "admin")}
            style={{ fontFamily: "'Inter', sans-serif", color: "#8a8272" }}
            className="text-xs underline underline-offset-2"
          >
            {isAdmin ? "← Entrar como vistoriador" : "Acesso administrativo"}
          </button>
        </div>

        <p style={{ fontFamily: "'Inter', sans-serif", color: "#8a8272" }} className="text-xs mt-4">
          Protótipo: login simples, sem senha. Os agendamentos ficam salvos e visíveis para
          quem acessar este app.
        </p>
      </div>
    </div>
  );
}

// ---------- Client view ----------
function ClientView({ profile, onLogout }) {
  const days = useMemo(() => nextDays(21), []);
  const [selected, setSelected] = useState(days[0]);
  const [config, setCfg] = useState(null);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(true);
  const [service, setService] = useState("");
  const [time, setTime] = useState("");
  const [local, setLocal] = useState("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState(null); // 'ok' | 'full' | null
  const [lastAppointment, setLastAppointment] = useState(null);

  const SERVICE_OPTIONS = ["Vistoria", "Elaboração de croqui"];
  const [submitting, setSubmitting] = useState(false);
  const [myAppointments, setMyAppointments] = useState([]);

  const selectedKey = toKey(selected);

  const loadAll = useCallback(async () => {
    setLoading(true);
    const cfg = await fetchConfig();
    setCfg(cfg);
    const entries = await Promise.all(days.map(async (d) => [toKey(d), (await fetchDayAppointments(toKey(d))).length]));
    setCounts(Object.fromEntries(entries));
    setLoading(false);
  }, [days]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    (async () => {
      const list = await fetchDayAppointments(selectedKey);
      setMyAppointments(list.filter((a) => a.email === profile.email));
    })();
  }, [selectedKey, profile.email]);

  const cap = config ? capacityFor(config, selectedKey) : DEFAULT_CAPACITY;
  const count = counts[selectedKey] ?? 0;
  const isFull = count >= cap;

  const handleSubmit = async () => {
    if (!service.trim()) return;
    setSubmitting(true);
    setStatus(null);
    const payload = {
      name: profile.name,
      email: profile.email,
      service: service.trim(),
      time: time.trim(),
      local: local.trim(),
      notes: notes.trim(),
    };
    const result = await createAppointment(selectedKey, payload, config);
    if (!result.ok) {
      if (result.count != null) setCounts((c) => ({ ...c, [selectedKey]: result.count }));
      setStatus("full");
      setSubmitting(false);
      return;
    }
    const appointment = result.appointment;
    setCounts((c) => ({ ...c, [selectedKey]: (c[selectedKey] ?? 0) + 1 }));
    setMyAppointments((m) => [...m, appointment]);
    setService("");
    setTime("");
    setLocal("");
    setNotes("");
    setStatus("ok");
    setLastAppointment(appointment);
    setSubmitting(false);
  };

  return (
    <div style={{ background: "#FBF7EC", minHeight: "100%" }}>
      <Header profile={profile} onLogout={onLogout} />

      <div className="max-w-3xl mx-auto px-4 pb-16">
        <h2 style={{ fontFamily: "'Fraunces', serif", color: "#24211C" }} className="text-2xl md:text-3xl font-semibold mt-6 mb-1">
          Escolha um dia
        </h2>
        <p style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-sm mb-5">
          As faixas mostram quantas vagas já foram preenchidas naquele dia.
        </p>

        <div className="flex gap-2 overflow-x-auto pb-3 mb-6" style={{ scrollbarWidth: "thin" }}>
          {days.map((d) => {
            const k = toKey(d);
            const c = counts[k] ?? 0;
            const dCap = config ? capacityFor(config, k) : DEFAULT_CAPACITY;
            const full = c >= dCap;
            const active = k === selectedKey;
            const pct = Math.min(100, (c / dCap) * 100);
            return (
              <button
                key={k}
                onClick={() => {
                  setSelected(d);
                  setStatus(null);
                }}
                style={{
                  minWidth: 64,
                  border: `1px solid ${active ? "#24352C" : "rgba(36,33,28,0.15)"}`,
                  background: active ? "#24352C" : "#fff",
                }}
                className="rounded-lg px-3 py-2 flex flex-col items-center flex-shrink-0 transition-colors"
              >
                <span
                  style={{ fontFamily: "'JetBrains Mono', monospace", color: active ? "#d8cdb0" : "#8a8272" }}
                  className="text-[10px] uppercase"
                >
                  {weekdayShort(d)}
                </span>
                <span
                  style={{ fontFamily: "'Fraunces', serif", color: active ? "#FBF7EC" : "#24211C" }}
                  className="text-lg font-semibold"
                >
                  {pad(d.getDate())}
                </span>
                <div style={{ width: "100%", height: 4, background: active ? "rgba(251,247,236,0.25)" : "rgba(36,33,28,0.1)", borderRadius: 999, marginTop: 4 }}>
                  <div
                    style={{
                      width: `${pct}%`,
                      height: "100%",
                      borderRadius: 999,
                      background: full ? "#B23A2E" : "#3F6B4E",
                    }}
                  />
                </div>
              </button>
            );
          })}
        </div>

        <div style={{ background: "#fff", border: "1px solid rgba(36,33,28,0.1)", borderRadius: 12 }} className="relative overflow-hidden p-6">
          <Stamp visible={status === "full" || (isFull && status !== "ok")} />

          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 style={{ fontFamily: "'Fraunces', serif", color: "#24211C" }} className="text-xl font-semibold capitalize">
                {fmtLong(selected)}
              </h3>
              <p style={{ fontFamily: "'JetBrains Mono', monospace", color: "#8a8272" }} className="text-xs mt-1">
                {loading ? "carregando…" : `${count} de ${cap} vagas ocupadas`}
              </p>
            </div>
            <Ribbon text={isFull ? "lotado" : "vagas abertas"} />
          </div>

          {status === "ok" && (
            <div style={{ background: "#e9f1ea", border: "1px solid #3F6B4E33" }} className="rounded-md px-3 py-2 mb-4 text-sm">
              <div className="flex items-center gap-2">
                <Check size={16} color="#3F6B4E" />
                <span style={{ color: "#284631" }}>Agendamento confirmado para {fmtShort(selected)}.</span>
              </div>
              {lastAppointment && (
                <button
                  onClick={() => downloadICS(lastAppointment, selectedKey)}
                  style={{ fontFamily: "'Inter', sans-serif", color: "#24352C", border: "1px solid #24352C55" }}
                  className="flex items-center gap-1 rounded-md px-3 py-1.5 mt-2 text-xs"
                >
                  <CalendarPlus size={13} /> Adicionar ao calendário (iOS / Google)
                </button>
              )}
            </div>
          )}
          {status === "full" && (
            <div style={{ background: "#f6e6e3", border: "1px solid #B23A2E33" }} className="flex items-center gap-2 rounded-md px-3 py-2 mb-4 text-sm">
              <AlertCircle size={16} color="#B23A2E" />
              <span style={{ color: "#7a2a20" }}>Esse dia acabou de lotar. Escolha outra data.</span>
            </div>
          )}

          <fieldset disabled={isFull || submitting} className={isFull ? "opacity-40" : ""}>
            <label style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide flex items-center gap-1 mb-2">
              <Briefcase size={12} /> Serviço desejado
            </label>
            <div className="flex gap-2 mb-4">
              {SERVICE_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  onClick={() => setService(opt)}
                  style={{
                    fontFamily: "'Inter', sans-serif",
                    border: `1px solid ${service === opt ? "#24352C" : "rgba(36,33,28,0.2)"}`,
                    background: service === opt ? "#24352C" : "transparent",
                    color: service === opt ? "#FBF7EC" : "#24211C",
                  }}
                  className="flex-1 rounded-md py-2 text-sm transition-colors"
                >
                  {opt}
                </button>
              ))}
            </div>

            <label style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide flex items-center gap-1">
              <Clock size={12} /> Horário preferido (opcional)
            </label>
            <input
              value={time}
              onChange={(e) => setTime(e.target.value)}
              placeholder="Ex.: 14h30"
              style={{ borderBottom: "1px solid rgba(36,33,28,0.25)", fontFamily: "'Inter', sans-serif" }}
              className="w-full bg-transparent py-2 mb-4 outline-none text-[#24211C]"
            />
            <label style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide flex items-center gap-1">
              <MapPin size={12} /> Local (opcional)
            </label>
            <input
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              placeholder="Ex.: Unidade Centro, sala 3, endereço…"
              style={{ borderBottom: "1px solid rgba(36,33,28,0.25)", fontFamily: "'Inter', sans-serif" }}
              className="w-full bg-transparent py-2 mb-4 outline-none text-[#24211C]"
            />
            <label style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide flex items-center gap-1">
              <AlertCircle size={12} /> Observação técnica (opcional)
            </label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Descreva o que precisa ser verificado ou feito no local…"
              rows={3}
              style={{ border: "1px solid rgba(36,33,28,0.2)", fontFamily: "'Inter', sans-serif", borderRadius: 6 }}
              className="w-full bg-transparent px-3 py-2 mb-6 outline-none text-[#24211C] resize-none"
            />
          </fieldset>

          <button
            disabled={isFull || submitting || !service.trim()}
            onClick={handleSubmit}
            style={{
              background: isFull || !service.trim() ? "#c9c2ae" : "#24352C",
              fontFamily: "'Fraunces', serif",
            }}
            className="text-[#FBF7EC] rounded-md px-5 py-2.5 font-semibold tracking-wide"
          >
            {isFull ? "Dia lotado" : submitting ? "Agendando…" : "Confirmar agendamento"}
          </button>
        </div>

        {myAppointments.length > 0 && (
          <div className="mt-6">
            <h4 style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide mb-2">
              Seus agendamentos neste dia
            </h4>
            {myAppointments.map((a) => (
              <div
                key={a.id}
                style={{ borderBottom: "1px dashed rgba(36,33,28,0.2)", fontFamily: "'Inter', sans-serif" }}
                className="py-2 text-sm text-[#24211C]"
              >
                <div className="flex items-center justify-between">
                  <span>
                    {a.service}
                    {a.local && <span style={{ color: "#8a8272" }}> · {a.local}</span>}
                  </span>
                  <div className="flex items-center gap-2">
                    <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#8a8272" }}>{a.time || "sem horário"}</span>
                    <button onClick={() => downloadICS(a, selectedKey)} title="Adicionar ao calendário">
                      <CalendarPlus size={14} color="#24352C" />
                    </button>
                  </div>
                </div>
                {a.notes && (
                  <p style={{ color: "#8a8272" }} className="text-xs mt-1">
                    {a.notes}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Admin view ----------
function AdminView({ profile, onLogout }) {
  const [config, setCfgState] = useState(null);
  const [entries, setEntries] = useState([]); // [{key, date, list}]
  const [loading, setLoading] = useState(true);
  const [openDate, setOpenDate] = useState(null);
  const [defaultCap, setDefaultCap] = useState(DEFAULT_CAPACITY);
  const [overrideDate, setOverrideDate] = useState("");
  const [overrideVal, setOverrideVal] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const cfg = await fetchConfig();
    setCfgState(cfg);
    setDefaultCap(cfg.default);
    const list = await fetchAllAppointments();
    setEntries(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const saveDefault = async () => {
    const cfg = { ...(config || { overrides: {} }), default: Number(defaultCap) || DEFAULT_CAPACITY };
    await saveConfig(cfg);
    setCfgState(cfg);
  };

  const saveOverride = async () => {
    if (!overrideDate || !overrideVal) return;
    const cfg = { ...(config || { default: DEFAULT_CAPACITY, overrides: {} }) };
    cfg.overrides = { ...(cfg.overrides || {}), [overrideDate]: Number(overrideVal) };
    await saveConfig(cfg);
    setCfgState(cfg);
    setOverrideDate("");
    setOverrideVal("");
  };

  const removeAppointment = async (dateStr, id) => {
    await deleteAppointment(dateStr, id);
    setEntries((es) => es.map((e) => (e.date === dateStr ? { ...e, list: e.list.filter((a) => a.id !== id) } : e)).filter((e) => e.list.length > 0));
  };

  return (
    <div style={{ background: "#FBF7EC", minHeight: "100%" }}>
      <Header profile={profile} onLogout={onLogout} />

      <div className="max-w-3xl mx-auto px-4 pb-16">
        <h2 style={{ fontFamily: "'Fraunces', serif", color: "#24211C" }} className="text-2xl md:text-3xl font-semibold mt-6 mb-1">
          Sua agenda
        </h2>
        <p style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-sm mb-6">
          Defina quantos agendamentos cabem por dia e acompanhe quem marcou.
        </p>

        <div style={{ background: "#fff", border: "1px solid rgba(36,33,28,0.1)", borderRadius: 12 }} className="p-5 mb-6">
          <div className="flex items-center gap-2 mb-4">
            <Settings size={16} color="#24352C" />
            <h3 style={{ fontFamily: "'Fraunces', serif", color: "#24211C" }} className="font-semibold">
              Capacidade
            </h3>
          </div>
          <div className="flex items-end gap-3 flex-wrap mb-4">
            <div>
              <label style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide block mb-1">
                Padrão por dia
              </label>
              <input
                type="number"
                min="1"
                value={defaultCap}
                onChange={(e) => setDefaultCap(e.target.value)}
                style={{ border: "1px solid rgba(36,33,28,0.2)", fontFamily: "'JetBrains Mono', monospace" }}
                className="w-24 rounded-md px-2 py-1.5 text-[#24211C]"
              />
            </div>
            <button
              onClick={saveDefault}
              style={{ background: "#24352C", fontFamily: "'Inter', sans-serif" }}
              className="text-[#FBF7EC] rounded-md px-4 py-1.5 text-sm"
            >
              Salvar
            </button>
          </div>

          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide block mb-1">
                Exceção para um dia (AAAA-MM-DD)
              </label>
              <input
                value={overrideDate}
                onChange={(e) => setOverrideDate(e.target.value)}
                placeholder="2026-08-15"
                style={{ border: "1px solid rgba(36,33,28,0.2)", fontFamily: "'JetBrains Mono', monospace" }}
                className="w-36 rounded-md px-2 py-1.5 text-[#24211C]"
              />
            </div>
            <div>
              <label style={{ fontFamily: "'Inter', sans-serif", color: "#5b5648" }} className="text-xs uppercase tracking-wide block mb-1">
                Vagas nesse dia
              </label>
              <input
                type="number"
                min="0"
                value={overrideVal}
                onChange={(e) => setOverrideVal(e.target.value)}
                style={{ border: "1px solid rgba(36,33,28,0.2)", fontFamily: "'JetBrains Mono', monospace" }}
                className="w-24 rounded-md px-2 py-1.5 text-[#24211C]"
              />
            </div>
            <button
              onClick={saveOverride}
              style={{ border: "1px solid #24352C", color: "#24352C", fontFamily: "'Inter', sans-serif" }}
              className="rounded-md px-4 py-1.5 text-sm flex items-center gap-1"
            >
              <Plus size={14} /> Definir
            </button>
          </div>

          {config?.overrides && Object.keys(config.overrides).length > 0 && (
            <div className="mt-4 flex flex-wrap gap-2">
              {Object.entries(config.overrides).map(([d, v]) => (
                <span key={d} style={{ fontFamily: "'JetBrains Mono', monospace" }} className="text-xs bg-[#F0EBDB] text-[#5b5648] rounded px-2 py-1">
                  {d}: {v} vagas
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 mb-3">
          <Users size={16} color="#24352C" />
          <h3 style={{ fontFamily: "'Fraunces', serif", color: "#24211C" }} className="font-semibold">
            Dias com agendamentos
          </h3>
        </div>

        {loading && <p style={{ fontFamily: "'Inter', sans-serif", color: "#8a8272" }}>Carregando…</p>}
        {!loading && entries.length === 0 && (
          <p style={{ fontFamily: "'Inter', sans-serif", color: "#8a8272" }} className="text-sm">
            Ainda não há agendamentos.
          </p>
        )}

        {entries.map((e) => {
          const cap = capacityFor(config, e.date);
          const full = e.list.length >= cap;
          const open = openDate === e.date;
          return (
            <div key={e.date} style={{ background: "#fff", border: "1px solid rgba(36,33,28,0.1)", borderRadius: 10 }} className="mb-2 overflow-hidden">
              <button
                onClick={() => setOpenDate(open ? null : e.date)}
                className="w-full flex items-center justify-between px-4 py-3"
              >
                <span style={{ fontFamily: "'Fraunces', serif", color: "#24211C" }} className="capitalize">
                  {fmtLong(fromKey(e.date))}
                </span>
                <div className="flex items-center gap-2">
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", color: full ? "#B23A2E" : "#3F6B4E" }} className="text-xs">
                    {e.list.length}/{cap}
                  </span>
                  <Calendar size={14} color="#8a8272" />
                </div>
              </button>
              {open && (
                <div style={{ borderTop: "1px dashed rgba(36,33,28,0.15)" }} className="px-4 py-2">
                  {e.list.map((a) => (
                    <div key={a.id} className="flex items-start justify-between py-2 gap-2" style={{ borderBottom: "1px solid rgba(36,33,28,0.06)" }}>
                      <div style={{ fontFamily: "'Inter', sans-serif" }}>
                        <p className="text-sm text-[#24211C]">
                          <User size={12} className="inline mr-1" />
                          {a.name} — {a.service}
                        </p>
                        <p style={{ fontFamily: "'JetBrains Mono', monospace", color: "#8a8272" }} className="text-xs">
                          {a.email} {a.time && `· ${a.time}`} {a.local && `· ${a.local}`}
                        </p>
                        {a.notes && (
                          <p style={{ color: "#5b5648" }} className="text-xs mt-1 italic">
                            "{a.notes}"
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 mt-0.5">
                        <button onClick={() => downloadICS(a, e.date)} title="Adicionar ao calendário">
                          <CalendarPlus size={14} color="#24352C" />
                        </button>
                        <button onClick={() => removeAppointment(e.date, a.id)}>
                          <Trash2 size={14} color="#B23A2E" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Header({ profile, onLogout }) {
  return (
    <div style={{ background: "#24352C" }} className="px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div style={{ width: 8, height: 8, borderRadius: 999, background: "#B08D57" }} />
        <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#d8cdb0" }} className="text-xs uppercase tracking-wide">
          {profile.role === "admin" ? "painel administrativo" : `olá, ${profile.name.split(" ")[0]}`}
        </span>
      </div>
      <button onClick={onLogout} className="flex items-center gap-1" style={{ fontFamily: "'Inter', sans-serif", color: "#d8cdb0" }}>
        <LogOut size={13} />
        <span className="text-xs">sair</span>
      </button>
    </div>
  );
}

export default function App() {
  const [profile, setProfile] = useState(null);

  return (
    <div className="min-h-screen">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600;700&family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;500&display=swap');
      `}</style>
      {!profile ? (
        <Login onEnter={setProfile} />
      ) : profile.role === "admin" ? (
        <AdminView profile={profile} onLogout={() => setProfile(null)} />
      ) : (
        <ClientView profile={profile} onLogout={() => setProfile(null)} />
      )}
    </div>
  );
}
