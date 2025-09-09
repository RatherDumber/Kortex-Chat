# Kortex-inspired Real-time Chat (Dark UI)

A real-time chat application with a sleek dark UI inspired by Kortex.co. Built with Node.js + Express backend and a vanilla JS frontend (served from `src/`). Real-time messaging is powered by Socket.IO and data is persisted to a local JSON file (`data.json`).

Highlights
- Dark, modern, and responsive UI with a collapsible sidebar (Chats, Inbox, Contacts, Settings).
- Username/password registration (no email required).
- On registration each user receives a persistent contact number (e.g. `C-123456`) — share this to let others add you.
- Contact requests: send a request by username or contact number. Recipient gets an actionable system message with Accept/Decline buttons in their Inbox.
- Real-time messaging via Socket.IO. In-memory caching and batched writes to disk for efficiency.

### notice
This is still being programmed so you might see traces of programming in the backup file, most of it was testing. Ok but the one with brr brr patapim i got a little too dosed off. So, just chillout.

The admin_tool.py is still in work meaning it's not done yet, wait a little and everything will be fixed in a matter of time.

Quick start
1. Install dependencies:
   npm install

2. Start the server:
   npm start

3. Open your browser to:
   http://localhost:3000/

Notes
- This uses a JSON file for storage. For production, migrate to a DB and secure JWT secrets with env vars.
