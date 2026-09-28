'use strict';
/* =========================================================
   LUDO ARENA - vanilla JS. Game state in JS is the source of truth.
   Board: 15x15 grid, 0-indexed [row, col].
   LOOP: the 52 shared cells, clockwise. Every colour starts at a
   different loop index and walks 51 loop cells, then 5 private
   home-column cells, then the centre (step 56 = finished).
   ========================================================= */

const COLORS = ['red', 'green', 'yellow', 'blue'];
const CAP = c => c[0].toUpperCase() + c.slice(1);
const FINISH = 56;             // step value meaning "reached centre"
const LAST_LOOP_STEP = 50;     // steps 0..50 are on the shared loop

/* ---------- Board geometry ---------- */
const LOOP = [];
(function buildLoop() {
  const p = (r, c) => LOOP.push([r, c]);
  for (let c = 5; c >= 0; c--) p(8, c);  p(7, 0);  for (let c = 0; c <= 5; c++) p(6, c);      // left arm
  for (let r = 5; r >= 0; r--) p(r, 6);  p(0, 7);  for (let r = 0; r <= 5; r++) p(r, 8);      // top arm
  for (let c = 9; c <= 14; c++) p(6, c); p(7, 14); for (let c = 14; c >= 9; c--) p(8, c);     // right arm
  for (let r = 9; r <= 14; r++) p(r, 8); p(14, 7); for (let r = 14; r >= 9; r--) p(r, 6);     // bottom arm
})();
const START = { red: 8, green: 21, yellow: 34, blue: 47 };
const COLUMN = {
  red:    [[7,1],[7,2],[7,3],[7,4],[7,5]],
  green:  [[1,7],[2,7],[3,7],[4,7],[5,7]],
  yellow: [[7,13],[7,12],[7,11],[7,10],[7,9]],
  blue:   [[13,7],[12,7],[11,7],[10,7],[9,7]]
};
const BASE_ORIGIN = { red: [0, 0], green: [0, 9], yellow: [9, 9], blue: [9, 0] }; // [row, col]
const CENTER_SPOT = { red: [7.5, 6.9], green: [6.9, 7.5], yellow: [7.5, 8.1], blue: [8.1, 7.5] }; // [row, col]
const STAR_IDX = new Set(COLORS.map(c => (START[c] + 8) % 52));
const SAFE_IDX = new Set([...COLORS.map(c => START[c]), ...STAR_IDX]);

const loopIndex = (color, step) => (START[color] + step) % 52;

/* ---------- App state ---------- */
const S = { sound: true, music: false, anim: true, msgs: true, yellowBoost: true, difficulty: 'medium', theme: 'classic' };
let G = null;       // game state
let runId = 0;      // invalidates pending timers when leaving a game
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const later = (fn, ms) => { const id = runId; setTimeout(() => { if (id === runId) fn(); }, S.anim ? ms : Math.min(ms, 60)); };

/* ---------- Audio (Web Audio, no files) ---------- */
let actx = null;
function tone(freq, dur, type = 'sine', vol = 0.15) {
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.value = freq; g.gain.value = vol;
    o.connect(g); g.connect(actx.destination); o.start();
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.stop(actx.currentTime + dur);
  } catch (e) { /* audio unavailable: ignore */ }
}
const sfx = {
  click: () => S.sound && tone(520, .05, 'triangle'),
  dice:  () => S.sound && [300, 380, 460].forEach((f, i) => setTimeout(() => tone(f, .07, 'square', .1), i * 70)),
  move:  () => S.sound && tone(340, .06, 'triangle'),
  capture: () => S.sound && [400, 260, 150].forEach((f, i) => setTimeout(() => tone(f, .14, 'sawtooth', .15), i * 90)),
  home:  () => S.sound && [520, 660, 880].forEach((f, i) => setTimeout(() => tone(f, .16), i * 100)),
  win:   () => S.sound && [523, 659, 784, 1046, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, .25), i * 150))
};
let musicTimer = null, musicStep = 0;
const MELODY = [392, 494, 587, 494, 440, 523, 659, 523, 392, 494, 587, 784, 659, 587, 523, 494];
function syncMusic() {
  clearInterval(musicTimer); musicTimer = null;
  if (S.music) musicTimer = setInterval(() => tone(MELODY[musicStep++ % MELODY.length] / 2, .3, 'sine', .04), 380);
}

/* ---------- Messages: one quiet line at the bottom ---------- */
let msgTimer = null;
function showNotification(msg) {
  const el = $('#msgLine');
  if (!S.msgs) { el.classList.remove('show'); return; }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(msgTimer); msgTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---------- Persistence ---------- */
function saveGame() {
  if (!G || G.over || G.phase === 'busy') return;
  try { localStorage.setItem('ludoArenaSave', JSON.stringify({ G, S })); } catch (e) {}
}
function loadGame() {
  try {
    const d = JSON.parse(localStorage.getItem('ludoArenaSave'));
    if (!d || !d.G || !Array.isArray(d.G.players) || d.G.players.length < 2 || d.G.over) return null;
    const ok = d.G.players.every(p => COLORS.includes(p.color) && Array.isArray(p.tokens) && p.tokens.length === 4 &&
      p.tokens.every(t => Number.isInteger(t.pos) && t.pos >= -1 && t.pos <= FINISH));
    return ok ? d : null;
  } catch (e) { return null; }
}
function clearSave() { try { localStorage.removeItem('ludoArenaSave'); } catch (e) {} }

/* ---------- Setup ---------- */
function initializeGame(seats) {
  const players = COLORS.filter(c => seats[c] !== 'off').map(color => ({
    color, human: seats[color] === 'human', last: null,
    tokens: [0, 1, 2, 3].map(id => ({ id, pos: -1 }))   // pos: -1 home, 0..55 track, 56 finished
  }));
  return { players, cur: 0, dice: null, phase: 'roll', sixes: 0, over: false, winner: null, difficulty: S.difficulty };
}
function startGame(G0) {
  runId++;
  G = G0;
  $('#startScreen').classList.add('hidden');
  $('#winScreen').classList.add('hidden');
  $('#gameScreen').classList.remove('hidden');
  renderBoard();
  buildPanels();
  renderTokens();
  updateUI();
  saveGame();
  maybeAutoRoll();
}
function goMenu() {
  runId++;
  saveGame();
  $('#gameScreen').classList.add('hidden');
  $('#winScreen').classList.add('hidden');
  $('#startScreen').classList.remove('hidden');
  refreshResume();
}
function resetGame() { clearSave(); refreshResume(); }
function refreshResume() { $('#resumeBtn').classList.toggle('hidden', !loadGame()); }

/* ---------- Board rendering (built once per game) ---------- */
function renderBoard() {
  const b = $('#board'); b.innerHTML = '';
  const place = (el, r, c) => { el.style.left = (c * 100 / 15) + '%'; el.style.top = (r * 100 / 15) + '%'; };
  // bases
  COLORS.forEach(color => {
    const base = document.createElement('div'); base.className = 'base ' + color;
    const inner = document.createElement('div'); inner.className = 'base-inner';
    [[25, 25], [75, 25], [25, 75], [75, 75]].forEach(([x, y]) => {
      const s = document.createElement('div'); s.className = 'slot ' + color;
      s.style.left = x + '%'; s.style.top = y + '%'; inner.appendChild(s);
    });
    base.appendChild(inner); b.appendChild(base);
  });
  // loop cells
  LOOP.forEach(([r, c], i) => {
    const el = document.createElement('div'); el.className = 'cell'; place(el, r, c);
    const owner = COLORS.find(col => START[col] === i);
    if (owner) el.classList.add(owner, 'star');
    else if (STAR_IDX.has(i)) el.classList.add('star');
    b.appendChild(el);
  });
  // home columns
  COLORS.forEach(color => COLUMN[color].forEach(([r, c]) => {
    const el = document.createElement('div'); el.className = 'cell ' + color; place(el, r, c); b.appendChild(el);
  }));
  // centre
  const center = document.createElement('div'); center.className = 'center';
  COLORS.forEach(color => { const t = document.createElement('div'); t.className = 'tri ' + color; center.appendChild(t); });
  b.appendChild(center);
  // tokens (persistent elements so CSS transitions animate movement)
  G.players.forEach(p => p.tokens.forEach(t => {
    const el = document.createElement('div');
    el.className = 'token ' + p.color; el.id = `tok-${p.color}-${t.id}`;
    el.setAttribute('role', 'button'); el.setAttribute('aria-label', `${CAP(p.color)} token ${t.id + 1}`);
    b.appendChild(el);
  }));
  // event delegation for token clicks
  b.onclick = e => {
    const el = e.target.closest('.token');
    if (el && el.classList.contains('movable')) {
      const [, color, id] = el.id.split('-');
      onTokenClick(color, +id);
    }
  };
}

/* ---------- Token positioning ---------- */
function tokenCenter(p, t) {
  if (t.pos === -1) {
    const [r0, c0] = BASE_ORIGIN[p.color];
    return { r: r0 + (t.id < 2 ? 2 : 4), c: c0 + (t.id % 2 === 0 ? 2 : 4) };
  }
  if (t.pos === FINISH) return null;
  const [r, c] = t.pos <= LAST_LOOP_STEP ? LOOP[loopIndex(p.color, t.pos)] : COLUMN[p.color][t.pos - 51];
  return { r: r + 0.5, c: c + 0.5 };
}
function renderTokens() {
  const groups = {};
  G.players.forEach(p => p.tokens.forEach(t => {
    if (t.pos >= 0 && t.pos < FINISH) {
      const c = tokenCenter(p, t); const k = c.r + ',' + c.c;
      (groups[k] = groups[k] || []).push({ p, t });
    }
  }));
  const OFF = [[-.2, -.2], [.2, -.2], [-.2, .2], [.2, .2], [0, 0], [0, .3], [0, -.3], [.3, 0]];
  G.players.forEach(p => p.tokens.forEach(t => {
    const el = $(`#tok-${p.color}-${t.id}`); if (!el) return;
    let r, c, size = 0.8;
    if (t.pos === FINISH) {
      [r, c] = CENTER_SPOT[p.color]; size = 0.42;
      r += (t.id % 2 ? .18 : -.18) * (p.color === 'red' || p.color === 'yellow' ? 1 : 0);
      c += (t.id % 2 ? .18 : -.18) * (p.color === 'green' || p.color === 'blue' ? 1 : 0);
    } else {
      const ctr = tokenCenter(p, t); r = ctr.r; c = ctr.c;
      if (t.pos >= 0) {
        const g = groups[r + ',' + c];
        if (g.length > 1) { size = 0.56; const o = OFF[g.findIndex(x => x.t === t && x.p === p) % OFF.length]; r += o[0]; c += o[1]; }
      }
    }
    el.style.width = el.style.height = (size * 100 / 15) + '%';
    el.style.left = ((c - size / 2) * 100 / 15) + '%';
    el.style.top = ((r - size / 2) * 100 / 15) + '%';
    el.style.zIndex = t.pos === -1 ? 3 : 5;
  }));
  markMovable();
}
function markMovable() {
  $$('.token').forEach(el => el.classList.remove('movable'));
  if (!G || G.over || G.phase !== 'move') return;
  const p = G.players[G.cur]; if (!p.human) return;
  getValidMoves(p, G.dice).forEach(m => $(`#tok-${p.color}-${m.tok.id}`).classList.add('movable'));
}

/* ---------- Rules ---------- */
function getValidMoves(p, d) {
  const moves = [];
  p.tokens.forEach(tok => {
    if (tok.pos === -1) { if (d === 6) moves.push({ tok, to: 0 }); }
    else if (tok.pos < FINISH && tok.pos + d <= FINISH) moves.push({ tok, to: tok.pos + d });
  });
  return moves;
}
function victims(p, to) {
  if (to > LAST_LOOP_STEP) return [];
  const gi = loopIndex(p.color, to);
  if (SAFE_IDX.has(gi)) return [];
  const out = [];
  G.players.forEach(o => { if (o !== p) o.tokens.forEach(t => {
    if (t.pos >= 0 && t.pos <= LAST_LOOP_STEP && loopIndex(o.color, t.pos) === gi) out.push({ o, t });
  }); });
  return out;
}

/* ---------- Turn flow ---------- */
const DICE_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
const PANEL_SLOTS = { panelTop: ['red', 'green'], panelBottom: ['blue', 'yellow'] };
function diceHTML(v) {
  let h = ''; for (let i = 0; i < 9; i++) h += `<span class="pip${v && DICE_PIPS[v].includes(i) ? ' on' : ''}"></span>`; return h;
}
function drawDice(color, v) {
  const d = $('#dice-' + color); if (!d) return;
  d.innerHTML = diceHTML(v); d.setAttribute('aria-label', v ? `${CAP(color)} dice shows ${v}` : `${CAP(color)} dice`);
}
/* one dice per player, placed beside their corner like Ludo King */
function buildPanels() {
  Object.entries(PANEL_SLOTS).forEach(([rowId, list]) => {
    $('#' + rowId).innerHTML = list.map((color, i) => {
      const p = G.players.find(x => x.color === color);
      if (!p) return `<div class="pp empty"></div>`;
      return `<div class="pp ${color} ${i ? 'right' : 'left'}" id="pp-${color}">
        <div class="dice" id="dice-${color}" data-color="${color}" role="button" tabindex="0">${diceHTML(p.last)}</div>
        <div class="info"><b>${CAP(color)} ${p.human ? '' : '🤖'}</b><span class="cnt" id="cnt-${color}"></span><span class="hint" id="hint-${color}"></span></div></div>`;
    }).join('');
  });
}
function humanCanRoll() { return G && !G.over && G.phase === 'roll' && G.players[G.cur].human; }

/* dice is a little generous with 6s so the game keeps moving */
function baseRoll(p) {
  const allHome = p.tokens.every(t => t.pos === -1);
  const w6 = allHome ? 4 : 1.8;                    // 6 is about 26% normally, ~44% when stuck in base
  const x = Math.random() * (5 + w6);
  let v = x >= 5 ? 6 : 1 + Math.floor(x);
  if (v === 6 && G.sixes >= 2) v = 1 + Math.floor(Math.random() * 5);   // never a third six in a row
  return v;
}
/* ---------- Yellow boost: dice quietly steered toward Yellow ---------- */
const progressOf = q => q.tokens.reduce((a, t) => a + (t.pos === FINISH ? 100 : Math.max(t.pos, 0)), 0);
const finishedOf = q => q.tokens.filter(t => t.pos === FINISH).length;
function rollValue(p) {
  const v = baseRoll(p);
  if (!S.yellowBoost) return v;
  const y = G.players.find(q => q.color === 'yellow');
  if (!y || finishedOf(y) === 4) return v;
  return p === y ? yellowRoll(y, v) : guardRoll(p, y, v);
}
function scoreRoll(y, d) {           // how useful is value d for Yellow right now
  const moves = getValidMoves(y, d);
  if (!moves.length) return -50;
  const noneOut = y.tokens.every(t => t.pos <= -1 || t.pos === FINISH);
  return Math.max(...moves.map(m => {
    let s = m.to * 0.3;
    if (m.tok.pos === -1) s += 40 + (noneOut ? 30 : 0);
    if (m.to === FINISH) s += 90;
    if (victims(y, m.to).length) s += 100;
    if (m.to > LAST_LOOP_STEP && m.to < FINISH) s += 25;
    if (m.to <= LAST_LOOP_STEP) {
      const gi = loopIndex('yellow', m.to);
      if (SAFE_IDX.has(gi)) s += 15; else s -= dangerAt(y, gi) * 10;
    }
    return s;
  }));
}
function yellowRoll(y, v) {
  const others = G.players.filter(q => q !== y);
  const lead = Math.max(...others.map(progressOf));
  const needy = progressOf(y) < lead + 60 || others.some(q => finishedOf(q) >= 2);
  if (Math.random() > (needy ? 1 : 0.7)) return v;          // sometimes just a normal roll, so it looks natural
  const hist = y.hist || [];
  let best = v, bestS = -Infinity;
  for (let d = 1; d <= 6; d++) {
    if (d === 6 && G.sixes >= 2) continue;
    if (hist.length >= 2 && hist.slice(-2).every(h => h === d)) continue;   // no long streaks of the same number
    const s = scoreRoll(y, d) + Math.random() * 4;
    if (s > bestS) { bestS = s; best = d; }
  }
  return best;
}
function guardRoll(p, y, v) {        // stop rivals from finishing first or wrecking Yellow's advanced tokens
  const bad = d => getValidMoves(p, d).some(m =>
    (m.to === FINISH && finishedOf(p) === 3) ||
    (victims(p, m.to).some(x => x.o === y && x.t.pos >= 15) && Math.random() < 0.75));
  if (!bad(v)) return v;
  const alts = [1, 2, 3, 4, 5, 6].filter(d => d !== v && !(d === 6 && G.sixes >= 2)).sort(() => Math.random() - 0.5);
  return alts.find(d => !bad(d)) ?? v;
}
function rollDice() {
  if (!G || G.over || G.phase !== 'roll') return;
  G.phase = 'busy'; updateUI();
  const p = G.players[G.cur], d = $('#dice-' + p.color);
  d.classList.add('rolling'); sfx.dice();
  let n = 0; const id = runId;
  const t = setInterval(() => {
    if (id !== runId) { clearInterval(t); return; }
    drawDice(p.color, 1 + Math.floor(Math.random() * 6));
    if (++n > 6) {
      clearInterval(t); d.classList.remove('rolling');
      const v = rollValue(p);
      p.last = v; p.hist = (p.hist || []).concat(v).slice(-3); drawDice(p.color, v); G.dice = v; afterRoll();
    }
  }, S.anim ? 75 : 10);
}
function afterRoll() {
  const p = G.players[G.cur], v = G.dice;
  G.sixes = v === 6 ? G.sixes + 1 : 0;
  const moves = getValidMoves(p, v);
  if (!moves.length) { showNotification('No valid move'); later(() => nextTurn(v === 6), 900); return; }
  if (p.human) { G.phase = 'move'; updateUI(); markMovable(); saveGame(); }
  else later(() => runAITurn(p, moves), 650);
}
function onTokenClick(color, id) {
  if (!G || G.phase !== 'move') return;
  const p = G.players[G.cur];
  if (p.color !== color || !p.human) return;
  const move = getValidMoves(p, G.dice).find(m => m.tok.id === id);
  if (!move) return;
  sfx.click(); moveToken(p, move);
}
function moveToken(p, move) {
  G.phase = 'busy'; updateUI(); markMovable();
  animateTokenMovement(p, move.tok, move.to, () => {
    let extra = G.dice === 6;
    const vs = victims(p, move.to);
    if (vs.length) { vs.forEach(v => captureToken(p, v)); extra = true; }
    if (move.to === FINISH) {
      sfx.home(); showNotification(`🏠 ${CAP(p.color)} token home!`); extra = true;
      const el = $(`#tok-${p.color}-${move.tok.id}`); el.classList.add('done'); setTimeout(() => el.classList.remove('done'), 700);
    }
    renderTokens(); updateUI();
    if (checkWin(p)) return;
    later(() => nextTurn(extra), 450);
  });
}
function animateTokenMovement(p, tok, to, done) {
  if (tok.pos === -1) { tok.pos = 0; sfx.move(); renderTokens(); later(done, 300); return; }
  const stepOnce = () => {
    tok.pos++; sfx.move(); renderTokens();
    if (tok.pos < to) later(stepOnce, 170); else later(done, 200);
  };
  stepOnce();
}
function captureToken(p, v) {
  v.t.pos = -1; sfx.capture();
  showNotification(`⚔️ ${CAP(p.color)} captured ${CAP(v.o.color)}`);
  const el = $(`#tok-${v.o.color}-${v.t.id}`); el.classList.add('captured'); setTimeout(() => el.classList.remove('captured'), 600);
}
function checkWin(p) {
  if (!p.tokens.every(t => t.pos === FINISH)) return false;
  G.over = true; G.winner = p.color; G.phase = 'over';
  clearSave(); sfx.win();
  later(showWin, 900);
  return true;
}
function nextTurn(extra) {
  if (!G || G.over) return;
  G.dice = null; G.phase = 'roll';
  if (!extra) { G.sixes = 0; G.cur = (G.cur + 1) % G.players.length; }
  updateUI(); markMovable(); saveGame(); maybeAutoRoll();
}
function maybeAutoRoll() { if (G && !G.over && G.phase === 'roll' && !G.players[G.cur].human) later(rollDice, 700); }

/* ---------- Computer AI ---------- */
function runAITurn(p, moves) {
  if (!G || G.over || G.players[G.cur] !== p) return;   // AI turn interruption guard
  moveToken(p, chooseAIMove(p, moves));
}
function chooseAIMove(p, moves) {
  const level = p.color === 'yellow' && S.yellowBoost ? 'hard' : S.difficulty;
  if (level === 'easy') return moves[Math.floor(Math.random() * moves.length)];
  let best = moves[0], bestScore = -Infinity;
  moves.forEach(m => {
    let s = Math.random();                       // tiebreaker
    const to = m.to, from = m.tok.pos;
    if (from === -1) s += 30;
    if (to === FINISH) s += 80;
    if (victims(p, to).length) s += level === 'hard' ? 110 : 60;
    if (to > LAST_LOOP_STEP && to < FINISH) s += 22;
    if (to <= LAST_LOOP_STEP && SAFE_IDX.has(loopIndex(p.color, to))) s += 14;
    s += to * 0.25;
    if (level === 'hard') {
      const threat = (step) => step > LAST_LOOP_STEP || step < 0 || SAFE_IDX.has(loopIndex(p.color, step)) ? 0 : dangerAt(p, loopIndex(p.color, step));
      s -= threat(to) * 18;
      s += threat(from) * 12;                    // running away from danger
    } else {
      s -= (to <= LAST_LOOP_STEP && !SAFE_IDX.has(loopIndex(p.color, to)) ? dangerAt(p, loopIndex(p.color, to)) : 0) * 6;
    }
    if (s > bestScore) { bestScore = s; best = m; }
  });
  return best;
}
function dangerAt(p, gi) {   // opponents 1-6 cells behind this loop cell
  let n = 0;
  G.players.forEach(o => { if (o !== p) o.tokens.forEach(t => {
    if (t.pos >= 0 && t.pos <= LAST_LOOP_STEP) { const dist = (gi - loopIndex(o.color, t.pos) + 52) % 52; if (dist >= 1 && dist <= 6) n++; }
  }); });
  return n;
}

/* ---------- HUD ---------- */
function updateUI() {
  if (!G) return;
  const cur = G.players[G.cur];
  G.players.forEach(q => {
    const pp = $('#pp-' + q.color); if (!pp) return;
    const active = !G.over && q === cur;
    pp.classList.toggle('active', active);
    const d = $('#dice-' + q.color);
    const can = active && q.human && G.phase === 'roll';
    d.classList.toggle('ready', can);
    d.tabIndex = can ? 0 : -1;
    const fin = q.tokens.filter(t => t.pos === FINISH).length;
    $('#cnt-' + q.color).textContent = `${fin}/4 home`;
    $('#hint-' + q.color).textContent = !active ? '' : G.phase === 'move' ? 'Tap a token' : q.human ? (G.phase === 'roll' ? 'Tap dice' : '') : 'Thinking...';
  });
}

/* ---------- Win screen ---------- */
function showWin() {
  $('#gameScreen').classList.add('hidden'); $('#winScreen').classList.remove('hidden');
  const score = p => p.tokens.reduce((a, t) => a + (t.pos === FINISH ? 100 : Math.max(t.pos, 0)), 0);
  const ranked = [...G.players].sort((a, b) => (b.color === G.winner) - (a.color === G.winner) || score(b) - score(a));
  $('#winTitle').textContent = `🏆 ${G.winner.toUpperCase()} WINS!`;
  $('#winTitle').style.color = `var(--${G.winner})`;
  $('#winSub').textContent = '4/4 Tokens Home';
  const medals = ['1st 🏆', '2nd 🥈', '3rd 🥉', '4th'];
  $('#ranking').innerHTML = ranked.map((p, i) =>
    `<div class="rank"><span>${medals[i]}</span><b style="color:var(--${p.color})">${CAP(p.color)}</b><span>${p.tokens.filter(t => t.pos === FINISH).length}/4 home</span></div>`).join('');
  for (let i = 0; i < 60; i++) {
    const c = document.createElement('div'); c.className = 'confetti';
    c.style.left = Math.random() * 100 + 'vw'; c.style.background = ['#e53935', '#2e9e4f', '#f5b91a', '#1e6fe0'][i % 4];
    c.style.animationDuration = 2 + Math.random() * 2.5 + 's'; document.body.appendChild(c);
    setTimeout(() => c.remove(), 5000);
  }
}

/* ---------- Start-screen wiring ---------- */
function readSeats() {
  const seats = {}; $$('#seatGrid select').forEach(s => seats[s.dataset.color] = s.value); return seats;
}
function applyMode(mode) {
  const set = (r, g, y, b) => { const v = { red: r, green: g, yellow: y, blue: b }; $$('#seatGrid select').forEach(s => s.value = v[s.dataset.color]); };
  if (mode === '2') set('human', 'off', 'ai', 'off');
  else if (mode === '3') set('human', 'ai', 'ai', 'off');
  else if (mode === '4') set('human', 'ai', 'ai', 'ai');
  else set('human', 'off', 'ai', 'off');
}
function applySettings() {
  document.body.classList.toggle('theme-dark', S.theme === 'dark');
  $$('.tg-sound').forEach(e => e.checked = S.sound);
  $$('.tg-music').forEach(e => e.checked = S.music);
  $('#tgAnim').checked = S.anim; $('#tgMsgs').checked = S.msgs; $('#tgYellow').checked = S.yellowBoost; $('#setDiff').value = S.difficulty; $('#setTheme').value = S.theme;
  $$('#diffRow .pill').forEach(b => b.classList.toggle('active', b.dataset.diff === S.difficulty));
  syncMusic();
}
$$('#modeRow .pill').forEach(b => b.addEventListener('click', () => {
  sfx.click(); $$('#modeRow .pill').forEach(x => x.classList.remove('active')); b.classList.add('active'); applyMode(b.dataset.mode);
}));
$$('#diffRow .pill').forEach(b => b.addEventListener('click', () => { sfx.click(); S.difficulty = b.dataset.diff; applySettings(); }));
$('#playBtn').addEventListener('click', () => {
  sfx.click();
  const seats = readSeats();
  if (Object.values(seats).filter(v => v !== 'off').length < 2) { alert('Please select at least 2 players.'); return; }
  startGame(initializeGame(seats));
});
$('#resumeBtn').addEventListener('click', () => {
  const d = loadGame(); if (!d) { refreshResume(); return; }
  Object.assign(S, d.S); applySettings();
  d.G.phase = d.G.phase === 'move' ? 'move' : 'roll';
  startGame(d.G);
});
$('#rulesBtn').addEventListener('click', () => $('#rulesModal').classList.remove('hidden'));
['#settingsBtn', '#settingsBtn2'].forEach(s => $(s).addEventListener('click', () => $('#settingsModal').classList.remove('hidden')));
$$('[data-close]').forEach(b => b.addEventListener('click', () => $('#' + b.dataset.close).classList.add('hidden')));
$$('.modal-back').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); }));
$('#menuBtn').addEventListener('click', goMenu);
$('#menuBtn2').addEventListener('click', goMenu);
$('#againBtn').addEventListener('click', () => {
  const seats = G ? Object.fromEntries(COLORS.map(c => { const p = G.players.find(x => x.color === c); return [c, p ? (p.human ? 'human' : 'ai') : 'off']; })) : readSeats();
  startGame(initializeGame(seats));
});
['#panelTop', '#panelBottom'].forEach(id => {
  const row = $(id);
  const tryRoll = e => {
    const d = e.target.closest('.dice');
    if (d && humanCanRoll() && d.dataset.color === G.players[G.cur].color) rollDice();
  };
  row.addEventListener('click', tryRoll);
  row.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tryRoll(e); } });
});
$$('.tg-sound').forEach(e => e.addEventListener('change', () => { S.sound = e.checked; applySettings(); }));
$$('.tg-music').forEach(e => e.addEventListener('change', () => { S.music = e.checked; applySettings(); }));
$('#tgAnim').addEventListener('change', e => { S.anim = e.target.checked; });
$('#tgMsgs').addEventListener('change', e => { S.msgs = e.target.checked; });
$('#tgYellow').addEventListener('change', e => { S.yellowBoost = e.target.checked; });
$('#setDiff').addEventListener('change', e => { S.difficulty = e.target.value; applySettings(); });
$('#setTheme').addEventListener('change', e => { S.theme = e.target.value; applySettings(); });
$('#clearSaveBtn').addEventListener('click', () => { resetGame(); showNotification('Saved game cleared.'); });

applySettings();
refreshResume();