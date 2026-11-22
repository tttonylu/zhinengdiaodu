// =============================================================================
// C4 · 年龄识别（纯解析，无发送）
// 工作指导：只改年龄数据解析；禁止关键词婉拒 / 发送分支
// =============================================================================
(function () {
  'use strict';
  if (typeof window !== 'undefined' && window.__sg_age_parse_loaded__) return;
  if (typeof window !== 'undefined') window.__sg_age_parse_loaded__ = true;

  var AGE_MIN = 14;
  var AGE_MAX = 80;
  var AGE_REJECT_BELOW = 25; // <25 婉拒；>=25 或解析失败（寒暄）→ 发 AD（3.7.46 起不再 need_age）

  function chineseNumeralToInt(raw) {
    var s = String(raw || '').trim();
    if (!s) return null;
    if (/^\d{1,2}$/.test(s)) {
      var d0 = parseInt(s, 10);
      return isNaN(d0) ? null : d0;
    }
    if (s === '廿') return 20;
    if (s === '卅') return 30;
    if (s === '卌') return 40;
    var DIGIT = {
      '零': 0, '〇': 0, '○': 0, '一': 1, '二': 2, '两': 2, '兩': 2, '三': 3, '四': 4,
      '五': 5, '六': 6, '七': 7, '八': 8, '九': 9,
      '壱': 1, '弐': 2, '參': 3, '参': 3
    };
    var mAbbr = s.match(/^([廿卅卌])([一二三四五六七八九])?$/);
    if (mAbbr) {
      var base = mAbbr[1] === '廿' ? 20 : (mAbbr[1] === '卅' ? 30 : 40);
      return base + (mAbbr[2] ? (DIGIT[mAbbr[2]] || 0) : 0);
    }
    if (s === '十') return 10;
    var mTen = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
    if (mTen) {
      var tens = mTen[1] ? (DIGIT[mTen[1]] || 0) : 1;
      var ones = mTen[2] ? (DIGIT[mTen[2]] || 0) : 0;
      return tens * 10 + ones;
    }
    if (s.length === 1 && DIGIT[s] != null) return DIGIT[s];
    return null;
  }

  function ageInRange(n) {
    n = Number(n);
    if (isNaN(n)) return null;
    if (n < AGE_MIN || n > AGE_MAX) return null;
    return n;
  }

  var AGE_YEAR_CTX_RE = /年|生まれ|平成|昭和|令和|\d{4}/;
  var AGE_CLAUSE_SPLIT_RE = /[。．！？!?\n]+/;

  /** 全角数字 → 半角，便于 ２４です / ３０歳 */
  function normalizeAgeDigits(s) {
    return String(s || '').replace(/[０-９]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 0x30);
    });
  }

  /** 解析单个子句中的年龄；单位可在句中，裸数字仅整句纯数字 */
  function parseAgeFromClause(clause) {
    var t = normalizeAgeDigits(String(clause || '')).replace(/\s+/g, ' ').trim();
    if (!t) return null;

    // 明示未成年/未满18 自称 → 视同明确低龄（非模糊「若い」关键词婉拒）
    if (/未成年|みせいねん|高校生|中学生|小学生|18\s*歳\s*未満|under\s*age|i\s*'?m\s*a\s*minor|i\s*am\s*a\s*minor/i.test(t)) {
      return 17;
    }

    var candidates = [];
    var m;

    var reDigitUnit = /(\d{1,2})\s*(?:歳|才|岁|歲)/g;
    while ((m = reDigitUnit.exec(t)) !== null) {
      var a = ageInRange(parseInt(m[1], 10));
      if (a != null) candidates.push({ age: a, score: 3 });
    }

    var reCnUnit = /([一二三四五六七八九十廿卅卌两兩零〇○]{1,4})\s*(?:歳|才|岁|歲)/g;
    while ((m = reCnUnit.exec(t)) !== null) {
      var cn = chineseNumeralToInt(m[1]);
      var a2 = ageInRange(cn);
      if (a2 != null) candidates.push({ age: a2, score: 3 });
    }

    // 4.1.62：口语「24です / 30だよ / 28かな」无歳单位也认年龄
    if (!AGE_YEAR_CTX_RE.test(t)) {
      var reDesu = /(?:^|[^\d])(\d{1,2})\s*(?:歳|才)?\s*(?:です|だよ|だね|だわ|だな|ですよ|ですー|かな|かも|くらい|ぐらい)(?:[！!。．…〜～]?|$)/;
      var mDesu = t.match(reDesu);
      if (mDesu) {
        var aDesu = ageInRange(parseInt(mDesu[1], 10));
        if (aDesu != null) candidates.push({ age: aDesu, score: 2 });
      }
      var reCnDesu = /([二三四五六七八九]十[一二三四五六七八九]?|十[一二三四五六七八九]?|[廿卅卌][一二三四五六七八九]?)\s*(?:です|だよ|だね|だわ|かな)?/;
      var mCnDesu = t.match(reCnDesu);
      if (mCnDesu) {
        var aCnD = ageInRange(chineseNumeralToInt(mCnDesu[1]));
        if (aCnD != null) candidates.push({ age: aCnD, score: 2 });
      }
    }

    if (!AGE_YEAR_CTX_RE.test(t) && /^\d{1,2}$/.test(t)) {
      var a3 = ageInRange(parseInt(t, 10));
      if (a3 != null) candidates.push({ age: a3, score: 2 });
    }

    if (!AGE_YEAR_CTX_RE.test(t)) {
      var reCnBareWhole = /^([二三四五六七八九]十[一二三四五六七八九]?|十[一二三四五六七八九]?|[廿卅卌][一二三四五六七八九]?|[一二三四五六七八九十廿卅卌两兩])$/;
      var mCn = t.match(reCnBareWhole);
      if (mCn) {
        var a4 = ageInRange(chineseNumeralToInt(mCn[1]));
        if (a4 != null) candidates.push({ age: a4, score: 2 });
      }
    }

    if (!candidates.length) return null;
    candidates.sort(function (x, y) { return y.score - x.score; });
    return candidates[0].age;
  }

  /** 从单条文本解析年龄（先分句再解析，从后往前）；失败返回 null */
  function parseAgeFromText(text) {
    var raw = String(text || '');
    if (!raw.trim()) return null;
    var clauses = raw.split(AGE_CLAUSE_SPLIT_RE).filter(function (c) {
      return String(c || '').replace(/\s+/g, ' ').trim();
    });
    if (!clauses.length) clauses = [raw];
    for (var i = clauses.length - 1; i >= 0; i--) {
      var age = parseAgeFromClause(clauses[i]);
      if (age != null) return age;
    }
    if (clauses.length === 1) return null;
    return parseAgeFromClause(raw);
  }

  function parseAgeFromInbound(texts) {
    if (!texts || !texts.length) return null;
    for (var i = texts.length - 1; i >= 0; i--) {
      var age = parseAgeFromText(texts[i]);
      if (age != null) return age;
    }
    return null;
  }

  function routeByAge(age) {
    if (age != null && age < AGE_REJECT_BELOW) {
      return { route: 'reject', reason: 'age_below_' + AGE_REJECT_BELOW };
    }
    if (age != null) {
      return { route: 'ad', reason: 'age_ok' };
    }
    return { route: 'need_age', reason: 'need_age' };
  }

  var api = {
    AGE_MIN: AGE_MIN,
    AGE_MAX: AGE_MAX,
    AGE_REJECT_BELOW: AGE_REJECT_BELOW,
    chineseNumeralToInt: chineseNumeralToInt,
    parseAgeFromClause: parseAgeFromClause,
    parseAgeFromText: parseAgeFromText,
    parseAgeFromInbound: parseAgeFromInbound,
    routeByAge: routeByAge
  };

  if (typeof window !== 'undefined') {
    window.SgAgeParse = api;
    // 兼容旧诊断入口：content_chat 加载前也可测解析
    window.__sgChatAge = window.__sgChatAge || {};
    window.__sgChatAge.parseAgeFromText = parseAgeFromText;
  }

  console.log('[C4] age-parse.js loaded');
})();
