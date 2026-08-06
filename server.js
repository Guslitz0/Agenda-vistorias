const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "data.json");

// Token secreto usado na URL do feed de calendário (ex: /agenda/SEU_TOKEN.ics)
// Defina isso como variável de ambiente no seu serviço de hospedagem.
// Se não definir, um token é gerado uma vez e salvo em .token (só pra facilitar testes locais).
let CALENDAR_TOKEN = process.env.CALENDAR_TOKEN;
if (!CALENDAR_TOKEN) {
  const tokenFile = path.join(__dirname, ".token");
  if (fs.existsSync(tokenFile)) {
    CALENDAR_TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
  } else {
    CALENDAR_TOKEN = crypto.randomBytes(16).toString("hex");
    fs.writeFileSync(tokenFile, CALENDAR_TOKEN);
    console.log("Token de calendário gerado:", CALENDAR_TOKEN);
  }
}

const DEFAULT_CAPACITY = 2;

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "*" }));
app.use(express.json());

// ---------- armazenamento em arquivo JSON, com fila simples para evitar corrupção ----------
function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { config: { default: DEFAULT_CAPACITY, overrides: {} }, appointments: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return { config: { default: DEFAULT_CAPACITY, overrides: {} }, appointments: {} };
  }
}

let writeQueue = Promise.resolve();
function writeData(data) {
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve, reject) => {
        fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2), (err) => (err ? reject(err) : resolve()));
      })
  );
  return writeQueue;
}

function capacityFor(cfg, dateKey) {
  return cfg.overrides?.[dateKey] ?? cfg.default ?? DEFAULT_CAPACITY;
}

// ---------- rotas da API ----------

app.get("/api/config", (req, res) => {
  const data = readData();
  res.json(data.config);
});

app.put("/api/config", async (req, res) => {
  const data = readData();
  const { default: def, overrides } = req.body || {};
  data.config = {
    default: Number(def) || data.config.default || DEFAULT_CAPACITY,
    overrides: overrides || data.config.overrides || {},
  };
  await writeData(data);
  res.json(data.config);
});

// lista agendamentos de UM dia (usado pelo vistoriador pra ver vagas)
app.get("/api/appointments/:date", (req, res) => {
  const data = readData();
  res.json(data.appointments[req.params.date] || []);
});

// lista TODOS os dias com agendamentos (usado no painel administrativo)
app.get("/api/appointments", (req, res) => {
  const data = readData();
  const out = Object.entries(data.appointments)
    .filter(([, list]) => list.length > 0)
    .map(([date, list]) => ({ date, list }))
    .sort((a, b) => a.date.localeCompare(b.date));
  res.json(out);
});

// cria um agendamento (o servidor confere a capacidade, evitando condição de corrida)
app.post("/api/appointments", async (req, res) => {
  const { date, name, email, service, time, local, notes } = req.body || {};
  if (!date || !name || !email || !service) {
    return res.status(400).json({ error: "campos obrigatórios faltando" });
  }
  const data = readData();
  const list = data.appointments[date] || [];
  const cap = capacityFor(data.config, date);
  if (list.length >= cap) {
    return res.status(409).json({ error: "full", count: list.length, capacity: cap });
  }
  const appointment = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    email,
    service,
    time: time || "",
    local: local || "",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  data.appointments[date] = [...list, appointment];
  await writeData(data);
  res.status(201).json(appointment);
});

app.delete("/api/appointments/:date/:id", async (req, res) => {
  const { date, id } = req.params;
  const data = readData();
  const list = data.appointments[date] || [];
  data.appointments[date] = list.filter((a) => a.id !== id);
  await writeData(data);
  res.json({ ok: true });
});

// ---------- feed .ics assinável (Google Calendar / iOS) ----------
function pad(n) {
  return String(n).padStart(2, "0");
}
function fromKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
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
function parseTimeParts(timeStr) {
  if (!timeStr) return null;
  const m = timeStr.match(/(\d{1,2})\s*[h:]\s*(\d{0,2})/i);
  if (!m) return null;
  return { h: Math.min(23, parseInt(m[1], 10) || 0), min: Math.min(59, parseInt(m[2] || "0", 10) || 0) };
}
function buildEvent(appointment, dateKey) {
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
  return [
    "BEGIN:VEVENT",
    `UID:${appointment.id}@caderno-agendamentos`,
    `DTSTAMP:${icsDateStamp(new Date())}`,
    dtStartLine,
    dtEndLine,
    `SUMMARY:${icsEscape(appointment.service)}`,
    appointment.local ? `LOCATION:${icsEscape(appointment.local)}` : null,
    `DESCRIPTION:${icsEscape(descBits.join(" — "))}`,
    "END:VEVENT",
  ]
    .filter(Boolean)
    .join("\r\n");
}

app.get("/agenda/:token.ics", (req, res) => {
  if (req.params.token !== CALENDAR_TOKEN) {
    return res.status(403).send("Token inválido");
  }
  const data = readData();
  const events = [];
  for (const [date, list] of Object.entries(data.appointments)) {
    for (const appt of list) events.push(buildEvent(appt, date));
  }
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Caderno de Agendamentos//PT",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Agenda de Vistorias",
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    ...events,
    "END:VCALENDAR",
  ].join("\r\n");
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.send(ics);
});

app.get("/", (req, res) => {
  res.send("Backend da agenda de vistorias no ar.");
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Link do calendário: /agenda/${CALENDAR_TOKEN}.ics`);
});
