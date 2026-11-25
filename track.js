// Логирование действий респондента в прототипе.
// Пишет: старт сессии, все тапы (в т.ч. «мёртвые»), просмотр блоков, глубину скролла, переходы, уход со страницы.
// Отправка — пачками через sendBeacon на PROTO_CONFIG.endpoint; копия всегда лежит в localStorage.
(function () {
  var CFG = window.PROTO_CONFIG || {};
  var T0 = Date.now();
  var LS_KEY = 'proto_log_' + (CFG.prototype || 'proto');

  function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function ss(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } }

  var params = new URLSearchParams(location.search);
  // ?embed=1 — страница открыта внутри дашборда для тепловой карты: ничего не логируем
  if (params.get('embed') === '1') { window.Track = { event: function () {}, flush: function () {}, session: '' }; return; }
  var respondent = params.get('r') || '';
  // Пишем только первую сессию до перехода в УК: после перехода ставим метку на устройстве
  // (отдельно для каждого респондента r), и при возврате назад или повторном открытии ничего не логируем
  var DONE_KEY = 'proto_done_' + (CFG.prototype || 'proto') + '_' + respondent;
  function isDone() { try { return !!localStorage.getItem(DONE_KEY); } catch (e) { return false; } }
  function markDone() { try { localStorage.setItem(DONE_KEY, new Date().toISOString()); } catch (e) {} }
  var stopped = isDone();
  if (stopped) { window.Track = { event: function () {}, flush: function () {}, session: '', stopped: true }; return; }
  // у каждого прототипа своя сессия, даже если оба открывают в одной вкладке
  var SESSION_KEY = 'proto_session_' + (CFG.prototype || 'proto') + '_' + respondent;  // новый респондент в той же вкладке = новая сессия
  var session = ss(SESSION_KEY);
  if (!session) { session = rid(); ss(SESSION_KEY, session); }

  var queue = [];
  var maxScroll = 0;

  function docH() { return Math.max(document.documentElement.scrollHeight, 1); }

  function event(type, data) {
    if (stopped) return;
    var e = {
      ts: new Date().toISOString(),
      t: Date.now() - T0,
      session: session,
      r: respondent,
      proto: CFG.prototype || '',
      type: type,
      vw: window.innerWidth,
      sy: Math.round(window.scrollY)
    };
    if (data) for (var k in data) e[k] = data[k];
    queue.push(e);
    try {
      var all = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
      all.push(e);
      if (all.length > 5000) all = all.slice(-5000);
      localStorage.setItem(LS_KEY, JSON.stringify(all));
    } catch (err) { /* приватный режим — живём без копии */ }
    if (queue.length >= 10) flush();
  }

  function flush() {
    if (!queue.length || !CFG.endpoint) { queue = CFG.endpoint ? queue : []; return; }
    var body = JSON.stringify({ events: queue });
    var ok = false;
    try { ok = navigator.sendBeacon(CFG.endpoint, new Blob([body], { type: 'text/plain' })); } catch (e) {}
    if (!ok) {
      try { fetch(CFG.endpoint, { method: 'POST', mode: 'no-cors', keepalive: true, body: body, headers: { 'Content-Type': 'text/plain' } }); } catch (e) {}
    }
    queue = [];
  }
  setInterval(flush, 3000);

  // Старт
  event('session_start', {
    ua: navigator.userAgent,
    vh: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
    ref: document.referrer || '',
    doc_h: docH()
  });

  // Тапы
  function sectionOf(el) { return el && el.closest ? el.closest('[data-section]') : null; }
  document.addEventListener('click', function (ev) {
    // искусственные клики браузера (активация label, отправка формы по Enter) без координат — не тапы
    if (ev.detail === 0 && ev.clientX === 0 && ev.clientY === 0) return;
    var el = ev.target;
    var tracked = el.closest ? el.closest('[data-track]') : null;
    var sec = sectionOf(el);
    var secBox = sec ? sec.getBoundingClientRect() : null;
    var label = tracked ? tracked.getAttribute('data-track') : '';
    var text = ((tracked || el).innerText || (tracked || el).alt || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    var isNav = !!(tracked && tracked.hasAttribute('data-nav'));
    event('tap', {
      el: label || 'untracked:' + el.tagName.toLowerCase(),
      text: text,
      dead: !isNav && !(el.closest && el.closest('button, input, label')),
      section: sec ? sec.getAttribute('data-section') : '',
      x: Math.round(ev.pageX), y: Math.round(ev.pageY),
      xr: +(ev.clientX / window.innerWidth).toFixed(4),
      yr: +(ev.pageY / docH()).toFixed(4),
      sxr: secBox ? +((ev.clientX - secBox.left) / secBox.width).toFixed(4) : null,
      syr: secBox ? +((ev.clientY - secBox.top) / secBox.height).toFixed(4) : null
    });
    if (isNav) {
      ev.preventDefault();
      var href = tracked.href;
      var to = tracked.getAttribute('data-to') || href;
      event('nav', { el: label, to: to });
      flush();
      if (/profi\.ru\/remont\//.test(to)) { markDone(); stopped = true; }
      setTimeout(function () { location.href = href; }, 150);
    }
  }, true);

  // Глубина скролла
  var marks = [25, 50, 75, 90, 100], hit = {};
  function onScroll() {
    var p = Math.min(100, Math.round((window.scrollY + window.innerHeight) / docH() * 100));
    if (p > maxScroll) maxScroll = p;
    marks.forEach(function (m) { if (p >= m && !hit[m]) { hit[m] = 1; event('scroll_depth', { pct: m }); } });
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  // Просмотр блоков (≥40% блока или ≥60% экрана занято блоком)
  if ('IntersectionObserver' in window) {
    var seen = {}, enter = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        var id = en.target.getAttribute('data-section');
        var visible = en.intersectionRatio >= 0.4 || en.intersectionRect.height >= window.innerHeight * 0.6;
        if (visible && !enter[id]) {
          enter[id] = Date.now();
          if (!seen[id]) { seen[id] = 1; event('section_view', { section: id }); }
        } else if (!visible && enter[id]) {
          event('section_dwell', { section: id, ms: Date.now() - enter[id] });
          enter[id] = 0;
        }
      });
    }, { threshold: [0, 0.2, 0.4, 0.6, 0.8, 1] });
    document.querySelectorAll('[data-section]').forEach(function (s) { io.observe(s); });
  }

  // Уход / сворачивание
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      event('page_hide', { ms: Date.now() - T0, max_scroll: maxScroll });
      flush();
    } else {
      if (isDone()) { stopped = true; return; }
      event('page_show', {});
    }
  });
  window.addEventListener('pagehide', function () { flush(); });
  // Возврат кнопкой «Назад» из УК (страница из кэша браузера) — больше не пишем
  window.addEventListener('pageshow', function (ev) { if (ev.persisted && isDone()) stopped = true; });

  // Экспорт локального лога: тройной тап по логотипу в шапке
  var taps = [];
  var logo = document.querySelector('.header .logo');
  if (logo) logo.addEventListener('click', function () {
    var now = Date.now();
    taps = taps.filter(function (t) { return now - t < 800; });
    taps.push(now);
    if (taps.length >= 3) { taps = []; showExport(); }
  });

  function showExport() {
    var data = '[]';
    try { data = localStorage.getItem(LS_KEY) || '[]'; } catch (e) {}
    var n = JSON.parse(data).length;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.5);display:flex;align-items:flex-end';
    wrap.innerHTML = '<div style="background:#fff;width:100%;border-radius:24px 24px 0 0;padding:24px 20px calc(24px + env(safe-area-inset-bottom));font:15px/20px -apple-system,system-ui,sans-serif">' +
      '<b style="font-size:17px">Лог прототипа</b><p style="color:#838398;margin:4px 0 16px">Событий на этом телефоне: ' + n + '. Сессия ' + session + '</p>' +
      '<button data-a="copy" style="width:100%;height:48px;border-radius:12px;background:#fa2a48;color:#fff;font-weight:600;margin-bottom:8px">Скопировать JSON</button>' +
      '<button data-a="clear" style="width:100%;height:48px;border-radius:12px;background:#eff1f8;margin-bottom:8px">Очистить и начать новую сессию</button>' +
      '<button data-a="close" style="width:100%;height:48px;border-radius:12px;background:#eff1f8">Закрыть</button></div>';
    wrap.addEventListener('click', function (e) {
      var a = e.target.getAttribute && e.target.getAttribute('data-a');
      if (a === 'copy') { navigator.clipboard && navigator.clipboard.writeText(data).then(function () { e.target.textContent = 'Скопировано'; }); }
      if (a === 'clear') { try { localStorage.removeItem(LS_KEY); sessionStorage.removeItem(SESSION_KEY); } catch (err) {} location.reload(); }
      if (a === 'close' || e.target === wrap) wrap.remove();
      e.stopPropagation();
    }, true);
    document.body.appendChild(wrap);
  }

  window.Track = { event: event, flush: flush, session: session };
})();
