// Shared language switch for app pages. Uses the same saved choice as the home page.
window.initLang = function (T, onChange) {
  function apply(l) {
    const t = T[l];
    document.documentElement.lang = l;
    document.querySelectorAll("[data-i18n]").forEach(el => { if (t[el.dataset.i18n] != null) el.textContent = t[el.dataset.i18n]; });
    document.querySelectorAll("[data-i18n-alt]").forEach(el => { if (t[el.dataset.i18nAlt] != null) el.alt = t[el.dataset.i18nAlt]; });
    document.querySelectorAll("[data-i18n-ph]").forEach(el => { el.placeholder = t[el.dataset.i18nPh]; });
    document.querySelectorAll("[data-i18n-html]").forEach(el => { if (t[el.dataset.i18nHtml] != null) el.innerHTML = t[el.dataset.i18nHtml]; });
    document.querySelectorAll(".lang button").forEach(b => b.classList.toggle("on", b.dataset.lang === l));
    localStorage.setItem("lang", l);
    window.LANG = l; window.t = k => t[k] ?? k;
    if (onChange) onChange(l);
    document.dispatchEvent(new CustomEvent("langchange", { detail: l }));
  }
  document.querySelectorAll(".lang button").forEach(b => b.onclick = () => apply(b.dataset.lang));
  apply(localStorage.getItem("lang") === "en" ? "en" : "bg");
};

// Supabase client for logins (needs supabase-js and /config.js loaded first).
window.sb = (window.supabase && window.CLASSFIT_SUPABASE)
  ? window.supabase.createClient(window.CLASSFIT_SUPABASE.url, window.CLASSFIT_SUPABASE.key)
  : null;

// Call this site's API. Sends the member's Supabase login token when logged in.
window.api = async function (method, url, body) {
  const headers = body ? { "Content-Type": "application/json" } : {};
  if (window.sb) {
    const { data } = await window.sb.auth.getSession();
    if (data?.session?.access_token) headers.Authorization = "Bearer " + data.session.access_token;
  }
  const r = await fetch(url, {
    method, credentials: "same-origin", headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, data };
};

window.fmtDate = function (iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

// Password rules shown live under a password field. Must match passwordProblem() in server.js.
window.PW_RULES = {
  bg: ["Поне 10 символа", "Главна и малка буква", "Поне една цифра", "Да не съдържа имейла ти"],
  en: ["At least 10 characters", "Upper and lower case letter", "At least one digit", "Doesn't contain your email"],
};
window.checkPassword = function (pw, email = "") {
  const local = (email.split("@")[0] || "").toLowerCase();
  return [
    pw.length >= 10,
    /[a-zа-я]/.test(pw) && /[A-ZА-Я]/.test(pw),
    /\d/.test(pw),
    !(local.length >= 4 && pw.toLowerCase().includes(local)),
  ];
};
// Attach a live checklist: input = password field, list = <ul>, getEmail = () => email.
window.attachPwRules = function (input, list, getEmail = () => "") {
  const draw = () => {
    const ok = checkPassword(input.value, getEmail());
    list.innerHTML = PW_RULES[window.LANG || "bg"].map((r, i) =>
      `<li class="${ok[i] ? "ok" : ""}">${r}</li>`).join("");
  };
  input.addEventListener("input", draw);
  document.addEventListener("langchange", draw);
  draw();
  return () => checkPassword(input.value, getEmail()).every(Boolean);
};

// ---- Free first visit offer ----
// Milliseconds timestamp of HH:MM on a given YYYY-MM-DD in Sofia time (gym's time zone).
window.sofiaDeadline = function (isoDate, hhmm = "21:00") {
  const now = new Date();
  const asUTC = tz => new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const offsetMs = asUTC("Europe/Sofia") - asUTC("UTC");
  const [y, m, d] = isoDate.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  return Date.UTC(y, m - 1, d, h, mi) - offsetMs;
};
// "3 ч 12 мин 05 с" / "3h 12m 05s"
window.fmtCountdown = function (ms) {
  ms = Math.max(0, ms);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  const p = n => String(n).padStart(2, "0");
  return `${h}:${p(m)}:${p(s)}`;
};
// Small gift icon, drawn so it looks the same everywhere.
window.GIFT_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v7.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V12M12 8v12.5M12 8c-1.5-3.5-5.5-4-5.5-1.5S9.5 8 12 8Zm0 0c1.5-3.5 5.5-4 5.5-1.5S14.5 8 12 8Z"/></svg>';
document.addEventListener("DOMContentLoaded", () => document.querySelectorAll(".gift").forEach(g => { g.innerHTML = GIFT_SVG; }));

// Is the given date today or tomorrow (Sofia)? Returns "today" | "tomorrow" | "later".
window.sofiaDayWord = function (isoDate) {
  const fmt = d => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Sofia" }).format(d);
  const t = fmt(new Date()), tm = fmt(new Date(Date.now() + 86400000));
  return isoDate === t ? "today" : isoDate === tm ? "tomorrow" : "later";
};
// Keep an element's text updated with the time left until a deadline.
window.startCountdown = function (el, deadline, onEnd) {
  clearInterval(el._cd);
  const tick = () => {
    const left = deadline - Date.now();
    el.textContent = fmtCountdown(left);
    if (left <= 0) { clearInterval(el._cd); onEnd && onEnd(); }
  };
  tick();
  el._cd = setInterval(tick, 1000);
};
