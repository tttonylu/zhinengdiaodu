// =============================================================================
// 智能调度 — 养号评论模板库 + 智能匹配器
// 9大类近100条日文评论，按时间+推文内容自动匹配
// =============================================================================

var NurtureComments = (function () {
  'use strict';

  var BANK = {
    morning: [
      'おはようございます', '朝から頑張ってますね', '今日も一日頑張りましょう',
      'おはよう☀️', '朝活お疲れ様です', '素敵な朝ですね',
      '今日もいい日になりますように', '早起きですね', '清々しい朝です',
      '今日も元気にいきましょう',
    ],
    evening: [
      'お疲れ様です', 'こんばんは', '今日もお疲れ様でした',
      'ゆっくり休んでくださいね', '充実した一日でしたか', 'おやすみなさい',
      '夜更かし注意ですよ', 'いい夢見てください',
    ],
    praise: [
      'すごいですね', '素敵です✨', '感動しました', '素晴らしい',
      '最高です', 'すごすぎる', '天才かよ', 'マジで尊敬します',
      'いつも感心します', 'レベルが違う', '憧れます', 'さすがです',
      'クオリティ高すぎ', '神ってる', 'めちゃくちゃ上手い',
    ],
    sympathy: [
      'わかります', 'そう思います', 'その通りですね', 'めっちゃわかる',
      '共感しかない', 'すごく共感しました', '同じです',
      'わかる〜', 'たしかに', 'それな！', 'ほんとそれ', 'マジでそれ',
    ],
    encouragement: [
      '頑張ってください', '応援してます', 'ファイト！',
      'これからも頑張ってください', 'いつも楽しみにしてます', '負けないで',
      '陰ながら応援してます', 'きっと大丈夫', '諦めないで',
      'あなたならできる',
    ],
    cute: [
      'かわいい！', '癒されました', 'エモい', '最高にかわいい',
      'かわいすぎます', '尊い', '天使ですか？', '癒しをありがとう',
      'めっちゃ癒される', '可愛さに震える',
    ],
    cool: [
      'かっこいい！', 'スタイルいいですね', 'センスがいい',
      'オシャレです', 'かっこよすぎます', 'イケメン', '渋い',
      'かっこよさが溢れてる',
    ],
    food: [
      '美味しそう！', '食べたいです', '作り方教えてください',
      'お店教えてほしいです', 'よだれが出る', '絶対美味しいやつ',
      'レシピ知りたいです', 'また食べに行きたい', '贅沢ですね',
      'お腹すいてきた',
    ],
    scenery: [
      '綺麗ですね', 'いい景色', 'どこですか？', '行ってみたいです',
      '絶景ですね', '空気が綺麗そう', '写真が上手いですね',
      '日本の風景って素敵', '癒される景色', 'また行きたい',
    ],
    casual: [
      '初めまして', 'フォロー失礼します', 'いつも参考になります',
      'いいね', 'ナイス！', 'いい感じですね', '参考になりました',
      'また遊びに来ます', 'こんにちは', 'お邪魔します', 'いい一日を',
    ],
  };

  function shanghaiHour() {
    var s = new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour12: false });
    var m = s.match(/(\d+):/);
    return m ? parseInt(m[1]) : new Date().getHours();
  }

  function pickFrom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  function pick(tweet) {
    var txt = (tweet ? (tweet.innerText || '').toLowerCase() : '');
    var hour = shanghaiHour();

    var pool = BANK.casual;
    if (hour >= 6 && hour < 11) pool = BANK.morning;
    else if (hour >= 18) pool = BANK.evening;

    if (txt.includes('料理') || txt.includes('ご飯') || txt.includes('食べ') || txt.includes('美味')) pool = BANK.food;
    else if (txt.includes('かわいい') || txt.includes('猫') || txt.includes('犬') || txt.includes('動物')) pool = BANK.cute;
    else if (txt.includes('頑張') || txt.includes('努力') || txt.includes('挑戦')) pool = BANK.encouragement;
    else if (txt.includes('綺麗') || txt.includes('景色') || txt.includes('写真') || txt.includes('旅行')) pool = BANK.scenery;
    else if (Math.random() < 0.3) {
      var pools = [BANK.praise, BANK.sympathy, BANK.cool, BANK.casual];
      pool = pools[Math.floor(Math.random() * pools.length)];
    }

    return pickFrom(pool);
  }

  function loadRemote() {
    try {
      var raw = localStorage.getItem('sg_nurture_comments');
      if (!raw) return;
      var remote = JSON.parse(raw);
      var categories = remote.categories;
      if (!categories) {
        var cats = remote.categories || null;
        if (!cats) return;
      }
      var cats = remote.categories || remote;
      if (Array.isArray(cats)) {
        for (var i = 0; i < cats.length; i++) {
          var c = cats[i];
          if (c.id && Array.isArray(c.templates) && c.templates.length > 0) {
            BANK[c.id] = c.templates;
          }
        }
        return;
      }
      for (var k in cats) {
        if (Array.isArray(cats[k]) && cats[k].length > 0) {
          if (BANK[k]) { BANK[k] = BANK[k].concat(cats[k]); } else { BANK[k] = cats[k]; }
        }
      }
    } catch (e) {}
  }

  loadRemote();

  return {
    BANK: BANK,
    pick: pick,
  };
