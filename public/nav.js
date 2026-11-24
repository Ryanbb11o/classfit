// Shared site header: logo, profile icon and the three-line menu.
// Include after <header id="site-header"></header> and before the page script.
(function () {
  const NAV = {
    bg: { about: "За нас", gym: "Залата", prices: "Цени", reviews: "Отзиви", visit: "Контакти",
          account: "Моят профил", desk: "Рецепция · всички клиенти", trainer: "Треньори", call: "Обади се", menu: "Меню", close: "Затвори меню",
          profile: "Профил", lang: "Език" },
    en: { about: "About", gym: "The gym", prices: "Prices", reviews: "Reviews", visit: "Contact",
          account: "My account", desk: "Front desk · all members", trainer: "Trainers", call: "Call us", menu: "Menu", close: "Close menu",
          profile: "Account", lang: "Language" },
  };

  const header = document.getElementById("site-header");
  header.innerHTML = `
    <div class="wrap">
      <nav>
        <a href="index.html" class="logo">CLASS<span>FIT</span></a>
        <div class="nav-right">
          <a href="account.html" class="icon-btn profile-btn" id="nav-profile" data-nav-label="profile">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8.5" r="3.75"/><path d="M4.75 19.5c1.2-3.3 4-5 7.25-5s6.05 1.7 7.25 5"/></svg>
            <span class="initials" hidden></span>
          </a>
          <button class="icon-btn menu-btn" id="nav-menu-btn" aria-expanded="false" aria-controls="nav-menu" data-nav-label="menu">
            <span></span><span></span><span></span>
          </button>
        </div>
      </nav>
    </div>`;

  const scrim = document.createElement("div");
  scrim.className = "menu-scrim";
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.id = "nav-menu";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-modal", "false");
  menu.innerHTML = `
    <ul class="menu-links">
      <li><a href="index.html#about" data-nav="about"></a></li>
      <li><a href="index.html#gym" data-nav="gym"></a></li>
      <li><a href="index.html#prices" data-nav="prices"></a></li>
      <li><a href="index.html#reviews" data-nav="reviews"></a></li>
      <li><a href="index.html#visit" data-nav="visit"></a></li>
      <li><a href="account.html" data-nav="account"></a></li>
      <li class="menu-sep"><a href="desk.html" data-nav="desk"></a></li>
      <li class="menu-staff"><a href="trainer.html" data-nav="trainer"></a></li>
    </ul>
    <div class="menu-foot">
      <div class="menu-row">
        <span class="hint" data-nav="lang"></span>
        <div class="lang" role="group" aria-label="Language">
          <button data-lang="bg">BG</button>
          <button data-lang="en">EN</button>
        </div>
      </div>
      <a href="tel:+359894830386" class="btn" data-nav="call"></a>
    </div>`;
  document.body.append(scrim, menu);

  const btn = document.getElementById("nav-menu-btn");
  let lang = "bg";

  function setOpen(open) {
    document.body.classList.toggle("menu-open", open);
    btn.setAttribute("aria-expanded", String(open));
    btn.setAttribute("aria-label", NAV[lang][open ? "close" : "menu"]);
    if (open) menu.querySelector("a").focus({ preventScroll: true });
  }
  const isOpen = () => document.body.classList.contains("menu-open");

  btn.addEventListener("click", () => setOpen(!isOpen()));
  scrim.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", e => { if (e.key === "Escape" && isOpen()) { setOpen(false); btn.focus(); } });
  menu.querySelectorAll("a").forEach(a => a.addEventListener("click", () => setOpen(false)));

  function applyLang(l) {
    lang = l;
    const t = NAV[l];
    menu.querySelectorAll("[data-nav]").forEach(el => { el.textContent = t[el.dataset.nav]; });
    header.querySelectorAll("[data-nav-label]").forEach(el => el.setAttribute("aria-label", t[el.dataset.navLabel]));
    btn.setAttribute("aria-label", t[isOpen() ? "close" : "menu"]);
  }
  document.addEventListener("langchange", e => applyLang(e.detail));
  applyLang(localStorage.getItem("lang") === "en" ? "en" : "bg");

  // Show the member's initials in the profile icon when logged in.
  window.refreshNavProfile = async function () {
    const el = document.getElementById("nav-profile");
    const initials = el.querySelector(".initials");
    try {
      const r = await api("GET", "/api/me");
      if (!r.ok) throw 0;
      const me = r.data;
      initials.textContent = me.name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();
      initials.hidden = false;
      el.classList.add("signed-in");
    } catch {
      initials.hidden = true;
      el.classList.remove("signed-in");
    }
  };
  refreshNavProfile();
})();
