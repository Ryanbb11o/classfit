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

window.api = async function (method, url, body) {
  const r = await fetch(url, {
    method, credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
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
