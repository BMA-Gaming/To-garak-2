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

/* ------------------------------- BAZA ------------------------------------- */

function emptyDb() {
  // groups ichida har bir guruhning g.chat va g.homework massivi bo'ladi
  return { seq: 1, users: {}, groups: [], requests: [], messages: [], aiChats: {} };
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

/* ---------------------------- AI YORDAMCHI (Gemini) ------------------------ */

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AQ.Ab8RN6LYraJQIopO8VtVL_G6JpZkuDTVBnRF7u4HjxQWf74LGw';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const AI_SYSTEM =
  "Sen — \"To'garakga qatnashmaysizmi?\" nomli Telegram mini ilovasidagi AI yordamchisan. " +
  "Ilova mentorlar (o'qituvchilar) va o'quvchilarni to'garaklar orqali bog'laydi. " +
  "Foydalanuvchilarning (mentor yoki o'quvchi bo'lishidan qat'i nazar) ta'lim, fanlar, uy vazifalari, " +
  "to'garak tashkil qilish va umumiy bilim savollariga aniq, qisqa, do'stona va tushunarli javob ber. " +
  "Foydalanuvchi qaysi tilda yozsa (o'zbek lotin, o'zbek kirill, rus yoki ingliz), o'sha tilda javob qaytar.";

const AI_FAIL_TEXT = {
  uz: 'Uzr, hozir javob bera olmadim. Birozdan so\'ng qayta urinib ko\'ring.',
  cyr: 'Узр, ҳозир жавоб бера олмадим. Бироздан сўнг қайта уриниб кўринг.',
  ru: 'Извините, не удалось ответить. Попробуйте, пожалуйста, ещё раз чуть позже.',
  en: "Sorry, I couldn't reply right now. Please try again in a moment.",
};

async function askGemini(history) {
  if (!GEMINI_API_KEY) return null;
  try {
    const contents = history.slice(-16).map((m) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }],
    }));
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction: { parts: [{ text: AI_SYSTEM }] },
          generationConfig: { temperature: 0.6, maxOutputTokens: 900 },
        }),
        signal: AbortSignal.timeout(25000),
      }
    );
    const j = await r.json();
    const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
    const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : '';
    return text.trim() || null;
  } catch (e) {
    console.error('gemini:', e.message);
    return null;
  }
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
        if (db.aiChats) delete db.aiChats[u.id];
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
      limit: 9999,
      open: body.open === undefined ? true : !!body.open,
      members: [],
      homework: [],
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
    // limit endi ishlatilmaydi — cheksiz
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
    // limit yo'q — cheksiz qabul qilinadi
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

  /* ========================= GURUH CHATI ========================= */

  /* Guruh xabarlarini olish */
  if (m === 'GET' && pathname.startsWith('/api/group-chat/')) {
    const gId = pathname.split('/')[3];
    const g = db.groups.find((x) => x.id === gId);
    if (!g) return json(res, 404, { error: 'not_found' });
    // faqat a'zolar va mentor ko'ra oladi
    const isMember = g.members.includes(me.id) || g.mentorId === me.id;
    if (!isMember) return json(res, 403, { error: 'not_member' });

    // o'qilmagan xabarlarni belgilash
    let changed = false;
    const msgs = (g.chat || []).map((x) => {
      if (!x.readBy) x.readBy = [];
      if (!x.readBy.includes(me.id)) { x.readBy.push(me.id); changed = true; }
      return x;
    });
    if (changed) save();

    const pinned = (g.chat || []).find((x) => x.pinned) || null;
    return json(res, 200, { messages: msgs, pinned, memberCount: g.members.length + 1 });
  }

  /* Guruh chatiga xabar/rasm yuborish */
  if (m === 'POST' && pathname.startsWith('/api/group-chat/')) {
    const gId = pathname.split('/')[3];
    const g = db.groups.find((x) => x.id === gId);
    if (!g) return json(res, 404, { error: 'not_found' });
    const isMember = g.members.includes(me.id) || g.mentorId === me.id;
    if (!isMember) return json(res, 403, { error: 'not_member' });

    if (!g.chat) g.chat = [];

    const text = clean(body.text || '', 1000);
    const image = body.image && typeof body.image === 'string' && body.image.startsWith('data:image/')
      ? body.image : null;

    if (!text && !image) return json(res, 400, { error: 'empty' });

    const msg = {
      id: nextId(),
      from: me.id,
      name: me.name || me.tgName,
      photo: me.photo || '',
      text,
      image: image || null,
      at: now(),
      pinned: false,
      readBy: [me.id],
    };
    g.chat.push(msg);
    if (g.chat.length > 500) g.chat.splice(0, 100); // eski xabarlarni tozalash
    save();
    return json(res, 200, { message: msg });
  }

  /* Xabarni pin/unpin qilish — faqat mentor */
  if (m === 'POST' && pathname.startsWith('/api/group-pin/')) {
    const gId = pathname.split('/')[3];
    const g = db.groups.find((x) => x.id === gId);
    if (!g) return json(res, 404, { error: 'not_found' });
    if (g.mentorId !== me.id) return json(res, 403, { error: 'mentor_only' });

    const msgId = String(body.msgId || '');
    const unpin = !!body.unpin;

    if (!g.chat) g.chat = [];
    // avvalgi pinnedni olib tashla
    g.chat.forEach((x) => { x.pinned = false; });
    if (!unpin) {
      const msg = g.chat.find((x) => x.id === msgId);
      if (msg) msg.pinned = true;
    }
    save();
    return json(res, 200, { ok: true });
  }

  /* ========================= UYGA VAZIFA ========================= */

  /* Guruh vazifalarini olish */
  if (m === 'GET' && pathname.startsWith('/api/group-homework/')) {
    const gId = pathname.split('/')[3];
    const g = db.groups.find((x) => x.id === gId);
    if (!g) return json(res, 404, { error: 'not_found' });
    const isMember = g.members.includes(me.id) || g.mentorId === me.id;
    if (!isMember) return json(res, 403, { error: 'not_member' });
    if (!g.homework) g.homework = [];
    const list = g.homework.map((h) => ({
      id: h.id,
      title: h.title,
      text: h.text,
      deadline: h.deadline,
      createdAt: h.createdAt,
      doneCount: (h.doneBy || []).length,
      doneByMe: (h.doneBy || []).includes(me.id),
    }));
    return json(res, 200, { homework: list, isMentor: g.mentorId === me.id, memberCount: g.members.length });
  }

  /* Yangi vazifa qo'shish — faqat mentor */
  if (m === 'POST' && pathname.startsWith('/api/group-homework/')) {
    const gId = pathname.split('/')[3];
    const g = db.groups.find((x) => x.id === gId);
    if (!g) return json(res, 404, { error: 'not_found' });
    if (g.mentorId !== me.id) return json(res, 403, { error: 'mentor_only' });
    const title = clean(body.title, 120);
    const text = clean(body.text, 1500);
    const deadline = clean(body.deadline, 20);
    if (!title) return json(res, 400, { error: 'bad_request' });
    if (!g.homework) g.homework = [];
    const hw = { id: nextId(), title, text, deadline, createdAt: now(), doneBy: [] };
    g.homework.unshift(hw);
    if (g.homework.length > 150) g.homework.length = 150;
    save();
    for (const uid of g.members) {
      notify(uid, `📚 <b>Yangi uyga vazifa</b>\n«${g.title}»: ${title}`);
    }
    return json(res, 200, { homework: { ...hw, doneCount: 0, doneByMe: false } });
  }

  /* Vazifani bajarildi deb belgilash — o'quvchi */
  if (m === 'POST' && pathname.startsWith('/api/group-homework-done/')) {
    const gId = pathname.split('/')[3];
    const g = db.groups.find((x) => x.id === gId);
    if (!g) return json(res, 404, { error: 'not_found' });
    if (!g.members.includes(me.id)) return json(res, 403, { error: 'not_member' });
    if (!g.homework) g.homework = [];
    const hw = g.homework.find((h) => h.id === String(body.hwId));
    if (!hw) return json(res, 404, { error: 'not_found' });
    if (!hw.doneBy) hw.doneBy = [];
    const i = hw.doneBy.indexOf(me.id);
    if (body.done === false) { if (i >= 0) hw.doneBy.splice(i, 1); }
    else if (i < 0) hw.doneBy.push(me.id);
    save();
    return json(res, 200, { ok: true, doneByMe: hw.doneBy.includes(me.id), doneCount: hw.doneBy.length });
  }

  /* Vazifani o'chirish — faqat mentor */
  if (m === 'POST' && pathname.startsWith('/api/group-homework-del/')) {
    const gId = pathname.split('/')[3];
    const g = db.groups.find((x) => x.id === gId);
    if (!g) return json(res, 404, { error: 'not_found' });
    if (g.mentorId !== me.id) return json(res, 403, { error: 'mentor_only' });
    if (!g.homework) g.homework = [];
    g.homework = g.homework.filter((h) => h.id !== String(body.hwId));
    save();
    return json(res, 200, { ok: true });
  }

  /* ========================= AI YORDAMCHI ========================= */

  if (m === 'GET' && pathname === '/api/ai-chat') {
    if (!db.aiChats) db.aiChats = {};
    return json(res, 200, { messages: db.aiChats[me.id] || [] });
  }

  if (m === 'POST' && pathname === '/api/ai-chat') {
    const text = clean(body.text, 1500);
    if (!text) return json(res, 400, { error: 'empty' });
    if (!db.aiChats) db.aiChats = {};
    const list = db.aiChats[me.id] || (db.aiChats[me.id] = []);
    list.push({ role: 'user', text, at: now() });
    save();
    const answer = await askGemini(list);
    list.push({ role: 'model', text: answer || AI_FAIL_TEXT[me.lang] || AI_FAIL_TEXT.uz, at: now(), failed: !answer });
    if (list.length > 60) list.splice(0, list.length - 60);
    save();
    return json(res, 200, { messages: list });
  }

  if (m === 'POST' && pathname === '/api/ai-chat-clear') {
    if (!db.aiChats) db.aiChats = {};
    db.aiChats[me.id] = [];
    save();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'not_found' });
}

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
});

/* -------------------------------- BOT ------------------------------------- */

const START_TEXT =
  "👋 <b>To'garakga qatnashmaysizmi?</b>\n\n" +
  "Bu yerda o'quvchilar hech kim bilan yuzma-yuz ko'rishmasdan to'garaklarga ariza topshiradi, " +
  "mentorlar esa o'z to'garagini e'lon qiladi.\n\n" +
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
    commands: [{ command: 'start', description: "Ilovani ochish" }],
  });
  poll();
})();

process.on('SIGTERM', () => { try { fs.writeFileSync(DB_PATH, JSON.stringify(db)); } catch {} process.exit(0); });
