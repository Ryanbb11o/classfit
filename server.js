// Classfit website server: static pages plus the member, front desk and trainer API.
// Logins and data live in Supabase (project "classfit"):
//  - members sign up / log in in the browser with Supabase Auth and send their access token here;
//  - this server reads and writes the database with the secret key, which never leaves the server.
// No npm dependencies: Node 22+ built-ins only (fetch, crypto, http).
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

try { process.loadEnvFile(path.join(__dirname, ".env")); } catch {}

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";            // public, also used in the browser
const SUPABASE_SECRET = process.env.SUPABASE_SERVICE_ROLE_KEY || "";       // server only: full database access
const CONFIGURED = !!(SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SECRET);
if (!CONFIGURED) {
  console.error("Missing Supabase settings: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY (in .env locally, or in the Vercel project's environment variables).");
}
// Front desk and trainer access. While STAFF_PIN is not set, those pages are OPEN TO EVERYONE
// (anyone can see member details and change subscriptions). Set STAFF_PIN before going live.
const STAFF_PIN = process.env.STAFF_PIN || "";
const DESK_OPEN = !STAFF_PIN;
const DESK_SESSION_HOURS = 12;
const GUEST_SESSION_HOURS = 4;
// Signs the staff and guest cookies. Keep it stable in .env so restarts don't log people out.
const COOKIE_SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString("hex");

// Free first visit for new sign-ups: valid today, or until tomorrow when signing up this late
// (Sofia time). The database sets it on sign-up (trial_end_date() in the migration); this copy
// is only used to show the offer on the website, so keep the two in step.
const TRIAL_LATE_HOUR = 18;

// ---------- Supabase ----------
async function db(pathAndQuery, { method = "GET", body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: {
      apikey: SUPABASE_SECRET,
      Authorization: `Bearer ${SUPABASE_SECRET}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const err = new Error(data?.message || `Supabase ${r.status}`);
    err.status = r.status; err.details = data;
    throw err;
  }
  return data;
}
const q = v => encodeURIComponent(String(v));
const one = async p => (await db(p))?.[0] || null;

async function authAdmin(pathAndQuery, { method = "GET", body } = {}) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${pathAndQuery}`, {
    method,
    headers: { apikey: SUPABASE_SECRET, Authorization: `Bearer ${SUPABASE_SECRET}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error(data?.msg || data?.message || `Auth ${r.status}`); e.status = r.status; e.details = data; throw e; }
  return data;
}

// Check a member's Supabase access token; short cache so every page load isn't a round trip.
const tokenCache = new Map();
async function userFromToken(token) {
  const hit = tokenCache.get(token);
  if (hit && hit.until > Date.now()) return hit.user;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` } });
  const user = r.ok ? await r.json() : null;
  tokenCache.set(token, { user, until: Date.now() + 60000 });
  if (tokenCache.size > 5000) tokenCache.clear();
  return user;
}

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
// On Vercel (https) cookies are also marked Secure.
const SECURE = process.env.VERCEL ? "; Secure" : "";
function setCookie(name, value, maxAgeSec) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}${SECURE}`;
}
// Signed cookie values: "<kind>.<expiry ms>.<signature>", no server-side storage needed.
function signed(kind, hours) {
  const exp = Date.now() + hours * 3600000;
  const sig = crypto.createHmac("sha256", COOKIE_SECRET).update(`${kind}.${exp}`).digest("hex");
  return `${kind}.${exp}.${sig}`;
}
function validSigned(value, kind) {
  const [k, exp, sig] = String(value || "").split(".");
  if (k !== kind || !exp || !sig || Number(exp) < Date.now()) return false;
  const want = crypto.createHmac("sha256", COOKIE_SECRET).update(`${k}.${exp}`).digest("hex");
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}

// Gym is in Varna; dates are local to Europe/Sofia.
const sofiaDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" });
function today() { return sofiaDay.format(new Date()); }
function dayOf(ts) { return sofiaDay.format(new Date(ts)); }
function sofiaHour() {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Sofia", hour: "2-digit", hour12: false }).format(new Date()));
}
function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + months, d));
  if (dt.getUTCDate() !== d) dt.setUTCDate(0); // Jan 31 + 1 month -> Feb 28
  return dt.toISOString().slice(0, 10);
}
function addDays(isoDate, days) {
  const dt = new Date(isoDate + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}
function trialEndDate() { return sofiaHour() >= TRIAL_LATE_HOUR ? addDays(today(), 1) : today(); }
// Timestamps go to the browser as "YYYY-MM-DD HH:MM:SS" in UTC.
function ts(v) { return v ? new Date(v).toISOString().slice(0, 19).replace("T", " ") : null; }

// Store Bulgarian numbers one way: "+359 88..." and "088..." both become "088...".
function normPhone(p) { return String(p || "").replace(/[^\d+]/g, "").replace(/^(\+|00)359/, "0"); }

function status(m) {
  const t = today();
  const active = !!m.sub_until && m.sub_until >= t;
  const daysLeft = active ? Math.round((Date.parse(m.sub_until) - Date.parse(t)) / 86400000) + 1 : 0;
  const trialOpen = !m.is_guest && !!m.trial_until && !m.trial_used_at && m.trial_until >= t;
  return {
    active, sub_until: m.sub_until, days_left: daysLeft,
    trial: m.trial_until ? { until: m.trial_until, used_at: ts(m.trial_used_at), open: trialOpen } : null,
    can_enter: active || trialOpen,
  };
}

function publicMember(m) {
  return { member_no: m.member_no, name: m.name, email: m.email, phone: m.phone,
           created_at: ts(m.created_at), guest: !!m.is_guest, ...status(m) };
}

async function visitsOf(memberId, limit) {
  const rows = await db(`checkins?member_id=eq.${q(memberId)}&select=at,active,source,staff,free&order=at.desc,id.desc${limit ? `&limit=${limit}` : ""}`);
  return rows.map(v => ({ ...v, at: ts(v.at), active: v.active ? 1 : 0, free: v.free ? 1 : 0 }));
}

// Full member card for staff: details, notes, visits.
async function staffMember(m) {
  const visits = await visitsOf(m.id);
  const t = today(), month = t.slice(0, 7);
  const dayOfTs = s => dayOf(s.replace(" ", "T") + "Z");
  return {
    ...publicMember(m), notes: m.notes || "",
    visits_total: visits.length,
    visits_month: visits.filter(v => dayOfTs(v.at).startsWith(month)).length,
    visited_today: visits.find(v => dayOfTs(v.at) === t) || null,
    visits: visits.slice(0, 30),
  };
}

// Find a real member from a scanned QR, member number, email or phone. Never the demo guest.
async function findMember(code) {
  code = String(code || "").trim();
  const no = code.toUpperCase().match(/CF-?(\d{6})/);
  let filter = null;
  if (no) filter = `member_no=eq.${q("CF-" + no[1])}`;
  else if (code.includes("@")) filter = `email=eq.${q(code.toLowerCase())}`;
  else if (normPhone(code).length >= 6) filter = `phone=eq.${q(normPhone(code))}`;
  if (!filter) return null;
  return one(`members?${filter}&is_guest=eq.false&select=*&limit=1`);
}
const memberById = id => one(`members?id=eq.${q(id)}&select=*`);

// Log a visit in the database (spends the free first visit if that's what lets them in).
async function logVisit(m, source, staff = "") {
  const free = await db("rpc/log_visit", { method: "POST", body: { p_member: m.id, p_source: source, p_staff: staff } });
  return { member: await memberById(m.id), free: free === true };
}

// ---------- who is asking ----------
// A logged-in member (Supabase token) or the demo guest (signed cookie).
async function currentMember(req) {
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    const user = await userFromToken(auth.slice(7));
    if (user?.id) return one(`members?user_id=eq.${q(user.id)}&select=*`);
  }
  if (validSigned(cookies(req).cf_guest, "guest")) return guestMember(false);
  return null;
}
function deskAllowed(req) { return DESK_OPEN || validSigned(cookies(req).cf_desk, "desk"); }

// Demo guest account: a shared, read-only profile with sample data so people can look around.
let guestId = null;
async function guestMember(refresh) {
  let g = guestId ? await memberById(guestId) : await one("members?is_guest=eq.true&select=*&limit=1");
  if (!g) {
    [g] = await db("members", { method: "POST", prefer: "return=representation",
      body: { member_no: "CF-000000", name: "Гост", email: "guest@classfit.demo", phone: "0000000000", is_guest: true } });
  }
  guestId = g.id;
  if (refresh) {
    // Keep the sample fresh: subscription with 18 days left and a few recent visits.
    [g] = await db(`members?id=eq.${q(g.id)}`, { method: "PATCH", prefer: "return=representation", body: { sub_until: addDays(today(), 17) } });
    await db(`checkins?member_id=eq.${q(g.id)}`, { method: "DELETE" });
    await db("checkins", { method: "POST", body: [1, 3, 4, 6, 8, 11, 13].map(d => ({
      member_id: g.id, at: new Date(Date.now() - d * 86400000).toISOString(), active: true, source: "desk" })) });
  }
  return g;
}

// Simple in-memory lockout for the desk PIN: 5 wrong tries, then 5 minutes.
const pinFails = new Map();

// ---------- API ----------
const routes = {
  // Public Supabase settings for the browser (the URL and the public key only).
  "GET /config.js": async (req, res) => {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(`window.CLASSFIT_SUPABASE = ${JSON.stringify({ url: SUPABASE_URL, key: SUPABASE_ANON_KEY })};`);
  },

  "GET /api/offer": async (req, res) => {
    send(res, 200, { until: trialEndDate(), today: today(), late_hour: TRIAL_LATE_HOUR, closes: "21:00" });
  },

  "POST /api/guest": async (req, res) => {
    await guestMember(true);
    send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cf_guest", signed("guest", GUEST_SESSION_HOURS), GUEST_SESSION_HOURS * 3600) });
  },

  // Ends the guest view. Member logout happens in the browser with Supabase.
  "POST /api/logout": async (req, res) => {
    send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cf_guest", "", 0) });
  },

  "GET /api/me": async (req, res) => {
    const m = await currentMember(req);
    if (!m) return send(res, 401, { error: "not_logged_in" });
    send(res, 200, publicMember(m));
  },

  "GET /api/me/visits": async (req, res) => {
    const m = await currentMember(req);
    if (!m) return send(res, 401, { error: "not_logged_in" });
    const all = await visitsOf(m.id);
    const month = today().slice(0, 7);
    send(res, 200, {
      total: all.length,
      this_month: all.filter(c => dayOf(c.at.replace(" ", "T") + "Z").startsWith(month)).length,
      recent: all.slice(0, 10),
    });
  },

  "POST /api/me/update": async (req, res) => {
    const m = await currentMember(req);
    if (!m) return send(res, 401, { error: "not_logged_in" });
    if (m.is_guest) return send(res, 403, { error: "guest_read_only" });
    const b = await readBody(req);
    const name = String(b.name || "").trim().slice(0, 100), phone = normPhone(b.phone);
    if (!name || phone.length < 6) return send(res, 400, { error: "invalid_fields" });
    const [u] = await db(`members?id=eq.${q(m.id)}`, { method: "PATCH", prefer: "return=representation", body: { name, phone } });
    send(res, 200, publicMember(u));
  },

  // ---- front desk ----
  "POST /api/desk/login": async (req, res) => {
    if (DESK_OPEN) return send(res, 200, { ok: true, open: true });
    const ip = req.socket.remoteAddress;
    const f = pinFails.get(ip);
    if (f && f.count >= 5 && Date.now() - f.at < 5 * 60000) return send(res, 429, { error: "locked" });
    const b = await readBody(req);
    const a = Buffer.from(String(b.pin || "")), e = Buffer.from(STAFF_PIN);
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) {
      pinFails.set(ip, { count: (f && Date.now() - f.at < 5 * 60000 ? f.count : 0) + 1, at: Date.now() });
      return send(res, 401, { error: "bad_pin" });
    }
    pinFails.delete(ip);
    send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cf_desk", signed("desk", DESK_SESSION_HOURS), DESK_SESSION_HOURS * 3600) });
  },

  "POST /api/desk/logout": async (req, res) => {
    send(res, 200, { ok: true }, { "Set-Cookie": setCookie("cf_desk", "", 0) });
  },

  "GET /api/desk/me": async (req, res) => {
    send(res, deskAllowed(req) ? 200 : 401, { ok: deskAllowed(req), open: DESK_OPEN });
  },

  // Look up a scanned code (member number), or a typed phone / email. Logs a check-in.
  "POST /api/desk/check": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const code = String((await readBody(req)).code || "").trim();
    if (!code) return send(res, 400, { error: "empty" });
    const m = await findMember(code);
    if (!m) return send(res, 404, { error: "not_found" });
    const v = await logVisit(m, "desk");
    send(res, 200, { ...publicMember(v.member), free_visit: v.free });
  },

  // Add time to a subscription: { member_no, months } or { member_no, days }.
  "POST /api/desk/extend": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const b = await readBody(req);
    const m = await findMember(b.member_no);
    if (!m) return send(res, 404, { error: "not_found" });
    const months = Number(b.months) || 0, days = Number(b.days) || 0;
    if (!(months > 0 && months <= 24) && !(days > 0 && days <= 366)) return send(res, 400, { error: "bad_amount" });
    const t = today();
    // Extend from the current end date if still active, otherwise from today.
    const start = m.sub_until && m.sub_until >= t ? addDays(m.sub_until, 1) : t;
    const until = months ? addDays(addMonths(start, months), -1) : addDays(start, days - 1);
    const [u] = await db(`members?id=eq.${q(m.id)}`, { method: "PATCH", prefer: "return=representation", body: { sub_until: until } });
    send(res, 200, publicMember(u));
  },

  "POST /api/desk/cancel": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const b = await readBody(req);
    const m = await findMember(b.member_no);
    if (!m) return send(res, 404, { error: "not_found" });
    const [u] = await db(`members?id=eq.${q(m.id)}`, { method: "PATCH", prefer: "return=representation", body: { sub_until: null } });
    send(res, 200, publicMember(u));
  },

  "GET /api/desk/members": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const rows = await db("member_overview?is_guest=eq.false&select=*&order=name.asc");
    send(res, 200, rows.map(m => ({ ...publicMember(m), last_visit: ts(m.last_visit), visits: m.visits })));
  },

  "GET /api/desk/recent": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const rows = await db("checkins?select=at,active,free,members!inner(name,member_no,is_guest)&members.is_guest=eq.false&order=id.desc&limit=15");
    send(res, 200, rows.map(c => ({ at: ts(c.at), active: c.active ? 1 : 0, free: c.free ? 1 : 0, name: c.members.name, member_no: c.members.member_no })));
  },

  // ---- trainer ----
  // Look up without logging a visit.
  "POST /api/staff/lookup": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const m = await findMember((await readBody(req)).code);
    if (!m) return send(res, 404, { error: "not_found" });
    send(res, 200, await staffMember(m));
  },

  "POST /api/staff/visit": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const b = await readBody(req);
    const m = await findMember(b.member_no);
    if (!m) return send(res, 404, { error: "not_found" });
    const v = await logVisit(m, "trainer", String(b.staff || "").trim().slice(0, 60));
    send(res, 200, { ...(await staffMember(v.member)), free_visit: v.free });
  },

  "POST /api/staff/update": async (req, res) => {
    if (!deskAllowed(req)) return send(res, 401, { error: "not_logged_in" });
    const b = await readBody(req);
    const m = await findMember(b.member_no);
    if (!m) return send(res, 404, { error: "not_found" });
    const name = String(b.name || "").trim().slice(0, 100);
    const email = String(b.email || "").trim().toLowerCase();
    const phone = normPhone(b.phone);
    const notes = String(b.notes || "").slice(0, 2000);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || phone.length < 6) return send(res, 400, { error: "invalid_fields" });
    if (email !== m.email) {
      if (await one(`members?email=eq.${q(email)}&id=neq.${q(m.id)}&select=id`)) return send(res, 409, { error: "email_taken" });
      // The email is also the member's login, so change it in Supabase Auth too.
      if (m.user_id) {
        try { await authAdmin(`users/${m.user_id}`, { method: "PUT", body: { email, email_confirm: true } }); }
        catch (e) { return send(res, e.status === 422 ? 409 : 400, { error: e.status === 422 ? "email_taken" : "invalid_fields" }); }
      }
    }
    const [u] = await db(`members?id=eq.${q(m.id)}`, { method: "PATCH", prefer: "return=representation", body: { name, email, phone, notes } });
    send(res, 200, await staffMember(u));
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

// One handler for both: the local server below, and the Vercel function in api/index.js.
async function handler(req, res) {
  const key = `${req.method} ${new URL(req.url, "http://x").pathname}`;
  const route = routes[key];
  if (route) {
    if (!CONFIGURED) return send(res, 500, { error: "not_configured" });
    try { await route(req, res); }
    catch (e) { console.error(e.message, e.details || ""); if (!res.headersSent) send(res, 500, { error: "server_error" }); }
    return;
  }
  if (req.url.startsWith("/api/")) return send(res, 404, { error: "no_route" });
  serveStatic(req, res);
}
module.exports = handler;

// Run as a normal server with: node server.js
if (require.main === module) {
  if (!CONFIGURED) process.exit(1);
  http.createServer(handler).listen(PORT, () => {
    console.log(`Classfit running at http://localhost:${PORT} (Supabase: ${SUPABASE_URL})`);
    if (DESK_OPEN) console.log("WARNING: front desk and trainer pages are open to everyone (no STAFF_PIN set). Set STAFF_PIN before going live.");
  });
}
