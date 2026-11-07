/*!
 * geo-guard.js — ограничение доступа по стране/региону для сайтов GO и і.
 * Подключается из <head> с атрибутом data-site="go" | "i".
 *
 * Работает на статике (GitHub Pages): определяет страну по IP через
 * публичные гео-API и при совпадении со списком полностью перекрывает сайт
 * стилизованным экраном блокировки.
 *
 * Проверка выполняется заново при каждой загрузке страницы (без кэша
 * вердикта), поэтому смена IP/VPN и обновление страницы сразу применяются.
 *
 * Отключить проверку для локальной отладки: ?geo=off (только для текущей
 * загрузки страницы).
 */
(function () {
  'use strict';

  var script = document.currentScript;
  var SITE = (script && script.getAttribute('data-site')) ||
    (/\/i-site(\/|$)/.test(location.pathname) ? 'i' : 'go');

  var CONFIG = {
    // Страны под ограничениями
    blockedCountries: ['BY', 'CU', 'IR', 'KP', 'RU', 'SY'],
    // Крым, Донецкая и Луганская области (проверяется только для UA)
    uaRegions: [
      /crimea/i, /krym/i, /krim/i, /qirim/i,
      /sevastopol/i, /sevastopol/i,
      /donetsk/i, /doneck/i,
      /luhansk/i, /lugansk/i
    ],
    uaRegionCodes: ['UA-40', 'UA-43', 'UA-14', 'UA-09', '40', '43', '14', '09'],
    timeout: 3200
  };

  var COUNTRY_NAMES = {
    BY: 'Беларусь', CU: 'Куба', IR: 'Иран', KP: 'КНДР',
    RU: 'Россия', SY: 'Сирия', UA: 'Украина'
  };

  var root = document.documentElement;
  var bootStyle = null;
  var splash = null;
  var decided = false;

  /* ───────────────────────── boot: прячем контент ───────────────────────── */

  var THEME_DARK = (function () {
    try { return localStorage.getItem('i-theme') === 'dark'; } catch (e) { return false; }
  })();

  root.setAttribute('data-gg-site', SITE);
  if (SITE === 'i' && THEME_DARK) root.setAttribute('data-gg-theme', 'dark');
  root.classList.add('gg-check');

  // Убираем кэш вердикта из предыдущей версии скрипта: теперь проверка
  // всегда свежая, иначе после смены IP мог оставаться старый блок.
  try {
    localStorage.removeItem('gg:geo:v1');
    localStorage.removeItem('gg:bypass');
  } catch (e) { /* storage может быть недоступен */ }

  bootStyle = document.createElement('style');
  bootStyle.id = 'gg-boot-style';
  bootStyle.textContent = [
    'html.gg-check body{visibility:hidden!important}',
    'html.gg-check{background:#08080b}',
    'html.gg-check[data-gg-site="i"]{background:#fafaf8}',
    'html.gg-check[data-gg-site="i"][data-gg-theme="dark"]{background:#0b0b12}',
    'html.gg-blocked,html.gg-blocked body{overflow:hidden!important}',
    'html.gg-blocked body{display:none!important}',
    '#gg-splash{position:fixed;inset:0;z-index:2147483640;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:#08080b;color:#f4f2ee;font-family:"Unbounded","Inter",Arial,sans-serif;transition:opacity .25s ease}',
    'html[data-gg-site="i"] #gg-splash{background:#fafaf8;color:#1a1a1a}',
    'html[data-gg-site="i"][data-gg-theme="dark"] #gg-splash{background:#0b0b12;color:#f0ece4}',
    '#gg-splash .gg-splash__mark{font-size:22px;font-weight:800;letter-spacing:-.03em;opacity:.9}',
    '#gg-splash .gg-splash__bar{width:128px;height:2px;border-radius:2px;overflow:hidden;background:rgba(255,255,255,.1)}',
    'html[data-gg-site="i"] #gg-splash .gg-splash__bar{background:rgba(0,0,0,.08)}',
    '#gg-splash .gg-splash__bar i{display:block;width:42%;height:100%;background:#b8a6ff;animation:ggSlide 1.1s ease-in-out infinite}',
    'html[data-gg-site="i"] #gg-splash .gg-splash__bar i{background:#5be37b}',
    '@keyframes ggSlide{0%{transform:translateX(-120%)}100%{transform:translateX(340%)}}',
    '@media (prefers-reduced-motion:reduce){#gg-splash .gg-splash__bar i{animation:none;width:100%}}'
  ].join('');
  document.head.appendChild(bootStyle);

  /* стили экрана блокировки грузим сразу, параллельно с проверкой */
  try {
    var cssBase = script && script.src ? script.src : location.href;
    var cssLink = document.createElement('link');
    cssLink.id = 'gg-css';
    cssLink.rel = 'stylesheet';
    cssLink.href = new URL('geo-guard.css', cssBase).href;
    document.head.appendChild(cssLink);
  } catch (e) { /* если не удалось — экран всё равно отрисуется без части стилей */ }

  try {
    splash = document.createElement('div');
    splash.id = 'gg-splash';
    splash.setAttribute('aria-hidden', 'true');
    splash.innerHTML = '<div class="gg-splash__mark">' + (SITE === 'i' ? 'і.' : 'GO') +
      '</div><div class="gg-splash__bar"><i></i></div>';
    root.appendChild(splash);
  } catch (e) { /* ignore */ }

  var fallbackTimer = setTimeout(function () { allow(); }, CONFIG.timeout + 1500);

  /* ───────────────────────────── проверка ───────────────────────────── */

  function fetchJSON(url, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { if (ctrl) ctrl.abort(); } catch (e) {}
        resolve(null);
      }, ms);

      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }

      try {
        fetch(url, {
          mode: 'cors',
          cache: 'no-store',
          credentials: 'omit',
          signal: ctrl ? ctrl.signal : undefined
        }).then(function (r) {
          if (!r || !r.ok) return null;
          return r.json();
        }).then(function (d) { finish(d || null); })
          .catch(function () { finish(null); });
      } catch (e) { finish(null); }
    });
  }

  var PROVIDERS = [
    {
      url: function () { return 'https://get.geojs.io/v1/ip/geo.json?_=' + Date.now(); },
      parse: function (d) {
        return { country: d.country_code, region: d.region, city: d.city, ip: d.ip };
      }
    },
    {
      url: function () {
        return 'https://ipwho.is/?fields=success,ip,country_code,region,region_code,city&_=' + Date.now();
      },
      parse: function (d) {
        if (d && d.success === false) return null;
        return { country: d.country_code, region: d.region, regionCode: d.region_code, city: d.city, ip: d.ip };
      }
    },
    {
      url: function () { return 'https://ipinfo.io/json?_=' + Date.now(); },
      parse: function (d) {
        if (!d || d.bogon) return null;
        return { country: d.country, region: d.region, city: d.city, ip: d.ip };
      }
    }
  ];

  function normalize(info) {
    if (!info) return null;
    return {
      country: String(info.country || '').toUpperCase(),
      region: String(info.region || ''),
      regionCode: String(info.regionCode || '').toUpperCase(),
      city: String(info.city || ''),
      ip: String(info.ip || '')
    };
  }

  function detectFromNetwork() {
    var jobs = PROVIDERS.map(function (p) {
      return fetchJSON(p.url(), CONFIG.timeout).then(function (d) {
        if (!d) return null;
        try { return normalize(p.parse(d)); } catch (e) { return null; }
      });
    });
    return Promise.all(jobs).then(function (list) {
      var good = list.filter(function (x) { return x && x.country; });
      if (!good.length) return null;

      // Голосование по независимым гео-сервисам: если один из них отдал
      // устаревший IP (например, сразу после включения VPN), он не должен
      // удерживать блокировку в одиночку.
      var blocked = [];
      var allowed = [];
      good.forEach(function (x) {
        if (isBlocked(x).blocked) blocked.push(x); else allowed.push(x);
      });
      return blocked.length > allowed.length ? blocked[0] : allowed[0];
    });
  }

  function isBlocked(info) {
    if (!info) return { blocked: false };
    var cc = info.country;
    if (CONFIG.blockedCountries.indexOf(cc) !== -1) {
      return { blocked: true, reason: 'country' };
    }
    if (cc === 'UA') {
      var where = info.region + ' ' + info.city;
      for (var i = 0; i < CONFIG.uaRegions.length; i++) {
        if (CONFIG.uaRegions[i].test(where)) return { blocked: true, reason: 'region' };
      }
      var rc = info.regionCode;
      var short = rc.replace(/^UA-/, '');
      for (var j = 0; j < CONFIG.uaRegionCodes.length; j++) {
        var c = CONFIG.uaRegionCodes[j];
        if (rc === c || short === c.replace(/^UA-/, '')) {
          return { blocked: true, reason: 'region' };
        }
      }
    }
    return { blocked: false };
  }

  function bypassed() {
    // Отключатель только для текущей загрузки страницы: index.html?geo=off
    return /(?:^|[?&])geo=off(?:&|$)/.test(location.search);
  }

  /* ───────────────────────────── отрисовка ───────────────────────────── */

  function removeSplash() {
    if (!splash) return;
    var s = splash;
    splash = null;
    s.style.opacity = '0';
    setTimeout(function () {
      if (s.parentNode) s.parentNode.removeChild(s);
    }, 260);
  }

  function allow() {
    if (decided) return;
    decided = true;
    clearTimeout(fallbackTimer);
    removeSplash();
    root.classList.remove('gg-check');
    setTimeout(function () {
      if (bootStyle && bootStyle.parentNode) bootStyle.parentNode.removeChild(bootStyle);
    }, 300);
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function countryLabel(cc) {
    if (!cc) return '—';
    return COUNTRY_NAMES[cc] ? COUNTRY_NAMES[cc] + ' · ' + cc : cc;
  }

  function block(info) {
    if (decided) return;
    decided = true;
    clearTimeout(fallbackTimer);
    removeSplash();
    root.classList.add('gg-blocked');

    var title = SITE === 'i' ? 'і. — доступ ограничен' : 'GO — доступ ограничен';
    try { document.title = title; } catch (e) {}

    var where = [info.city, info.region].filter(Boolean).join(', ');
    var ip = info.ip || '—';

    var el = document.createElement('div');
    el.className = 'gg';
    el.setAttribute('data-gg-site', SITE);
    if (SITE === 'i' && THEME_DARK) el.setAttribute('data-gg-theme', 'dark');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'gg-title');

    el.innerHTML =
      '<div class="gg-bg" aria-hidden="true">' +
        '<div class="gg-grid"></div>' +
        '<div class="gg-glow gg-glow--a"></div>' +
        '<div class="gg-glow gg-glow--b"></div>' +
        '<div class="gg-glow gg-glow--c"></div>' +
        '<div class="gg-noise"></div>' +
      '</div>' +

      '<div class="gg-shell">' +
        '<header class="gg-top">' +
          '<a class="gg-logo" href="./" aria-label="' + (SITE === 'i' ? 'і.' : 'GO') + '">' +
            (SITE === 'i' ? 'і.' : 'GO') +
          '</a>' +
          '<div class="gg-top__meta"><span class="gg-pulse"></span>geo / sanctions</div>' +
        '</header>' +

        '<main class="gg-main">' +
          '<p class="gg-eyebrow">Доступ к сервису</p>' +
          '<h1 class="gg-title" id="gg-title">Доступ<br>ограничен</h1>' +
          '<p class="gg-lead">Вы ограничиваете доступ к сервису и платформе для каких-либо конкретных стран? ' +
            '<span>Да — мы обязаны ограничить доступ для следующих стран и регионов:</span></p>' +

          '<ul class="gg-countries" aria-label="Страны и регионы под ограничениями">' +
            '<li>Беларусь</li><li>Куба</li><li>Иран</li><li>Северная Корея</li>' +
            '<li>Россия</li><li>Сирия</li><li>Крым</li>' +
            '<li>Донецкая область</li><li>Луганская область</li>' +
          '</ul>' +

          '<div class="gg-notes">' +
            '<p>Если вы подключаетесь из одной из стран, находящихся под санкциями, ' +
              'ваш доступ к нашему сервису будет заблокирован.</p>' +
            '<p>Эта блокировка может затронуть некоторые серверы, даже если они физически ' +
              'не расположены в одном из затронутых регионов, поскольку наш облачный провайдер ' +
              'может пометить их как связанные с одной из этих стран. ' +
              'Мы рекомендуем по возможности получить новый IP-адрес.</p>' +
          '</div>' +

          '<div class="gg-status" role="status">' +
            '<div class="gg-status__item"><span>IP-адрес</span><b>' + esc(ip) + '</b></div>' +
            '<div class="gg-status__item"><span>Страна</span><b>' + esc(countryLabel(info.country)) + '</b></div>' +
            '<div class="gg-status__item"><span>Регион</span><b>' + esc(where || '—') + '</b></div>' +
          '</div>' +

          '<div class="gg-actions">' +
            '<button class="gg-btn" type="button" id="gg-retry">Проверить снова</button>' +
            '<span class="gg-hint" id="gg-retry-note">Проверка выполняется по IP через сторонний гео-сервис.</span>' +
          '</div>' +
        '</main>' +

        '<footer class="gg-foot">' +
          '<span>' + (SITE === 'i' ? 'і. studio' : 'GO ecosystem') + '</span>' +
          '<span>geo-guard · restricted region</span>' +
        '</footer>' +
      '</div>';

    root.appendChild(el);

    var btn = el.querySelector('#gg-retry');
    if (btn) btn.addEventListener('click', function () { retry(btn, el); });
    if (btn) setTimeout(function () { try { btn.focus(); } catch (e) {} }, 60);
  }

  function updateStatus(el, info) {
    if (!el) return;
    var where = [info.city, info.region].filter(Boolean).join(', ');
    var items = el.querySelectorAll('.gg-status__item b');
    if (items.length === 3) {
      items[0].textContent = info.ip || '—';
      items[1].textContent = countryLabel(info.country);
      items[2].textContent = where || '—';
    }
  }

  function retry(btn, el) {
    btn.disabled = true;
    btn.textContent = 'Проверяем…';
    var note = el.querySelector('#gg-retry-note');
    if (note) note.textContent = 'Запрашиваем данные о вашем подключении…';

    detectFromNetwork().then(function (info) {
      if (!info) {
        btn.disabled = false;
        btn.textContent = 'Проверить снова';
        if (note) note.textContent = 'Не удалось определить страну. Обновите страницу или попробуйте позже.';
        return;
      }
      if (!isBlocked(info).blocked) {
        if (note) note.textContent = 'Доступ разрешён. Перезагружаем…';
        setTimeout(function () { location.reload(); }, 500);
        return;
      }
      updateStatus(el, info);
      btn.disabled = false;
      btn.textContent = 'Проверить снова';
      if (note) note.textContent = 'Доступ по-прежнему ограничен.';
    });
  }

  /* ───────────────────────────── запуск ───────────────────────────── */

  function run() {
    if (bypassed()) { allow(); return; }

    // Всегда свежая проверка: никакого кэша вердикта, чтобы смена IP/VPN
    // и обновление страницы применялись сразу.
    detectFromNetwork().then(function (info) {
      if (decided) return;
      if (!info) { allow(); return; }
      if (isBlocked(info).blocked) block(info); else allow();
    }).catch(function () { allow(); });
  }

  run();

  /* Если вердикт мог измениться без перезагрузки (VPN включили в соседней
     вкладке, вернулись по bfcache, восстановили сеть) — перепроверяем. */
  var lastRecheck = Date.now();

  function recheck() {
    if (Date.now() - lastRecheck < 30000) return;
    lastRecheck = Date.now();
    detectFromNetwork().then(function (info) {
      if (!info) return;
      var nowBlocked = isBlocked(info).blocked;
      var shownBlocked = root.classList.contains('gg-blocked');
      if (nowBlocked !== shownBlocked) location.reload();
    }).catch(function () {});
  }

  window.addEventListener('pageshow', function (e) { if (e.persisted) recheck(); });
  window.addEventListener('online', recheck);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') recheck();
  });

  /* страховка: снять блокировку загрузки, если что-то пошло не так */
  setTimeout(function () {
    if (!decided) allow();
  }, CONFIG.timeout + 2500);
})();
