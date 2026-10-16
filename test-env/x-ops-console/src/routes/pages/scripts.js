const { createScriptsRepo } = require('../../repositories/scripts-repo');
const { createScrmStatusRepo } = require('../../repositories/scrm-status-repo');
const { extractAgentIds } = require('../../services/scrm-links-sync');

async function scriptsPageRoutes(app) {
  app.get('/scripts', async (request, reply) => {
    const repo = createScriptsRepo(app.db);
    const sets = repo.listFullSets();
    const shuffleMode = repo.getSetting('shuffle_mode') || 'random';
    const linksRow = app.db.prepare("SELECT value FROM script_settings WHERE key = 'promo_links'").get();
    let promoLinks = [];
    if (linksRow) { try { promoLinks = JSON.parse(linksRow.value); } catch (_) {} }
    const scrmRepo = createScrmStatusRepo(app.db);
    const expectedAgentIds = extractAgentIds(promoLinks);
    const gate = scrmRepo.evaluateGate({ expectedAgentIds });
    const sync = scrmRepo.getLinkSync();
    let syncedAgentIds = [];
    try { syncedAgentIds = sync && sync.agent_ids_json ? JSON.parse(sync.agent_ids_json) : []; } catch (_) {}
    const a = [...expectedAgentIds].map(String).map((s) => s.toLowerCase()).sort();
    const b = [...syncedAgentIds].map(String).map((s) => s.toLowerCase()).sort();
    const scrmLinkMismatch = syncedAgentIds.length > 0 && (
      a.length !== b.length || a.some((v, i) => v !== b[i])
    );
    if (!syncedAgentIds.length) syncedAgentIds = expectedAgentIds;
    return reply.view('scripts.njk', {
      title: '话术中心 & 链接管理',
      sets,
      shuffleMode,
      promoLinks,
      scrmGate: gate,
      scrmSyncedAt: (sync && sync.synced_at) || '',
      scrmAgentIds: syncedAgentIds,
      linkAgentIds: expectedAgentIds,
      scrmLinkMismatch,
      activePromoAgent: expectedAgentIds[0] || '',
      templateTypes: [
        { key: 'icebreaker', label: '❄️ 破冰消息' },
        { key: 'ad_template', label: '🎣 广告消息（含 {LINK}）' },
        { key: 'kick_message', label: '🛡️ 盾牌消息' },
        { key: 'reject_message', label: '⛔ 低龄婉拒' },
        { key: 'foreigner_reject', label: '🌍 外国人婉拒' },
      ],
    });
  });

  // Seed default scripts from chat_scripts.json if DB is empty
  app.addHook('onReady', async () => {
    // Ensure script tables exist (defensive for in-memory DBs used in tests)
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const migFile = path.join(__dirname, '..', '..', 'db', 'migrations', '002_scripts.sql');
      if (fs.existsSync(migFile)) {
        app.db.exec(fs.readFileSync(migFile, 'utf8'));
      }
    } catch (_) {}
    const repo = createScriptsRepo(app.db);
    if (repo.listSets().length === 0) {
      const defaults = getDefaultScripts();
      for (const [setId, data] of Object.entries(defaults.scripts)) {
        repo.upsertSet(setId, { name: data.name, description: data.description, enabled: true });
        for (const type of ['icebreaker', 'ad_template', 'kick_message', 'reject_message', 'foreigner_reject']) {
          if (data[type]) repo.upsertTemplate(setId, type, data[type]);
        }
      }
      repo.setSetting('shuffle_mode', defaults.shuffle_mode || 'random');
    }
  });
}

function getDefaultScripts() {
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const jsonPath = path.join(__dirname, '..', '..', '..', '..', 'unified-scheduler', 'chat_scripts.json');
    if (fs.existsSync(jsonPath)) {
      const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const scripts = {};
      for (const [setId, data] of Object.entries(json.scripts || {})) {
        scripts[setId] = {
          name: data.name || setId,
          description: data.description || '',
          icebreaker: data.icebreaker || '',
          ad_template: data.ad_template || '',
          kick_message: data.kick_message || '',
          reject_message: data.reject_message || '',
          foreigner_reject: data.foreigner_reject || '',
        };
      }
      return { shuffle_mode: json.mode || 'random', scripts };
    }
  } catch (_) {}
  return {
    shuffle_mode: 'random',
    scripts: {
      v1: {
        name: '话术1',
        description: '大人余裕 2.1',
        icebreaker: 'いきなりごめんなさい💦\n同世代より、大人の余裕がある人がいいなーって探してて、メッセージしちゃいました🫣\nちなみに、今おいくつですか？👀',
        ad_template: '教えてくれてありがとう💕\n大人の方とゆっくり話したいな…LINEで待ってるね♡\n{LINK}',
        kick_message: 'まだかなー🥺\nこっちの方が話しやすいよ、待ってる💕',
        reject_message: 'ごめんね💦\n25歳以上の大人の方とゆっくり話したいって思ってて…また機会があれば🙏',
        foreigner_reject: '',
      },
      v2: {
        name: '话术2',
        description: '被动求确认',
        icebreaker: '年齢教えて〜？😊',
        ad_template: 'デートできそうだったら教えてくれると嬉しいな💕\n{LINK}',
        kick_message: 'お返事待ってるね〜😊\nこっちで話そっか💕',
        reject_message: 'ごめんね😭 25歳以上で探してて💦 また機会があれば！',
        foreigner_reject: '',
      },
      v3: {
        name: '话术3',
        description: '自言自语+提议',
        icebreaker: '何歳くらい？🙌',
        ad_template: 'デートしてみたいな〜 良かったらメッセージ待ってるね😊\n{LINK}',
        kick_message: '連絡くれないかな？🥺\nこっちの方がすぐ返せるよ！',
        reject_message: 'ごめんね😭 25歳以上で探してて💦 また機会があれば！',
        foreigner_reject: '',
      },
      v4: {
        name: '话术4',
        description: '心理暗示',
        icebreaker: '年齢どーなの？✌️',
        ad_template: 'デートしたいなって思ったら連絡してね♡\n{LINK}',
        kick_message: '待ちくたびれちゃった😭\nこっちでお話しよ💕',
        reject_message: 'ごめんね😭 25歳以上で探してて💦 また機会があれば！',
        foreigner_reject: '',
      },
      v5: {
        name: '话术5',
        description: '先问再邀',
        icebreaker: '何歳？教えて〜🤗',
        ad_template: 'デートできそう？もしそうならメッセージ待ってるよ😊\n{LINK}',
        kick_message: 'まだ〜？🥺\nLINEの方が話しやすいんだ〜待ってる💕',
        reject_message: 'ごめんね😭 25歳以上で探してて💦 また機会があれば！',
        foreigner_reject: '',
      },
      v6: {
        name: '话术6',
        description: '反问试探',
        icebreaker: '年齢聞かせて😳',
        ad_template: 'デートしてみない？メッセージ待ってるね♡\n{LINK}',
        kick_message: 'あれ？まだかな😳\nこっちで待ってるよ💕',
        reject_message: 'ごめんね😭 25歳以上で探してて💦 また機会があれば！',
        foreigner_reject: '',
      },
      v7: {
        name: '话术7',
        description: '晚上型',
        icebreaker: '何歳ですか？😊',
        ad_template: '暇なときデートどうかな？連絡ちょうだい💕\n{LINK}',
        kick_message: 'もしよかったら、こっちでも話さない？😊💕',
        reject_message: 'ごめんね😭 25歳以上で探してて💦 また機会があれば！',
        foreigner_reject: '',
      },
      v8: {
        name: '话术8',
        description: 'LINE直邀',
        icebreaker: '年齢教えてほしいな🙌',
        ad_template: 'LINEで話さない？デートできる人探してるんだ〜💕\n{LINK}',
        kick_message: '返信遅くなりそうだからこっちで話そう💕\n待ってるね！',
        reject_message: 'ごめんね😭 25歳以上で探してて💦 また機会があれば！',
        foreigner_reject: '',
      },
      v9: {
        name: '话术9',
        description: '初次直球',
        icebreaker: '何歳？🤗',
        ad_template: 'デートしてくれる？気軽にメッセージちょうだいね♡\n{LINK}',
        kick_message: 'ねぇ、まだ〜？🥺\nこっちの方がいいよ💕',
        reject_message: 'ごめんね😭 25歳以上で探してて💦 また機会があれば！',
        foreigner_reject: '',
      },
      v10: {
        name: '话术10',
        description: '轻松邀约',
        icebreaker: '年齢どれくらい？😳',
        ad_template: 'よかったらデートしようよ〜メッセージ待ってる😊\n{LINK}',
        kick_message: 'おーい😳\nこっちの方が便利だよ！待ってる💕',
        reject_message: 'ごめんね😭 25歳以上で探してて💦 また機会があれば！',
        foreigner_reject: '',
      },
    },
  };
}

module.exports = { scriptsPageRoutes };