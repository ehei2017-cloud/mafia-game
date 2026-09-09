const path = require('path');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
const server = app.listen(process.env.PORT || 3000, () => console.log('Mafia running on port 3000'));
const io = new Server(server);
app.use(express.static(__dirname));

const rooms = new Map();
const code = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const publicPlayer = p => ({ id: p.id, name: p.name, alive: p.alive, host: p.host });

function state(room, viewer) {
  const me = room.players.get(viewer);
  return {
    code: room.code, phase: room.phase, started: room.started, hostId: room.hostId,
    players: [...room.players.values()].map(publicPlayer),
    role: me?.role || null, alive: me?.alive ?? false,
    votes: room.phase === 'day' ? Object.fromEntries(room.votes) : {},
    note: room.note || ''
  };
}
function broadcast(room) { for (const id of room.players.keys()) io.to(id).emit('state', state(room, id)); }
function announce(room, text) { room.note = text; io.to(room.code).emit('announcement', text); broadcast(room); }
function winCheck(room) {
  const alive = [...room.players.values()].filter(p => p.alive);
  const mafia = alive.filter(p => p.role === 'mafia').length;
  if (!mafia) { room.phase = 'ended'; announce(room, 'فاز المواطنون! تم كشف كل المافيا.'); return true; }
  if (mafia >= alive.length - mafia) { room.phase = 'ended'; announce(room, 'فازت المافيا! أصبحت تسيطر على المدينة.'); return true; }
  return false;
}
function assignRoles(room) {
  const list = [...room.players.values()];
  const shuffled = [...list].sort(() => Math.random() - .5);
  const mafiaCount = list.length >= 9 ? 3 : list.length >= 6 ? 2 : 1;
  shuffled.forEach((p, i) => { p.role = i < mafiaCount ? 'mafia' : i === mafiaCount ? 'doctor' : i === mafiaCount + 1 ? 'detective' : 'citizen'; p.alive = true; });
}
function nextPhase(room) {
  if (room.phase === 'lobby') { assignRoles(room); room.started = true; room.phase = 'night'; room.votes.clear(); announce(room, 'حلّ الليل… المافيا تختار ضحيتها، والطبيب ينقذ، والمحقق يحقق.'); return; }
  if (room.phase === 'night') { room.phase = 'day'; room.votes.clear(); announce(room, 'طلع النهار — ناقشوا وصوّتوا على المشتبه به.'); return; }
  if (room.phase === 'day') { room.phase = 'night'; room.votes.clear(); announce(room, 'حلّ الليل من جديد…'); }
}

io.on('connection', socket => {
  socket.on('create-room', ({ name }) => {
    const room = { code: code(), hostId: socket.id, phase: 'lobby', started: false, players: new Map(), votes: new Map(), note: 'بانتظار اللاعبين…' };
    room.players.set(socket.id, { id: socket.id, name: name?.trim() || 'المدير', alive: true, host: true }); rooms.set(room.code, room);
    socket.join(room.code); socket.emit('joined', { code: room.code, state: state(room, socket.id) }); broadcast(room);
  });
  socket.on('join-room', ({ code: roomCode, name }) => {
    const room = rooms.get((roomCode || '').toUpperCase());
    if (!room) return socket.emit('error-message', 'كود الغرفة غير صحيح.');
    if (room.started) return socket.emit('error-message', 'اللعبة بدأت بالفعل.');
    if (room.players.size >= 14) return socket.emit('error-message', 'الغرفة ممتلئة.');
    room.players.set(socket.id, { id: socket.id, name: name?.trim() || 'لاعب', alive: true, host: false }); socket.join(room.code);
    socket.emit('joined', { code: room.code, state: state(room, socket.id) }); broadcast(room);
  });
  socket.on('start', () => { const room = [...rooms.values()].find(r => r.hostId === socket.id); if (!room) return; if (room.players.size < 4) return socket.emit('error-message', 'تحتاجون 4 لاعبين على الأقل.'); nextPhase(room); });
  socket.on('next-phase', () => { const room = [...rooms.values()].find(r => r.hostId === socket.id); if (room && room.phase !== 'ended') nextPhase(room); });
  socket.on('vote', target => {
    const room = [...rooms.values()].find(r => r.players.has(socket.id)); const voter = room?.players.get(socket.id); const victim = room?.players.get(target);
    if (!room || room.phase !== 'day' || !voter?.alive || !victim?.alive) return;
    room.votes.set(socket.id, target); broadcast(room);
    const alive = [...room.players.values()].filter(p => p.alive).length;
    if (room.votes.size === alive) {
      const totals = {}; for (const id of room.votes.values()) totals[id] = (totals[id] || 0) + 1;
      const out = Object.entries(totals).sort((a,b) => b[1]-a[1])[0]?.[0]; room.players.get(out).alive = false;
      announce(room, `تم إخراج ${room.players.get(out).name} من المدينة. كان دوره: ${room.players.get(out).role}.`); winCheck(room);
    }
  });
  socket.on('signal', ({ to, data }) => io.to(to).emit('signal', { from: socket.id, data }));
  socket.on('disconnect', () => { for (const room of rooms.values()) if (room.players.delete(socket.id)) { if (room.hostId === socket.id) room.hostId = room.players.keys().next().value; if (!room.players.size) rooms.delete(room.code); else broadcast(room); } });
});
