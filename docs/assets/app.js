/* ==========================================================================
 * app.js — 界面逻辑
 *   ① 单型号查询(回车/点击即查,每次计 1 次请求)
 *   ② 批量导入 Excel/CSV(列自动识别 · 进度 · 日志 · 断点续查)
 *   ③ 结果导出 Excel
 * ========================================================================== */

(function () {
  'use strict';

  var DK = window.DigiKey;
  var COL = DK.DEFAULT_COLUMNS;

  var LS_KEY = {
    settings: 'dkmsl.settings.v1',
    counter: 'dkmsl.counter.v1',
    theme: 'dkmsl.theme.v1',
    batch: 'dkmsl.batch.v1'
  };

  var DEFAULT_SETTINGS = {
    clientId: '',
    clientSecret: '',
    requestDelay: 1.0,
    dailyLimit: 950,
    maxRetries: 3
  };

  /* ---------------- 状态 ---------------- */

  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    counter: {
      date: todayKey(),
      today: 0,
      session: 0,
      serverLimit: null,
      serverRemaining: null
    },
    results: [],          // 本次会话的单型号查询结果(用于导出)
    busy: false,
    batch: {
      rows: [],
      headerOrder: [],
      mapping: {},
      fileName: '',
      running: false,
      cancel: false,
      stats: { ok: 0, notfound: 0, mismatch: 0, error: 0, skip: 0 },
      rowEls: []
    }
  };

  /* ---------------- 小工具 ---------------- */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function todayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function nowStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function storageGet(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn('localStorage 写入失败', e);
      return false;
    }
  }

  function num(v, dflt) {
    var n = parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  /* ---------------- Toast ---------------- */

  var ICON = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
  };

  function toast(msg, type, ms) {
    var wrap = $('#toasts');
    var t = el('div', 'toast' + (type ? ' ' + type : ''));
    t.innerHTML = (type === 'ok' ? ICON.check : type === 'err' ? ICON.alert : ICON.info) +
      '<span></span>';
    t.lastChild.textContent = msg;
    wrap.appendChild(t);
    setTimeout(function () {
      t.classList.add('out');
      setTimeout(function () { t.remove(); }, 240);
    }, ms || 3200);
  }

  /* ---------------- 日志 ---------------- */

  function log(msg, level) {
    var body = $('#logBody');
    var empty = $('.log-empty', body);
    if (empty) empty.remove();

    var d = new Date();
    var line = el('div', 'log-line' + (level ? ' ' + level : ''));
    line.appendChild(el('span', 'log-time', pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())));
    line.appendChild(el('span', 'log-msg', msg));
    body.appendChild(line);

    // 只保留最近 400 行
    while (body.children.length > 400) body.removeChild(body.firstChild);
    body.scrollTop = body.scrollHeight;
  }

  /* ---------------- 主题 ---------------- */

  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    storageSet(LS_KEY.theme, mode);
    $('#iconSun').style.display = mode === 'dark' ? '' : 'none';
    $('#iconMoon').style.display = mode === 'dark' ? 'none' : '';
  }

  function initTheme() {
    var saved = storageGet(LS_KEY.theme, null);
    if (!saved) {
      saved = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    applyTheme(saved);
  }

  /* ---------------- 计数 ---------------- */

  function loadCounter() {
    var c = storageGet(LS_KEY.counter, null);
    if (c && typeof c === 'object') {
      state.counter.date = c.date || todayKey();
      state.counter.today = c.today || 0;
      state.counter.serverLimit = c.serverLimit === undefined ? null : c.serverLimit;
      state.counter.serverRemaining = c.serverRemaining === undefined ? null : c.serverRemaining;
      // 跨天归零
      if (state.counter.date !== todayKey()) {
        state.counter.date = todayKey();
        state.counter.today = 0;
      }
    }
    state.counter.session = 0;
  }

  function saveCounter() {
    storageSet(LS_KEY.counter, {
      date: state.counter.date,
      today: state.counter.today,
      serverLimit: state.counter.serverLimit,
      serverRemaining: state.counter.serverRemaining
    });
  }

  /** 每发起 1 次查询请求调用一次 */
  function bumpCounter() {
    if (state.counter.date !== todayKey()) {
      state.counter.date = todayKey();
      state.counter.today = 0;
    }
    state.counter.today += 1;
    state.counter.session += 1;
    saveCounter();
    renderCounter();
  }

  function quotaExhausted() {
    var limit = state.settings.dailyLimit;
    if (state.counter.today >= limit) {
      return '已达本地每日上限 ' + limit + ' 次。可在「设置」中调高,或明天再查。';
    }
    if (state.counter.serverRemaining !== null && state.counter.serverRemaining <= 0) {
      return 'DigiKey 服务端配额已用尽(今日 ' + (state.counter.serverLimit || 1000) + ' 次)。请等待配额重置。';
    }
    return null;
  }

  /**
   * 读取服务端配额。
   *
   * ⚠️ 实测结论:DigiKey 的响应里虽然有 x-ratelimit-limit / x-ratelimit-remaining,
   *    但它没有返回 Access-Control-Expose-Headers,所以浏览器只允许 JS 读取
   *    content-length 和 content-type —— 这两个 header 在浏览器里恒为 null。
   *    这里保留读取逻辑:万一 DigiKey 以后暴露它们,UI 会自动升级成显示服务端余额;
   *    在此之前界面统一用本机计数,不做虚假承诺。
   */
  function onQuota(limit, remaining) {
    if (limit !== null && limit !== undefined) state.counter.serverLimit = limit;
    if (remaining !== null && remaining !== undefined) state.counter.serverRemaining = remaining;
    if (limit || remaining) {
      saveCounter();
      renderCounter();
    }
  }

  function renderCounter() {
    var c = state.counter;
    var limit = state.settings.dailyLimit;

    var counterText = $('#counterText');
    if (counterText) counterText.textContent = '本次查询 ' + c.session + ' 次';

    var quotaChip = $('#quotaChip');
    var quotaText = $('#quotaText');

    if (c.serverRemaining !== null && c.serverRemaining !== undefined) {
      // 仅在服务端配额真的可读时才展示(目前浏览器下不会走到这里)
      var rem = c.serverRemaining;
      var lim = c.serverLimit || 1000;
      quotaChip.className = 'chip' + (rem <= 0 ? ' chip-danger' : rem < lim * 0.1 ? ' chip-warn' : ' chip-ok');
      quotaText.textContent = '服务端剩余 ' + rem + ' / ' + lim;
    } else {
      quotaChip.className = 'chip' +
        (c.today >= limit ? ' chip-danger' : c.today >= limit * 0.9 ? ' chip-warn' : '');
      quotaText.textContent = '今日 ' + c.today + ' / ' + limit;
    }

    var batchCounter = $('#batchCounter');
    if (batchCounter) batchCounter.textContent = '本次会话 ' + c.session + ' 次请求';
  }

  /* ---------------- 设置 ---------------- */

  function loadSettings() {
    var s = storageGet(LS_KEY.settings, null);
    state.settings = Object.assign({}, DEFAULT_SETTINGS, s || {});
    return state.settings;
  }

  function saveSettings(patch) {
    state.settings = Object.assign({}, state.settings, patch || {});
    storageSet(LS_KEY.settings, state.settings);
  }

  function hasCredentials() {
    return !!(state.settings.clientId && state.settings.clientSecret);
  }

  function makeClient() {
    return new DK.Client({
      clientId: state.settings.clientId,
      clientSecret: state.settings.clientSecret,
      maxRetries: num(state.settings.maxRetries, 3),
      onQuota: onQuota
    });
  }

  /* ---------------- 设置弹窗 ---------------- */

  function openSettings() {
    var s = state.settings;
    $('#setClientId').value = s.clientId || '';
    $('#setClientSecret').value = s.clientSecret || '';
    $('#setDelay').value = s.requestDelay !== undefined ? s.requestDelay : 1.0;
    $('#setLimit').value = s.dailyLimit !== undefined ? s.dailyLimit : 950;
    $('#setClientSecret').type = 'password';
    $('#revealBtn').textContent = '显示';
    $('#connResult').className = 'conn-result';
    $('#connResult').textContent = '';
    var dlg = $('#settingsDialog');
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function closeSettings() {
    var dlg = $('#settingsDialog');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  function readSettingsForm() {
    return {
      clientId: $('#setClientId').value.trim(),
      clientSecret: $('#setClientSecret').value.trim(),
      requestDelay: Math.max(0, num($('#setDelay').value, 1)),
      dailyLimit: Math.max(1, Math.floor(num($('#setLimit').value, 950))),
      maxRetries: 3
    };
  }

  function doSaveSettings(silent) {
    var patch = readSettingsForm();
    saveSettings(patch);
    renderCounter();
    closeSettings();
    if (!silent) toast('设置已保存到本机浏览器', 'ok');
    log('设置已保存(密钥仅存放于本机 localStorage)', 'brand');
  }

  function doTestConnection() {
    var patch = readSettingsForm();
    var res = $('#connResult');
    var btn = $('#testBtn');

    if (!patch.clientId || !patch.clientSecret) {
      res.className = 'conn-result err';
      res.textContent = '请先填入 Client ID 与 Client Secret';
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 测试中';
    res.className = 'conn-result';
    res.textContent = '正在向 DigiKey 申请 Token…';

    var client = new DK.Client({
      clientId: patch.clientId,
      clientSecret: patch.clientSecret
    });

    client.testConnection().then(function (r) {
      btn.disabled = false;
      btn.textContent = '测试连接';
      if (r.ok) {
        res.className = 'conn-result ok';
        res.innerHTML = ICON.check + '<span></span>';
        res.lastChild.textContent = r.message;
      } else {
        res.className = 'conn-result err';
        res.innerHTML = ICON.alert + '<span></span>';
        res.lastChild.textContent = r.message;
      }
    });
  }

  /* ---------------- 单型号查询 ---------------- */

  var MAX_SINGLE_PARTS = 20;

  /**
   * 把输入框内容切成型号列表。
   *
   * 分隔符:换行(含从 Excel 复制的制表符)、逗号、分号、顿号。
   * 刻意不用「空格」做分隔符 —— 有些型号本身带空格(如 "LM358 DR"),
   * 按空格切会把一个型号拆成两个,白白浪费一次 API 配额。
   */
  function splitParts(raw) {
    return String(raw)
      .split(/[\n\r\t,;，；、]+/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  /** 实时回显"把输入识别成了几个型号",让用户不必猜分隔规则 */
  function updateParseChip() {
    var chip = $('#parseChip');
    var text = $('#parseText');
    if (!chip || !text) return;

    var parts = splitParts($('#partInput').value);
    if (!parts.length) {
      chip.hidden = true;
      return;
    }

    var over = parts.length > MAX_SINGLE_PARTS;
    text.textContent = over
      ? '识别到 ' + parts.length + ' 个型号（超出 ' + MAX_SINGLE_PARTS + ' 个上限）'
      : '识别到 ' + parts.length + ' 个型号';
    chip.hidden = false;
    chip.className = 'chip ' + (over ? 'chip-danger' : 'chip-brand');
  }

  function setBusy(busy) {
    state.busy = busy;
    var btn = $('#queryBtn');
    btn.disabled = busy;
    btn.innerHTML = busy
      ? '<span class="spinner"></span><span>查询中</span>'
      : '<span>查询</span>' + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
    $('#queryForm').classList.toggle('is-busy', busy);
  }

  function runQuery() {
    if (state.busy) return;

    var raw = $('#partInput').value;
    var parts = splitParts(raw);

    if (!parts.length) {
      toast('请输入至少一个型号', 'err');
      $('#partInput').focus();
      return;
    }

    if (parts.length > MAX_SINGLE_PARTS) {
      toast('一次最多 ' + MAX_SINGLE_PARTS + ' 个型号，你识别到 ' + parts.length +
            ' 个。更多请用下方「批量查询」导入 Excel。', 'err');
      $('#partInput').focus();
      return;
    }

    if (!hasCredentials()) {
      toast('请先在「设置」中填入 DigiKey 密钥', 'err');
      openSettings();
      return;
    }

    var gate = quotaExhausted();
    if (gate) { toast(gate, 'err'); log(gate, 'err'); return; }

    var client = makeClient();
    var delay = num(state.settings.requestDelay, 1);
    var done = 0;

    setBusy(true);

    function next() {
      if (done >= parts.length) {
        setBusy(false);
        $('#partInput').value = '';
        autosize($('#partInput'));
        updateParseChip();
        if (parts.length > 1) toast('完成 ' + parts.length + ' 个型号查询', 'ok');
        return;
      }

      var part = parts[done];
      var gate2 = quotaExhausted();
      if (gate2) {
        setBusy(false);
        toast(gate2, 'err');
        log(gate2, 'err');
        return;
      }

      bumpCounter();
      log('查询 ' + part, 'brand');

      client.search(part, null).then(function (r) {
        var rec = buildRecord(part, r);
        pushResult(rec);

        if (r.msl) {
          log('  → MSL ' + (rec.__mslDisplay || rec[COL.msl]) +
              ' · 真空包装 ' + rec[COL.need_vacuum] +
              ' · ' + (rec[COL.matched_mfr] || '—'), 'ok');
        } else {
          log('  → ' + rec[COL.status], r.empty ? 'warn' : 'err');
        }
      }, function (err) {
        var rec = buildRecord(part, { ok: false, status: '异常: ' + (err && err.message ? err.message : String(err)) });
        pushResult(rec);
        log('  → ' + rec[COL.status], 'err');
      }).then(function () {
        done++;
        if (done < parts.length && delay > 0) {
          setTimeout(next, delay * 1000);
        } else {
          next();
        }
      });
    }

    next();
  }

  /** 把 API 结果转成一行记录(列名与 Python 版一致) */
  function buildRecord(part, r) {
    var rec = {};
    rec[COL.part] = part;
    rec[COL.brand] = '';
    rec[COL.msl] = r.msl || '';
    rec[COL.msl_num] = r.mslNum === null || r.mslNum === undefined ? '' : r.mslNum;
    rec[COL.need_vacuum] = r.msl ? r.vacuum : '未知';
    rec[COL.matched_mfr] = r.matchedMfr || '';
    rec[COL.rohs] = r.rohs || '';
    rec[COL.status] = r.status || '';
    rec[COL.query_time] = nowStr();
    // 仅用于界面展示,不会写进导出的 Excel
    var info = DK.describeMsl(r.msl);
    rec.__products = r.products || [];
    rec.__ok = !!r.msl;
    rec.__mslDisplay = r.mslDisplay || info.display || '';
    rec.__mslLevel = r.mslLevel || info.level || null;
    rec.__mslFull = r.mslFull || info.full || '';
    return rec;
  }

  function pushResult(rec) {
    state.results.unshift(rec);
    if (state.results.length > 60) state.results.pop();
    renderResults();
  }

  function clearResults() {
    state.results = [];
    renderResults();
  }

  function mslClass(rec) {
    if (rec[COL.msl_num] === '' || rec[COL.msl_num] === null || rec[COL.msl_num] === undefined) return 'msl-na';
    var n = parseInt(rec[COL.msl_num], 10);
    if (!isFinite(n)) return 'msl-na';
    return 'msl-' + Math.min(6, Math.max(0, n));
  }

  function idleClass(rec) {
    var s = String(rec[COL.status] || '');
    return s.indexOf('成功') !== -1 ? 'ok' : s.indexOf('未找到') !== -1 ? 'warn' : 'err';
  }

  function renderResults() {
    var wrap = $('#resultsList');
    var section = $('#resultSection');

    if (!state.results.length) {
      section.hidden = true;
      wrap.innerHTML = '';
      $('#heroSection').classList.remove('is-compact');
      return;
    }
    section.hidden = false;

    var html = state.results.map(function (rec, idx) {
      var mslNum = rec[COL.msl_num];
      var badge = rec.__mslLevel || ((mslNum === '' || mslNum === null || mslNum === undefined) ? 'N/A' : String(mslNum));
      var statusKey = idleClass(rec);
      var vacuum = rec[COL.need_vacuum];
      var vacCls = vacuum === '是' ? 'chip-warn' : vacuum === '否' ? 'chip-ok' : '';

      var cands = rec.__products || [];
      var candHtml = '';
      if (cands.length > 1) {
        candHtml =
          '<details class="candidates">' +
            '<summary>' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>' +
              '查看 ' + cands.length + ' 个匹配产品的 MSL 明细' +
            '</summary>' +
            '<div class="cand-list">' +
              cands.slice(0, 50).map(function (p) {
                return '<div class="cand-row">' +
                  '<div><div class="cand-mpn">' + escapeHtml(p.mpn || '—') + '</div>' +
                  '<div class="cand-mfr">' + escapeHtml(p.mfr || '—') + '</div></div>' +
                  '<div class="cand-msl">' + escapeHtml(p.msl ? DK.formatMsl(p.msl) : '无 MSL') + '</div>' +
                  '<div class="cand-msl">' + escapeHtml(p.rohs || '') + '</div>' +
                '</div>';
              }).join('') +
            '</div>' +
          '</details>';
      }

      return '' +
        '<article class="result" data-idx="' + idx + '">' +
          '<div class="result-head">' +
            '<div style="min-width:0">' +
              '<div class="result-part">' + escapeHtml(rec[COL.part]) + '</div>' +
              '<div class="result-brandline">' + escapeHtml(rec[COL.query_time]) + '</div>' +
            '</div>' +
            '<span class="chip chip-' + (statusKey === 'ok' ? 'ok' : statusKey === 'warn' ? 'warn' : 'danger') + '">' +
              '<span class="chip-dot"></span>' + escapeHtml(rec[COL.status]) +
            '</span>' +
          '</div>' +
          '<div class="msl-hero">' +
            '<div class="msl-badge ' + mslClass(rec) + '">' + escapeHtml(badge) + '</div>' +
            '<div class="msl-meta">' +
              '<div class="msl-label">湿气等级MSL<span class="msl-label-en">（Moisture Sensitivity Level）</span></div>' +
              '<div class="msl-value"' +
                (rec.__mslFull ? ' title="' + escapeHtml(rec.__mslFull) + '"' : '') + '>' +
                escapeHtml(rec.__mslDisplay || '该型号无 MSL 参数') +
              '</div>' +
              '<div class="msl-tags">' +
                '<span class="chip ' + vacCls + '"><span class="chip-dot"></span>真空包装 ' + escapeHtml(vacuum) + '</span>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="spec-grid">' +
            '<div class="spec"><div class="spec-k">匹配品牌</div><div class="spec-v">' + escapeHtml(rec[COL.matched_mfr] || '—') + '</div></div>' +
            '<div class="spec"><div class="spec-k">RoHS 状态</div><div class="spec-v">' + escapeHtml(rec[COL.rohs] || '—') + '</div></div>' +
            '<div class="spec"><div class="spec-k">候选产品</div><div class="spec-v mono">' + (cands.length || 0) + ' 个</div></div>' +
            '<div class="spec"><div class="spec-k">查询时间</div><div class="spec-v mono">' + escapeHtml(rec[COL.query_time]) + '</div></div>' +
          '</div>' +
          candHtml +
        '</article>';
    }).join('');

    wrap.innerHTML = html;
    $('#resultCount').textContent = state.results.length + ' 条结果';
    $('#heroSection').classList.add('is-compact');
  }

  /* ---------------- Excel 导出 ---------------- */

  function hasXLSX() {
    return typeof window.XLSX !== 'undefined';
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      a.remove();
    }, 500);
  }

  /**
   * 导出为 .xlsx
   * @param {Array<object>} rows
   * @param {string[]} headerOrder
   * @param {string} filename
   */
  function exportRows(rows, headerOrder, filename) {
    if (!rows.length) { toast('没有可导出的结果', 'err'); return; }

    if (!hasXLSX()) {
      // 兜底:导出 CSV
      var keys = headerOrder;
      var csv = '\ufeff' + keys.join(',') + '\n' + rows.map(function (r) {
        return keys.map(function (k) {
          var v = r[k] === undefined || r[k] === null ? '' : String(r[k]);
          return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
        }).join(',');
      }).join('\n');
      downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename.replace(/\.xlsx$/, '.csv'));
      toast('SheetJS 未加载,已导出 CSV', 'ok');
      return;
    }

    var clean = rows.map(function (r) {
      var o = {};
      headerOrder.forEach(function (k) {
        var v = r[k];
        o[k] = v === undefined || v === null ? '' : v;
      });
      return o;
    });

    var ws = XLSX.utils.json_to_sheet(clean, { header: headerOrder });

    // 列宽
    ws['!cols'] = headerOrder.map(function (k) {
      var longest = String(k).length;
      clean.forEach(function (r) {
        var v = r[k] === undefined ? '' : String(r[k]);
        if (v.length > longest) longest = v.length;
      });
      return { wch: Math.min(42, Math.max(10, longest + 2)) };
    });

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'MSL查询结果');
    XLSX.writeFile(wb, filename, { compression: true });
    toast('已导出 ' + filename, 'ok');
    log('导出 ' + rows.length + ' 条 → ' + filename, 'ok');
  }

  function resultHeaderOrder() {
    return [
      COL.part, COL.brand, COL.msl, COL.msl_num,
      COL.need_vacuum, COL.matched_mfr, COL.rohs, COL.status, COL.query_time
    ];
  }

  function exportSingleResults() {
    if (!state.results.length) { toast('暂无结果可导出', 'err'); return; }
    var rows = state.results.slice().reverse();
    exportRows(rows, resultHeaderOrder(), 'MSL查询结果_' + stamp() + '.xlsx');
  }

  /* ---------------- 批量导入 ---------------- */

  function looksLikeNote(text) {
    var t = String(text || '').trim();
    if (!t) return false;
    if (t.indexOf('说明') !== -1) return true;
    if (/^\d+\s*[.、)]/.test(t)) return true;
    if (t.length > 64) return true;
    return false;
  }

  /** 列自动识别:优先用模板列名,其次按关键词 */
  function resolveColumn(headers, preferred, tests) {
    var i;
    if (preferred) {
      for (i = 0; i < headers.length; i++) {
        if (String(headers[i]).trim() === String(preferred).trim()) return headers[i];
      }
    }
    for (i = 0; i < headers.length; i++) {
      var h = String(headers[i]).trim();
      if (!h) continue;
      var hl = h.toLowerCase();
      for (var j = 0; j < tests.length; j++) {
        if (tests[j](hl, h)) return headers[i];
      }
    }
    return null;
  }

  function detectMapping(headers) {
    var part = resolveColumn(headers, COL.part, [
      function (hl, h) { return h.indexOf('型号') !== -1; },
      function (hl) { return hl.indexOf('mpn') !== -1; },
      function (hl) { return hl.indexOf('part') !== -1; },
      function (hl, h) { return h.indexOf('料号') !== -1 || h.indexOf('物料') !== -1; },
      function (hl) { return hl.indexOf('pn') !== -1; }
    ]);

    var brand = resolveColumn(headers, COL.brand, [
      function (hl, h) { return h.indexOf('品牌') !== -1; },
      function (hl, h) { return h.indexOf('厂') !== -1; },
      function (hl) { return hl.indexOf('brand') !== -1; },
      function (hl) { return hl.indexOf('mfr') !== -1; },
      function (hl) { return hl.indexOf('manufacturer') !== -1; }
    ]);

    var status = resolveColumn(headers, COL.status, [
      function (hl, h) { return h.indexOf('查询状态') !== -1; },
      function (hl, h) { return h.indexOf('状态') !== -1; }
    ]);

    return { part: part, brand: brand, status: status };
  }

  function readWorkbook(file) {
    return new Promise(function (resolve, reject) {
      if (!hasXLSX()) {
        reject(new Error('解析库 SheetJS 未加载,请检查 vendor/xlsx.full.min.js'));
        return;
      }
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.onload = function (e) {
        try {
          var data = new Uint8Array(e.target.result);
          var wb = XLSX.read(data, { type: 'array', cellDates: false });
          var sheetName = wb.SheetNames[0];
          if (!sheetName) return reject(new Error('工作簿里没有工作表'));
          var ws = wb.Sheets[sheetName];
          var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: false, raw: false });
          resolve({ sheetName: sheetName, aoa: aoa });
        } catch (err) {
          reject(err);
        }
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function handleFile(file) {
    if (!file) return;
    var okExt = /\.(xlsx|xls|csv)$/i.test(file.name);
    if (!okExt) { toast('请选择 .xlsx / .xls / .csv 文件', 'err'); return; }

    readWorkbook(file).then(function (wb) {
      var aoa = wb.aoa || [];
      if (!aoa.length) { toast('文件是空的', 'err'); return; }

      // 找到表头行:第一行里包含识别出的型号列
      var headers = (aoa[0] || []).map(function (h) { return String(h).trim(); });
      if (!headers.some(function (h) { return h; })) { toast('第一行没有表头', 'err'); return; }

      var mapping = detectMapping(headers);
      if (!mapping.part) {
        toast('未找到型号列,请确认表头含「型号」或「MPN」', 'err');
        log('导入失败:未识别到型号列。当前表头:' + headers.join(' / '), 'err');
        return;
      }

      // 构建行
      var rows = [];
      for (var r = 1; r < aoa.length; r++) {
        var arr = aoa[r] || [];
        var obj = {};
        var hasAny = false;
        for (var c = 0; c < headers.length; c++) {
          if (!headers[c]) continue;
          var v = arr[c] === undefined ? '' : arr[c];
          obj[headers[c]] = v;
          if (String(v).trim()) hasAny = true;
        }
        if (!hasAny) continue;

        var partVal = String(obj[mapping.part] || '').trim();
        if (!partVal || looksLikeNote(partVal)) continue;

        // 输出列补齐 + 断点续查标记
        var existingStatus = mapping.status ? String(obj[mapping.status] || '').trim() : '';
        for (var k = 0; k < resultHeaderOrder().length; k++) {
          var key = resultHeaderOrder()[k];
          if (!(key in obj)) obj[key] = '';
        }
        obj[mapping.part] = partVal;

        rows.push({
          data: obj,
          part: partVal,
          brand: mapping.brand ? String(obj[mapping.brand] || '').trim() : '',
          resumed: !!existingStatus,
          done: !!existingStatus
        });
      }

      if (!rows.length) {
        toast('没有解析到有效型号行', 'err');
        log('文件中没有可查询的型号行', 'err');
        return;
      }

      var b = state.batch;
      b.rows = rows;
      b.fileName = file.name;
      b.mapping = mapping;
      b.headerOrder = headers.filter(Boolean).concat(
        resultHeaderOrder().filter(function (k) { return headers.indexOf(k) === -1; })
      );
      b.stats = { ok: 0, notfound: 0, mismatch: 0, error: 0, skip: 0 };
      b.cancel = false;

      var resumedCount = rows.filter(function (x) { return x.resumed; }).length;

      log('载入 ' + file.name + ' · ' + rows.length + ' 行型号', 'brand');
      log('列识别 → 型号列「' + mapping.part + '」' +
          (mapping.brand ? ' · 品牌列「' + mapping.brand + '」' : ' · 无品牌列(仅按型号查)'), 'brand');
      if (resumedCount) log(resumedCount + ' 行已有查询状态,将跳过(断点续查)', 'warn');

      $('#dropzone').hidden = true;
      $('#fileCard').hidden = false;
      $('#fileName').textContent = file.name;
      $('#fileSub').textContent = rows.length + ' 行 · 型号列: ' + mapping.part +
        (mapping.brand ? ' · 品牌列: ' + mapping.brand : ' · 无品牌列') +
        (resumedCount ? ' · 可续查 ' + resumedCount + ' 行' : '');

      renderBatchStats();
      renderTable();
      setProgress(0, rows.length);
      $('#startBatch').disabled = false;
      $('#startBatch').textContent = resumedCount === rows.length ? '无可查行' : '开始批量查询';
      $('#startBatch').disabled = resumedCount === rows.length;
      $('#exportBatch').disabled = true;

    }, function (err) {
      toast('读取失败:' + err.message, 'err');
      log('读取失败:' + err.message, 'err');
    });
  }

  function renderBatchStats() {
    var s = state.batch.stats;
    $('#batchStats').innerHTML =
      '<span class="chip chip-ok"><span class="chip-dot"></span>成功 ' + s.ok + '</span>' +
      '<span class="chip chip-warn"><span class="chip-dot"></span>未找到 ' + s.notfound + '</span>' +
      '<span class="chip chip-warn"><span class="chip-dot"></span>品牌不符 ' + s.mismatch + '</span>' +
      '<span class="chip chip-danger"><span class="chip-dot"></span>错误 ' + s.error + '</span>' +
      '<span class="chip"><span class="chip-dot"></span>跳过 ' + s.skip + '</span>';
  }

  function setProgress(done, total) {
    var pct = total ? Math.round((done / total) * 100) : 0;
    $('#progressFill').style.width = pct + '%';
    $('#progressText').textContent = done + ' / ' + total + '  (' + pct + '%)';
  }

  function statusPillClass(status) {
    var s = String(status || '');
    if (s.indexOf('跳过') !== -1) return 'skip';
    if (s.indexOf('成功') !== -1) return 'ok';
    if (s.indexOf('未找到') !== -1 || s.indexOf('无MSL') !== -1) return 'warn';
    if (s.indexOf('品牌不匹配') !== -1) return 'warn';
    return 'err';
  }

  /** 表格里用小标签,省地方;完整文案放 title 提示 + 导出的 Excel */
  function shortStatus(status) {
    var s = String(status || '');
    if (!s) return '';
    if (s.indexOf('成功(品牌匹配)') === 0) return '品牌匹配';
    if (s === '成功') return '成功';
    if (s.indexOf('未找到') === 0) return '未找到';
    if (s.indexOf('品牌不匹配') === 0) return '品牌不符';
    if (s.indexOf('无MSL') !== -1) return '无 MSL';
    if (s.indexOf('已达') !== -1) return '超限';
    return s.length > 12 ? s.slice(0, 12) + '…' : s;
  }

  /* 表格只展示决策关键字段,完整 9 列(含 MSL数字 / RoHS)在导出的 Excel 里 */
  var TABLE_COLS = [
    { key: COL.part, label: '型号', cls: 'mono-cell' },
    { key: COL.brand, label: '品牌', cls: 'nowrap-cell' },
    { key: COL.msl, label: 'MSL 等级', cls: 'mono-cell' },
    { key: COL.need_vacuum, label: '真空包装', cls: 'nowrap-cell' },
    { key: COL.matched_mfr, label: '匹配品牌', cls: 'nowrap-cell' },
    { key: COL.status, label: '查询状态', cls: 'nowrap-cell' }
  ];

  function renderTable() {
    var b = state.batch;
    var wrap = $('#tableScroll');
    var hint = $('#tableHint');
    if (!b.rows.length) { wrap.hidden = true; if (hint) hint.hidden = true; return; }
    wrap.hidden = false;
    if (hint) hint.hidden = false;
    wrap.innerHTML = '';

    var table = el('table', 'results');
    var thead = el('thead');
    var trh = el('tr');
    TABLE_COLS.forEach(function (c) { trh.appendChild(el('th', '', c.label)); });
    thead.appendChild(trh);
    table.appendChild(thead);

    var tbody = el('tbody');
    b.rowEls = [];

    b.rows.forEach(function (row) {
      var tr = el('tr');
      var cells = {};
      TABLE_COLS.forEach(function (c) {
        var td = el('td', c.cls);
        tr.appendChild(td);
        if (c.key === COL.status) {
          var pill = el('span', 'status-pill skip', row.resumed ? '已跳过' : '待查');
          td.appendChild(pill);
          cells._status = pill;
        } else {
          cells[c.key] = td;
        }
      });
      tbody.appendChild(tr);
      b.rowEls.push({ tr: tr, cells: cells, row: row });
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    refreshTableCells();
  }

  function refreshTableCells() {
    var b = state.batch;
    for (var i = 0; i < b.rowEls.length; i++) {
      var entry = b.rowEls[i];
      var d = entry.row.data;

      for (var j = 0; j < TABLE_COLS.length; j++) {
        var c = TABLE_COLS[j];
        if (c.key === COL.status) continue;
        var td = entry.cells[c.key];
        if (!td) continue;
        var v = d[c.key];
        // MSL 列在表格里显示中文等级,导出 Excel 时仍是原始英文值
        if (c.key === COL.msl) {
          var shown = v ? DK.formatMsl(v) : '';
          td.textContent = shown || '';
          if (v && shown) td.setAttribute('title', String(v));
          continue;
        }
        td.textContent = (v === undefined || v === null) ? '' : String(v);
      }

      var st = String(d[COL.status] || '').trim();
      var pill = entry.cells._status;
      if (!st) {
        pill.textContent = entry.row.done ? '—' : (entry.row.resumed ? '已跳过' : '待查');
        pill.className = 'status-pill skip';
        pill.removeAttribute('title');
      } else {
        pill.textContent = shortStatus(st);
        pill.className = 'status-pill ' + statusPillClass(st);
        pill.setAttribute('title', st);
      }
    }
  }

  function startBatch() {
    var b = state.batch;
    if (!b.rows.length) { toast('请先导入文件', 'err'); return; }
    if (b.running) return;

    if (!hasCredentials()) {
      toast('请先在「设置」中填入 DigiKey 密钥', 'err');
      openSettings();
      return;
    }

    var gate = quotaExhausted();
    if (gate) { toast(gate, 'err'); log(gate, 'err'); return; }

    var pending = b.rows.filter(function (r) { return !r.done; });
    if (!pending.length) { toast('所有行都已有结果,无需重查', 'ok'); return; }

    var client = makeClient();
    var delay = num(state.settings.requestDelay, 1);

    b.running = true;
    b.cancel = false;
    $('#startBatch').disabled = true;
    $('#stopBatch').hidden = false;
    $('#exportBatch').disabled = true;
    $('#startBatch').textContent = '查询中…';

    log('开始批量查询:待查 ' + pending.length + ' 行 · 间隔 ' + delay + 's', 'brand');

    var idx = 0;

    function step() {
      if (b.cancel) return finish('用户已停止');
      if (idx >= b.rows.length) return finish(null);

      var entry = b.rows[idx];
      if (entry.done) {
        b.stats.skip += 1;
        idx += 1;
        renderBatchStats();
        return step();
      }

      var gate2 = quotaExhausted();
      if (gate2) {
        log(gate2, 'err');
        toast(gate2, 'err');
        return finish('配额用尽');
      }

      var part = entry.part;
      var brand = entry.brand;

      bumpCounter();
      log('[' + (idx + 1) + '/' + b.rows.length + '] ' + part + (brand ? ' / ' + brand : ''), 'brand');

      client.search(part, brand || null).then(function (r) {
        var rec = buildRecord(part, r);
        rec[COL.brand] = brand || '';

        entry.data[COL.msl] = rec[COL.msl];
        entry.data[COL.msl_num] = rec[COL.msl_num];
        entry.data[COL.need_vacuum] = rec[COL.need_vacuum];
        entry.data[COL.matched_mfr] = rec[COL.matched_mfr];
        entry.data[COL.rohs] = rec[COL.rohs];
        entry.data[COL.status] = rec[COL.status];
        entry.data[COL.query_time] = rec[COL.query_time];
        entry.done = true;

        if (rec.__ok) {
          b.stats.ok += 1;
          log('  → MSL ' + (rec.__mslDisplay || rec[COL.msl] || '') +
              ' · 真空包装 ' + rec[COL.need_vacuum] +
              ' · ' + (rec[COL.matched_mfr] || '—'), 'ok');
        } else if (String(rec[COL.status]).indexOf('品牌不匹配') !== -1) {
          b.stats.mismatch += 1;
          log('  → ' + rec[COL.status], 'warn');
        } else if (String(rec[COL.status]).indexOf('未找到') !== -1 || String(rec[COL.status]).indexOf('无MSL') !== -1) {
          b.stats.notfound += 1;
          log('  → ' + rec[COL.status], 'warn');
        } else {
          b.stats.error += 1;
          log('  → ' + rec[COL.status], 'err');
        }
      }, function (err) {
        entry.data[COL.status] = '异常: ' + (err && err.message ? err.message : String(err));
        entry.data[COL.query_time] = nowStr();
        entry.done = true;
        b.stats.error += 1;
        log('  → ' + entry.data[COL.status], 'err');
      }).then(function () {
        idx += 1;
        renderBatchStats();
        setProgress(idx, b.rows.length);
        refreshTableCells();
        maybePersistBatch();

        // 自动滚动到当前行
        var cur = b.rowEls[idx - 1];
        if (cur && cur.tr) {
          var scroll = $('#tableScroll');
          var top = cur.tr.offsetTop - scroll.clientHeight / 2;
          scroll.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
        }

        if (idx < b.rows.length && delay > 0) setTimeout(step, delay * 1000);
        else step();
      });
    }

    function finish(reason) {
      b.running = false;
      $('#stopBatch').hidden = true;
      $('#stopBatch').disabled = false;
      $('#exportBatch').disabled = false;

      var pendingLeft = b.rows.filter(function (r) { return !r.done; }).length;
      if (pendingLeft === 0) {
        $('#startBatch').disabled = true;
        $('#startBatch').textContent = '已全部完成';
      } else {
        $('#startBatch').disabled = false;
        $('#startBatch').textContent = '继续查询（剩 ' + pendingLeft + ' 行）';
      }

      renderBatchStats();
      clearBatchPersist();

      if (reason) {
        log('已停止:' + reason, 'warn');
        toast('已停止 · ' + reason, 'err');
      } else {
        var s = b.stats;
        log('批量查询完成 · 成功 ' + s.ok + ' · 未找到 ' + s.notfound +
            ' · 品牌不符 ' + s.mismatch + ' · 错误 ' + s.error + ' · 跳过 ' + s.skip, 'ok');
        toast('批量查询完成,可导出结果', 'ok');
      }
    }

    step();
  }

  function stopBatch() {
    state.batch.cancel = true;
    $('#stopBatch').disabled = true;
    log('已请求停止,当前型号完成后停止…', 'warn');
  }

  function exportBatch() {
    var b = state.batch;
    var rows = b.rows.map(function (r) { return r.data; });
    var order = b.headerOrder.length ? b.headerOrder : resultHeaderOrder();
    exportRows(rows, order, 'MSL查询结果_' + stamp() + '.xlsx');
  }

  /* ---------------- 批量进度持久化(防刷新丢失) ---------------- */

  function maybePersistBatch() {
    var b = state.batch;
    if (!b.rows.length) return;
    if (b.rows.length > 3000) return; // 防止超出 localStorage 配额
    storageSet(LS_KEY.batch, {
      fileName: b.fileName,
      headerOrder: b.headerOrder,
      rows: b.rows.map(function (r) {
        return { data: r.data, part: r.part, brand: r.brand, resumed: r.resumed, done: r.done };
      }),
      savedAt: nowStr()
    });
  }

  function clearBatchPersist() {
    try { localStorage.removeItem(LS_KEY.batch); } catch (e) {}
  }

  function tryRestoreBatch() {
    var saved = storageGet(LS_KEY.batch, null);
    if (!saved || !saved.rows || !saved.rows.length) return false;

    var b = state.batch;
    b.rows = saved.rows;
    b.fileName = saved.fileName || '上次导入';
    b.headerOrder = saved.headerOrder || resultHeaderOrder();
    b.stats = { ok: 0, notfound: 0, mismatch: 0, error: 0, skip: 0 };
    b.rows.forEach(function (r) {
      var s = String(r.data[COL.status] || '');
      if (!s) { b.stats.skip += 0; return; }
      if (s.indexOf('成功') !== -1) b.stats.ok += 1;
      else if (s.indexOf('品牌不匹配') !== -1) b.stats.mismatch += 1;
      else if (s.indexOf('未找到') !== -1 || s.indexOf('无MSL') !== -1) b.stats.notfound += 1;
      else b.stats.error += 1;
    });

    $('#dropzone').hidden = true;
    $('#fileCard').hidden = false;
    $('#fileName').textContent = b.fileName;
    $('#fileSub').textContent = b.rows.length + ' 行 · 恢复自 ' + (saved.savedAt || '上次会话');
    renderBatchStats();
    renderTable();
    var doneCount = b.rows.filter(function (r) { return r.done; }).length;
    setProgress(doneCount, b.rows.length);
    $('#startBatch').disabled = false;
    $('#startBatch').textContent = '继续查询';
    $('#exportBatch').disabled = doneCount === 0;
    log('已恢复上次批量进度:' + b.fileName + ' · ' + b.rows.length + ' 行,已完成 ' + doneCount, 'brand');
    toast('已恢复上次批量进度', 'ok');
    return true;
  }

  /* ---------------- 文本域自适应 ---------------- */

  function autosize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 150) + 'px';
  }

  /* ---------------- 事件绑定 ---------------- */

  function bind() {
    // 主题
    $('#themeBtn').addEventListener('click', function () {
      var cur = document.documentElement.getAttribute('data-theme');
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });

    // 设置
    $('#settingsBtn').addEventListener('click', openSettings);
    $('#settingsBtn2').addEventListener('click', openSettings);
    $('#closeSettings').addEventListener('click', closeSettings);
    $('#saveSettings').addEventListener('click', function () { doSaveSettings(false); });
    $('#testBtn').addEventListener('click', doTestConnection);

    $('#revealBtn').addEventListener('click', function () {
      var inp = $('#setClientSecret');
      var showing = inp.type === 'text';
      inp.type = showing ? 'password' : 'text';
      this.textContent = showing ? '显示' : '隐藏';
    });

    $('#clearKeyBtn').addEventListener('click', function () {
      if (!confirm('确定清除本机保存的密钥?清除后需要重新填入。')) return;
      $('#setClientId').value = '';
      $('#setClientSecret').value = '';
      doSaveSettings(true);
      toast('已清除密钥', 'ok');
    });

    // 弹窗点遮罩关闭
    $('#settingsDialog').addEventListener('click', function (e) {
      if (e.target === this) closeSettings();
    });

    // 单型号查询
    $('#queryForm').addEventListener('submit', function (e) {
      e.preventDefault();
      runQuery();
    });

    var input = $('#partInput');
    input.addEventListener('input', function () { autosize(this); updateParseChip(); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        runQuery();
      }
    });

    $('#clearResults').addEventListener('click', clearResults);
    $('#exportSingle').addEventListener('click', exportSingleResults);

    // 批量拖拽
    var dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dz.classList.add('is-drag');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dz.addEventListener(ev, function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (ev === 'dragleave' && dz.contains(e.relatedTarget)) return;
        dz.classList.remove('is-drag');
      });
    });
    dz.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length) handleFile(files[0]);
    });
    dz.addEventListener('click', function () { $('#fileInput').click(); });

    // 整页拖入
    window.addEventListener('dragover', function (e) {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1) {
        e.preventDefault();
      }
    });
    window.addEventListener('drop', function (e) {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      if (!state.batch.running) handleFile(e.dataTransfer.files[0]);
    });

    $('#fileInput').addEventListener('change', function () {
      if (this.files && this.files.length) handleFile(this.files[0]);
      this.value = '';
    });

    $('#startBatch').addEventListener('click', startBatch);
    $('#stopBatch').addEventListener('click', stopBatch);
    $('#exportBatch').addEventListener('click', exportBatch);

    $('#resetBatch').addEventListener('click', function () {
      if (state.batch.running) { toast('请先停止当前查询', 'err'); return; }
      if (state.batch.rows.length && !confirm('确定放弃当前批次?')) return;
      state.batch.rows = [];
      state.batch.rowEls = [];
      state.batch.fileName = '';
      state.batch.stats = { ok: 0, notfound: 0, mismatch: 0, error: 0, skip: 0 };
      clearBatchPersist();
      $('#dropzone').hidden = false;
      $('#fileCard').hidden = true;
      $('#tableScroll').hidden = true;
      $('#tableHint').hidden = true;
      $('#exportBatch').disabled = true;
      $('#startBatch').disabled = true;
      setProgress(0, 0);
      renderBatchStats();
    });

    // 下载模板
    $('#downloadTemplate').addEventListener('click', downloadImportTemplate);

    // 快捷键
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        openSettings();
      }
    });

    // 离页提示
    window.addEventListener('beforeunload', function (e) {
      if (state.batch.running) {
        e.preventDefault();
        e.returnValue = '批量查询进行中,确定离开?';
        return e.returnValue;
      }
    });
  }

  /* ---------------- 导入模板 ---------------- */

  function downloadImportTemplate() {
    var headers = [COL.part, COL.brand];
    var rows = [
      { '型号': 'STM32F103C8T6', '品牌': 'ST' },
      { '型号': 'GRM155R71C104KA88D', '品牌': 'Murata' },
      { '型号': 'LM358DR', '品牌': 'Texas Instruments' }
    ];
    exportRows(rows, headers, '型号清单_导入模板.xlsx');
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    initTheme();
    loadSettings();
    loadCounter();
    bind();

    renderCounter();
    renderBatchStats();
    setProgress(0, 0);
    renderResults();

    if (hasXLSX()) {
      log('SheetJS 已就绪,支持 .xlsx / .xls / .csv 导入', 'ok');
    } else {
      log('警告:vendor/xlsx.full.min.js 未加载,批量导入不可用(单型号查询不受影响)', 'err');
    }

    if (hasCredentials()) {
      log('已加载本机保存的密钥', 'brand');
    } else {
      log('未配置密钥。点击右上角「设置」填入 DigiKey Client ID / Secret。', 'warn');
    }

    // 恢复上次批量进度
    tryRestoreBatch();

    // 首次使用自动打开设置
    if (!hasCredentials()) {
      setTimeout(openSettings, 420);
    }

    autosize($('#partInput'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
