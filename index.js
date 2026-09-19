'use strict';
/* =============================================================================
   "To'garakga qatnashmaysizmi" — Telegram Mini Web App
   Backend + Bot  |  Node.js 18+  |  tashqi kutubxonalarsiz (0 dependency)

   Ishga tushirish:
     BOT_TOKEN=TOKEN PUBLIC_URL=https://sizning-app.onrender.com node index.js

   Render uchun:
     Build Command : (bo'sh)
     Start Command : node index.js
     Environment   : BOT_TOKEN = TOKEN
                     PUBLIC_URL = https://sizning-app.onrender.com
   ============================================================================= */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/* ----------------------------- SOZLAMALAR --------------------------------- */

const TOKEN = process.env.BOT_TOKEN || 'TOKEN';
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'db.json');
const HTML_PATH = path.join(__dirname, 'index.html');
// Brauzerda (Telegramsiz) sinab ko'rish uchun: ALLOW_BROWSER=1
const ALLOW_BROWSER = process.env.ALLOW_BROWSER === '1' || TOKEN === 'TOKEN';

const ADMINS = [
  { login: 'BaxtiyorMasharipov', password: 'T201RJABMA' },
  { login: "JayxunRo'zmamatov", password: 'T201RJABMA' },
];

const SUBJECTS = [
  'matematika', 'ona_tili', 'adabiyot', 'ingliz_tili', 'turk_tili', 'rus_tili',
  'shaxmat', 'mental', 'fransuz_tili', 'fizika', 'kimyo', 'biologiya',
  'geografiya', 'uz_tarix', 'jahon_tarix', 'huquq', 'iqtisod',
];

const MAX_BODY = 8 * 1024 * 1024; // sertifikat rasmlari uchun

/* ---- AI (Gemini / OpenAI) ---- */
const AI_PROVIDER = (process.env.AI_PROVIDER ||
  (process.env.OPENAI_API_KEY ? 'openai' : 'gemini')).toLowerCase();
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AI_ON = !!(AI_PROVIDER === 'openai' ? OPENAI_KEY : GEMINI_KEY);
const AI_LIMIT = Number(process.env.AI_LIMIT) || 40; // 1 soatda 1 foydalanuvchiga
// Agar Google/OpenAI to'g'ridan-to'g'ri ochilmasa — proksi manzilini shu yerga qo'ying
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
const OPENAI_BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');

/* ---- Ob-havo (Open-Meteo — kalit kerak emas) ---- */
const CITY_NAME = process.env.WEATHER_CITY || 'Toshkent';
const CITY_LAT = Number(process.env.WEATHER_LAT) || 41.2995;
const CITY_LON = Number(process.env.WEATHER_LON) || 69.2401;

/* ---- Guruh o'rinlari: amalda cheksiz ---- */
const GROUP_MAX = Number(process.env.GROUP_MAX) || 100000;
const GROUP_DEFAULT = Number(process.env.GROUP_DEFAULT) || 30;

/* ------------------------------- BAZA ------------------------------------- */

function emptyDb() {
  return {
    seq: 1, users: {}, groups: [], requests: [], messages: [],
    groupMessages: [], // guruh chati
    topics: [],        // AI tayyorlagan mavzular (kesh)
    studyLog: [],      // mavzu tahlili natijalari
    scores: [],        // viktorina natijalari
    aiChats: {},       // userId -> [{role,text,at}]
  };
}

let db;
try {
  db = Object.assign(emptyDb(), JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
} catch {
  db = emptyDb();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DB_PATH, JSON.stringify(db), (e) => e && console.error('db:', e.message));
  }, 250);
}
const nextId = () => String(db.seq++);
const now = () => Date.now();

/* ------------------------------ YORDAMCHI --------------------------------- */

function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// Apostroflar har xil yoziladi (' ’ ʻ) — solishtirishdan oldin bir xillashtiramiz
const norm = (s) => String(s || '').trim().replace(/[\u2018\u2019\u02BB\u02BC`\u00B4]/g, "'");
const clean = (s, max = 300) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
const num = (v, min, max, def = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
};

/* -------------------- TELEGRAM initData TEKSHIRUVI ------------------------ */

function checkInitData(initData) {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dataCheckString = [...params.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
    const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');
    if (calc !== hash) return null;
    return JSON.parse(params.get('user') || 'null');
  } catch { return null; }
}

function authUser(req, body) {
  const initData = req.headers['x-init-data'] || body.initData || '';
  if (initData) {
    const u = checkInitData(initData);
    if (u && u.id) return u;
  }
  if (ALLOW_BROWSER) {
    const id = Number(req.headers['x-dev-id']) || 900001;
    return { id, first_name: 'Demo', last_name: '', username: 'demo_user' };
  }
  return null;
}

/* ------------------------- FOYDALANUVCHI MODELI --------------------------- */

function touchUser(tgUser) {
  const id = String(tgUser.id);
  let u = db.users[id];
  if (!u) {
    u = db.users[id] = {
      id,
      tgName: clean([tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '), 80),
      username: clean(tgUser.username, 40),
      photo: clean(tgUser.photo_url, 400),
      role: null,           // 'mentor' | 'student'
      name: '',             // FISH
      age: 0,
      phone: '',
      lang: 'uz',
      blocked: false,
      // mentor maydonlari
      subjects: [],
      bio: '',
      experience: 0,
      certs: [],
      studentsNow: 0,
      days: [],
      timeFrom: '',
      timeTo: '',
      location: '',
      open: true,
      createdAt: now(),
    };
    save();
  } else {
    // Telegram profili yangilangan bo'lsa — yangilaymiz
    const tgName = clean([tgUser.first_name, tgUser.last_name].filter(Boolean).join(' '), 80);
    if (tgName) u.tgName = tgName;
    if (tgUser.username) u.username = clean(tgUser.username, 40);
    if (tgUser.photo_url) u.photo = clean(tgUser.photo_url, 400);
  }
  return u;
}

// Ochiq (public) ko'rinish — telefon faqat kerakli joyda beriladi
function publicUser(u, withPhone = false) {
  return {
    id: u.id,
    name: u.name || u.tgName,
    username: u.username,
    photo: u.photo,
    role: u.role,
    age: u.age,
    subjects: u.subjects,
    bio: u.bio,
    experience: u.experience,
    certs: u.certs,
    studentsNow: u.studentsNow,
    days: u.days,
    timeFrom: u.timeFrom,
    timeTo: u.timeTo,
    location: u.location,
    open: !!u.open && !u.blocked,
    phone: withPhone ? u.phone : '',
  };
}

/* --------------------------- TELEGRAM API --------------------------------- */

async function tg(method, payload) {
  if (TOKEN === 'TOKEN') return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await r.json();
  } catch (e) {
    console.error('telegram', method, e.message);
    return null;
  }
}

function notify(userId, text) {
  return tg('sendMessage', {
    chat_id: userId,
    text,
    parse_mode: 'HTML',
    reply_markup: PUBLIC_URL
      ? { inline_keyboard: [[{ text: '📚 Ilovani ochish', web_app: { url: PUBLIC_URL } }]] }
      : undefined,
  });
}

/* ==================== AI / OB-HAVO / VALYUTA XIZMATLARI =================== */

async function getJson(url, opts, ms) {
  const r = await fetch(url, Object.assign({ signal: AbortSignal.timeout(ms || 20000) }, opts || {}));
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error('http_' + r.status + ' ' + t.slice(0, 200));
  }
  return r.json();
}

/* Oddiy kesh: kalit -> { v, at } */
const memo = new Map();
async function cached(key, ms, fn) {
  const c = memo.get(key);
  if (c && now() - c.at < ms) return c.v;
  try {
    const v = await fn();
    memo.set(key, { v, at: now() });
    return v;
  } catch (e) {
    if (c) return c.v;      // eski ma'lumot bo'lsa — shuni beramiz
    throw e;
  }
}

/* --- AI limiti --- */
const aiUse = new Map();
function aiQuota(id) {
  const r = aiUse.get(id);
  if (!r || now() - r.at > 3600000) { aiUse.set(id, { n: 1, at: now() }); return true; }
  if (r.n >= AI_LIMIT) return false;
  r.n++;
  return true;
}

const LANG_NAME = {
  uz: "o'zbek tilida (lotin yozuvida)",
  cyr: "ўзбек тилида (кирилл ёзувида)",
  ru: 'на русском языке',
  en: 'in English',
};

/* --- Asosiy AI chaqiruvi --- */
async function askAI(system, user, wantJson) {
  if (!AI_ON) { const e = new Error('ai_off'); e.code = 'ai_off'; throw e; }

  if (AI_PROVIDER === 'openai') {
    const payload = {
      model: OPENAI_MODEL,
      temperature: wantJson ? 0.2 : 0.7,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    };
    if (wantJson) payload.response_format = { type: 'json_object' };
    const j = await getJson(OPENAI_BASE + '/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify(payload),
    }, 60000);
    return (j.choices && j.choices[0] && j.choices[0].message.content) || '';
  }

  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: wantJson ? 0.2 : 0.75,
      maxOutputTokens: 2600,
      ...(wantJson ? { responseMimeType: 'application/json' } : {}),
    },
  };
  const url = GEMINI_BASE + '/v1beta/models/' +
    encodeURIComponent(GEMINI_MODEL) + ':generateContent?key=' + encodeURIComponent(GEMINI_KEY);
  const j = await getJson(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, 60000);
  const c = j.candidates && j.candidates[0];
  if (!c) { const e = new Error('ai_empty'); e.code = 'ai_empty'; throw e; }
  return ((c.content && c.content.parts) || []).map((p) => p.text || '').join('');
}

/* Javobdan JSON ajratib olish (model ba'zan ```json ... ``` qaytaradi) */
function pickJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  const f = t.indexOf('```');
  if (f >= 0) {
    const g = t.indexOf('```', f + 3);
    if (g > f) t = t.slice(f + 3, g).replace(/^json/i, '');
  }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
async function askJson(system, user) {
  const raw = await askAI(system, user, true);
  const j = pickJson(raw);
  if (!j) { const e = new Error('ai_parse'); e.code = 'ai_parse'; throw e; }
  return j;
}

/* ------------------------------ OB-HAVO ----------------------------------- */

const WCODE = {
  0: ['☀️', 'Ochiq'], 1: ['🌤', 'Asosan ochiq'], 2: ['⛅️', 'Bulutli'], 3: ['☁️', 'Tim bulut'],
  45: ['🌫', 'Tuman'], 48: ['🌫', 'Qirov tuman'],
  51: ['🌦', 'Mayda yomg\'ir'], 53: ['🌦', 'Yomg\'ir'], 55: ['🌧', 'Quyuq yomg\'ir'],
  56: ['🌧', 'Muzli yomg\'ir'], 57: ['🌧', 'Muzli yomg\'ir'],
  61: ['🌧', 'Yomg\'ir'], 63: ['🌧', 'Yomg\'ir'], 65: ['🌧', 'Kuchli yomg\'ir'],
  66: ['🌧', 'Muzli yomg\'ir'], 67: ['🌧', 'Muzli yomg\'ir'],
  71: ['🌨', 'Qor'], 73: ['🌨', 'Qor'], 75: ['❄️', 'Kuchli qor'], 77: ['❄️', 'Qor donalari'],
  80: ['🌦', 'Jala'], 81: ['🌦', 'Jala'], 82: ['⛈', 'Kuchli jala'],
  85: ['🌨', 'Qor jalasi'], 86: ['🌨', 'Qor jalasi'],
  95: ['⛈', 'Momaqaldiroq'], 96: ['⛈', 'Do\'lli momaqaldiroq'], 99: ['⛈', 'Kuchli do\'l'],
};

async function getWeather(lat, lon, name) {
  const u = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lon +
    '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code&forecast_days=4&timezone=auto';
  const j = await getJson(u, {}, 15000);
  const c = j.current || {};
  const w = WCODE[c.weather_code] || ['🌡', ''];
  const d = j.daily || { time: [] };
  return {
    city: name,
    temp: Math.round(c.temperature_2m),
    feels: Math.round(c.apparent_temperature),
    humidity: Math.round(c.relative_humidity_2m),
    wind: Math.round(c.wind_speed_10m),
    icon: w[0], text: w[1],
    days: (d.time || []).slice(0, 4).map((t, i) => {
      const dw = WCODE[d.weather_code[i]] || ['🌡', ''];
      return {
        date: t,
        max: Math.round(d.temperature_2m_max[i]),
        min: Math.round(d.temperature_2m_min[i]),
        icon: dw[0],
      };
    }),
  };
}

async function findCity(q) {
  const u = 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=ru&name=' +
    encodeURIComponent(q);
  const j = await getJson(u, {}, 15000);
  const r = j.results && j.results[0];
  if (!r) return null;
  return { lat: r.latitude, lon: r.longitude, name: r.name };
}

/* ------------------------------ VALYUTA ----------------------------------- */

const CCY = ['USD', 'EUR', 'RUB', 'GBP', 'TRY', 'KZT', 'CNY', 'JPY'];
async function getRates() {
  const j = await getJson('https://cbu.uz/uz/arkhiv-kursov-valyut/json/', {}, 15000);
  const list = Array.isArray(j) ? j : [];
  const out = CCY
    .map((code) => list.find((x) => x.Ccy === code))
    .filter(Boolean)
    .map((x) => ({
      code: x.Ccy,
      name: clean(x.CcyNm_UZ || x.CcyNm_EN || x.Ccy, 40),
      rate: Number(x.Rate),
      diff: Number(x.Diff) || 0,
      date: x.Date,
    }));
  return { date: out[0] ? out[0].date : '', rates: out };
}

/* ------------------------------ ADMIN ------------------------------------- */

const adminSessions = new Map(); // token -> { login, at }

function adminOf(req) {
  const t = req.headers['x-admin-token'];
  if (!t) return null;
  const s = adminSessions.get(t);
  if (!s) return null;
  if (now() - s.at > 12 * 60 * 60 * 1000) { adminSessions.delete(t); return null; }
  return s;
}

/* ------------------- TAYYOR MAVZULAR (taklif uchun) ----------------------- */

const TOPIC_HINTS = {
  matematika: ['Kvadrat tenglama', 'Progressiyalar', 'Logarifm', 'Hosila', 'Integral', 'Vektorlar'],
  ona_tili: ['Gap bo\'laklari', 'Qo\'shma gap', 'Unli tovushlar', 'So\'z turkumlari', 'Tinish belgilari'],
  adabiyot: ['Alisher Navoiy ijodi', 'Abdulla Qodiriy — O\'tkan kunlar', 'Cho\'lpon she\'riyati', 'Doston janri'],
  ingliz_tili: ['Present Perfect', 'Conditionals', 'Passive Voice', 'Phrasal verbs', 'Reported speech'],
  turk_tili: ['Ismin halleri', 'Gecmis zaman', 'Sifat fiiller', 'Baglaclar'],
  rus_tili: ['Падежи', 'Виды глагола', 'Причастие', 'Сложное предложение'],
  shaxmat: ['Debyut tamoyillari', 'Endshpil', 'Taktik usullar: vilka', 'Ispan debyuti'],
  mental: ['Abakus asoslari', 'Qo\'shish usullari', 'Do\'stlar formulasi', 'Ko\'paytirish'],
  fransuz_tili: ['Passé composé', 'Les articles', 'Le subjonctif', 'Pronoms'],
  fizika: ['Nyuton qonunlari', 'Impuls saqlanish qonuni', 'Elektr toki', 'Optika', 'Termodinamika'],
  kimyo: ['Mendeleyev jadvali', 'Kimyoviy bog\'lanish', 'Oksidlanish-qaytarilish', 'Organik kimyo asoslari'],
  biologiya: ['Hujayra tuzilishi', 'Fotosintez', 'Mendel qonunlari', 'Inson qon aylanishi', 'Ekotizim'],
  geografiya: ['Iqlim mintaqalari', 'Litosfera plitalari', 'Daryolar va ko\'llar', 'Aholi geografiyasi'],
  uz_tarix: ['Amir Temur davlati', 'Buyuk ipak yo\'li', 'Jadidchilik harakati', 'Mustaqillik yillari'],
  jahon_tarix: ['Buyuk geografik kashfiyotlar', 'Fransuz inqilobi', 'Ikkinchi jahon urushi', 'Uyg\'onish davri'],
  huquq: ['Konstitutsiya asoslari', 'Fuqarolik huquqi', 'Jinoyat huquqi asoslari', 'Mehnat shartnomasi'],
  iqtisod: ['Talab va taklif', 'Inflyatsiya', 'Bank tizimi', 'YaIM va YaMM', 'Soliqlar'],
};

/* Zaxira viktorina (AI kaliti bo'lmasa ham ishlaydi) */
const QUIZ_BANK = {
  matematika: [
    ['2x + 6 = 0 tenglamaning ildizi?', ['-3', '3', '-6', '6'], 0],
    ['Aylana yuzi formulasi?', ['πr²', '2πr', 'πd', 'r²'], 0],
    ['√144 nechaga teng?', ['12', '14', '24', '10'], 0],
  ],
  ona_tili: [
    ['"Kitob" so\'zi qaysi turkumga kiradi?', ['Ot', 'Fe\'l', 'Sifat', 'Son'], 0],
    ['O\'zbek alifbosida nechta unli harf bor?', ['6', '5', '8', '10'], 0],
    ['Gapning bosh bo\'laklari qaysilar?', ['Ega va kesim', 'Aniqlovchi', 'To\'ldiruvchi', 'Hol'], 0],
  ],
  adabiyot: [
    ['"O\'tkan kunlar" asari muallifi?', ['Abdulla Qodiriy', 'Cho\'lpon', 'Oybek', 'G\'afur G\'ulom'], 0],
    ['"Xamsa" asari kimga tegishli?', ['Alisher Navoiy', 'Bobur', 'Lutfiy', 'Ogahiy'], 0],
    ['Doston qaysi turga kiradi?', ['Epik', 'Lirik', 'Dramatik', 'Publitsistik'], 0],
  ],
  ingliz_tili: [
    ['Choose the correct form: She ___ to school every day.', ['goes', 'go', 'going', 'gone'], 0],
    ['Past form of "buy"?', ['bought', 'buyed', 'buys', 'buying'], 0],
    ['Which is a preposition?', ['under', 'quickly', 'happy', 'run'], 0],
  ],
  turk_tili: [
    ['"Kitap" so\'zi o\'zbekcha nima?', ['Kitob', 'Qalam', 'Daftar', 'Stol'], 0],
    ['"Merhaba" nima degani?', ['Salom', 'Xayr', 'Rahmat', 'Kechirasiz'], 0],
    ['"Su" so\'zining ma\'nosi?', ['Suv', 'Non', 'Olov', 'Havo'], 0],
  ],
  rus_tili: [
    ['Сколько падежей в русском языке?', ['6', '5', '7', '4'], 0],
    ['"Книга" — какой род?', ['Женский', 'Мужской', 'Средний', 'Общий'], 0],
    ['Антоним слова "большой"?', ['маленький', 'высокий', '新', 'длинный'], 0],
  ],
  shaxmat: [
    ['Shaxmat taxtasida nechta katak bor?', ['64', '81', '100', '49'], 0],
    ['Qaysi dona "L" harfi shaklida yuradi?', ['Ot', 'Fil', 'Ruh', 'Farzin'], 0],
    ['Boshlang\'ich holatda har tomonda nechta piyoda bor?', ['8', '6', '10', '4'], 0],
  ],
  mental: [
    ['Abakusning bir yuqori donasi nechaga teng?', ['5', '1', '10', '2'], 0],
    ['7 + 8 = ?', ['15', '14', '16', '13'], 0],
    ['12 × 3 = ?', ['36', '32', '34', '38'], 0],
  ],
  fransuz_tili: [
    ['"Bonjour" nima degani?', ['Salom', 'Xayr', 'Rahmat', 'Ha'], 0],
    ['"Livre" so\'zining ma\'nosi?', ['Kitob', 'Stol', 'Non', 'Suv'], 0],
    ['Fransuz tilida "merci" — ?', ['Rahmat', 'Kechirasiz', 'Salom', 'Yo\'q'], 0],
  ],
  fizika: [
    ['Nyutonning ikkinchi qonuni formulasi?', ['F = ma', 'E = mc²', 'v = s/t', 'P = F/S'], 0],
    ['Kuch birligi qanday nomlanadi?', ['Nyuton', 'Joul', 'Vatt', 'Paskal'], 0],
    ['Yorug\'lik tezligi vakuumda taxminan?', ['300 000 km/s', '340 m/s', '150 000 km/s', '1000 km/s'], 0],
  ],
  kimyo: [
    ['Suvning kimyoviy formulasi?', ['H₂O', 'CO₂', 'O₂', 'NaCl'], 0],
    ['Mendeleyev jadvalidagi 1-element?', ['Vodorod', 'Geliy', 'Kislorod', 'Uglerod'], 0],
    ['Osh tuzining formulasi?', ['NaCl', 'KCl', 'CaCO₃', 'H₂SO₄'], 0],
  ],
  biologiya: [
    ['Fotosintez qayerda sodir bo\'ladi?', ['Xloroplastda', 'Mitoxondriyada', 'Yadroda', 'Ribosomada'], 0],
    ['Inson yuragi nechta kamerali?', ['4', '2', '3', '5'], 0],
    ['DNK ning to\'liq nomi?', ['Dezoksiribonuklein kislota', 'Ribonuklein kislota', 'Aminokislota', 'Nuklein oqsil'], 0],
  ],
  geografiya: [
    ['Yer yuzidagi eng baland cho\'qqi?', ['Everest', 'K2', 'Elbrus', 'Monblan'], 0],
    ['O\'zbekistonning poytaxti?', ['Toshkent', 'Samarqand', 'Buxoro', 'Namangan'], 0],
    ['Eng katta okean?', ['Tinch okean', 'Atlantika', 'Hind okeani', 'Shimoliy muz okeani'], 0],
  ],
  uz_tarix: [
    ['Amir Temur davlatining poytaxti?', ['Samarqand', 'Buxoro', 'Toshkent', 'Xiva'], 0],
    ['O\'zbekiston mustaqillikka erishgan yil?', ['1991', '1990', '1992', '1989'], 0],
    ['"Boburnoma" asari muallifi?', ['Zahiriddin Bobur', 'Alisher Navoiy', 'Ulug\'bek', 'Beruniy'], 0],
  ],
  jahon_tarix: [
    ['Ikkinchi jahon urushi qachon tugagan?', ['1945', '1939', '1918', '1950'], 0],
    ['Buyuk Fransuz inqilobi yili?', ['1789', '1804', '1848', '1871'], 0],
    ['Amerikani kim kashf etgan deb hisoblanadi?', ['Xristofor Kolumb', 'Magellan', 'Vasko da Gama', 'Kuk'], 0],
  ],
  huquq: [
    ['O\'zbekiston Konstitutsiyasi qabul qilingan yil?', ['1992', '1991', '1995', '2000'], 0],
    ['Eng oliy yuridik kuchga ega hujjat?', ['Konstitutsiya', 'Qonun', 'Farmon', 'Qaror'], 0],
    ['Fuqarolik huquqi nimani tartibga soladi?', ['Mulkiy munosabatlar', 'Jinoyatlar', 'Soliqlar', 'Harbiy xizmat'], 0],
  ],
  iqtisod: [
    ['Narx oshsa, talab odatda qanday o\'zgaradi?', ['Kamayadi', 'Oshadi', 'O\'zgarmaydi', 'Ikki barobar oshadi'], 0],
    ['Inflyatsiya nima?', ['Narxlarning umumiy o\'sishi', 'Ish haqi o\'sishi', 'Soliq turi', 'Bank foizi'], 0],
    ['YaIM nimani bildiradi?', ['Yalpi ichki mahsulot', 'Yillik import', 'Yagona investitsiya', 'Yalpi import'], 0],
  ],
};

function bankQuiz(subject, count) {
  const src = QUIZ_BANK[subject] || QUIZ_BANK.matematika;
  const out = src.map(([q, opts, ok], i) => {
    const pairs = opts.map((t, k) => ({ t, ok: k === ok }));
    for (let a = pairs.length - 1; a > 0; a--) {
      const b = Math.floor(Math.random() * (a + 1));
      [pairs[a], pairs[b]] = [pairs[b], pairs[a]];
    }
    return {
      id: 'b' + i,
      q,
      options: pairs.map((p) => p.t),
      answer: pairs.findIndex((p) => p.ok),
      why: '',
    };
  });
  return out.sort(() => Math.random() - 0.5).slice(0, count || 5);
}

/* ------------------------------- API -------------------------------------- */

async function api(req, res, pathname, url, body) {
  const m = req.method;

  /* ---- Admin: login ---- */
  if (m === 'POST' && pathname === '/api/admin/login') {
    const login = norm(body.login);
    const password = String(body.password || '');
    const found = ADMINS.find(
      (a) => norm(a.login).toLowerCase() === login.toLowerCase() && a.password === password
    );
    if (!found) return json(res, 401, { error: 'bad_credentials' });
    const token = crypto.randomBytes(24).toString('hex');
    adminSessions.set(token, { login: found.login, at: now() });
    return json(res, 200, { token, login: found.login });
  }

  /* ---- Admin: hamma ma'lumot ---- */
  if (pathname.startsWith('/api/admin/')) {
    const adm = adminOf(req);
    if (!adm) return json(res, 401, { error: 'no_admin' });

    if (m === 'GET' && pathname === '/api/admin/overview') {
      const users = Object.values(db.users);
      return json(res, 200, {
        stats: {
          users: users.length,
          mentors: users.filter((u) => u.role === 'mentor').length,
          students: users.filter((u) => u.role === 'student').length,
          groups: db.groups.length,
          requests: db.requests.filter((r) => r.status === 'pending').length,
          messages: db.messages.length,
        },
        users: users
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((u) => ({ ...publicUser(u, true), blocked: !!u.blocked, createdAt: u.createdAt })),
        groups: db.groups.map((g) => ({
          ...g,
          mentorName: db.users[g.mentorId] ? db.users[g.mentorId].name : '—',
        })),
      });
    }

    if (m === 'POST' && pathname === '/api/admin/user') {
      const u = db.users[String(body.id)];
      if (!u) return json(res, 404, { error: 'not_found' });
      if (body.action === 'block') u.blocked = true;
      if (body.action === 'unblock') u.blocked = false;
      if (body.action === 'delete') {
        delete db.users[u.id];
        db.groups = db.groups.filter((g) => g.mentorId !== u.id);
        db.requests = db.requests.filter((r) => r.studentId !== u.id && r.mentorId !== u.id);
        db.messages = db.messages.filter((x) => x.from !== u.id && x.to !== u.id);
      }
      save();
      return json(res, 200, { ok: true });
    }

    if (m === 'POST' && pathname === '/api/admin/group') {
      if (body.action === 'delete') {
        db.groups = db.groups.filter((g) => g.id !== String(body.id));
        db.requests = db.requests.filter((r) => r.groupId !== String(body.id));
        save();
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not_found' });
  }

  /* ---- Oddiy foydalanuvchi ---- */
  const tgUser = authUser(req, body);
  if (!tgUser) return json(res, 401, { error: 'no_auth' });
  const me = touchUser(tgUser);
  if (me.blocked) return json(res, 403, { error: 'blocked' });

  /* Kirish / holat */
  if (m === 'POST' && pathname === '/api/auth') {
    if (body.lang) me.lang = clean(body.lang, 8);
    save();
    return json(res, 200, {
      me: { ...publicUser(me, true), lang: me.lang, tgName: me.tgName },
      registered: !!me.role,
    });
  }

  /* Ro'yxatdan o'tish / profilni tahrirlash */
  if (m === 'POST' && pathname === '/api/profile') {
    const role = body.role === 'mentor' ? 'mentor' : body.role === 'student' ? 'student' : me.role;
    const age = num(body.age, 5, 99, me.age);

    if (role === 'mentor' && age < 18) return json(res, 400, { error: 'mentor_age' });
    if (role === 'student' && age > 18) return json(res, 400, { error: 'student_age' });
    if (!role) return json(res, 400, { error: 'no_role' });
    // Rolni keyinchalik o'zgartirib bo'lmaydi
    if (me.role && role !== me.role) return json(res, 400, { error: 'role_locked' });

    me.role = role;
    me.age = age;
    if (body.name !== undefined) me.name = clean(body.name, 80);
    if (body.phone !== undefined) me.phone = clean(body.phone, 25);
    if (body.lang) me.lang = clean(body.lang, 8);

    if (role === 'mentor') {
      if (Array.isArray(body.subjects)) {
        me.subjects = body.subjects.filter((s) => SUBJECTS.includes(s)).slice(0, SUBJECTS.length);
      }
      if (body.bio !== undefined) me.bio = clean(body.bio, 700);
      if (body.experience !== undefined) me.experience = num(body.experience, 0, 70, 0);
      if (body.studentsNow !== undefined) me.studentsNow = num(body.studentsNow, 0, 999, 0);
      if (Array.isArray(body.days)) me.days = body.days.filter((d) => d >= 0 && d <= 6).slice(0, 7);
      if (body.timeFrom !== undefined) me.timeFrom = clean(body.timeFrom, 5);
      if (body.timeTo !== undefined) me.timeTo = clean(body.timeTo, 5);
      if (body.location !== undefined) me.location = clean(body.location, 200);
      if (body.open !== undefined) me.open = !!body.open;
      if (Array.isArray(body.certs)) {
        me.certs = body.certs
          .filter((c) => typeof c === 'string' && c.startsWith('data:image/'))
          .slice(0, 6);
      }
    }
    save();
    return json(res, 200, { me: { ...publicUser(me, true), lang: me.lang } });
  }

  if (!me.role && !pathname.startsWith('/api/auth')) {
    // Ro'yxatdan o'tmaganlarga qolgan API yopiq
    if (pathname !== '/api/profile') return json(res, 403, { error: 'not_registered' });
  }

  /* Mentorlarni qidirish va filtrlash */
  if (m === 'GET' && pathname === '/api/mentors') {
    const subject = url.searchParams.get('subject') || '';
    const q = (url.searchParams.get('q') || '').toLowerCase().trim();
    const status = url.searchParams.get('status') || 'all'; // all | open | closed
    let list = Object.values(db.users).filter((u) => u.role === 'mentor' && !u.blocked && u.name);
    if (subject) list = list.filter((u) => u.subjects.includes(subject));
    if (status === 'open') list = list.filter((u) => u.open);
    if (status === 'closed') list = list.filter((u) => !u.open);
    if (q) {
      list = list.filter((u) =>
        (u.name + ' ' + u.location + ' ' + u.bio).toLowerCase().includes(q)
      );
    }
    list.sort((a, b) => (b.open ? 1 : 0) - (a.open ? 1 : 0) || b.createdAt - a.createdAt);
    return json(res, 200, { mentors: list.map((u) => publicUser(u)) });
  }

  if (m === 'GET' && pathname.startsWith('/api/mentor/')) {
    const u = db.users[pathname.split('/')[3]];
    if (!u || u.role !== 'mentor' || u.blocked) return json(res, 404, { error: 'not_found' });
    return json(res, 200, {
      mentor: publicUser(u),
      groups: db.groups
        .filter((g) => g.mentorId === u.id)
        .map((g) => ({ ...g, joined: g.members.includes(me.id), pending: !!db.requests.find(
          (r) => r.groupId === g.id && r.studentId === me.id && r.status === 'pending') })),
    });
  }

  /* Guruhlar */
  if (m === 'GET' && pathname === '/api/groups') {
    const mine = url.searchParams.get('mine') === '1';
    let list = db.groups;
    if (mine) {
      list = me.role === 'mentor'
        ? db.groups.filter((g) => g.mentorId === me.id)
        : db.groups.filter((g) => g.members.includes(me.id));
    }
    return json(res, 200, {
      groups: list.map((g) => ({
        ...g,
        mentorName: db.users[g.mentorId] ? db.users[g.mentorId].name : '—',
        mentorPhoto: db.users[g.mentorId] ? db.users[g.mentorId].photo : '',
        joined: g.members.includes(me.id),
        pending: !!db.requests.find(
          (r) => r.groupId === g.id && r.studentId === me.id && r.status === 'pending'),
      })),
    });
  }

  if (m === 'POST' && pathname === '/api/groups') {
    if (me.role !== 'mentor') return json(res, 403, { error: 'mentor_only' });
    const g = {
      id: nextId(),
      mentorId: me.id,
      title: clean(body.title, 80) || 'To\'garak',
      subject: SUBJECTS.includes(body.subject) ? body.subject : SUBJECTS[0],
      days: Array.isArray(body.days) ? body.days.filter((d) => d >= 0 && d <= 6) : [],
      timeFrom: clean(body.timeFrom, 5),
      timeTo: clean(body.timeTo, 5),
      duration: num(body.duration, 0, 600, 60),
      location: clean(body.location, 200),
      limit: num(body.limit, 1, GROUP_MAX, GROUP_DEFAULT),
      open: body.open === undefined ? true : !!body.open,
      members: [],
      seen: {},
      createdAt: now(),
    };
    db.groups.push(g);
    save();
    return json(res, 200, { group: g });
  }

  if (m === 'POST' && pathname === '/api/group/update') {
    const g = db.groups.find((x) => x.id === String(body.id));
    if (!g || g.mentorId !== me.id) return json(res, 404, { error: 'not_found' });
    if (body.delete) {
      db.groups = db.groups.filter((x) => x.id !== g.id);
      db.requests = db.requests.filter((r) => r.groupId !== g.id);
      save();
      return json(res, 200, { ok: true });
    }
    for (const k of ['title', 'location', 'timeFrom', 'timeTo']) {
      if (body[k] !== undefined) g[k] = clean(body[k], 200);
    }
    if (body.subject && SUBJECTS.includes(body.subject)) g.subject = body.subject;
    if (Array.isArray(body.days)) g.days = body.days.filter((d) => d >= 0 && d <= 6);
    if (body.duration !== undefined) g.duration = num(body.duration, 0, 600, 60);
    if (body.limit !== undefined) g.limit = num(body.limit, 1, GROUP_MAX, GROUP_DEFAULT);
    if (body.open !== undefined) g.open = !!body.open;
    save();
    return json(res, 200, { group: g });
  }

  /* Guruhga qo'shilish so'rovi */
  if (m === 'POST' && pathname === '/api/group/join') {
    if (me.role !== 'student') return json(res, 403, { error: 'student_only' });
    const g = db.groups.find((x) => x.id === String(body.id));
    if (!g) return json(res, 404, { error: 'not_found' });
    if (!g.open) return json(res, 400, { error: 'group_closed' });
    if (g.members.includes(me.id)) return json(res, 400, { error: 'already_member' });
    if (g.members.length >= g.limit) return json(res, 400, { error: 'group_full' });
    const dup = db.requests.find(
      (r) => r.groupId === g.id && r.studentId === me.id && r.status === 'pending');
    if (dup) return json(res, 200, { ok: true, request: dup });

    const r = {
      id: nextId(),
      groupId: g.id,
      mentorId: g.mentorId,
      studentId: me.id,
      note: clean(body.note, 200),
      status: 'pending',
      createdAt: now(),
    };
    db.requests.push(r);
    save();
    notify(g.mentorId,
      `🔔 <b>Yangi so'rov</b>\n${me.name} (${me.age} yosh) «${g.title}» guruhiga qo'shilmoqchi.`);
    return json(res, 200, { ok: true, request: r });
  }

  /* Mentorga kelgan so'rovlar */
  if (m === 'GET' && pathname === '/api/requests') {
    const list = db.requests
      .filter((r) => r.mentorId === me.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 200)
      .map((r) => {
        const s = db.users[r.studentId];
        const g = db.groups.find((x) => x.id === r.groupId);
        return {
          ...r,
          groupTitle: g ? g.title : '—',
          subject: g ? g.subject : '',
          student: s ? publicUser(s, r.status === 'accepted') : null,
        };
      });
    return json(res, 200, { requests: list });
  }

  /* Kirsin / Kirmasin */
  if (m === 'POST' && pathname === '/api/request/decide') {
    const r = db.requests.find((x) => x.id === String(body.id));
    if (!r || r.mentorId !== me.id) return json(res, 404, { error: 'not_found' });
    if (r.status !== 'pending') return json(res, 400, { error: 'already_done' });
    const g = db.groups.find((x) => x.id === r.groupId);
    if (body.accept) {
      r.status = 'accepted';
      if (g && !g.members.includes(r.studentId)) g.members.push(r.studentId);
      notify(r.studentId, `✅ Qabul qilindingiz! «${g ? g.title : ''}» guruhiga kirdingiz.`);
    } else {
      r.status = 'rejected';
      notify(r.studentId, `❌ So'rovingiz rad etildi: «${g ? g.title : ''}».`);
    }
    save();
    return json(res, 200, { ok: true, status: r.status });
  }

  /* Suhbatlar ro'yxati */
  if (m === 'GET' && pathname === '/api/threads') {
    const map = new Map();
    for (const msg of db.messages) {
      if (msg.from !== me.id && msg.to !== me.id) continue;
      const peer = msg.from === me.id ? msg.to : msg.from;
      const prev = map.get(peer);
      if (!prev || prev.at < msg.at) {
        map.set(peer, { at: msg.at, text: msg.text, mine: msg.from === me.id });
      }
    }
    const threads = [...map.entries()]
      .map(([peerId, last]) => {
        const p = db.users[peerId];
        return {
          peerId,
          name: p ? p.name || p.tgName : '—',
          photo: p ? p.photo : '',
          role: p ? p.role : '',
          last,
          unread: db.messages.filter((x) => x.from === peerId && x.to === me.id && !x.read).length,
        };
      })
      .sort((a, b) => b.last.at - a.last.at);
    return json(res, 200, { threads });
  }

  /* Bitta suhbat */
  if (m === 'GET' && pathname === '/api/messages') {
    const peer = String(url.searchParams.get('peer') || '');
    const p = db.users[peer];
    if (!p) return json(res, 404, { error: 'not_found' });
    let changed = false;
    const list = db.messages
      .filter((x) => (x.from === me.id && x.to === peer) || (x.from === peer && x.to === me.id))
      .map((x) => {
        if (x.to === me.id && !x.read) { x.read = true; changed = true; }
        return x;
      })
      .slice(-300);
    if (changed) save();
    return json(res, 200, {
      messages: list,
      peer: { id: p.id, name: p.name || p.tgName, photo: p.photo, role: p.role },
    });
  }

  if (m === 'POST' && pathname === '/api/messages') {
    const to = String(body.to || '');
    const p = db.users[to];
    const text = clean(body.text, 1000);
    if (!p || !text) return json(res, 400, { error: 'bad_request' });
    const msg = { id: nextId(), from: me.id, to, text, at: now(), read: false };
    db.messages.push(msg);
    if (db.messages.length > 20000) db.messages.splice(0, 5000);
    save();
    notify(to, `💬 <b>${me.name || me.tgName}</b>: ${text.slice(0, 200)}`);
    return json(res, 200, { message: msg });
  }

  /* ======================= GURUH CHATI ==================================== */

  // Foydalanuvchi guruh chatiga kira oladimi?
  const canChat = (g) => g && (g.mentorId === me.id || g.members.includes(me.id));

  if (m === 'GET' && pathname === '/api/group/messages') {
    const g = db.groups.find((x) => x.id === String(url.searchParams.get('id') || ''));
    if (!g) return json(res, 404, { error: 'not_found' });
    if (!canChat(g)) return json(res, 403, { error: 'not_member' });

    const list = db.groupMessages.filter((x) => x.groupId === g.id).slice(-300);
    const ids = [...new Set(list.map((x) => x.from).concat(g.members, [g.mentorId]))];
    const who = {};
    for (const id of ids) {
      const u = db.users[id];
      if (u) who[id] = { name: u.name || u.tgName, photo: u.photo, role: u.role };
    }
    // O'qilgan deb belgilaymiz
    const seen = g.seen || (g.seen = {});
    seen[me.id] = now();
    save();

    return json(res, 200, {
      messages: list,
      who,
      group: { id: g.id, title: g.title, subject: g.subject, members: g.members.length, mentorId: g.mentorId },
    });
  }

  if (m === 'POST' && pathname === '/api/group/messages') {
    const g = db.groups.find((x) => x.id === String(body.id || ''));
    if (!g) return json(res, 404, { error: 'not_found' });
    if (!canChat(g)) return json(res, 403, { error: 'not_member' });
    const text = clean(body.text, 1000);
    if (!text) return json(res, 400, { error: 'bad_request' });

    const msg = { id: nextId(), groupId: g.id, from: me.id, text, at: now() };
    db.groupMessages.push(msg);
    if (db.groupMessages.length > 30000) db.groupMessages.splice(0, 8000);
    save();

    // A'zolarga bildirishnoma (o'zidan boshqa)
    const to = [...new Set(g.members.concat([g.mentorId]))].filter((x) => x !== me.id);
    for (const id of to.slice(0, 60)) {
      notify(id, `👥 <b>${g.title}</b>\n${me.name || me.tgName}: ${text.slice(0, 180)}`);
    }
    return json(res, 200, { message: msg });
  }

  /* ================= OB-HAVO VA VALYUTA KURSI ============================= */

  if (m === 'GET' && pathname === '/api/info') {
    const q = clean(url.searchParams.get('city'), 40);
    const out = { weather: null, money: null, city: CITY_NAME };

    const wx = (async () => {
      let lat = CITY_LAT, lon = CITY_LON, nm = CITY_NAME;
      if (q && q.toLowerCase() !== CITY_NAME.toLowerCase()) {
        const c = await cached('geo:' + q.toLowerCase(), 86400000, () => findCity(q));
        if (c) { lat = c.lat; lon = c.lon; nm = c.name; }
      }
      out.city = nm;
      return cached('w:' + lat + ',' + lon, 15 * 60000, () => getWeather(lat, lon, nm));
    })();

    // Ikkalasini birga so'raymiz — biri ishlamasa ikkinchisi baribir keladi
    const [a, b] = await Promise.allSettled([wx, cached('cbu', 60 * 60000, getRates)]);
    if (a.status === 'fulfilled') out.weather = a.value; else out.weatherError = true;
    if (b.status === 'fulfilled') out.money = b.value; else out.moneyError = true;
    return json(res, 200, out);
  }

  /* ============================ AI ======================================== */

  if (pathname.startsWith('/api/ai/')) {
    if (!AI_ON && pathname !== '/api/ai/hints') {
      return json(res, 503, { error: 'ai_off' });
    }
    const lang = LANG_NAME[me.lang] || LANG_NAME.uz;

    /* --- Mavzu takliflari --- */
    if (m === 'GET' && pathname === '/api/ai/hints') {
      const s = url.searchParams.get('subject') || '';
      return json(res, 200, { hints: TOPIC_HINTS[s] || [] });
    }

    /* --- AI suhbat --- */
    if (m === 'POST' && pathname === '/api/ai/chat') {
      if (!aiQuota(me.id)) return json(res, 429, { error: 'ai_limit' });
      const text = clean(body.text, 2000);
      if (!text) return json(res, 400, { error: 'bad_request' });

      const hist = db.aiChats[me.id] || (db.aiChats[me.id] = []);
      if (body.reset) { db.aiChats[me.id] = []; save(); return json(res, 200, { messages: [] }); }

      const ctx = hist.slice(-8).map((x) => (x.role === 'me' ? 'O\'quvchi: ' : 'Yordamchi: ') + x.text).join('\n');
      const sys =
        'Sen "To\'garakga qatnashmaysizmi" ilovasining o\'quv yordamchisisan. ' +
        'Maktab o\'quvchilari va ustozlarga dars, fan va mavzularni tushuntirasan. ' +
        'Javobni ' + lang + ' yoz. Qisqa, aniq va tushunarli yoz (4-8 jumla). ' +
        'Formulalarni oddiy matnda ber. Zarur bo\'lsa 1-2 misol keltir. ' +
        'Dars va ta\'limga aloqasi yo\'q mavzularda muloyim rad et. Markdown belgilarini ishlatma.';
      let answer;
       
    try { answer = await askAI(sys, (ctx ? ctx + '\n\n' : '') + 'O\'quvchi: ' + text); }
catch (e) { console.error('AI XATO:', e.message, e.code); return json(res, 502, { error: e.code || 'ai_error' }); }
       
      hist.push({ role: 'me', text, at: now() });
      hist.push({ role: 'ai', text: clean(answer, 4000), at: now() });
      if (hist.length > 40) hist.splice(0, hist.length - 40);
      save();
      return json(res, 200, { messages: hist.slice(-40) });
    }

    if (m === 'GET' && pathname === '/api/ai/chat') {
      return json(res, 200, { messages: (db.aiChats[me.id] || []).slice(-40) });
    }

    /* --- Mavzuni topish: konspekt + savollar --- */
    if (m === 'POST' && pathname === '/api/ai/topic') {
      if (!aiQuota(me.id)) return json(res, 429, { error: 'ai_limit' });
      const subject = SUBJECTS.includes(body.subject) ? body.subject : '';
      const title = clean(body.title, 120);
      if (!title) return json(res, 400, { error: 'bad_request' });

      const key = (subject + '|' + title + '|' + me.lang).toLowerCase();
      const old = db.topics.find((t) => t.key === key);
      if (old && !body.fresh) return json(res, 200, { topic: old });

      const sys =
        'Sen tajribali o\'qituvchisan. Berilgan mavzu bo\'yicha maktab darajasidagi ' +
        'aniq va ishonchli o\'quv materiali tayyorlaysan. Barcha matn ' + lang + ' bo\'lsin. ' +
        'Faqat JSON qaytar, boshqa hech narsa yozma. JSON sxemasi: ' +
        '{"title":"to\'g\'rilangan mavzu nomi","summary":"3-5 jumlalik qisqa ta\'rif",' +
        '"keyPoints":["asosiy fakt 1","...6-10 ta"],' +
        '"formulas":[{"name":"nomi","body":"formula","note":"izoh"}],' +
        '"terms":[{"term":"atama","def":"ta\'rifi"}],' +
        '"questions":["o\'quvchiga beriladigan ochiq savol 1","...4-6 ta"]}. ' +
        'Agar mavzuda formula bo\'lmasa formulas bo\'sh massiv bo\'lsin. ' +
        'Savollar o\'quvchi bilimini tekshiradigan, "tushuntiring", "sanab bering" turida bo\'lsin.';
      const user = 'Fan: ' + (subject || 'umumiy') + '\nMavzu: ' + title;

      let j;
      try { j = await askJson(sys, user); }
      catch (e) { return json(res, 502, { error: e.code || 'ai_error' }); }

      const topic = {
        id: nextId(), key, subject,
        title: clean(j.title || title, 140),
        summary: clean(j.summary, 1200),
        keyPoints: (Array.isArray(j.keyPoints) ? j.keyPoints : []).slice(0, 12).map((x) => clean(x, 300)),
        formulas: (Array.isArray(j.formulas) ? j.formulas : []).slice(0, 10).map((f) => ({
          name: clean(f && f.name, 80), body: clean(f && f.body, 160), note: clean(f && f.note, 200),
        })),
        terms: (Array.isArray(j.terms) ? j.terms : []).slice(0, 10).map((t) => ({
          term: clean(t && t.term, 80), def: clean(t && t.def, 300),
        })),
        questions: (Array.isArray(j.questions) ? j.questions : []).slice(0, 6).map((x) => clean(x, 300)),
        at: now(),
      };
      if (old) Object.assign(old, topic, { id: old.id });
      else {
        db.topics.push(topic);
        if (db.topics.length > 4000) db.topics.splice(0, 800);
      }
      save();
      return json(res, 200, { topic: old || topic });
    }

    /* --- Javobni tahlil qilish --- */
    if (m === 'POST' && pathname === '/api/ai/check') {
      if (!aiQuota(me.id)) return json(res, 429, { error: 'ai_limit' });
      const t = db.topics.find((x) => x.id === String(body.topicId));
      if (!t) return json(res, 404, { error: 'not_found' });
      const answer = clean(body.answer, 6000);
      if (answer.length < 5) return json(res, 400, { error: 'answer_short' });

      const ref = JSON.stringify({
        title: t.title, summary: t.summary, keyPoints: t.keyPoints,
        formulas: t.formulas, terms: t.terms,
      });
      const sys =
        'Sen adolatli va xayrixoh imtihon oluvchisan. O\'quvchining javobini etalon material bilan ' +
        'solishtirasan. Barcha matn ' + lang + ' bo\'lsin. Faqat JSON qaytar. Sxema: ' +
        '{"percent":0-100 butun son,"verdict":"1 jumlalik umumiy baho",' +
        '"correct":["o\'quvchi to\'g\'ri aytgan narsalar"],' +
        '"missing":["esidan chiqqan yoki aytmagan muhim narsalar"],' +
        '"wrong":[{"said":"xato fikri","fix":"to\'g\'risi"}],' +
        '"formulasMissed":["aytilmagan formulalar"],' +
        '"advice":"nimani takrorlash kerakligi haqida 2-3 jumla",' +
        '"scores":{"tushuncha":0-100,"formulalar":0-100,"atamalar":0-100,"toliqlik":0-100}}. ' +
        'percent — javobning etalonga mos kelish foizi. Imlo xatolariga past baho qo\'yma, ' +
        'mazmunga qara. Agar javob umuman mavzuga oid bo\'lmasa percent 0-10 bo\'lsin.';
      const user = 'ETALON MATERIAL:\n' + ref + '\n\nO\'QUVCHI JAVOBI:\n' + answer;

      let j;
      try { j = await askJson(sys, user); }
      catch (e) { return json(res, 502, { error: e.code || 'ai_error' }); }

      const sc = j.scores || {};
      const result = {
        percent: num(j.percent, 0, 100, 0),
        verdict: clean(j.verdict, 300),
        correct: (Array.isArray(j.correct) ? j.correct : []).slice(0, 12).map((x) => clean(x, 300)),
        missing: (Array.isArray(j.missing) ? j.missing : []).slice(0, 12).map((x) => clean(x, 300)),
        wrong: (Array.isArray(j.wrong) ? j.wrong : []).slice(0, 8).map((w) => ({
          said: clean(w && w.said, 250), fix: clean(w && w.fix, 300),
        })),
        formulasMissed: (Array.isArray(j.formulasMissed) ? j.formulasMissed : []).slice(0, 8).map((x) => clean(x, 200)),
        advice: clean(j.advice, 600),
        scores: {
          tushuncha: num(sc.tushuncha, 0, 100, 0),
          formulalar: num(sc.formulalar, 0, 100, 0),
          atamalar: num(sc.atamalar, 0, 100, 0),
          toliqlik: num(sc.toliqlik, 0, 100, 0),
        },
      };

      db.studyLog.push({
        id: nextId(), userId: me.id, topicId: t.id, title: t.title,
        subject: t.subject, percent: result.percent, words: answer.split(/\s+/).length, at: now(),
      });
      if (db.studyLog.length > 20000) db.studyLog.splice(0, 5000);
      save();
      return json(res, 200, { result });
    }

    /* --- Shaxsiy statistika --- */
    if (m === 'GET' && pathname === '/api/ai/stats') {
      const mine = db.studyLog.filter((x) => x.userId === me.id).sort((a, b) => b.at - a.at);
      const bySub = {};
      for (const x of mine) {
        const s = bySub[x.subject] || (bySub[x.subject] = { subject: x.subject, n: 0, sum: 0, best: 0 });
        s.n++; s.sum += x.percent; s.best = Math.max(s.best, x.percent);
      }
      return json(res, 200, {
        total: mine.length,
        avg: mine.length ? Math.round(mine.reduce((a, x) => a + x.percent, 0) / mine.length) : 0,
        best: mine.reduce((a, x) => Math.max(a, x.percent), 0),
        bySubject: Object.values(bySub).map((s) => ({
          subject: s.subject, n: s.n, avg: Math.round(s.sum / s.n), best: s.best,
        })).sort((a, b) => b.n - a.n),
        recent: mine.slice(0, 25),
      });
    }

    return json(res, 404, { error: 'not_found' });
  }

  /* =========================== VIKTORINA ================================== */

  if (m === 'POST' && pathname === '/api/quiz/start') {
    const subject = SUBJECTS.includes(body.subject) ? body.subject : SUBJECTS[0];
    const count = num(body.count, 3, 10, 5);
    const level = ['oson', 'orta', 'qiyin'].includes(body.level) ? body.level : 'orta';
    let qs = null;

    if (AI_ON && body.ai !== false && aiQuota(me.id)) {
      const lang = LANG_NAME[me.lang] || LANG_NAME.uz;
      const sys =
        'Sen maktab o\'qituvchisisan. Test savollari tuzasan. Matn ' + lang + ' bo\'lsin. ' +
        'Faqat JSON qaytar. Sxema: {"questions":[{"q":"savol","options":["A","B","C","D"],' +
        '"answer":0,"why":"qisqa izoh"}]}. answer — to\'g\'ri javobning options ichidagi indeksi (0 dan). ' +
        'Har bir savolda aynan 4 ta variant bo\'lsin, faqat bittasi to\'g\'ri, variantlar ishonarli bo\'lsin.';
      const user = 'Fan: ' + subject + '\nDaraja: ' + level + '\nSavollar soni: ' + count +
        (body.topic ? '\nMavzu: ' + clean(body.topic, 120) : '');
      try {
        const j = await askJson(sys, user);
        const arr = Array.isArray(j.questions) ? j.questions : [];
        qs = arr.slice(0, count).map((x, i) => {
          const opts = (Array.isArray(x.options) ? x.options : []).slice(0, 4).map((o) => clean(o, 160));
          return opts.length === 4 ? {
            id: 'a' + i, q: clean(x.q, 400), options: opts,
            answer: num(x.answer, 0, 3, 0), why: clean(x.why, 300),
          } : null;
        }).filter(Boolean);
        if (!qs.length) qs = null;
      } catch (e) { qs = null; }
    }
    if (!qs) qs = bankQuiz(subject, count);

    const sid = crypto.randomBytes(12).toString('hex');
    quizRooms.set(sid, { userId: me.id, subject, qs, at: now() });
    if (quizRooms.size > 3000) {
      for (const [k, v] of quizRooms) if (now() - v.at > 3600000) quizRooms.delete(k);
    }
    return json(res, 200, {
      sid, subject,
      questions: qs.map((x) => ({ id: x.id, q: x.q, options: x.options })),
    });
  }

  if (m === 'POST' && pathname === '/api/quiz/submit') {
    const room = quizRooms.get(String(body.sid || ''));
    if (!room || room.userId !== me.id) return json(res, 404, { error: 'not_found' });
    quizRooms.delete(body.sid);

    const given = Array.isArray(body.answers) ? body.answers : [];
    const results = room.qs.map((q, i) => ({
      q: q.q, options: q.options, answer: q.answer,
      picked: Number.isInteger(given[i]) ? given[i] : -1,
      ok: given[i] === q.answer, why: q.why,
    }));
    const correct = results.filter((r) => r.ok).length;
    const points = correct * 10;

    db.scores.push({
      id: nextId(), userId: me.id, subject: room.subject,
      correct, total: room.qs.length, points, at: now(),
    });
    if (db.scores.length > 30000) db.scores.splice(0, 8000);
    save();
    return json(res, 200, { correct, total: room.qs.length, points, results });
  }

  if (m === 'GET' && pathname === '/api/quiz/leaderboard') {
    const subject = url.searchParams.get('subject') || '';
    const period = url.searchParams.get('period') || 'all'; // all | week
    const from = period === 'week' ? now() - 7 * 86400000 : 0;

    const agg = new Map();
    for (const s of db.scores) {
      if (s.at < from) continue;
      if (subject && s.subject !== subject) continue;
      const a = agg.get(s.userId) || { userId: s.userId, points: 0, games: 0, correct: 0, total: 0 };
      a.points += s.points; a.games++; a.correct += s.correct; a.total += s.total;
      agg.set(s.userId, a);
    }
    const top = [...agg.values()]
      .sort((a, b) => b.points - a.points)
      .slice(0, 50)
      .map((a, i) => {
        const u = db.users[a.userId];
        return {
          place: i + 1, userId: a.userId,
          name: u ? (u.name || u.tgName) : '—',
          photo: u ? u.photo : '',
          role: u ? u.role : '',
          points: a.points, games: a.games,
          accuracy: a.total ? Math.round((a.correct / a.total) * 100) : 0,
          me: a.userId === me.id,
        };
      });
    const mine = top.find((x) => x.me) || (() => {
      const a = agg.get(me.id);
      if (!a) return null;
      return {
        place: 0, userId: me.id, name: me.name || me.tgName, photo: me.photo,
        points: a.points, games: a.games,
        accuracy: a.total ? Math.round((a.correct / a.total) * 100) : 0, me: true,
      };
    })();
    return json(res, 200, { top, mine });
  }

  return json(res, 404, { error: 'not_found' });
}

/* Viktorina sessiyalari (xotirada, 1 soatlik) */
const quizRooms = new Map();

/* ------------------------------ SERVER ------------------------------------ */

let htmlCache = null;
function sendHtml(res) {
  try {
    if (!htmlCache) htmlCache = fs.readFileSync(HTML_PATH);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(htmlCache);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('index.html topilmadi');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const pathname = url.pathname;

  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type,x-init-data,x-admin-token,x-dev-id');
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (pathname === '/' || pathname === '/index.html') return sendHtml(res);
  if (pathname === '/health') return json(res, 200, { ok: true, up: process.uptime() });
  if (!pathname.startsWith('/api/')) return json(res, 404, { error: 'not_found' });

  let body = {};
  if (req.method !== 'GET') {
    try { body = await readBody(req); }
    catch { return json(res, 413, { error: 'too_large' }); }
  }
  try { await api(req, res, pathname, url, body); }
  catch (e) { console.error(e); json(res, 500, { error: 'server_error' }); }
});

server.listen(PORT, () => {
  console.log(`✅ Server: http://localhost:${PORT}`);
  if (TOKEN === 'TOKEN') console.log('⚠️  BOT_TOKEN qo\'yilmagan — bot ishlamaydi, faqat brauzer rejimi.');
  if (!PUBLIC_URL) console.log('⚠️  PUBLIC_URL qo\'yilmagan — bot tugmasi ochilmaydi.');
  console.log(AI_ON
    ? `🧠 AI: ${AI_PROVIDER} (${AI_PROVIDER === 'openai' ? OPENAI_MODEL : GEMINI_MODEL})`
    : '⚠️  AI kaliti yo\'q — GEMINI_API_KEY yoki OPENAI_API_KEY qo\'ying.');
  console.log('🌤  Ob-havo: Open-Meteo · 💱 Kurs: cbu.uz (kalit kerak emas)');

   // VAQTINCHALIK TEST
  setTimeout(async () => {
    try {
      const key = process.env.GEMINI_API_KEY || '';
      console.log('🔑 Key:', key ? key.slice(0,8)+'...' : 'YOQ!');
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key='+key, {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({contents:[{role:'user',parts:[{text:'salom'}]}]})
      });
      const t = await r.text();
      console.log('🧪 Gemini test:', r.status, t.slice(0,200));
    } catch(e) {
      console.log('🧪 Gemini test XATO:', e.message);
    }
  }, 3000);
});

/* -------------------------------- BOT ------------------------------------- */

const START_TEXT =
  "👋 <b>To'garakga qatnashmaysizmi?</b>\n\n" +
  "Bu yerda o'quvchilar hech kim bilan yuzma-yuz ko'rishmasdan to'garaklarga ariza topshiradi, " +
  "mentorlar esa o'z to'garagini e'lon qiladi.\n\n" +
  "🤖 Menga istalgan dars savolini yozing — javob beraman.\n" +
  "🌤 /obhavo · 💱 /kurs · 🧠 /ai\n\n" +
  "Quyidagi tugma orqali ilovani oching 👇";

async function handleUpdate(u) {
  const msg = u.message;
  if (!msg || !msg.from) return;
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (msg.contact && msg.contact.user_id === msg.from.id) {
    const user = db.users[String(msg.from.id)];
    if (user) { user.phone = clean(msg.contact.phone_number, 25); save(); }
    await tg('sendMessage', {
      chat_id: chatId,
      text: '✅ Telefon raqamingiz saqlandi.',
      reply_markup: { remove_keyboard: true },
    });
    return;
  }

  if (text.startsWith('/start') || text.startsWith('/help')) {
    touchUser(msg.from);
    await tg('sendMessage', {
      chat_id: chatId,
      text: START_TEXT,
      parse_mode: 'HTML',
      reply_markup: PUBLIC_URL
        ? { inline_keyboard: [[{ text: "📚 To'garaklarni ochish", web_app: { url: PUBLIC_URL } }]] }
        : { remove_keyboard: true },
    });
    return;
  }

  /* --- /obhavo --- */
  if (text.startsWith('/obhavo') || text.startsWith('/weather')) {
    const city = clean(text.split(' ').slice(1).join(' '), 40);
    try {
      let lat = CITY_LAT, lon = CITY_LON, nm = CITY_NAME;
      if (city) {
        const c = await cached('geo:' + city.toLowerCase(), 86400000, () => findCity(city));
        if (c) { lat = c.lat; lon = c.lon; nm = c.name; }
      }
      const w = await cached('w:' + lat + ',' + lon, 15 * 60000, () => getWeather(lat, lon, nm));
      await tg('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: `${w.icon} <b>${w.city}</b>\n${w.text}, <b>${w.temp}°C</b> (his: ${w.feels}°)\n` +
          `💧 Namlik: ${w.humidity}%   💨 Shamol: ${w.wind} km/s\n\n` +
          w.days.map((d) => `${d.icon} ${d.date.slice(5)} — ${d.min}°…${d.max}°`).join('\n'),
      });
    } catch { await tg('sendMessage', { chat_id: chatId, text: '⚠️ Ob-havo olinmadi.' }); }
    return;
  }

  /* --- /kurs --- */
  if (text.startsWith('/kurs') || text.startsWith('/valyuta')) {
    try {
      const r = await cached('cbu', 60 * 60000, getRates);
      await tg('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: `💱 <b>Markaziy bank kursi</b> (${r.date})\n\n` + r.rates.map((x) => {
          const d = x.diff > 0 ? `▲ +${x.diff}` : x.diff < 0 ? `▼ ${x.diff}` : '—';
          return `<b>${x.code}</b>  ${Math.round(x.rate).toLocaleString('ru-RU')} so'm   ${d}`;
        }).join('\n'),
      });
    } catch { await tg('sendMessage', { chat_id: chatId, text: '⚠️ Kurs olinmadi.' }); }
    return;
  }

  /* --- AI: /ai savol  yoki  oddiy matn --- */
  const isAiCmd = text.startsWith('/ai');
  const question = isAiCmd ? clean(text.replace(/^\/ai(@\S+)?\s*/, ''), 2000) : clean(text, 2000);
  if (!question || text.startsWith('/')) return;
  if (msg.chat.type !== 'private' && !isAiCmd) return; // guruhda faqat /ai orqali

  if (!AI_ON) {
    return void tg('sendMessage', {
      chat_id: chatId,
      text: "🤖 AI hozircha ulanmagan. Ilovadan to'garak qidirishingiz mumkin.",
    });
  }
  const usr = touchUser(msg.from);
  if (!aiQuota(usr.id)) {
    return void tg('sendMessage', { chat_id: chatId, text: '⏳ Soatlik limit tugadi, birozdan keyin urinib ko\'ring.' });
  }

  await tg('sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const lang = LANG_NAME[usr.lang] || LANG_NAME.uz;
    const answer = await askAI(
      'Sen "To\'garakga qatnashmaysizmi" ilovasining o\'quv yordamchisisan. ' +
      'Maktab o\'quvchilariga fanlarni tushuntirasan. Javobni ' + lang + ' yoz. ' +
      'Qisqa va tushunarli (4-8 jumla). Markdown belgilarini ishlatma.',
      question
    );
    await tg('sendMessage', { chat_id: chatId, text: clean(answer, 3500) || '…' });
  } catch {
    await tg('sendMessage', { chat_id: chatId, text: '⚠️ Javob olinmadi, qayta urinib ko\'ring.' });
  }
}

let offset = 0;
async function poll() {
  if (TOKEN === 'TOKEN') return;
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${TOKEN}/getUpdates?timeout=30&offset=${offset}`,
      { signal: AbortSignal.timeout(40000) }
    );
    const j = await r.json();
    if (j && j.ok) {
      for (const up of j.result) {
        offset = up.update_id + 1;
        handleUpdate(up).catch((e) => console.error('update:', e.message));
      }
    }
  } catch { /* qayta urinamiz */ }
  setTimeout(poll, 500);
}

(async function boot() {
  if (TOKEN === 'TOKEN') return;
  const meBot = await tg('getMe', {});
  if (meBot && meBot.ok) console.log(`🤖 Bot: @${meBot.result.username}`);
  if (PUBLIC_URL) {
    await tg('setChatMenuButton', {
      menu_button: { type: 'web_app', text: "To'garaklar", web_app: { url: PUBLIC_URL } },
    });
  }
  await tg('setMyCommands', {
    commands: [
      { command: 'start', description: 'Ilovani ochish' },
      { command: 'ai', description: 'AI yordamchidan so\'rash' },
      { command: 'obhavo', description: 'Ob-havo' },
      { command: 'kurs', description: 'Valyuta kursi' },
      { command: 'help', description: 'Yordam' },
    ],
  });
  poll();
})();

process.on('SIGTERM', () => { try { fs.writeFileSync(DB_PATH, JSON.stringify(db)); } catch {} process.exit(0); });
