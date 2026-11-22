'use strict';
/* Jeopardy Game App — standalone server. Zero dependencies (Node >= 18 built-ins only).
   One active game at a time. State persists to data.json next to this file. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const ADMINS = [
  { username: 'MarTech', password: 'impact' },
  { username: 'admin2', password: 'admin123' },
  { username: 'host1', password: 'host123' },
];

const uid = () => crypto.randomBytes(8).toString('hex');
const token = () => crypto.randomBytes(24).toString('hex');
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');

function sampleTemplate() {
  const q = (type, points, stem, options, correctIndex) => ({ id: uid(), type, points, stem, image: '', options, correctIndex });
  return {
    id: uid(), name: 'Tech & AI Night',
    settings: { answerMode: 'phone', deduction: 'full', continueAfterWrong: true, answerSeconds: 10, finalSeconds: 30 },
    groups: [
      { id: uid(), title: 'AI versus Human', questions: [
        q('tf', 100, '"The moon tonight is a silver coin hung in a velvet sky." — AI or Human? (True = AI-generated, False = Human-written)', ['AI-generated', 'Human-written'], 1),
        q('tf', 200, '"As an AI language model, I can help you write a poem about the moon in a variety of styles and tones." — True = AI-generated, False = Human-written', ['AI-generated', 'Human-written'], 0),
        q('tf', 300, '"I keep the porch light on for my brother. He\'s been gone six years, but the bulb is cheap and so is hope." — True = AI-generated, False = Human-written', ['AI-generated', 'Human-written'], 1),
      ]},
      { id: uid(), title: 'Space & Science', questions: [
        q('choice', 100, 'Which planet has the largest ring system?', ['Jupiter', 'Saturn', 'Uranus', 'Neptune'], 1),
        q('choice', 200, 'What is the chemical symbol for gold?', ['Gd', 'Go', 'Au', 'Ag'], 2),
        q('choice', 300, 'How many sides does a hexagon have?', ['Five', 'Six', 'Seven'], 1),
      ]},
      { id: uid(), title: 'World Capitals', questions: [
        q('choice', 100, 'What is the capital of Japan?', ['Seoul', 'Beijing', 'Tokyo', 'Bangkok'], 2),
        q('choice', 200, 'What is the capital of Australia?', ['Sydney', 'Canberra', 'Melbourne', 'Perth'], 1),
        q('choice', 300, 'The capital of Canada is…', ['Toronto', 'Vancouver', 'Ottawa'], 2),
      ]},
    ],
    final: { category: 'Classic Literature', question: 'This 19th-century novel opens with the line "Call me Ishmael."', answer: 'Moby-Dick', points: 1000 },
  };
}

function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const d = JSON.parse(raw);
    if (d && Array.isArray(d.templates)) return d;
  } catch (e) { /* first run */ }
  return { templates: [sampleTemplate()], game: null };
}
let DB = loadData();
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB, null, 1)); } catch (e) {} }, 120);
}

/* sessions: token -> {kind:'admin', username} | {kind:'player', playerId, gameCode} */
const sessions = new Map();
/* SSE clients: Set of {res, role, token} */
const sseClients = new Set();

function currentGame() { return DB.game; }

function broadcast() {
  for (const c of sseClients) {
    try { c.res.write('data: ' + JSON.stringify(stateFor(c)) + '\n\n'); } catch (e) { sseClients.delete(c); }
  }
}
function changed() { save(); broadcast(); }

/* ---------- game engine ---------- */
function teamById(g, id) { return g.teams.find(t => t.id === id); }
function playerById(g, id) { return g.players.find(p => p.id === id); }

function questionById(tpl, qid) {
  for (const gr of tpl.groups) { const q = gr.questions.find(x => x.id === qid); if (q) return { group: gr, q }; }
  return null;
}

function logScore(g, teamId, label, delta) {
  if (!g.scoreLog) g.scoreLog = [];
  g.scoreLog.push({ teamId, label, delta });
}

function applyDeduction(g, tpl, team, points, cq) {
  const mode = tpl.settings.deduction;
  const d = mode === 'full' ? points : mode === 'half' ? Math.floor(points / 2) : 0;
  team.score -= d;
  logScore(g, team.id, (cq ? cq.groupTitle + ' · ' + points : 'Question'), -d);
}

function resolveWrong(g, tpl, cq) {
  // cq = current question runtime
  const q = cq.q;
  const eligible = g.teams.filter(t => !cq.lockedTeamIds.includes(t.id));
  // choice and open questions (Movie Guessing, PPT rounds) continue to the
  // remaining teams after a wrong answer — the answer is revealed only when
  // no team is left to try. TF questions end at once (a wrong pick would hand
  // the other teams the answer).
  if ((q.type === 'choice' || q.type === 'open') && tpl.settings.continueAfterWrong && eligible.length > 0) {
    cq.phase = 'waiting';
    cq.phaseEndsAt = null;
    cq.buzzWinnerTeamId = null;
    cq.lastResult = 'wrong-continue';
  } else {
    cq.phase = 'reveal';
    cq.lastResult = 'wrong-final';
  }
}

function resolveCorrect(g, cq) {
  const winner = teamById(g, cq.buzzWinnerTeamId);
  if (winner) { winner.score += cq.q.points; logScore(g, winner.id, cq.groupTitle + ' · ' + cq.q.points, cq.q.points); }
  cq.phase = 'reveal';
  cq.lastResult = 'correct';
  g.usedQuestionIds.push(cq.q.id);
}

/* Peer-voting final: tally every captain's report. Only the winner's aggregate
   is ever exposed — individual team totals stay server-side. */
function computeFinalResult(g) {
  const totals = {}; g.teams.forEach(t => { totals[t.id] = 0; });
  let totalVotes = 0;
  for (const rep of Object.values(g.finalReports)) {
    for (const [tid, n] of Object.entries(rep)) {
      if (totals[tid] !== undefined) { totals[tid] += n; totalVotes += n; }
    }
  }
  const max = Math.max(0, ...Object.values(totals));
  g.finalResult = {
    winnerTeamIds: totalVotes > 0 ? g.teams.filter(t => totals[t.id] === max).map(t => t.id) : [],
    winnerVotes: totalVotes > 0 ? max : 0,
    totalVotes,
  };
  // the vote winner(s) earn the Final points, added to their total score
  if (g.finalPoints) {
    for (const id of g.finalResult.winnerTeamIds) {
      const t = teamById(g, id);
      if (t) { t.score += g.finalPoints; logScore(g, id, 'Final Jeopardy — vote winner', g.finalPoints); }
    }
  }
}

function tick() {
  const g = currentGame();
  if (!g || !g.templateSnapshot) return;
  const tpl = g.templateSnapshot;
  const now = Date.now();
  let dirty = false;
  const cq = g.current;
  if (cq) {
    if (cq.phase === 'answer' && cq.answerDeadline && !cq.submission && now > cq.answerDeadline) {
      // no answer in time: deduct, lock that team out of this question, and
      // buzzing reopens automatically after a 5-second countdown — the
      // answer is NOT revealed while other teams can still try
      const loser = teamById(g, cq.buzzWinnerTeamId);
      if (loser) { applyDeduction(g, tpl, loser, cq.q.points, cq); cq.lockedTeamIds.push(loser.id); }
      cq.timedOut = true;
      cq.lastResult = 'timeout';
      cq.lastTimeoutTeamId = loser ? loser.id : null;
      cq.buzzWinnerTeamId = null;
      cq.answerDeadline = null;
      cq.phase = 'rebuzz';
      cq.phaseEndsAt = now + 5000;
      dirty = true;
    }
    if (cq.phase === 'rebuzz' && cq.phaseEndsAt && now > cq.phaseEndsAt) {
      const eligible = g.teams.filter(t => !cq.lockedTeamIds.includes(t.id));
      cq.phaseEndsAt = null;
      if (eligible.length > 0) { cq.phase = 'buzz'; cq.timedOut = false; }
      else { cq.phase = 'reveal'; cq.lastResult = 'wrong-final'; }
      dirty = true;
    }
  }
  if (g.phase === 'final_answer' && g.finalDeadline && now > g.finalDeadline) {
    g.phase = 'final_judge'; dirty = true;
  }
  if (dirty) changed();
}
setInterval(tick, 250);

/* ---------- state views (never leak answers to players) ---------- */
function publicTeams(g) {
  return g.teams.map(t => ({ id: t.id, name: t.name, score: t.score, captainId: t.captainId,
    members: g.players.filter(p => p.teamId === t.id).map(p => ({ id: p.id, name: p.name })) }));
}
function stateFor(client) {
  const g = currentGame();
  const base = { serverNow: Date.now(), gameExists: !!g };
  if (!g) return base;
  base.code = g.code; base.phase = g.phase; base.startedAt = g.startedAt;
  base.title = g.title || g.templateSnapshot.name;
  base.answerSeconds = g.templateSnapshot.settings.answerSeconds;
  if (g.current && g.current.q.answerSeconds != null) base.answerSeconds = g.current.q.answerSeconds; // per-question override (e.g. 30s PPT round)
  base.finalSeconds = g.templateSnapshot.settings.finalSeconds;
  base.finalDeadline = g.finalDeadline;
  base.finalAnswerEndsAt = g.finalAnswerEndsAt || null; // display-only 5:00 countdown for the Slack-answer phase
  base.teams = publicTeams(g);

  if (client.kind === 'admin') {
    base.template = g.templateSnapshot;
    base.usedQuestionIds = g.usedQuestionIds;
    base.current = g.current ? {
      qid: g.current.q.id, groupTitle: g.current.groupTitle, phase: g.current.phase,
      phaseEndsAt: g.current.phaseEndsAt, answerDeadline: g.current.answerDeadline,
      buzzWinnerTeamId: g.current.buzzWinnerTeamId, lockedTeamIds: g.current.lockedTeamIds,
      lastResult: g.current.lastResult, timedOut: g.current.timedOut,
      stem: g.current.q.stem, image: g.current.q.image, type: g.current.q.type,
      options: g.current.q.options, correctIndex: g.current.q.correctIndex, points: g.current.q.points,
      answer: g.current.q.answer || null,
      hostJudge: !!g.current.q.hostJudge, submission: g.current.submission || null,
      lastTimeoutTeamId: g.current.lastTimeoutTeamId || null,
    } : null;
    base.finalPoints = g.finalPoints;
    base.final = g.phase.startsWith('final') || g.phase === 'finished' ? {
      category: g.templateSnapshot.final.category, question: g.templateSnapshot.final.question,
      answer: g.templateSnapshot.final.answer, hostScored: !!g.templateSnapshot.final.hostScored,
      submissions: g.finalSubmissions, judged: g.finalJudged,
      reported: Object.fromEntries(g.teams.map(t => [t.id, !!g.finalReports[t.id]])),
      result: (g.phase === 'final_reveal' || g.phase === 'finished') ? g.finalResult : null,
    } : null;
    if (g.phase === 'finished') base.scoreLog = g.scoreLog || [];
    return base;
  }

  // player view
  const me = client.playerId ? playerById(g, client.playerId) : null;
  base.me = me ? { id: me.id, name: me.name, role: me.role, teamId: me.teamId, isCaptain: me.role === 'player' && teamById(g, me.teamId) && teamById(g, me.teamId).captainId === me.id } : null;
  base.usedQuestionIds = g.usedQuestionIds;
  base.board = g.templateSnapshot.groups.map(gr => ({ title: gr.title, questions: gr.questions.map(q => ({ id: q.id, points: q.points })) }));
  if (g.current) {
    const cq = g.current;
    const isWinningCaptain = base.me && base.me.isCaptain && cq.buzzWinnerTeamId === me.teamId;
    base.current = {
      phase: cq.phase, phaseEndsAt: cq.phaseEndsAt, answerDeadline: cq.answerDeadline,
      buzzWinnerTeamId: cq.buzzWinnerTeamId, lockedTeamIds: cq.lockedTeamIds,
      lastResult: cq.lastResult, timedOut: cq.timedOut, points: cq.q.points, type: cq.q.type,
      // options only for the answering captain; choice/TF questions are answered on the phone in every mode; open questions never expose options
      options: cq.q.type === 'open' ? null : (isWinningCaptain && cq.phase === 'answer' ? cq.q.options : null),
      revealedAnswer: cq.phase === 'reveal' && cq.q.type === 'open' ? (cq.q.answer || '') : null,
      hostJudge: !!cq.q.hostJudge,
      myPick: cq.submission && me && cq.submission.teamId === me.teamId ? cq.submission.choiceIndex : null,
      lastTimeoutTeamId: cq.lastTimeoutTeamId || null,
      myFinalSubmitted: undefined,
    };
  }
  if (g.phase === 'final_answer' || g.phase === 'final_judge' || g.phase === 'final_vote' || g.phase === 'final_reveal' || g.phase === 'finished') {
    base.finalPoints = g.finalPoints;
    base.finalDeadline = g.finalDeadline;
    base.finalHostScored = !!g.templateSnapshot.final.hostScored;
    base.finalReported = {}; g.teams.forEach(t => { base.finalReported[t.id] = !!g.finalReports[t.id]; });
    base.finalSubmittedCount = Object.keys(g.finalSubmissions).length;
    if (me) base.myFinalAnswer = g.finalSubmissions[me.teamId] || null;
    if (g.phase === 'final_reveal' || g.phase === 'finished') base.finalResult = g.finalResult;
    if (g.phase === 'finished') { base.finalStandings = publicTeams(g).slice().sort((a, b) => b.score - a.score); base.scoreLog = g.scoreLog || []; }
  }
  return base;
}

/* ---------- http helpers ---------- */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 8 * 1024 * 1024) reject(new Error('too big')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); } });
    req.on('error', reject);
  });
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}
function authAdmin(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const s = sessions.get(t);
  return s && s.kind === 'admin' ? s : null;
}
function authPlayer(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  const s = sessions.get(t);
  return s && s.kind === 'player' ? s : null;
}

const routes = {
  'POST /api/admin/login': async (req, res) => {
    const b = await readBody(req);
    const a = ADMINS.find(x => x.username === b.username && x.password === b.password);
    if (!a) return send(res, 401, { error: 'Invalid username or password' });
    const t = token(); sessions.set(t, { kind: 'admin', username: a.username });
    send(res, 200, { token: t, username: a.username });
  },
  'GET /api/admin/templates': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    send(res, 200, { templates: DB.templates });
  },
  'POST /api/admin/templates': async (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const b = await readBody(req);
    const tpl = b.template;
    if (!tpl || !tpl.name) return send(res, 400, { error: 'template.name required' });
    tpl.id = tpl.id || uid();
    const i = DB.templates.findIndex(t => t.id === tpl.id);
    if (i >= 0) DB.templates[i] = tpl; else DB.templates.push(tpl);
    changed(); send(res, 200, { template: tpl });
  },
  'DELETE /api/admin/templates': async (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const b = await readBody(req);
    DB.templates = DB.templates.filter(t => t.id !== b.id);
    changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/start': async (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const b = await readBody(req);
    const tpl = DB.templates.find(t => t.id === b.templateId);
    if (!tpl) return send(res, 404, { error: 'template not found' });
    if (DB.game && DB.game.phase !== 'finished') return send(res, 409, { error: 'A game is already active. End it first.' });
    DB.game = {
      code: newCode(), phase: 'lobby', title: String(b.title || '').trim().slice(0, 80) || tpl.name,
      templateSnapshot: JSON.parse(JSON.stringify(tpl)),
      teams: [], players: [], usedQuestionIds: [], current: null,
      startedAt: null, finalPoints: tpl.final.points || 1000,
      finalSubmissions: {}, finalJudged: {}, finalDeadline: null,
      finalReports: {}, finalResult: null, scoreLog: [],
    };
    changed(); send(res, 200, { code: DB.game.code });
  },
  'POST /api/host/end': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    DB.game = null; changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/begin': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    if (g.teams.length === 0) return send(res, 400, { error: 'At least one team must join first' });
    g.phase = 'board'; g.startedAt = Date.now(); changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/open': async (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const b = await readBody(req);
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    const found = questionById(g.templateSnapshot, b.questionId);
    if (!found) return send(res, 404, { error: 'question not found' });
    if (g.usedQuestionIds.includes(b.questionId)) return send(res, 400, { error: 'already used' });
    // categories are played low to high: every lower-value question in this
    // category must be finished before a higher one can open
    const ordered = [...found.group.questions].sort((a, b) => a.points - b.points);
    const myIdx = ordered.findIndex(x => x.id === b.questionId);
    const blocker = ordered.slice(0, myIdx).find(x => !g.usedQuestionIds.includes(x.id));
    if (blocker) return send(res, 400, { error: `Play this category in order — the ${blocker.points}-point question comes first.` });
    g.phase = 'question';
    g.current = { q: found.q, groupTitle: found.group.title, phase: 'waiting', phaseEndsAt: null,
      buzzWinnerTeamId: null, lockedTeamIds: [], lastResult: null, timedOut: false, answerDeadline: null, submission: null };
    changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/openBuzz': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const g = currentGame(); if (!g || !g.current) return send(res, 404, { error: 'no question' });
    if (g.current.phase !== 'waiting') return send(res, 400, { error: 'buzzing is not closed' });
    g.current.phase = 'buzz'; g.current.phaseEndsAt = null;
    changed(); send(res, 200, { ok: true });
  },
  'GET /api/ping': (req, res) => send(res, 200, { ok: true, now: Date.now() }),
  'POST /api/host/judge': async (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const b = await readBody(req);
    const g = currentGame(); if (!g || !g.current) return send(res, 404, { error: 'no question' });
    const cq = g.current; if (cq.phase !== 'answer') return send(res, 400, { error: 'not in answer phase' });
    const team = teamById(g, cq.buzzWinnerTeamId);
    if (b.correct) { resolveCorrect(g, cq); }
    else { if (team) { applyDeduction(g, g.templateSnapshot, team, cq.q.points, cq); cq.lockedTeamIds.push(team.id); } resolveWrong(g, g.templateSnapshot, cq); }
    changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/skip': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    if (g.current) g.usedQuestionIds.push(g.current.q.id);
    g.current = null; if (g.phase === 'question') g.phase = 'board';
    changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/backToBoard': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    if (g.current && g.current.phase === 'reveal' && !g.usedQuestionIds.includes(g.current.q.id)) g.usedQuestionIds.push(g.current.q.id);
    g.current = null; if (g.phase === 'question') g.phase = 'board';
    changed(); send(res, 200, { ok: true });
  },

  'POST /api/host/adjust': async (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const b = await readBody(req);
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    const t = teamById(g, b.teamId); if (!t) return send(res, 404, { error: 'team not found' });
    const delta = Number(b.delta) || 0;
    t.score += delta; if (delta) logScore(g, t.id, 'Host adjustment', delta);
    changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/setFinalPoints': async (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const b = await readBody(req);
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    g.finalPoints = Number(b.points) || 0; changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/startFinal': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    g.current = null;
    if (g.templateSnapshot.final.hostScored) {
      // peer-voting final: answers go to the host on Slack (nothing is collected or shown in the app); teams then vote for other teams' answers
      g.phase = 'final_answer'; g.finalDeadline = null;
      g.finalAnswerEndsAt = Date.now() + 5 * 60 * 1000; // display-only 5:00 countdown on the host screen to hurry teams along — nothing is enforced when it runs out
      g.finalSubmissions = {}; g.finalReports = {}; g.finalResult = null;
    } else {
      g.phase = 'final_answer';
      g.finalDeadline = null; // no time limit on Final answers — the host closes answers manually
      g.finalAnswerEndsAt = null;
    }
    changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/startVoting': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    if (g.phase !== 'final_answer' || !g.templateSnapshot.final.hostScored) return send(res, 400, { error: 'not in the voting final answer phase' });
    g.phase = 'final_vote'; changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/closeVoting': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    if (g.phase !== 'final_vote') return send(res, 400, { error: 'not in the voting phase' });
    computeFinalResult(g); g.phase = 'final_reveal'; changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/finalJudgePhase': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    g.phase = 'final_judge'; changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/judgeFinal': async (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const b = await readBody(req);
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    if (g.finalJudged[b.teamId] !== undefined) return send(res, 400, { error: 'already judged' });
    const t = teamById(g, b.teamId); if (!t) return send(res, 404, { error: 'team not found' });
    g.finalJudged[b.teamId] = !!b.correct;
    t.score += b.correct ? g.finalPoints : -g.finalPoints;
    logScore(g, t.id, 'Final Jeopardy', b.correct ? g.finalPoints : -g.finalPoints);
    changed(); send(res, 200, { ok: true });
  },
  'POST /api/host/finish': (req, res) => {
    if (!authAdmin(req)) return send(res, 401, { error: 'login required' });
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    g.phase = 'finished'; g.current = null; changed(); send(res, 200, { ok: true });
  },
  'POST /api/game/find': async (req, res) => {
    const b = await readBody(req);
    const g = currentGame();
    if (!g || g.code !== String(b.code || '').toUpperCase().trim()) return send(res, 404, { error: 'Game not found. Check the code.' });
    send(res, 200, { code: g.code, phase: g.phase,
      teams: g.teams.map(t => ({ id: t.id, name: t.name, members: g.players.filter(p => p.teamId === t.id).length })) });
  },
  'POST /api/game/join': async (req, res) => {
    const b = await readBody(req);
    const g = currentGame();
    if (!g || g.code !== String(b.code || '').toUpperCase().trim()) return send(res, 404, { error: 'Game not found' });
    const name = String(b.name || '').trim();
    if (!name) return send(res, 400, { error: 'Name required' });
    const existing = g.players.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      if (!b.replace) return send(res, 200, { status: 'exists' });
      // take over: kill old sessions for this player
      for (const [tk, s] of sessions) if (s.kind === 'player' && s.playerId === existing.id) sessions.delete(tk);
      const t = token(); sessions.set(t, { kind: 'player', playerId: existing.id, gameCode: g.code });
      changed(); return send(res, 200, { status: 'joined', token: t, playerId: existing.id });
    }
    if (g.phase !== 'lobby') return send(res, 403, { error: 'This game has already started — joining is closed.' });
    let player;
    if (b.mode === 'create') {
      const teamName = String(b.teamName || '').trim();
      if (!teamName) return send(res, 400, { error: 'Team name required' });
      if (g.teams.find(t => t.name.toLowerCase() === teamName.toLowerCase())) return send(res, 400, { error: 'That team name is taken' });
      const team = { id: uid(), name: teamName, score: 0, captainId: null };
      player = { id: uid(), name, role: 'player', teamId: team.id };
      team.captainId = player.id;
      g.teams.push(team);
    } else if (b.mode === 'join') {
      const team = teamById(g, b.teamId);
      if (!team) return send(res, 404, { error: 'Team not found' });
      player = { id: uid(), name, role: 'player', teamId: team.id };
    } else return send(res, 400, { error: 'mode must be create or join' });
    g.players.push(player);
    const t = token(); sessions.set(t, { kind: 'player', playerId: player.id, gameCode: g.code });
    changed(); send(res, 200, { status: 'joined', token: t, playerId: player.id });
  },
  'POST /api/player/buzz': (req, res) => {
    const s = authPlayer(req); if (!s) return send(res, 401, { error: 'session expired' });
    const g = currentGame(); if (!g || !g.current) return send(res, 404, { error: 'no question' });
    const me = playerById(g, s.playerId); if (!me || me.role !== 'player') return send(res, 403, { error: 'players only' });
    const team = teamById(g, me.teamId);
    if (!team || team.captainId !== me.id) return send(res, 403, { error: 'Only the team captain can buzz' });
    const cq = g.current;
    if (cq.phase !== 'buzz') return send(res, 400, { error: 'Buzzing is not open' });
    if (cq.lockedTeamIds.includes(team.id)) return send(res, 400, { error: 'Your team is locked out of this question' });
    cq.buzzWinnerTeamId = team.id; cq.phase = 'answer';
    cq.submission = null; // a fresh attempt — clear any previous team's pick
    const secs = cq.q.answerSeconds != null ? cq.q.answerSeconds : g.templateSnapshot.settings.answerSeconds;
    cq.answerDeadline = secs > 0 ? Date.now() + secs * 1000 : null;
    changed(); send(res, 200, { ok: true });
  },
  'POST /api/player/answer': async (req, res) => {
    const s = authPlayer(req); if (!s) return send(res, 401, { error: 'session expired' });
    const b = await readBody(req);
    const g = currentGame(); if (!g || !g.current) return send(res, 404, { error: 'no question' });
    const me = playerById(g, s.playerId); if (!me) return send(res, 403, { error: 'not in game' });
    const cq = g.current;
    if (cq.phase !== 'answer' || cq.buzzWinnerTeamId !== me.teamId) return send(res, 400, { error: 'Not your turn to answer' });
    const team = teamById(g, me.teamId);
    if (cq.q.hostJudge) {
      // host-judged pick (e.g. PPT rounds): record the captain's A/B/C, never auto-score — the host judges
      const ci = Number(b.choiceIndex);
      if (!(ci >= 0 && ci < cq.q.options.length)) return send(res, 400, { error: 'invalid choice' });
      if (cq.submission) return send(res, 400, { error: 'answer already submitted' });
      cq.submission = { teamId: me.teamId, choiceIndex: ci };
      cq.answerDeadline = null;
      changed(); return send(res, 200, { ok: true, pending: true });
    }
    if (cq.q.type === 'open') return send(res, 400, { error: 'Open question — the host judges' });
    // known-answer choice/TF questions auto-judge in every mode; only open and hostJudge questions go to the host
    const correct = Number(b.choiceIndex) === cq.q.correctIndex;
    if (correct) resolveCorrect(g, cq);
    else { applyDeduction(g, g.templateSnapshot, team, cq.q.points, cq); cq.lockedTeamIds.push(team.id); resolveWrong(g, g.templateSnapshot, cq); }
    changed(); send(res, 200, { ok: true, correct });
  },
  'POST /api/player/finalAnswer': async (req, res) => {
    const s = authPlayer(req); if (!s) return send(res, 401, { error: 'session expired' });
    const b = await readBody(req);
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    const me = playerById(g, s.playerId); if (!me || me.role !== 'player') return send(res, 403, { error: 'players only' });
    const team = teamById(g, me.teamId);
    if (!team || team.captainId !== me.id) return send(res, 403, { error: 'Only the captain submits the Final answer' });
    if (g.phase !== 'final_answer') return send(res, 400, { error: 'Final answers are not open' });
    if (g.templateSnapshot.final.hostScored) return send(res, 400, { error: 'This Final runs on Slack — send your answer to the host there, not in the app.' });
    g.finalSubmissions[me.teamId] = String(b.text || '').slice(0, 2000);
    changed(); send(res, 200, { ok: true });
  },
  'POST /api/player/reportVotes': async (req, res) => {
    const s = authPlayer(req); if (!s) return send(res, 401, { error: 'session expired' });
    const b = await readBody(req);
    const g = currentGame(); if (!g) return send(res, 404, { error: 'no game' });
    const me = playerById(g, s.playerId); if (!me || me.role !== 'player') return send(res, 403, { error: 'players only' });
    const team = teamById(g, me.teamId);
    if (!team || team.captainId !== me.id) return send(res, 403, { error: 'Only the captain reports the votes' });
    if (g.phase !== 'final_vote') return send(res, 400, { error: 'Voting is not open' });
    if (g.finalReports[me.teamId]) return send(res, 400, { error: 'Votes already reported' });
    const votes = {};
    for (const [tid, n] of Object.entries(b.votes || {})) {
      if (tid === me.teamId) continue; // a team can never vote for itself
      if (!teamById(g, tid)) continue;
      const v = Math.floor(Number(n));
      if (Number.isFinite(v) && v > 0) votes[tid] = Math.min(v, 9999);
    }
    g.finalReports[me.teamId] = votes;
    if (g.teams.every(t => g.finalReports[t.id])) { computeFinalResult(g); g.phase = 'final_reveal'; }
    changed(); send(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const key = req.method + ' ' + url.pathname;
  if (url.pathname === '/api/events') {
    const t = url.searchParams.get('token') || '';
    const s = sessions.get(t);
    const client = { res, kind: s ? s.kind : 'anon', playerId: s && s.kind === 'player' ? s.playerId : null };
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('data: ' + JSON.stringify(stateFor(client)) + '\n\n');
    sseClients.add(client);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 20000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(client); });
    return;
  }
  if (routes[key]) { try { await routes[key](req, res); } catch (e) { send(res, 500, { error: String(e && e.message || e) }); } return; }
  // static
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(full);
    const type = ext === '.html' ? 'text/html; charset=utf-8' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store, must-revalidate' });
    res.end(data);
  });
});
server.listen(PORT, () => console.log('Jeopardy server listening on port ' + PORT));
