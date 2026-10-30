# Team Planning Poker

Planning Poker realtime web app: React + Vite + Express + Socket.IO. No user accounts required.

## Requirements
- Node.js 20 LTS or newer
- npm

## Run locally
1. Extract the ZIP.
2. Open a terminal in the project folder.
3. Install packages:
   ```bash
   npm install
   ```
4. Start frontend and backend:
   ```bash
   npm run dev
   ```
5. Open http://localhost:5173

The server runs at http://localhost:3001. Session data is stored in `server/data/sessions.json`.

## How to test with multiple members
- Open the app in multiple browser tabs or a private/incognito window.
- Create a session in one tab.
- Copy the room code and use it in the other tab.
- Vote from multiple tabs, then click Reveal from the host tab.
- Hover over a member and click an emoji to test reactions.

## Story input format
One story per line:
```
US-101 | Login page
US-102 | Password reset
US-103 | User profile
```
IDs must be unique within the session.

## Current behavior
- Votes are hidden until the host reveals the current story.
- The host may reveal even if some members have not voted.
- After reveal, numeric votes are summarized using the median, then snapped to the nearest Fibonacci card (ties round up), so the result is always a valid card. `?` votes are excluded.
- The host can move between stories and remove other members.
- Session and vote data persist in a local JSON file.
- Reactions are broadcast live and disappear after a short time.

## Important limitations before public deployment
This is a prototype for local testing. It does not have accounts or strong identity verification. A user who knows a room code can join under a chosen display name. The host key is stored in that browser's localStorage; clearing browser data can remove host access. Anyone with direct access to the server/data file can inspect stored votes.
For internet deployment, add rate limits, stronger host recovery, session expiration/deletion, input validation hardening, and HTTPS. Run the server behind a host that supports WebSockets. Do not use this prototype for sensitive/private meetings without reviewing its security.


Build Command : npm ci --include=dev && npm run build
Start Command : npm start
Health Check Path : /api/health
Environment Variables: NODE_ENV = production
