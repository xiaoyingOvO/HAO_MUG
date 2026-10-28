/**
 * 麻将称号字典（17 种役满/满贯/罚符）
 *
 * key 一旦上线就不要再改（已发出的称号记录会引用它）；可新增，勿删除/改名。
 *
 * 称号图为 PNG 文件，放在 miniprogram/images/titles/{key}.png
 *
 * 役满倍数：下面标 ★★ 的是双倍役满，其余为单倍役满。倍数不参与任何计算，
 * 只用于管理员发称号时辨认——麻币和雀力都只看顺位，不看役种。
 */

/* ── 合法称号 key 白名单（与云函数 baseFunctions/mahjongStats/index.js 保持一致） ── */
export const VALID_TITLE_KEYS = [
  'suankou', 'suankoutanki', 'daisangen',
  'kokushi', 'kokushijuusanmen', 'shousuushii',
  'tsuuiisou', 'chinroutou', 'daisuushii',
  'chuuren', 'chuurenjunsei', 'ryuuiisou',
  'suukantsu', 'tenhou', 'chihou', 'nagashi', 'chonbo'
];

const TITLES = [
  { key: 'suankou',          name: '四暗刻',       img: '/images/titles/suankou.png' },
  { key: 'suankoutanki',     name: '四暗刻单骑',   img: '/images/titles/suankoutanki.png' },      // ★★
  { key: 'daisangen',        name: '大三元',       img: '/images/titles/daisangen.png' },
  { key: 'kokushi',          name: '国士无双',     img: '/images/titles/kokushi.png' },
  { key: 'kokushijuusanmen', name: '国士十三面',   img: '/images/titles/kokushijuusanmen.png' },  // ★★
  { key: 'shousuushii',      name: '小四喜',       img: '/images/titles/shousuushii.png' },
  { key: 'tsuuiisou',        name: '字一色',       img: '/images/titles/tsuuiisou.png' },
  { key: 'chinroutou',       name: '清老头',       img: '/images/titles/chinroutou.png' },
  { key: 'daisuushii',       name: '大四喜',       img: '/images/titles/daisuushii.png' },        // ★★
  { key: 'chuuren',          name: '九莲宝灯',     img: '/images/titles/chuuren.png' },
  { key: 'chuurenjunsei',    name: '纯正九莲宝灯', img: '/images/titles/chuurenjunsei.png' },     // ★★
  { key: 'ryuuiisou',        name: '绿一色',       img: '/images/titles/ryuuiisou.png' },
  { key: 'suukantsu',        name: '四杠子',       img: '/images/titles/suukantsu.png' },
  { key: 'tenhou',           name: '天和',         img: '/images/titles/tenhou.png' },
  { key: 'chihou',           name: '地和',         img: '/images/titles/chihou.png' },
  { key: 'nagashi',          name: '流局满贯',     img: '/images/titles/nagashi.png' },
  { key: 'chonbo',           name: '诈和',         img: '/images/titles/chonbo.png' },
];

const TITLE_MAP = {};
TITLES.forEach((t) => {
  TITLE_MAP[t.key] = t;
});

export function getTitle(key) {
  return TITLE_MAP[key] || null;
}

/**
 * 把称号数据转成可渲染对象数组
 * 入参兼容两种：
 *  1. key 数组：['daisangen', ...]（旧格式）
 *  2. 对象数组：[{ title, count }, ...]（新格式，带获得次数）
 * 输出统一为 { key, name, img, count }，count 缺失时为 1
 */
export function decorateTitles(titles) {
  return (titles || []).map((item) => {
    const key = typeof item === 'string' ? item : item.title;
    const t = TITLE_MAP[key];
    if (!t) return null;
    const count = (typeof item === 'object' && item != null && item.count) ? item.count : 1;
    return { key: t.key, name: t.name, img: t.img, count };
  }).filter(Boolean);
}

export function getAllTitles() {
  return TITLES;
}

export default { TITLES, TITLE_MAP, getTitle, decorateTitles, getAllTitles };
