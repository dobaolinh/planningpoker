import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './styles.css';

const socket = io({ autoConnect: true });
const CARDS = ['0','1','2','3','5','8','13','21','34','55','89','?'];
const EMOJIS = ['😂','👍','💩','❤️','🔥','👏'];

// Biến thể animation cố định theo id reaction (không dùng :nth-child, vì khi emoji trước đó bị gỡ
// thì vị trí con đổi => animation-name đổi => hiệu ứng bị chạy lại lần nữa).
function impactVariant(id) {
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ['v0', 'v1', 'v2'][h % 3];
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// Bàn poker: member ngồi quanh bàn (bạn luôn ở dưới cùng), lá bài đặt trên mặt bàn trước chỗ ngồi.
function PokerTable({ session, story, memberId, isHost, reactions, median, onReact, onRemove, onReveal, onRevote }) {
  const members = session.members;
  const n = members.length;
  const meIdx = Math.max(0, members.findIndex(m => m.id === memberId));
  const pos = (i, rx, ry) => {
    const a = ((i - meIdx + n) % n) / n * 2 * Math.PI; // 0 = dưới cùng
    return { left: `${50 + rx * Math.sin(a)}%`, top: `${50 + ry * Math.cos(a)}%` };
  };
  const compact = n > 8;
  return <div className={`poker-table panel ${compact ? 'compact' : ''}`}>
    <div className="table-felt">
      <div className="table-center">
        <span className="table-label">{story.revealed ? 'MEDIAN' : `${(story.votes || []).length} / ${n} VOTED`}</span>
        {story.revealed ? <><strong className="table-point">{median ?? '—'}</strong>{isHost && <button className="primary-button reveal-button" onClick={onRevote}>Re-vote ↻</button>}</>
          : isHost ? <button className="primary-button reveal-button" onClick={onReveal}>Reveal ✦</button>
          : <span className="table-wait">◌ Waiting for host</span>}
      </div>
    </div>
    {members.map((m, i) => {
      const v = story.votes.find(x => x.memberId === m.id);
      const voted = !!v;
      return <React.Fragment key={m.id}>
        <div className="table-card-slot" style={pos(i, 27, 25)}>
          {voted ? <div className={`mini-card ${story.revealed ? 'face' : 'back'}`}>{story.revealed ? v.value : ''}</div> : <div className="mini-card empty"></div>}
        </div>
        <div className={`seat ${m.online ? '' : 'offline'}`} style={pos(i, 43, 43)}>
          <span className={`avatar avatar-${i % 5}`}><i className={`presence-dot ${m.online ? 'on' : ''}`}></i>{m.name.slice(0, 1).toUpperCase()}</span>
          <strong className="seat-name">{m.name}{m.id === memberId ? ' (you)' : ''}</strong>
          {m.isHost && <span className="host-badge">HOST</span>}
          <div className="reaction-menu">{EMOJIS.map(e => <button key={e} title={`Send ${e}`} onClick={() => onReact(m.id, e)}>{e}</button>)}
            {isHost && !m.isHost && <button className="seat-remove" title="Remove member" onClick={() => onRemove(m.id)}>×</button>}</div>
          <div className="member-reaction-overlay" aria-hidden="true">
            {reactions.filter(r => r.targetId === m.id).map(r => <span key={r.id} className={`member-impact-emoji ${impactVariant(r.id)}`}>{r.emoji}</span>)}
          </div>
        </div>
      </React.Fragment>;
    })}
  </div>;
}

function App() {
  const [page, setPage] = useState('home');
  const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [hostKey, setHostKey] = useState('');
  const [memberId, setMemberId] = useState('');
  const [displayName, setDisplayName] = useState(localStorage.getItem('pokerName') || '');
  const [layout, setLayout] = useState('grid');
  const [sessionName, setSessionName] = useState('Sprint Planning');
  const [storyText, setStoryText] = useState('US-101 | Login page\nUS-102 | Password reset\nUS-103 | User profile');
  const [sessionCode, setSessionCode] = useState('');
  const [selectedCard, setSelectedCard] = useState('');
  const [reactions, setReactions] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [addingStory, setAddingStory] = useState(false);
  const [newStoryText, setNewStoryText] = useState('');

  async function loadSessions() {
    try { setSessions(await api('/api/sessions')); } catch (e) { setError(e.message); }
  }
  useEffect(() => { loadSessions(); }, []);

  useEffect(() => {
    if (!session?.id) return;
    if (!memberId) return;
    const join = () => socket.emit('session:join', { sessionId: session.id, memberId });
    join(); // vào room + báo presence cho các member khác
    socket.on('connect', join); // tự join lại khi mất mạng / server restart
    const update = s => { if (s.id === session.id) setSession(s); };
    const reaction = r => {
      setReactions(old => old.some(x => x.id === r.id) ? old : [...old, r]);
      setTimeout(() => setReactions(old => old.filter(x => x.id !== r.id)), 2400);
    };
    socket.on('session:update', update);
    socket.on('reaction', reaction);
    return () => {
      socket.off('connect', join); socket.off('session:update', update); socket.off('reaction', reaction);
      socket.emit('session:leave');
    };
  }, [session?.id, memberId]);

  const currentStory = session?.stories?.[session.currentStoryIndex];
  const ownVote = currentStory?.votes?.find(v => v.memberId === memberId);
  const isHost = !!hostKey;
  // Điểm gợi ý do server tính (đã snap về dãy Fibonacci), không tự tính lại ở client.
  const median = currentStory?.revealed ? currentStory.point : null;
  const onlineIds = new Set((session?.members || []).filter(m => m.online).map(m => m.id));
  const onlineCount = onlineIds.size;
  const voteCount = (currentStory?.votes || []).filter(v => onlineIds.has(v.memberId)).length;
  // Online lên trước, offline xuống dưới (giữ thứ tự tham gia trong từng nhóm).
  const isTable = session?.layout === 'table';
  const sortedMembers = [...(session?.members || [])].sort((a, b) => Number(b.online) - Number(a.online));

  async function createSession(e) {
    e?.preventDefault(); setError('');
    const parsed = storyText.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const parts = line.split('|');
      return { id: (parts.shift() || '').trim(), name: parts.join('|').trim() };
    });
    setBusy(true);
    try {
      const data = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ name: sessionName, hostName: displayName, layout, stories: parsed }) });
      setSession(data.session); setHostKey(data.hostKey); setMemberId(data.hostMemberId);
      localStorage.setItem('pokerName', displayName); localStorage.setItem(`pokerHost:${data.session.id}`, data.hostKey);
      localStorage.setItem(`pokerMember:${data.session.id}`, data.hostMemberId);
      setPage('room');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function joinSession(id) {
    setError('');
    if (!displayName.trim()) return setError('Enter your display name before joining a session.');
    setBusy(true);
    try {
      const normalized = id.trim().toUpperCase();
      const existingMember = localStorage.getItem(`pokerMember:${normalized}`) || '';
      const data = await api(`/api/sessions/${normalized}/join`, { method: 'POST', body: JSON.stringify({ name: displayName, memberId: existingMember }) });
      setSession(data.session); setMemberId(data.memberId);
      setHostKey(localStorage.getItem(`pokerHost:${normalized}`) || '');
      localStorage.setItem('pokerName', displayName);
      localStorage.setItem(`pokerMember:${normalized}`, data.memberId);
      setSelectedCard(''); setPage('room');
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  async function doAction(path, body = {}) {
    setError('');
    try { await api(path, { method: 'POST', body: JSON.stringify(body) }); }
    catch (e) { setError(e.message); }
  }
  async function vote(value) {
    setSelectedCard(value);
    await doAction(`/api/sessions/${session.id}/vote`, { memberId, value });
  }
  async function reveal() {
    await doAction(`/api/sessions/${session.id}/reveal`, { hostKey });
  }
  async function revote() {
    setSelectedCard('');
    await doAction(`/api/sessions/${session.id}/revote`, { hostKey });
  }
  async function nextStory(index) {
    setSelectedCard('');
    await doAction(`/api/sessions/${session.id}/stories/${index}/next`, { hostKey });
  }
  async function addStories(e) {
    e.preventDefault(); setError('');
    const parsed = newStoryText.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
      const parts = line.split('|');
      return { id: (parts.shift() || '').trim(), name: parts.join('|').trim() };
    });
    try {
      await api(`/api/sessions/${session.id}/stories`, { method: 'POST', body: JSON.stringify({ hostKey, stories: parsed }) });
      setNewStoryText(''); setAddingStory(false);
    } catch (err) { setError(err.message); }
  }
  async function removeMember(id) {
    if (confirm('Remove this member from the session?')) await doAction(`/api/sessions/${session.id}/members/${id}/remove`, { hostKey });
  }
  async function sendReaction(targetId, emoji) {
    await doAction(`/api/sessions/${session.id}/reaction`, { memberId, targetId, emoji });
  }
  function leaveRoom() {
    setAddingStory(false); setNewStoryText(''); setPage('home'); setSession(null); setHostKey(''); setMemberId(''); setSelectedCard(''); setReactions([]); loadSessions();
  }

  return <div className="app-shell">
    <header className="topbar">
      <button className="brand" onClick={leaveRoom}><span className="brand-icon">♠</span><span>Planning<span className="brand-accent">Poker</span></span></button>
      <div className="top-actions"><span className="live-dot"></span><span>Realtime planning</span>{session && <span className="code-pill">ROOM {session.id}</span>}</div>
    </header>
    {error && <div className="toast-error"><span>{error}</span><button onClick={() => setError('')}>×</button></div>}
    {page === 'home' ? <main className="home">
      <section className="hero">
        <div className="eyebrow"><span className="eyebrow-dot"></span> AGILE TEAM TOOLKIT</div>
        <h1>Estimate together.<br/><span>Build better.</span></h1>
        <p className="hero-copy">Simple planning poker for your team. No account needed — pick a name, join a room and start estimating.</p>
        <div className="hero-stats"><div><strong>01</strong><span>Create a room</span></div><div><strong>02</strong><span>Vote privately</span></div><div><strong>03</strong><span>Reveal together</span></div></div>
      </section>
      <section className="home-grid">
        <div className="panel create-panel">
          <div className="panel-heading"><div><div className="step-label">HOST WORKSPACE</div><h2>Create a new session</h2></div><div className="panel-icon purple">＋</div></div>
          <form onSubmit={createSession}>
            <label>Your display name</label><input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="e.g. Linh" required maxLength={40}/>
            <label>Session name</label><input value={sessionName} onChange={e => setSessionName(e.target.value)} placeholder="Sprint 12 Planning" required maxLength={80}/>
            <label>Room layout <span className="label-hint">Fixed after creation</span></label>
            <div className="layout-picker" role="radiogroup">
              {[['grid','Grid','▦','Members listed in a panel'],['table','Poker table','◯','Members seated around a table']].map(([v,t,ic,d])=><button type="button" key={v} role="radio" aria-checked={layout===v} className={`layout-option ${layout===v?'active':''}`} onClick={()=>setLayout(v)}><span className="layout-ic">{ic}</span><span><strong>{t}</strong><small>{d}</small></span></button>)}
            </div>
            <label>User stories <span className="label-hint">One per line: ID | Name</span></label>
            <textarea className="story-input" value={storyText} onChange={e => setStoryText(e.target.value)} rows={5} placeholder={'US-101 | Login page\nUS-102 | Password reset'} required/>
            <div className="field-help">e.g. <code>US-101 | Login page</code></div>
            <button className="primary-button full" disabled={busy}>{busy ? 'Creating…' : 'Create planning room'} <span>↗</span></button>
          </form>
        </div>
        <div className="panel join-panel">
          <div className="panel-heading"><div><div className="step-label">JOIN YOUR TEAM</div><h2>Join a session</h2></div><div className="panel-icon green">↗</div></div>
          <form onSubmit={e => { e.preventDefault(); joinSession(sessionCode); }}>
            <label>Your display name</label><input value={displayName} onChange={e => setDisplayName(e.target.value)} placeholder="Enter your name" required maxLength={40}/>
            <label>Session code</label><div className="join-code-row"><input value={sessionCode} onChange={e => setSessionCode(e.target.value.toUpperCase())} placeholder="e.g. A1B2C3D4" required/><button className="primary-button" disabled={busy}>Join room</button></div>
          </form>
          <div className="divider-label"><span></span> OR PICK AN OPEN ROOM <span></span></div>
          <div className="session-list">
            {sessions.length === 0 ? <div className="empty-state"><span>◌</span><p>No sessions yet. Create the first room.</p></div> : sessions.map(s => <button className="session-item" key={s.id} onClick={() => { setSessionCode(s.id); joinSession(s.id); }}>
              <span className="session-item-icon">♧</span><span className="session-item-info"><strong>{s.name}</strong><small>{s.storyCount} stories · {s.memberCount} members</small></span><span className="session-item-arrow">↗</span>
            </button>)}
          </div>
          <button className="text-button" onClick={loadSessions}>↻ Refresh list</button>
        </div>
      </section>
      <footer className="home-footer"><span>BUILT FOR BETTER SPRINTS</span><span>Fibonacci sequence · Team collaboration</span><span>Created by <a href="mailto:dobaolinh@gmail.com">dobaolinh@gmail.com</a></span></footer>
    </main> : <main className="room">
      {!session ? <div className="panel">Loading session…</div> : <>
        <div className="room-header">
          <div><button className="back-link" onClick={leaveRoom}>← All sessions</button><div className="room-title-row"><h1>{session.name}</h1><span className="room-code">{session.id}</span></div><p className="muted">Planning room · {session.stories.length} user stories</p></div>
          <div className="room-header-right"><div className="avatar-stack">{sortedMembers.slice(0,4).map((m,i)=><span key={m.id} className={`avatar avatar-${i%5}`} title={m.name}>{m.name.slice(0,1).toUpperCase()}</span>)}{sortedMembers.length>4&&<span className="avatar extra">+{session.members.length-4}</span>}</div><span className="member-count">{onlineCount} online</span></div>
        </div>
        <div className={`room-layout ${isTable ? 'table-mode' : ''}`}>
          <aside className="sidebar panel">
            <div className="sidebar-title"><span>USER STORIES</span><span className="count-badge">{session.stories.length}</span></div>
            <div className="story-list">{session.stories.map((story,i)=><button key={story.id} onClick={() => isHost ? nextStory(i) : setError('Only the host can switch user stories.')} className={`story-row ${i===session.currentStoryIndex?'active':''} ${story.revealed?'done':''}`}>
              <span className="story-number">{String(i+1).padStart(2,'0')}</span><span className="story-copy"><strong>{story.id}</strong><small>{story.name}</small></span>{story.revealed?<span className="story-point">{story.point ?? '—'}</span>:i===session.currentStoryIndex?<span className="current-dot"></span>:null}
            </button>)}</div>
            {isHost && (addingStory
              ? <form className="add-story-form" onSubmit={addStories}>
                  <textarea className="story-input" rows={3} autoFocus value={newStoryText} onChange={e => setNewStoryText(e.target.value)} placeholder={'US-104 | Notifications\nUS-105 | Search'} required/>
                  <small>One story per line: <code>ID | Name</code></small>
                  <div className="add-story-actions"><button type="button" className="text-button" onClick={() => { setAddingStory(false); setNewStoryText(''); }}>Cancel</button><button type="submit" className="primary-button">Add</button></div>
                </form>
              : <button className="add-story-btn" onClick={() => setAddingStory(true)}>+ Add user story</button>)}
            <div className="sidebar-bottom"><div className="lock-icon">⌁</div><div><strong>Private voting</strong><small>Votes are shown only after reveal</small></div></div>
          </aside>
          <section className="main-board">
            {currentStory ? <>
              <div className="story-focus panel">
                <div className="story-focus-top"><span className="eyebrow small">CURRENT STORY · {session.currentStoryIndex+1} OF {session.stories.length}</span><span className={`status-tag ${currentStory.revealed?'revealed':''}`}><span></span>{currentStory.revealed?'REVEALED':'VOTING IN PROGRESS'}</span></div>
                <div className="story-focus-content"><div><span className="story-id">{currentStory.id}</span><h2>{currentStory.name}</h2></div><div className="big-point">{currentStory.revealed && currentStory.point !== null ? currentStory.point : <span>?</span>}<small>STORY POINTS</small></div></div>
                <div className="vote-progress"><div className="progress-track"><span style={{width: `${onlineCount ? Math.min(100, voteCount/onlineCount*100) : 0}%`}}></span></div><span>{voteCount} / {onlineCount} voted</span></div>
              </div>
              {isTable && <PokerTable session={session} story={currentStory} memberId={memberId} isHost={isHost} reactions={reactions} median={median} onReact={sendReaction} onRemove={removeMember} onReveal={reveal} onRevote={revote} />}
              <div className="panel voting-panel">
                <div className="section-heading"><div><h3>Choose your estimate</h3><p>Select a card that represents the effort and complexity.</p></div><span className="fib-tag">FIBONACCI DECK</span></div>
                <div className="cards-grid">{CARDS.map(value=><button key={value} disabled={currentStory.revealed} onClick={() => vote(value)} className={`poker-card ${ownVote?.value===value?'selected':''} ${value==='?'?'unknown':''}`}><span>{value}</span><small>{value==='?'?'UNSURE':'POINTS'}</small></button>)}</div>
                <div className="vote-footer"><span>{currentStory.revealed ? 'Votes revealed.' : ownVote ? <>Your vote: <strong>{ownVote.value}</strong> · You can change it before reveal.</> : 'Your vote stays hidden until the host reveals.'}</span>{isHost ? (currentStory.revealed ? <button className="primary-button reveal-button" onClick={revote}>Re-vote <span>↻</span></button> : <button className="primary-button reveal-button" onClick={reveal}>Reveal cards <span>✦</span></button>) : <span className="waiting-label">◌ Waiting for host to reveal</span>}</div>
              </div>
              {currentStory.revealed && !isTable && <div className="panel results-panel"><div className="section-heading"><div><h3>Round results</h3><p>All submitted votes are now visible.</p></div><span className="result-median">Median <strong>{median ?? '—'}</strong></span></div>
                <div className="results-grid">{session.members.map(m=>{const v=currentStory.votes.find(x=>x.memberId===m.id);return <div className="result-person" key={m.id}><span className="avatar avatar-1">{m.name.slice(0,1).toUpperCase()}</span><span className="result-name">{m.name}</span><strong className="result-vote">{v?.value ?? '—'}</strong></div>})}</div>
                <div className="result-note">Suggested point is the median of numeric votes, snapped to the nearest Fibonacci card (ties round up). “?” votes are excluded.</div>
              </div>}
            </> : <div className="panel">This session has no user stories yet.</div>}
          </section>
          {!isTable && <aside className="members-panel panel">
            <div className="sidebar-title"><span>TEAM MEMBERS</span><span className="count-badge">{onlineCount}/{session.members.length}</span></div>
            <p className="members-hint">Hover a name to send a reaction 👀</p>
            <div className="members-list">{sortedMembers.map((m,i)=><div className={`member-row ${m.online?'':'offline'}`} key={m.id}>
              <span className={`avatar avatar-${i%5}`}><i className={`presence-dot ${m.online?'on':''}`}></i>{m.name.slice(0,1).toUpperCase()}</span>
              <div className="member-name-wrap" id={`member-${m.id}`}>
                <strong className="member-name-label">{m.name}{m.id===memberId?' (you)':''}</strong>
                <small>{m.isHost?'Session host':'Team member'}{m.online?'':' · offline'}</small>
                <div className="reaction-menu">{EMOJIS.map(emoji=><button key={emoji} title={`Send ${emoji}`} onClick={()=>sendReaction(m.id,emoji)}>{emoji}</button>)}</div>
                <div className="member-reaction-overlay" aria-hidden="true">
                  {reactions.filter(r => r.targetId === m.id).map(r => <span key={r.id} className={`member-impact-emoji ${impactVariant(r.id)}`}>{r.emoji}</span>)}
                </div>
              </div>
              {m.isHost?<span className="host-badge">HOST</span>:isHost?<button className="remove-member" title="Remove member" onClick={()=>removeMember(m.id)}>×</button>:null}
            </div>)}</div>
            <div className="member-footer"><span className="live-dot"></span> Live updates enabled</div>
          </aside>}
        </div>
      </>}
    </main>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
