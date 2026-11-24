// Classfit website server: static pages plus member accounts and front desk API.
// No dependencies: Node's built-in http, crypto and sqlite (Node 22.13+).
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
// Front desk access. While STAFF_PIN is not set, the front desk is OPEN TO EVERYONE
// (anyone can see member details and change subscriptions). Set STAFF_PIN before going live.
const STAFF_PIN = process.env.STAFF_PIN || "";
const DESK_OPEN = !STAFF_PIN;
// Public address used in password reset emails. Set SITE_URL when hosted.
const SITE_URL = (process.env.SITE_URL || "").replace(/\/$/, "");
const RESET_MINUTES = 60;
const SESSION_DAYS = 30;
const DESK_SESSION_HOURS = 12;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, "classfit.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY,
    member_no TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    sub_until TEXT,               -- last day the subscription is valid, YYYY-MM-DD
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    kind TEXT NOT NULL,           -- 'member' or 'desk'
    member_id INTEGER,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS resets (
    token_hash TEXT PRIMARY KEY,
    member_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS checkins (
    id INTEGER PRIMARY KEY,
    member_id INTEGER NOT NULL,
    at TEXT NOT NULL DEFAULT (datetime('now')),
    active INTEGER NOT NULL
  );
`);

function addColumn(table, name, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${def}`);
}
addColumn("members", "is_guest", "INTEGER NOT NULL DEFAULT 0");
addColumn("members", "notes", "TEXT NOT NULL DEFAULT ''");       // trainer notes: goals, injuries...
addColumn("checkins", "source", "TEXT NOT NULL DEFAULT 'desk'");  // 'desk' or 'trainer'
addColumn("checkins", "staff", "TEXT NOT NULL DEFAULT ''");       // trainer name, if marked by a trainer

// ---------- helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".ico": "image/x-icon", ".json": "application/json",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("bad json")); } });
    req.on("error", reject);
  });
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map(c => c.trim().split("=")).filter(p => p[0]));
}

function setCookie(name, value, maxAgeSec) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function checkPassword(password, salt, hash) {
  const got = Buffer.from(hashPassword(password, salt).hash, "hex");
  return crypto.timingSafeEqual(got, Buffer.from(hash, "hex"));
}

function newSession(kind, memberId, seconds) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO sessions (token, kind, member_id, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, kind, memberId ?? null, Date.now() + seconds * 1000);
  return token;
}

function session(req, kind) {
  const token = cookies(req)[kind === "desk" ? "cf_desk" : "cf_member"];
  if (!token) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE token = ? AND kind = ?").get(token, kind);
  if (!row || row.expires_at < Date.now()) return null;
  return row;
}

// Gym is in Varna; dates are local to Europe/Sofia.
function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(new Date());
}

function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  // Clamp end-of-month overflow (e.g. Jan 31 + 1 month -> Feb 28).
  if (dt.getUTCDate() !== d) dt.setUTCDate(0);
  return dt.toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const dt = new Date(isoDate + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function status(member) {
  const t = today();
  const active = !!member.sub_until && member.sub_until >= t;
  const daysLeft = active
    ? Math.round((Date.parse(member.sub_until) - Date.parse(t)) / 86400000) + 1
    : 0;
  return { active, sub_until: member.sub_until, days_left: daysLeft };
}

function publicMember(m) {
  return { member_no: m.member_no, name: m.name, email: m.email, phone: m.phone,
           created_at: m.created_at, guest: !!m.is_guest, ...status(m) };
}

function newMemberNo() {
  for (;;) {
    const no = "CF-" + crypto.randomInt(100000, 1000000);
    if (!db.prepare("SELECT 1 FROM members WHERE member_no = ?").get(no)) return no;
  }
}

// Store Bulgarian numbers one way: "+359 88..." and "088..." both become "088...".
function normPhone(p) {
  return String(p || "").replace(/[^\d+]/g, "").replace(/^(\+|00)359/, "0");
}

// Password rules: at least 10 characters, upper and lower case letters and a digit,
// not a common password, and not containing the email name.
const COMMON = new Set(["password1", "password123", "qwerty123", "1234567890", "parola1234", "classfit123", "iloveyou1", "welcome123", "abc1234567"]);
function passwordProblem(pw, email = "") {
  if (pw.length < 10 || pw.length > 200) return "weak_password";
  if (!/[a-zа-я]/.test(pw) || !/[A-ZА-Я]/.test(pw) || !/\d/.test(pw)) return "weak_password";
  if (COMMON.has(pw.toLowerCase())) return "weak_password";
  const local = email.split("@")[0].toLowerCase();
  if (local.length >= 4 && pw.toLowerCase().includes(local)) return "weak_password";
  return null;
}

// Email. No mail provider is connected yet: messages are saved to data/outbox and printed
// in the server log. Replace sendMail with a real provider (SMTP, Resend, Mailgun...) to go live.
const OUTBOX = path.join(DATA_DIR, "outbox");
function sendMail(to, subject, text) {
  fs.mkdirSync(OUTBOX, { recursive: true });
  const file = path.join(OUTBOX, `${Date.now()}-${to.replace(/[^a-z0-9@.]/gi, "_")}.txt`);
  fs.writeFileSync(file, `To: ${to}
Subject: ${subject}

${text}
`);
  console.log(`[mail] to ${to}: ${subject} (saved to ${path.relative(__dirname, file)})`);
}

function sendResetEmail(req, member) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO resets (token_hash, member_id, expires_at) VALUES (?, ?, ?)")
    .run(hash, member.id, Date.now() + RESET_MINUTES * 60000);
  const base = SITE_URL || `http://${req.headers.host}`;
  const link = `${base}/reset.html?token=${token}`;
  sendMail(member.email, "Classfit: смяна на парола / password reset",
    `Здравей, ${member.name}!

За да смениш паролата си, отвори:
${link}

Линкът важи ${RESET_MINUTES} минути. Ако не си искал смяна, игнорирай този имейл.

---
To reset your password, open the link above. It works for ${RESET_MINUTES} minutes. If you didn't ask for this, ignore this email.`);
}

// Demo guest account: a shared, read-only profile with sample data so people can look around.
const GUEST_EMAIL = "guest@classfit.demo";
function guestMember() {
  let g = db.prepare("SELECT * FROM members WHERE email = ?").get(GUEST_EMAIL);
  if (!g) {
    const { salt, hash } = hashPassword(crypto.randomBytes(24).toString("hex")); // nobody can log in with a password
    db.prepare("INSERT INTO members (member_no, name, email, phone, pass_hash, pass_salt, is_guest) VALUES (?, ?, ?, ?, ?, ?, 1)")
      .run("CF-000000", "Гост", GUEST_EMAIL, "0000000000", hash, salt);
    g = db.prepare("SELECT * FROM members WHERE email = ?").get(GUEST_EMAIL);
  }
  // Keep the sample fresh: subscription with 18 days left and a few recent visits.
  db.prepare("UPDATE members SET sub_until = ? WHERE id = ?").run(addDays(today(), 17), g.id);
  db.prepare("DELETE FROM checkins WHERE member_id = ?").run(g.id);
  const ins = db.prepare("INSERT INTO checkins (member_id, at, active) VALUES (?, datetime('now', ?), 1)");
  for (const d of [1, 3, 4, 6, 8, 11, 13]) ins.run(g.id, `-${d} days`);
  return db.prepare("SELECT * FROM members WHERE id = ?").get(g.id);
}
function isGuestSession(s) {
  return !!db.prepare("SELECT is_guest FROM members WHERE id = ?").get(s.member_id)?.is_guest;
}

// Find a real member from a scanned QR, member number, email or phone. Never the demo guest.
function findMember(q) {
  q = String(q || "").trim();
  const no = q.toUpperCase().match(/CF-?(\d{6})/);
  let m = null;
  if (no) m = db.prepare("SELECT * FROM members WHERE member_no = ?").get("CF-" + no[1]);
  else if (q.includes("@")) m = db.prepare("SELECT * FROM members WHERE email = ?").get(q.toLowerCase());
  else if (normPhone(q).length >= 6) m = db.prepare("SELECT * FROM members WHERE phone = ?").get(normPhone(q));
  return m && !m.is_guest ? m : null;
}

// Full member card for staff: details, notes, visits.
function staffMember(m) {
  const visits = db.prepare("SELECT at, active, source, staff FROM checkins WHERE member_id = ? ORDER BY at DESC, id DESC").all(m.id);
  const sofiaDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" });
  const dayOf = at => sofiaDay.format(new Date(at.replace(" ", "T") + "Z"));
  const t = today(), month = t.slice(0, 7);
  return {
    ...publicMember(m), notes: m.notes || "",
    visits_total: visits.length,
    visits_month: visits.filter(v => dayOf(v.at).startsWith(month)).length,
    visited_today: visits.find(v => dayOf(v.at) === t) || null,
    visits: visits.slice(0, 30),
  };
}

function deskAllowed(req) { return DESK_OPEN || !!session(req, "desk"); }

// Simple in-memory lockout for the desk PIN: 5 wrong tries, then 5 minutes.
const pinFails = new Map();

// ---------- API ----------
const routes = {
  "POST /api/register": async (req, res) => {
    const b = await readBody(req);
    const name = String(b.name || "").trim();
    const email = String(b.email || "").trim().toLowerCase();
    const phone = normPhone(b.phone);
    const password = String(b.password || "");
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || phone.length < 6)
      return send(res, 400, { error: "invalid_fields" });
    if (passwordProblem(password, email)) return send(res, 400, { error: "weak_password" });
    if (db.prepare("SELECT 1 FROM members WHERE email = ?").get(email))
      return send(res, 409, { error: "email_taken" });
    const { salt, hash } = hashPassword(password);
    const memberNo = newMemberNo();
    const r = db.prepare("INSERT INTO members (member_no, name, email, phone, pass_hash, pass_salt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(memberNo, name, email, phone, hash, salt);
    const token = newSession("member", Number(r.lastInsertRowid), SESSION_DAYS * 86400);
    send(res, 201, { ok: true }, { "Set-Cookie": setCookie("cf_member", token, SESSION_DAYS * 86400) });
  },

  "POST /api/login": async (req, res) => {
    const b = await readBody(req);
    const m = db.prepare("SELECT * FROM members WHERE email = ?").get(String(b.email || "").trim().toLowerCase());
    if (!m || !checkPassword(String(b.password || ""), m.pass_salt, m.pass_hash))
      return send(res, 401, { error: "bad_login" });
    const token = newSession("member", m.id, SESSION_DAYS * 86400);
    send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cf_member", token, SESSION_DAYS * 86400) });
  },

  "POST /api/guest": async (req, res) => {
    const g = guestMember();
    const token = newSession("member", g.id, 4 * 3600);
    send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cf_member", token, 4 * 3600) });
  },

  "POST /api/logout": async (req, res) => {
    const token = cookies(req).cf_member;
    if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cf_member", "", 0) });
  },

  "GET /api/me": async (req, res) => {
    const s = session(req, "member");
    if (!s) return send(res, 401, { error: "not_logged_in" });
    const m = db.prepare("SELECT * FROM members WHERE id = ?").get(s.member_id);
    if (!m) return send(res, 401, { error: "not_logged_in" });
    send(res, 200, publicMember(m));
  },

  "GET /api/me/visits": async (req, res) => {
    const s = session(req, "member");
    if (!s) return send(res, 401, { error: "not_logged_in" });
    const month = today().slice(0, 7);
    const sofiaDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" });
    const all = db.prepare("SELECT at, active FROM checkins WHERE member_id = ? ORDER BY at DESC, id DESC").all(s.member_id);
    send(res, 200, {
      total: all.length,
      this_month: all.filter(c => sofiaDay.format(new Date(c.at.replace(" ", "T") + "Z")).startsWith(month)).length,
      recent: all.slice(0, 10),
    });
  },

  "POST /api/me/update": async (req, res) => {
    const s = session(req, "member");
    if (!s) return send(res, 401, { error: "not_logged_in" });
    if (isGuestSession(s)) return send(res, 403, { error: "guest_read_only" });
    const b = await readBody(req);
    const name = String(b.name || "").trim(), phone = normPhone(b.phone);
    if (!name || phone.length < 6) return send(res, 400, { error: "invalid_fields" });
    db.prepare("UPDATE members SET name = ?, phone = ? WHERE id = ?").run(name, phone, s.member_id);
    send(res, 200, publicMember(db.prepare("SELECT * FROM members WHERE id = ?").get(s.member_id)));
  },

  "POST /api/me/password": async (req, res) => {
    const s = session(req, "member");
    if (!s) return send(res, 401, { error: "not_logged_in" });
    if (isGuestSession(s)) return send(res, 403, { error: "guest_read_only" });
    const b = await readBody(req);
    const m = db.prepare("SELECT * FROM members WHERE id = ?").get(s.member_id);
    if (!checkPassword(String(b.current || ""), m.pass_salt, m.pass_hash)) return send(res, 401, { error: "bad_current" });
    if (passwordProblem(String(b.next || ""), m.email)) return send(res, 400, { error: "weak_password" });
    const { salt, hash } = hashPassword(String(b.next));
    db.prepare("UPDATE members SET pass_hash = ?, pass_salt = ? WHERE id = ?").run(hash, salt, m.id);
    // Log out every other device.
    db.prepare("DELETE FROM sessions WHERE kind = 'member' AND member_id = ? AND token != ?").run(m.id, s.token);
    send(res, 200, { ok: true });
  },

  // Always answers the same way, so it can't be used to find out who has an account.
  "POST /api/password/forgot": async (req, res) => {
    const email = String((await readBody(req)).email || "").trim().toLowerCase();
    const m = db.prepare("SELECT * FROM members WHERE email = ?").get(email);
    if (m) sendResetEmail(req, m);
    send(res, 200, { ok: true });
  },

  "POST /api/me/reset-email": async (req, res) => {
    const s = session(req, "member");
    if (!s) return send(res, 401, { error: "not_logged_in" });
    if (isGuestSession(s)) return send(res, 403, { error: "guest_read_only" });
    const m = db.prepare("SELECT * FROM members WHERE id = ?").get(s.member_id);
    sendResetEmail(req, m);
    send(res, 200, { ok: true, email: m.email });
  },

  "POST /api/password/reset": async (req, res) => {
    const b = await readBody(req);
    const hash = crypto.createHash("sha256").update(String(b.token || "")).digest("hex");
    const r = db.prepare("SELECT * FROM resets WHERE token_hash = ?").get(hash);
    if (!r || r.used || r.expires_at < Date.now()) return send(res, 400, { error: "bad_token" });
    const m = db.prepare("SELECT * FROM members WHERE id = ?").get(r.member_id);
    if (passwordProblem(String(b.password || ""), m.email)) return send(res, 400, { error: "weak_password" });
    const { salt, hash: ph } = hashPassword(String(b.password));
    db.prepare("UPDATE members SET pass_hash = ?, pass_salt = ? WHERE id = ?").run(ph, salt, m.id);
    db.prepare("UPDATE resets SET used = 1 WHERE member_id = ?").run(m.id);
    db.prepare("DELETE FROM sessions WHERE kind = 'member' AND member_id = ?").run(m.id);
    send(res, 200, { ok: true });
  },

  // ---- front desk ----
  "POST /api/desk/login": async (req, res) => {
    const ip = req.socket.remoteAddress;
    const f = pinFails.get(ip);
    if (f && f.count >= 5 && Date.now() - f.at < 5 * 60000) return send(res, 429, { error: "locked" });
    const b = await readBody(req);
    if (DESK_OPEN) return send(res, 200, { ok: true, open: true });
    const a = Buffer.from(String(b.pin || "")), e = Buffer.from(STAFF_PIN);
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) {
      pinFails.set(ip, { count: (f && Date.now() - f.at < 5 * 60000 ? f.count : 0) + 1, at: Date.now() });
      return send(res, 401, { error: "bad_pin" });
    }
    pinFails.delete(ip);
    const token = newSession("desk", null, DESK_SESSION_HOURS * 3600);
    send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cf_desk", token, DESK_SESSION_HOURS * 3600) });
  },

  "POST /api/desk/logout": async (req, res) => {
    const token = cookies(req).cf_desk;
    if (token) db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cf_desk", "", 0) });
  },

  "GET /api/desk/me": async (req, res) => {
    send(res, deskAllowed(req) ? 200 : 401, { ok: deskAllowed(req), open: DESK_OPEN });
  },

  // Look up a scanned code (member number), or a typed phone / email. Logs a check-in.
  "POST /api/desk/check": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const q = String((await readBody(req)).code || "").trim();
    if (!q) return send(res, 400, { error: "empty" });
    const m = findMember(q);
    if (!m) return send(res, 404, { error: "not_found" });
    const st = status(m);
    db.prepare("INSERT INTO checkins (member_id, active) VALUES (?, ?)").run(m.id, st.active ? 1 : 0);
    send(res, 200, publicMember(m));
  },

  // Add time to a subscription: { member_no, months } or { member_no, days }.
  "POST /api/desk/extend": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const b = await readBody(req);
    const m = db.prepare("SELECT * FROM members WHERE member_no = ? AND is_guest = 0").get(String(b.member_no || ""));
    if (!m) return send(res, 404, { error: "not_found" });
    const months = Number(b.months) || 0, days = Number(b.days) || 0;
    if (!(months > 0 && months <= 24) && !(days > 0 && days <= 366)) return send(res, 400, { error: "bad_amount" });
    const t = today();
    // Extend from the current end date if still active, otherwise from today.
    const start = m.sub_until && m.sub_until >= t ? addDays(m.sub_until, 1) : t;
    const until = months ? addDays(addMonths(start, months), -1) : addDays(start, days - 1);
    db.prepare("UPDATE members SET sub_until = ? WHERE id = ?").run(until, m.id);
    send(res, 200, publicMember({ ...m, sub_until: until }));
  },

  "POST /api/desk/cancel": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const b = await readBody(req);
    const m = db.prepare("SELECT * FROM members WHERE member_no = ? AND is_guest = 0").get(String(b.member_no || ""));
    if (!m) return send(res, 404, { error: "not_found" });
    db.prepare("UPDATE members SET sub_until = NULL WHERE id = ?").run(m.id);
    send(res, 200, publicMember({ ...m, sub_until: null }));
  },

  // ---- trainer ----
  // Look up without logging a visit.
  "POST /api/staff/lookup": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const m = findMember((await readBody(req)).code);
    if (!m) return send(res, 404, { error: "not_found" });
    send(res, 200, staffMember(m));
  },

  "POST /api/staff/visit": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const b = await readBody(req);
    const m = findMember(b.member_no);
    if (!m) return send(res, 404, { error: "not_found" });
    const staff = String(b.staff || "").trim().slice(0, 60);
    db.prepare("INSERT INTO checkins (member_id, active, source, staff) VALUES (?, ?, 'trainer', ?)")
      .run(m.id, status(m).active ? 1 : 0, staff);
    send(res, 200, staffMember(m));
  },

  "POST /api/staff/update": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const b = await readBody(req);
    const m = findMember(b.member_no);
    if (!m) return send(res, 404, { error: "not_found" });
    const name = String(b.name || "").trim().slice(0, 100);
    const email = String(b.email || "").trim().toLowerCase();
    const phone = normPhone(b.phone);
    const notes = String(b.notes || "").slice(0, 2000);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || phone.length < 6) return send(res, 400, { error: "invalid_fields" });
    const other = db.prepare("SELECT id FROM members WHERE email = ? AND id != ?").get(email, m.id);
    if (other) return send(res, 409, { error: "email_taken" });
    db.prepare("UPDATE members SET name = ?, email = ?, phone = ?, notes = ? WHERE id = ?").run(name, email, phone, notes, m.id);
    send(res, 200, staffMember(db.prepare("SELECT * FROM members WHERE id = ?").get(m.id)));
  },

  "GET /api/desk/members": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const rows = db.prepare(`
      SELECT m.*, (SELECT MAX(at) FROM checkins c WHERE c.member_id = m.id) AS last_visit,
             (SELECT COUNT(*) FROM checkins c WHERE c.member_id = m.id) AS visits
      FROM members m WHERE m.is_guest = 0 ORDER BY m.name COLLATE NOCASE`).all();
    send(res, 200, rows.map(m => ({ ...publicMember(m), last_visit: m.last_visit, visits: m.visits })));
  },

  "GET /api/desk/recent": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const rows = db.prepare(`
      SELECT c.at, c.active, m.name, m.member_no
      FROM checkins c JOIN members m ON m.id = c.member_id
      ORDER BY c.id DESC LIMIT 15`).all();
    send(res, 200, rows);
  },
};

// ---------- static files ----------
function serveStatic(req, res) {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const key = `${req.method} ${new URL(req.url, "http://x").pathname}`;
  const route = routes[key];
  if (route) {
    try { await route(req, res); }
    catch (e) { console.error(e); if (!res.headersSent) send(res, 400, { error: "bad_request" }); }
    return;
  }
  if (req.url.startsWith("/api/")) return send(res, 404, { error: "no_route" });
  serveStatic(req, res);
}).listen(PORT, () => {
  console.log(`Classfit running at http://localhost:${PORT}`);
  if (DESK_OPEN) console.log("WARNING: front desk is open to everyone (no STAFF_PIN set). Set STAFF_PIN before going live.");
});
