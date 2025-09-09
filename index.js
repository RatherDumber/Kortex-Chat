const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');

const DATA_FILE = path.join(__dirname, 'data.json');
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-dev-key';
const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use('/', express.static(path.join(__dirname, 'src')));
app.use(bodyParser.json());

// Ensure data file exists
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [], chats: [], contactRequests: [] }, null, 2));
}

// Load into memory
let data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

// Debounced save to disk
let saveTimeout = null;
function saveDataDebounced() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Failed to save data.json', err);
    }
    saveTimeout = null;
  }, 200);
}

// Auth helpers
function createToken(user) {
  const payload = { id: user.id, username: user.username };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
function authMiddleware(req, res, next) {
  const token = req.headers.authorization && req.headers.authorization.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Utilities
function findUserByUsername(username) {
  return data.users.find(u => u.username === username);
}
function findUserById(id) {
  return data.users.find(u => u.id === id);
}
function findUserByContactNumber(contactNumber) {
  return data.users.find(u => u.contactNumber === contactNumber);
}
function generateContactNumber() {
  let n;
  do {
    n = 'C-' + Math.floor(100000 + Math.random() * 900000).toString();
  } while (data.users.find(u => u.contactNumber === n));
  return n;
}
function findOrCreateDirectChat(userA, userB) {
  let chat = data.chats.find(c => c.type === 'direct' &&
    c.participants.includes(userA) && c.participants.includes(userB));
  if (!chat) {
    chat = {
      id: 'chat-' + uuidv4(),
      type: 'direct',
      participants: [userA, userB],
      messages: [],
      updatedAt: Date.now()
    };
    data.chats.push(chat);
    saveDataDebounced();
  }
  return chat;
}
function findOrCreateInbox(username) {
  let chat = data.chats.find(c => c.type === 'inbox' && c.participants.length === 1 && c.participants[0] === username);
  if (!chat) {
    chat = {
      id: 'inbox-' + username,
      type: 'inbox',
      participants: [username],
      messages: [],
      updatedAt: Date.now()
    };
    data.chats.push(chat);
    saveDataDebounced();
  }
  return chat;
}

// Add helper to compute contacts for a username
function getContactsForUser(username) {
  const contactsSet = new Set();

  // From direct chats: other participant(s)
  data.chats.filter(c => c.type === 'direct' && c.participants.includes(username)).forEach(c => {
    c.participants.forEach(p => {
      if (p !== username) contactsSet.add(p);
    });
  });

  // From accepted contact requests (either direction)
  data.contactRequests.filter(r => r.status === 'accepted' && (r.from === username || r.to === username)).forEach(r => {
    if (r.from !== username) contactsSet.add(r.from);
    if (r.to !== username) contactsSet.add(r.to);
  });

  // Map to user objects (username, id, contactNumber) - ignore missing users
  const contacts = Array.from(contactsSet).map(un => {
    const u = data.users.find(x => x.username === un);
    return u ? { id: u.id, username: u.username, contactNumber: u.contactNumber } : { username: un };
  });

  return contacts;
}

// API

// Register (assigns contact number and creates inbox)
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  if (findUserByUsername(username)) return res.status(409).json({ error: 'username taken' });

  const id = 'user-' + uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);
  const now = Date.now();
  const contactNumber = generateContactNumber();

  const user = { id, username, passwordHash, contactNumber, createdAt: now, lastSeen: now };
  data.users.push(user);
  // Create inbox
  findOrCreateInbox(username);
  saveDataDebounced();

  const token = createToken(user);
  res.json({ token, user: { id: user.id, username: user.username, createdAt: user.createdAt, contactNumber: user.contactNumber } });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = findUserByUsername(username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  user.lastSeen = Date.now();
  saveDataDebounced();
  const token = createToken(user);
  res.json({ token, user: { id: user.id, username: user.username, createdAt: user.createdAt, contactNumber: user.contactNumber } });
});

app.get('/api/me', authMiddleware, (req, res) => {
  const user = findUserById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, username: user.username, createdAt: user.createdAt, lastSeen: user.lastSeen, contactNumber: user.contactNumber });
});

app.get('/api/users', authMiddleware, (req, res) => {
  const users = data.users.map(u => ({ id: u.id, username: u.username, contactNumber: u.contactNumber }));
  res.json(users);
});

// Get chats for current user (lightweight)
app.get('/api/chats', authMiddleware, (req, res) => {
  const username = req.user.username;
  const chats = data.chats
    .filter(c => c.participants.includes(username))
    .map(c => ({
      id: c.id,
      type: c.type,
      participants: c.participants,
      lastMessage: c.messages.length ? c.messages[c.messages.length - 1] : null,
      updatedAt: c.updatedAt
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  res.json(chats);
});

// Create/get direct chat (resolve username or contact number)
app.post('/api/chats/direct', authMiddleware, (req, res) => {
  const { withUser } = req.body;
  if (!withUser) return res.status(400).json({ error: 'withUser required' });
  const username = req.user.username;
  // Resolve by username or contactNumber
  let targetUser = findUserByUsername(withUser);
  if (!targetUser && /^C-\d{6}$/.test(withUser)) {
    targetUser = findUserByContactNumber(withUser);
  }
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const chat = findOrCreateDirectChat(username, targetUser.username);
  res.json(chat);
});

// Get messages (paginated)
app.get('/api/chats/:chatId/messages', authMiddleware, (req, res) => {
  const { chatId } = req.params;
  const limit = Math.min(200, parseInt(req.query.limit || '50', 10));
  const before = parseInt(req.query.before || '0', 10);
  const username = req.user.username;

  const chat = data.chats.find(c => c.id === chatId && c.participants.includes(username));
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  let messages = chat.messages.slice();
  if (before) messages = messages.filter(m => m.timestamp < before);
  messages = messages.slice(-limit);
  res.json(messages);
});

// Post message
app.post('/api/chats/:chatId/messages', authMiddleware, (req, res) => {
  const { chatId } = req.params;
  const { text } = req.body;
  const username = req.user.username;
  if (!text) return res.status(400).json({ error: 'text required' });

  const chat = data.chats.find(c => c.id === chatId && c.participants.includes(username));
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const message = {
    id: 'm-' + uuidv4(),
    sender: username,
    text,
    timestamp: Date.now(),
    meta: {}
  };
  chat.messages.push(message);
  chat.updatedAt = Date.now();
  saveDataDebounced();

  // emit to participants (socket rooms)
  io.to(chat.id).emit('new_message', { chatId: chat.id, message });
  res.json(message);
});

// CONTACT REQUESTS
app.post('/api/contacts/request', authMiddleware, (req, res) => {
  const from = req.user.username;
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'to required' });
  // prevent sending to self either by username or contact number
  if (to === from) return res.status(400).json({ error: 'Cannot send request to yourself' });
  let targetUser = findUserByUsername(to);
  if (!targetUser && /^C-\d{6}$/.test(to)) {
    targetUser = findUserByContactNumber(to);
  }
  if (!targetUser) return res.status(404).json({ error: 'User not found' });

  const toUsername = targetUser.username;
  if (toUsername === from) return res.status(400).json({ error: 'Cannot send request to yourself' });

  // Prevent duplicates
  const existing = data.contactRequests.find(r => r.from === from && r.to === toUsername && r.status === 'pending');
  if (existing) return res.status(409).json({ error: 'Request already pending' });

  const request = {
    id: 'req-' + uuidv4(),
    from,
    to: toUsername,
    status: 'pending',
    timestamp: Date.now()
  };
  data.contactRequests.push(request);

  // Create inbox system message for recipient with meta linking to request
  const inbox = findOrCreateInbox(toUsername);
  const sysMessage = {
    id: 'm-' + uuidv4(),
    sender: 'system',
    text: `${from} sent you a contact request.`,
    timestamp: Date.now(),
    meta: { requestId: request.id, type: 'contact_request', from }
  };
  inbox.messages.push(sysMessage);
  inbox.updatedAt = Date.now();
  saveDataDebounced();

  // notify via socket room
  io.to(inbox.id).emit('new_message', { chatId: inbox.id, message: sysMessage });

  res.json({ ok: true, request });
});

app.post('/api/contacts/respond', authMiddleware, (req, res) => {
  const username = req.user.username;
  const { requestId, action } = req.body;
  if (!requestId || !action) return res.status(400).json({ error: 'requestId and action required' });
  const request = data.contactRequests.find(r => r.id === requestId);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.to !== username) return res.status(403).json({ error: 'Not authorized to respond' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already handled' });

  if (action === 'accept') {
    request.status = 'accepted';
    request.resolvedAt = Date.now();

    const direct = findOrCreateDirectChat(request.from, request.to);

    // notify both via inbox
    const inboxTo = findOrCreateInbox(request.to);
    const inboxFrom = findOrCreateInbox(request.from);
    const mTo = {
      id: 'm-' + uuidv4(),
      sender: 'system',
      text: `You accepted ${request.from}'s contact request. A chat has been created.`,
      timestamp: Date.now(),
      meta: { type: 'contact_accepted', requestId: request.id }
    };
    const mFrom = {
      id: 'm-' + uuidv4(),
      sender: 'system',
      text: `${request.to} accepted your contact request. You can now chat.`,
      timestamp: Date.now(),
      meta: { type: 'contact_accepted', requestId: request.id }
    };
    inboxTo.messages.push(mTo);
    inboxTo.updatedAt = Date.now();
    inboxFrom.messages.push(mFrom);
    inboxFrom.updatedAt = Date.now();

    saveDataDebounced();

    io.to(inboxTo.id).emit('new_message', { chatId: inboxTo.id, message: mTo });
    io.to(inboxFrom.id).emit('new_message', { chatId: inboxFrom.id, message: mFrom });

    io.emit('chat_created', { chat: direct });
    return res.json({ ok: true, status: 'accepted', chat: direct });
  } else if (action === 'decline') {
    request.status = 'declined';
    request.resolvedAt = Date.now();

    const inboxFrom = findOrCreateInbox(request.from);
    const mFrom = {
      id: 'm-' + uuidv4(),
      sender: 'system',
      text: `${request.to} declined your contact request.`,
      timestamp: Date.now(),
      meta: { type: 'contact_declined', requestId: request.id }
    };
    inboxFrom.messages.push(mFrom);
    inboxFrom.updatedAt = Date.now();

    saveDataDebounced();

    io.to(inboxFrom.id).emit('new_message', { chatId: inboxFrom.id, message: mFrom });

    return res.json({ ok: true, status: 'declined' });
  } else {
    return res.status(400).json({ error: 'Unknown action' });
  }
});

// New endpoint: list only contacts for the authenticated user
app.get('/api/contacts', authMiddleware, (req, res) => {
  const username = req.user.username;
  const contacts = getContactsForUser(username);
  res.json(contacts);
});

// Chat endpoint
app.post('/chat', (req, res) => {
  const messages = req.body.messages;
  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }
  const py = spawn('python3', [path.join(__dirname, 'ai.py')]);
  let aiResponse = '';
  py.stdin.write(JSON.stringify(messages));
  py.stdin.end();
  py.stdout.on('data', (data) => {
    aiResponse += data.toString();
  });
  py.stderr.on('data', (data) => {
    console.error('AI stderr:', data.toString());
  });
  py.on('close', (code) => {
    res.json({ response: aiResponse.trim() });
  });
});

// Chat history endpoints
const dataPath = path.join(__dirname, 'data.json');

app.get('/history', (req, res) => {
  fs.readFile(dataPath, 'utf8', (err, data) => {
    if (err) return res.json([]);
    try {
      res.json(JSON.parse(data));
    } catch {
      res.json([]);
    }
  });
});

app.put('/history', (req, res) => {
  fs.writeFile(dataPath, JSON.stringify(req.body, null, 2), err => {
    if (err) return res.status(500).json({ error: 'Failed to save history' });
    res.json({ status: 'ok' });
  });
});

// Socket auth
io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.user = payload;
    return next();
  } catch (err) {
    return next(new Error('Authentication error'));
  }
});

io.on('connection', (socket) => {
  const username = socket.user.username;
  // join all chat rooms that this user participates in
  const userChats = data.chats.filter(c => c.participants.includes(username));
  userChats.forEach(c => socket.join(c.id));

  socket.emit('connected', { username });

  socket.on('send_message', (payload) => {
    const { chatId, text } = payload || {};
    if (!chatId || !text) return;

    const chat = data.chats.find(c => c.id === chatId && c.participants.includes(username));
    if (!chat) return;

    const message = {
      id: 'm-' + uuidv4(),
      sender: username,
      text,
      timestamp: Date.now(),
      meta: {}
    };
    chat.messages.push(message);
    chat.updatedAt = Date.now();
    saveDataDebounced();

    io.to(chat.id).emit('new_message', { chatId: chat.id, message });
  });

  socket.on('typing', ({ chatId, typing }) => {
    socket.to(chatId).emit('typing', { chatId, username, typing });
  });

  socket.on('disconnect', () => {
    const user = findUserByUsername(username);
    if (user) {
      user.lastSeen = Date.now();
      saveDataDebounced();
    }
  });
});

// Example in-memory user store (replace with DB in production)
const users = {};

// Signup endpoint
app.post('/signup', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (users[username]) {
    return res.status(409).json({ error: 'User already exists' });
  }
  users[username] = {
    username,
    password, // In production, hash this!
    'ai-chats': [] // Store this user's AI chat history
  };
  res.json({ status: 'ok', user: { username } });
});

server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
