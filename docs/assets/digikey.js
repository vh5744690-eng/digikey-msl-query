/* ==========================================================================
 * digikey.js — DigiKey MSL 查询核心
 * 由原 Python 版 digikey_api.py 移植而来,业务逻辑保持一致:
 *   - OAuth2 client_credentials 取 token,自动续期
 *   - V4 Keyword Search 搜索
 *   - MSL / RoHS 提取(Classifications 优先,Parameters 兜底)
 *   - 品牌模糊匹配(ST / TI / ADI ... 别名表)
 *   - MSL 数字解析 + 真空包装判定(MSL >= 2 需要)
 * ========================================================================== */

(function (global) {
  'use strict';

  /* ---------------- 默认列名(与 Python 版完全一致) ---------------- */

  var DEFAULT_COLUMNS = {
    part: '型号',
    brand: '品牌',
    msl: 'MSL等级',
    msl_num: 'MSL数字',
    need_vacuum: '需真空包装',
    matched_mfr: '匹配品牌',
    rohs: 'RoHS状态',
    status: '查询状态',
    query_time: '查询时间'
  };

  /* ---------------- 品牌别名表(照搬 Python 版) ---------------- */

  /* 品牌别名表
   * 在 Python 原版基础上补充了中文厂名 —— 你的型号清单里多半写的是"德州仪器"这类中文,
   * 原版只认英文,填写中文品牌时会被判为"品牌不匹配"。 */
  var BRAND_ALIASES = {
    'st': ['stmicroelectronics', 'st microelectronics', 'st', '意法半导体', '意法'],
    'ti': ['texas instruments', 'ti', '德州仪器', '德仪'],
    'adi': ['analog devices', 'adi', '亚德诺', '美国模拟器件'],
    'nxp': ['nxp', 'nxp semiconductors', '恩智浦'],
    'on': ['on semiconductor', 'onsemi', 'on', '安森美'],
    'microchip': ['microchip technology', 'microchip', '微芯'],
    'micrel': ['micrel', 'microchip'],
    'maxim': ['maxim integrated', 'maxim', 'analog devices', '美信'],
    'toshiba': ['toshiba', 'toshiba electronic devices & storage', '东芝'],
    'samsung': ['samsung electro-mechanics', 'samsung', 'samsung electronics', '三星'],
    'murata': ['murata', 'murata electronics', '村田'],
    'tdk': ['tdk', 'tdk electronics', '东电化'],
    'yageo': ['yageo', 'yageo corporation', '国巨'],
    'taiyo': ['taiyo yuden', 'taiyo', '太阳诱电'],
    'kyocera': ['kyocera', 'kyocera avx', 'avx', '京瓷'],
    'vishay': ['vishay', 'vishay thin film', 'vishay dale', '威世'],
    'panasonic': ['panasonic', 'panasonic electronic components', '松下'],
    'rohm': ['rohm', 'rohm semiconductor', '罗姆'],
    'infineon': ['infineon', 'infineon technologies', '英飞凌'],
    'renesas': ['renesas', 'renesas electronics', '瑞萨'],
    'silicon labs': ['silicon labs', 'silicon laboratories', '芯科'],
    'micron': ['micron', 'micron technology', '美光'],
    'microchip_alt': ['microchip'],
    'hrotek': ['holtek', 'holtek semiconductor', '盛群'],
    'holtek': ['holtek', 'holtek semiconductor', '盛群'],
    'gmt': ['gmt', 'global mixed-mode technology', '致新'],
    '3peak': ['3peak', '3peak microelectronics', '思瑞浦'],
    'silan': ['silan', 'hangzhou silan microelectronics', '士兰'],
    'sst': ['sst', 'silicon storage technology', '超捷'],
    'winbond': ['winbond', 'winbond electronics', '华邦'],
    'nuvoton': ['nuvoton', 'nuvoton technology', '新唐'],
    'realtek': ['realtek', 'realtek semiconductor', '瑞昱'],
    'novatek': ['novatek', '联咏'],
    'esmt': ['esmt', 'elite semiconductor', '晶豪'],
    'diodes': ['diodes incorporated', 'diodes', '达尔'],
    'liteon': ['lite-on', 'liteon', '光宝'],
    'delta': ['delta electronics', '台达'],
    'yageo_alt': ['yageo'],
    'ampere': ['ampere computing', '安晟培'],
    'rockchip': ['rockchip', '瑞芯微'],
    'allwinner': ['allwinner', '全志']
  };

  /* ---------------- 纯函数工具 ---------------- */

  /** 折叠多余空白。DigiKey 会返回 '3  (168 Hours)'(双空格),统一成单空格。 */
  function norm(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/\s+/g, ' ').trim();
  }

  /** '3 (168 Hours)' -> 3 ; 无数字返回 null */
  function parseMslNumber(mslValue) {
    if (!mslValue) return null;
    var m = String(mslValue).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  /* ---------------- MSL 等级中文对照 ---------------- */

  /* DigiKey 的 MoistureSensitivityLevel 形如 "3  (168 Hours)" / "1  (Unlimited)" /
   * "2a  (4 Weeks)",括号里是"车间寿命"(floor life)。
   * short = 前端紧凑展示用,full = 悬停提示用的完整说明。 */
  var MSL_GRADES = {
    '1':  { short: '无限的', full: '无限车间寿命' },
    '2':  { short: '1年',   full: '一年车间寿命' },
    '2a': { short: '4周',   full: '四周车间寿命' },
    '3':  { short: '168H',  full: '168小时车间寿命' },
    '4':  { short: '72H',   full: '72小时车间寿命' },
    '5':  { short: '48H',   full: '48小时车间寿命' },
    '5a': { short: '24H',   full: '24小时车间寿命' },
    '6':  { short: '12H',   full: '12小时车间寿命' }
  };

  /* 非数值型返回值。实测 "Not Applicable" 出现频率很高,必须单独处理。 */
  var MSL_SPECIAL = {
    'not applicable': { display: '不适用', full: '不适用（该产品无湿敏等级要求）' },
    'n/a': { display: '不适用', full: '不适用（该产品无湿敏等级要求）' },
    'na': { display: '不适用', full: '不适用（该产品无湿敏等级要求）' },
    'vendor undefined': { display: '厂商未定义', full: '厂商未定义湿敏等级' },
    'unknown': { display: '未知', full: '未知' }
  };

  /**
   * 提取等级标记。
   *   '2a (4 Weeks)' -> '2a'
   *   '3 (168 Hours)' -> '3'
   *   'Level 2' -> '2'
   */
  function parseMslLevel(mslValue) {
    if (mslValue === null || mslValue === undefined) return null;
    var s = String(mslValue).trim();
    if (!s) return null;

    // 1) 开头就是等级(绝大多数情况)
    var m = s.match(/^([0-9]+\s*[a-zA-Z]?)/);
    if (m && /[0-9]/.test(m[1])) {
      return m[1].replace(/\s+/g, '').toLowerCase();
    }
    // 2) "MSL 2" / "Level 3" 之类
    m = s.match(/(?:MSL|Level|等级)\s*([0-9]+\s*[a-zA-Z]?)/i);
    if (m) return m[1].replace(/\s+/g, '').toLowerCase();
    // 3) 兜底:第一个数字
    m = s.match(/([0-9]+)/);
    return m ? m[1] : null;
  }

  /**
   * 把 MSL 原始值转成前端展示信息。
   * @returns {{level: string|null, short: string|null, full: string|null,
   *            display: string|null, known: boolean}}
   *
   * 例:
   *   '1 (Unlimited)'  -> { level:'1',  display:'1（无限的）' }
   *   '2 (1 Year)'     -> { level:'2',  display:'2（1年）'   }
   *   '3 (168 Hours)'  -> { level:'3',  display:'3（168H）'  }
   *   'Not Applicable' -> { level:null, display:'不适用'     }
   */
  function describeMsl(mslValue) {
    var raw = norm(mslValue);
    if (!raw) {
      return { level: null, short: null, full: null, display: null, known: false };
    }

    var level = parseMslLevel(raw);
    var grade = level ? MSL_GRADES[level] : null;
    if (grade) {
      return {
        level: level,
        short: grade.short,
        full: grade.full,
        display: level + '（' + grade.short + '）',
        known: true
      };
    }

    // 非数值型
    var special = MSL_SPECIAL[raw.toLowerCase()];
    if (special) {
      return {
        level: null,
        short: null,
        full: special.full,
        display: special.display,
        known: false
      };
    }

    // 完全没见过的值:原样展示,不做瞎猜
    return { level: null, short: null, full: raw, display: raw, known: false };
  }

  /** 只要展示字符串,取不到时返回空串 */
  function formatMsl(mslValue) {
    return describeMsl(mslValue).display || '';
  }

  /** MSL >= 2 需要真空包装 */
  function needsVacuum(mslNumber) {
    if (mslNumber === null || mslNumber === undefined) return '未知';
    return mslNumber >= 2 ? '是' : '否';
  }

  /** 从产品 Classifications 提取 MSL,失败则回落到 Parameters */
  function extractMsl(product) {
    var cls = product && product.Classifications;
    if (cls && cls.MoistureSensitivityLevel) {
      var v = norm(cls.MoistureSensitivityLevel);
      if (v) return v;
    }
    var params = (product && product.Parameters) || [];
    for (var i = 0; i < params.length; i++) {
      var name = String(params[i].ParameterText || '').toLowerCase();
      if (name.indexOf('moisture sensitivity') !== -1 || name.indexOf('msl') !== -1) {
        var val = norm(params[i].ValueText);
        if (val) return val;
      }
    }
    return null;
  }

  /** 从产品 Classifications 提取 RoHS 状态 */
  function extractRohs(product) {
    var cls = product && product.Classifications;
    if (cls && cls.RohsStatus) {
      var v = norm(cls.RohsStatus);
      if (v) return v;
    }
    return null;
  }

  /**
   * 品牌名归一化:小写、去标点、压空白
   */
  function normBrand(s) {
    return String(s === null || s === undefined ? '' : s)
      .toLowerCase()
      .replace(/[.,()&/\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * 给一个厂名 vs 一组候选词打分。
   *
   * 这里刻意不用原版的「双向子串包含」,因为短品牌名会灾难性误匹配:
   *   'on' 是 "Murata Electr-ON-ics" 的子串
   *   'st' 是 "Texas In-ST-ruments" 的子串 → 会把 TI 的 MSL 当成 ST 的报给你。
   * 改为分级评分:完全相同 > 厂名以该词开头 > 首词相同 > 足够长的包含。
   */
  function scoreBrand(mfr, terms) {
    var m = normBrand(mfr);
    if (!m) return 0;
    var mHead = m.split(' ')[0];
    var best = 0;

    for (var i = 0; i < terms.length; i++) {
      var t = normBrand(terms[i]);
      if (!t) continue;
      var score = 0;

      if (m === t) {
        score = 100;                                   // 完全相同
      } else if (m.indexOf(t + ' ') === 0) {
        score = 80;                                    // 厂名以该词开头
      } else if (mHead === t) {
        score = 75;                                    // 厂名首词相同
      } else if (t.length >= 4 && m.indexOf(t) !== -1) {
        score = 40;                                    // 足够长(>=4)的包含
      } else if (t.length >= 6 && m.length >= 4 && t.indexOf(m) !== -1) {
        score = 30;                                    // 反向包含(品牌写得比厂名长)
      }

      if (score > best) best = score;
    }
    return best;
  }

  /**
   * 品牌模糊匹配,处理 'ST' vs 'STMicroelectronics'、'德州仪器' vs 'Texas Instruments'。
   * 返回得分最高的产品对象,或 null。
   */
  function matchManufacturer(products, brand) {
    var brandLower = normBrand(brand);
    if (!brandLower) return null;

    var terms = [brandLower];
    var keys = Object.keys(BRAND_ALIASES);

    // 品牌名命中别名表 → 展开全部同义写法
    for (var k = 0; k < keys.length; k++) {
      var aliasList = BRAND_ALIASES[keys[k]];
      if (brandLower === keys[k] || aliasList.indexOf(brandLower) !== -1) {
        terms = terms.concat(aliasList, [keys[k]]);
        break;
      }
    }

    var best = null;
    var bestScore = 0;
    for (var i = 0; i < products.length; i++) {
      var score = scoreBrand(products[i].mfr, terms);
      if (score > bestScore) {
        bestScore = score;
        best = products[i];
      }
    }
    return bestScore >= 30 ? best : null;
  }

  /* ---------------- 错误类型 ---------------- */

  function DkError(message, code, detail) {
    this.name = 'DkError';
    this.message = message;
    this.code = code || 'unknown';
    this.detail = detail || '';
  }
  DkError.prototype = Object.create(Error.prototype);
  DkError.prototype.constructor = DkError;

  /* ---------------- 客户端 ---------------- */

  /* 只保留 DigiKey 正式环境。
   * 沙盒环境返回的是假数据、查询结果没有实际意义,对本工具无用,已移除。 */
  var API_BASE = 'https://api.digikey.com';
  var TOKEN_URL = API_BASE + '/v1/oauth2/token';

  /**
   * @param {object} opts
   *   clientId, clientSecret, maxRetries (default 3), onQuota (fn(limit, remaining))
   */
  function DigiKeyClient(opts) {
    opts = opts || {};
    this.clientId = (opts.clientId || '').trim();
    this.clientSecret = (opts.clientSecret || '').trim();
    this.maxRetries = opts.maxRetries || 3;
    this.onQuota = opts.onQuota || null;
    this.onToken = opts.onToken || null;

    this.tokenUrl = TOKEN_URL;
    this.apiBase = API_BASE;

    this._token = null;
    this._tokenExpiresAt = 0;
  }

  /** 带超时的 fetch */
  function fetchWithTimeout(url, init, timeoutMs) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      init.signal = ctrl.signal;
      timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    }
    return fetch(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      return res;
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /** 获取 OAuth2 token,带缓存与自动续期 */
  DigiKeyClient.prototype.ensureToken = function (forceRefresh) {
    var self = this;
    if (!this.clientId || !this.clientSecret) {
      return Promise.reject(new DkError('尚未配置 Client ID / Client Secret', 'nokey'));
    }
    var now = Date.now() / 1000;
    if (!forceRefresh && this._token && now < this._tokenExpiresAt - 60) {
      return Promise.resolve(this._token);
    }

    // 用 URLSearchParams => Content-Type 为 form-urlencoded,
    // 属于 CORS 简单请求,不触发预检,速度更快。
    var body = new URLSearchParams();
    body.append('client_id', this.clientId);
    body.append('client_secret', this.clientSecret);
    body.append('grant_type', 'client_credentials');

    return fetchWithTimeout(this.tokenUrl, {
      method: 'POST',
      body: body,
      headers: { 'Accept': 'application/json' }
    }, 15000).then(function (res) {
      return res.text().then(function (text) {
        if (res.status !== 200) {
          throw new DkError(
            '认证失败 (' + res.status + ')' + excerpt(text),
            res.status === 401 || res.status === 400 ? 'badauth' : 'httperror',
            text
          );
        }
        var data;
        try { data = JSON.parse(text); } catch (e) {
          throw new DkError('Token 响应不是合法 JSON', 'badjson', text);
        }
        self._token = data.access_token;
        self._tokenExpiresAt = (Date.now() / 1000) + (data.expires_in || 600);
        if (self.onToken) self.onToken(data);
        return self._token;
      });
    }, function (err) {
      throw new DkError('无法连接 DigiKey 认证服务(' + err.name + ')', 'network', String(err));
    });
  };

  /** 测试连接:仅取 token */
  DigiKeyClient.prototype.testConnection = function () {
    var self = this;
    this._token = null;
    return this.ensureToken(true).then(function () {
      return {
        ok: true,
        message: '连接成功 · Token 有效期 ' +
                 Math.round(self._tokenExpiresAt - Date.now() / 1000) + ' 秒'
      };
    }, function (err) {
      return { ok: false, message: err.message || String(err) };
    });
  };

  function excerpt(text) {
    if (!text) return '';
    var t = String(text).replace(/\s+/g, ' ').trim();
    return t ? ': ' + t.slice(0, 180) : '';
  }

  function headersFor(token, clientId) {
    return {
      'Authorization': 'Bearer ' + token,
      'X-DIGIKEY-Client-Id': clientId,
      'X-DIGIKEY-Locale-Site': 'US',
      'X-DIGIKEY-Locale-Language': 'en',
      'X-DIGIKEY-Locale-Currency': 'USD',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };
  }

  /**
   * 按型号关键词搜索。
   * @param {string} partNumber
   * @param {string} [manufacturer] 品牌要求,可空
   * @returns {Promise<object>} 结果对象(见下方 resolve 的字段)
   */
  DigiKeyClient.prototype.search = function (partNumber, manufacturer) {
    var self = this;
    var url = this.apiBase + '/products/v4/search/keyword';
    var body = JSON.stringify({ Keywords: partNumber, Limit: 50, Offset: 0 });
    var attempt = 0;

    function run(token) {
      return fetchWithTimeout(url, {
        method: 'POST',
        headers: headersFor(token, self.clientId),
        body: body
      }, 30000);
    }

    function attemptLoop() {
      attempt++;
      return self.ensureToken(false).then(run).then(function (res) {
        // 尝试读取配额头。
        // 注意:DigiKey 未返回 Access-Control-Expose-Headers,所以浏览器里
        // x-ratelimit-limit / x-ratelimit-remaining 恒为 null(实测只有
        // content-length / content-type 可读)。这里保留读取,便于服务端哪天开放后自动生效。
        var limit = res.headers.get('x-ratelimit-limit');
        var remaining = res.headers.get('x-ratelimit-remaining');
        if (limit !== null || remaining !== null) {
          self.lastQuota = {
            limit: limit === null ? null : parseInt(limit, 10),
            remaining: remaining === null ? null : parseInt(remaining, 10)
          };
          if (self.onQuota) self.onQuota(self.lastQuota.limit, self.lastQuota.remaining);
        }

        if (res.status === 429) {
          if (attempt >= self.maxRetries) {
            return { ok: false, status: '请求过于频繁(429),已重试用尽', rateLimited: true };
          }
          return sleep(5000).then(attemptLoop);
        }
        if (res.status === 401) {
          self._token = null;
          if (attempt >= self.maxRetries) {
            return { ok: false, status: '认证失败(401),请检查密钥' };
          }
          return attemptLoop();
        }
        if (res.status !== 200) {
          return res.text().then(function (t) {
            return { ok: false, status: 'API错误(' + res.status + ')' + excerpt(t) };
          });
        }
        return res.json().then(function (data) {
          return self._interpret(data, manufacturer);
        });
      }).catch(function (err) {
        if (err && (err.name === 'AbortError')) {
          if (attempt >= self.maxRetries) return { ok: false, status: '请求超时' };
          return sleep(1000).then(attemptLoop);
        }
        if (err && err.code === 'badauth') {
          return { ok: false, status: err.message, authError: true };
        }
        if (err && err.code === 'nokey') {
          return { ok: false, status: err.message, authError: true };
        }
        if (err && (err.name === 'TypeError' || err.code === 'network')) {
          // TypeError 在浏览器里通常意味着网络失败或 CORS 被拒
          if (attempt < self.maxRetries) return sleep(2000).then(attemptLoop);
          return {
            ok: false,
            status: '网络错误或跨域被拒(CORS)。请检查网络,或确认 DigiKey 是否仍开放浏览器直连。',
            networkError: true
          };
        }
        return { ok: false, status: '查询异常: ' + (err && err.message ? err.message : String(err)) };
      });
    }

    return attemptLoop();
  };

  /** 把 API 响应转成业务结果(与 Python 版 search_by_keyword 的返回语义一致) */
  DigiKeyClient.prototype._interpret = function (data, manufacturer) {
    var products = data.Products || [];
    if (!products.length) {
      return { ok: false, status: '未找到该型号', empty: true, products: [] };
    }

    var infos = products.map(function (p) {
      return {
        mfr: norm((p.Manufacturer || {}).Name),
        mpn: norm(p.ManufacturerProductNumber),
        msl: extractMsl(p),
        rohs: extractRohs(p)
      };
    });

    var picked = null;
    var status = '成功';

    if (manufacturer) {
      var matched = matchManufacturer(infos, manufacturer);
      if (matched) {
        picked = matched;
        status = '成功(品牌匹配)';
      } else {
        for (var i = 0; i < infos.length; i++) {
          if (infos[i].msl) {
            picked = infos[i];
            status = '品牌不匹配(返回' + infos[i].mfr + '的MSL)';
            break;
          }
        }
        if (!picked) {
          return {
            ok: false,
            status: '品牌不匹配且无MSL数据',
            brandMismatch: true,
            products: infos
          };
        }
      }
    } else {
      for (var j = 0; j < infos.length; j++) {
        if (infos[j].msl) { picked = infos[j]; break; }
      }
      if (!picked) {
        picked = infos[0];
        status = '该型号无MSL参数';
      }
    }

    var mslNum = parseMslNumber(picked.msl);
    var mslInfo = describeMsl(picked.msl);
    return {
      ok: !!picked.msl,
      msl: picked.msl || null,
      mslNum: mslNum,
      mslLevel: mslInfo.level,        // '3' / '2a' / null
      mslShort: mslInfo.short,        // '168H'
      mslFull: mslInfo.full,          // '168小时车间寿命'
      mslDisplay: mslInfo.display,    // '3（168H）'
      vacuum: needsVacuum(mslNum),
      matchedMfr: picked.mfr || null,
      rohs: picked.rohs || null,
      mpn: picked.mpn || null,
      status: status,
      products: infos
    };
  };

  /* ---------------- 导出 ---------------- */

  global.DigiKey = {
    Client: DigiKeyClient,
    Error: DkError,
    DEFAULT_COLUMNS: DEFAULT_COLUMNS,
    BRAND_ALIASES: BRAND_ALIASES,
    MSL_GRADES: MSL_GRADES,
    norm: norm,
    parseMslNumber: parseMslNumber,
    parseMslLevel: parseMslLevel,
    describeMsl: describeMsl,
    formatMsl: formatMsl,
    needsVacuum: needsVacuum,
    extractMsl: extractMsl,
    extractRohs: extractRohs,
    matchManufacturer: matchManufacturer
  };
})(window);
