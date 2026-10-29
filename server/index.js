import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { randomUUID, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { sessions: [] };
try {
  if (fs.existsSync(DATA_FILE)) db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch (e) {
  console.error('Could not read sessions file; starting with empty data.', e);
}
function persist() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
function cleanName(value, max = 40) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}
const DECK = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

// Gợi ý story point sau reveal: luôn trả về một lá bài thuộc dãy Fibonacci.
// - Bỏ phiếu '?'.
// - Lấy median (bền với outlier hơn trung bình cộng).
// - Nếu median rơi giữa 2 lá (số phiếu chẵn), snap về lá gần nhất;
//   hòa thì chọn lá lớn hơn (ước lượng thận trọng, tránh underestimate).
function suggestPoint(values) {
  const nums = values
    .filter(v => v !== null && v !== undefined && v !== '?')
    .map(Number)
    .filter(n => DECK.includes(n))
    .sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  const median = nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
  return DECK.reduce((best, card) => {
    const d = Math.abs(card - median), bd = Math.abs(best - median);
    return d < bd || (d === bd && card > best) ? card : best;
  });
}

// Presence: sessionId -> memberId -> Set(socketId). Chỉ lưu trong RAM, không persist.
const presence = new Map();
const DISCONNECT_GRACE_MS = 3000; // tránh nhấp nháy offline khi member F5 / mạng chập chờn
const pendingOffline = new Map(); // `${sessionId}:${memberId}:${socketId}` -> timeout
function isOnline(sessionId, memberId) {
  return (presence.get(sessionId)?.get(memberId)?.size ?? 0) > 0;
}
function addPresence(sessionId, memberId, socketId) {
  if (!presence.has(sessionId)) presence.set(sessionId, new Map());
  const room = presence.get(sessionId);
  if (!room.has(memberId)) room.set(memberId, new Set());
  room.get(memberId).add(socketId);
}
function removePresence(sessionId, memberId, socketId) {
  const room = presence.get(sessionId);
  const sockets = room?.get(memberId);
  if (!sockets) return false;
  const had = sockets.delete(socketId);
  if (!sockets.size) room.delete(memberId);
  if (!room.size) presence.delete(sessionId);
  return had;
}

function publicSession(s) {
  return {
    id: s.id, name: s.name, createdAt: s.createdAt,
    stories: s.stories.map(({ id, name, point, votes, revealed }) => ({
      id, name, point: revealed ? point : null, revealed: !!revealed,
      votes: revealed ? votes : votes.map(v => ({ memberId: v.memberId, value: null }))
    })),
    members: s.members.map(m => ({ id: m.id, name: m.name, joinedAt: m.joinedAt, isHost: !!m.isHost, online: isOnline(s.id, m.id) })),
    currentStoryIndex: s.currentStoryIndex, revealed: s.stories[s.currentStoryIndex]?.revealed ?? false
  };
}
function findSession(id) { return db.sessions.find(s => s.id === id); }
function isHost(s, key) { return !!key && s.hostKey === key; }
function emitSession(s) { io.to(s.id).emit('session:update', publicSession(s)); }
function errorResponse(res, status, message) { return res.status(status).json({ error: message }); }

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/sessions', (_req, res) => {
  res.json(db.sessions.map(s => ({
    id: s.id, name: s.name, createdAt: s.createdAt,
    storyCount: s.stories.length, memberCount: s.members.length
  })));
});
app.post('/api/sessions', (req, res) => {
  const name = cleanName(req.body?.name, 80);
  const hostName = cleanName(req.body?.hostName, 40);
  const storiesInput = Array.isArray(req.body?.stories) ? req.body.stories : [];
  if (!name) return errorResponse(res, 400, 'Please enter a session name.');
  if (!hostName) return errorResponse(res, 400, 'Please enter the host display name.');
  if (!storiesInput.length) return errorResponse(res, 400, 'A session needs at least one user story.');
  const seen = new Set();
  const stories = [];
  for (const raw of storiesInput) {
    const id = cleanName(raw?.id, 40);
    const storyName = cleanName(raw?.name, 200);
    if (!id || !storyName) return errorResponse(res, 400, 'Each user story needs both an ID and a name.');
    if (seen.has(id.toLowerCase())) return errorResponse(res, 400, `Duplicate story ID: ${id}`);
    seen.add(id.toLowerCase());
    stories.push({ id, name: storyName, point: null, votes: [], revealed: false });
  }
  const hostKey = randomBytes(24).toString('hex');
  const session = {
    id: randomUUID().slice(0, 8).toUpperCase(),
    name, hostKey, createdAt: new Date().toISOString(),
    stories, members: [], currentStoryIndex: 0
  };
  session.members.push({ id: randomUUID(), name: hostName, joinedAt: new Date().toISOString(), isHost: true });
  db.sessions.unshift(session);
  persist();
  res.status(201).json({ session: publicSession(session), hostKey, hostMemberId: session.members[0].id });
});
app.get('/api/sessions/:id', (req, res) => {
  const s = findSession(req.params.id.toUpperCase());
  if (!s) return errorResponse(res, 404, 'Session not found.');
  res.json(publicSession(s));
});
app.post('/api/sessions/:id/join', (req, res) => {
  const s = findSession(req.params.id.toUpperCase());
  if (!s) return errorResponse(res, 404, 'Session not found.');
  const name = cleanName(req.body?.name, 40);
  const memberId = cleanName(req.body?.memberId, 80);
  if (!name) return errorResponse(res, 400, 'Please enter a display name.');
  let member = memberId ? s.members.find(m => m.id === memberId) : null;
  if (!member) {
    member = { id: randomUUID(), name, joinedAt: new Date().toISOString(), isHost: false };
    s.members.push(member);
  } else {
    member.name = name;
  }
  persist();
  res.json({ session: publicSession(s), memberId: member.id });
});
app.post('/api/sessions/:id/stories/:index/next', (req, res) => {
  const s = findSession(req.params.id.toUpperCase());
  if (!s) return errorResponse(res, 404, 'Session not found.');
  if (!isHost(s, req.body?.hostKey)) return errorResponse(res, 403, 'Only the host can switch stories.');
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= s.stories.length) return errorResponse(res, 400, 'Invalid story.');
  s.currentStoryIndex = index;
  persist(); emitSession(s); res.json(publicSession(s));
});
app.post('/api/sessions/:id/stories', (req, res) => {
  const s = findSession(req.params.id.toUpperCase());
  if (!s) return errorResponse(res, 404, 'Session not found.');
  if (!isHost(s, req.body?.hostKey)) return errorResponse(res, 403, 'Only the host can add user stories.');
  const input = Array.isArray(req.body?.stories) ? req.body.stories : [];
  if (!input.length) return errorResponse(res, 400, 'Please enter at least one user story.');
  if (input.length > 50) return errorResponse(res, 400, 'You can add at most 50 stories at a time.');
  const seen = new Set(s.stories.map(x => x.id.toLowerCase()));
  const added = [];
  for (const raw of input) {
    const id = cleanName(raw?.id, 40);
    const name = cleanName(raw?.name, 200);
    if (!id || !name) return errorResponse(res, 400, 'Each user story needs both an ID and a name.');
    if (seen.has(id.toLowerCase())) return errorResponse(res, 400, `Duplicate story ID: ${id}`);
    seen.add(id.toLowerCase());
    added.push({ id, name, point: null, votes: [], revealed: false });
  }
  s.stories.push(...added); // thêm vào cuối, không đổi story đang vote
  persist(); emitSession(s); res.json(publicSession(s));
});
app.post('/api/sessions/:id/vote', (req, res) => {
  const s = findSession(req.params.id.toUpperCase());
  if (!s) return errorResponse(res, 404, 'Session not found.');
  const member = s.members.find(m => m.id === req.body?.memberId);
  if (!member) return errorResponse(res, 403, 'You are no longer in this session. Please rejoin.');
  const story = s.stories[s.currentStoryIndex];
  if (!story) return errorResponse(res, 400, 'No story is currently selected.');
  if (story.revealed) return errorResponse(res, 409, 'Votes are already revealed. Switch to another story to keep voting.');
  const allowed = ['0','1','2','3','5','8','13','21','34','55','89','?'];
  const value = String(req.body?.value);
  if (!allowed.includes(value)) return errorResponse(res, 400, 'Invalid card value.');
  story.votes = story.votes.filter(v => v.memberId !== member.id);
  story.votes.push({ memberId: member.id, value });
  persist(); emitSession(s); res.json({ ok: true });
});
app.post('/api/sessions/:id/reveal', (req, res) => {
  const s = findSession(req.params.id.toUpperCase());
  if (!s) return errorResponse(res, 404, 'Session not found.');
  if (!isHost(s, req.body?.hostKey)) return errorResponse(res, 403, 'Only the host can reveal.');
  const story = s.stories[s.currentStoryIndex];
  if (!story) return errorResponse(res, 400, 'No story is currently selected.');
  story.revealed = true;
  story.point = suggestPoint(story.votes.map(v => v.value));
  persist(); emitSession(s); res.json(publicSession(s));
});
app.post('/api/sessions/:id/members/:memberId/remove', (req, res) => {
  const s = findSession(req.params.id.toUpperCase());
  if (!s) return errorResponse(res, 404, 'Session not found.');
  if (!isHost(s, req.body?.hostKey)) return errorResponse(res, 403, 'Only the host can remove members.');
  const target = s.members.find(m => m.id === req.params.memberId);
  if (!target) return errorResponse(res, 404, 'Member not found.');
  if (target.isHost) return errorResponse(res, 400, 'The host cannot be removed from the session.');
  s.members = s.members.filter(m => m.id !== target.id);
  presence.get(s.id)?.delete(target.id);
  for (const story of s.stories) story.votes = story.votes.filter(v => v.memberId !== target.id);
  persist(); emitSession(s); res.json(publicSession(s));
});
app.post('/api/sessions/:id/reaction', (req, res) => {
  const s = findSession(req.params.id.toUpperCase());
  if (!s) return errorResponse(res, 404, 'Session not found.');
  const sender = s.members.find(m => m.id === req.body?.memberId);
  const target = s.members.find(m => m.id === req.body?.targetId);
  const emoji = String(req.body?.emoji ?? '');
  if (!sender || !target) return errorResponse(res, 403, 'Invalid member.');
  if (!['😂','👍','💩','❤️','🔥','👏'].includes(emoji)) return errorResponse(res, 400, 'Invalid emoji.');
  io.to(s.id).emit('reaction', {
    id: randomUUID(), senderId: sender.id, senderName: sender.name,
    targetId: target.id, targetName: target.name, emoji, at: Date.now()
  });
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: false } });
io.on('connection', socket => {
  // Rời room hiện tại (nếu có) và báo cho các member còn lại.
  function leaveCurrent({ immediate = true } = {}) {
    const { sessionId, memberId } = socket.data;
    if (!sessionId) return;
    socket.data.sessionId = null; socket.data.memberId = null;
    socket.leave(sessionId);
    const finish = () => {
      pendingOffline.delete(`${sessionId}:${memberId}:${socket.id}`);
      const changed = memberId ? removePresence(sessionId, memberId, socket.id) : false;
      const s = findSession(sessionId);
      if (changed && s) emitSession(s);
    };
    if (immediate || !memberId) return finish();
    pendingOffline.set(`${sessionId}:${memberId}:${socket.id}`, setTimeout(finish, DISCONNECT_GRACE_MS));
  }

  socket.on('session:join', ({ sessionId, memberId } = {}) => {
    const id = String(sessionId ?? '').toUpperCase();
    const s = findSession(id);
    if (!s) return;
    const member = memberId ? s.members.find(m => m.id === String(memberId)) : null;
    if (socket.data.sessionId && (socket.data.sessionId !== id || socket.data.memberId !== member?.id)) leaveCurrent();
    socket.join(id);
    socket.data.sessionId = id;
    socket.data.memberId = member?.id ?? null;
    if (member) addPresence(id, member.id, socket.id);
    // Gửi cho tất cả (kể cả socket vừa vào) để mọi người thấy member mới online.
    emitSession(s);
  });
  socket.on('session:leave', () => leaveCurrent());
  socket.on('disconnect', () => leaveCurrent({ immediate: false }));
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Planning Poker server listening on http://localhost:${PORT}`));
