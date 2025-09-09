/*
  src/js/app.js

  Optimistic-send revamp:
  - optimistic messages get data-temp-id and data-temp-ts
  - when server message arrives, attempt to find and upgrade the optimistic node
  - ensure cache + DOM avoid duplicates
*/

(async function () {
  const API = {
    register: (u, p) => fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    }).then(r => r.json()),
    login: (u, p) => fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    }).then(r => r.json()),
    me: (token) => fetch('/api/me', { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.json()),
    users: (token) => fetch('/api/users', { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.json()),
    contacts: (token) => fetch('/api/contacts', { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.json()),

    getChats: (token) => fetch('/api/chats', { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.json()),
    createDirect: (token, withUser) => fetch('/api/chats/direct', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ withUser })
    }).then(r => r.json()),
    getMessages: (token, chatId, limit = 200, before = 0) => fetch(`/api/chats/${chatId}/messages?limit=${limit}&before=${before}`, { headers: { 'Authorization': 'Bearer ' + token } }).then(r => r.json()),
    postMessage: (token, chatId, text) => fetch(`/api/chats/${chatId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    }).then(r => r.json()),
    sendContactRequest: (token, to) => fetch('/api/contacts/request', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to })
    }).then(r => r.json()),
    respondContactRequest: (token, requestId, action) => fetch('/api/contacts/respond', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId, action })
    }).then(r => r.json())
  };

  // State
  let token = localStorage.getItem('token') || null;
  let currentUser = null;
  let socket = null;
  let chats = [];
  let currentChat = null;
  let messagesCache = {}; // chatId => [messages]

  // Elements
  const authModal = document.getElementById('authModal');
  const authForm = document.getElementById('authForm');
  const authTitle = document.getElementById('authTitle');
  const toggleAuthModeBtn = document.getElementById('toggleAuthMode');
  const authError = document.getElementById('authError');

  const usernameInput = document.getElementById('authUsername');
  const passwordInput = document.getElementById('authPassword');

  const chatListEl = document.getElementById('chatList');
  const inboxListEl = document.getElementById('inboxList');
  const contactListEl = document.getElementById('contactList');
  const currentChatTitle = document.getElementById('currentChatTitle');
  const messagesEl = document.getElementById('messages');
  const messageForm = document.getElementById('messageForm');
  const messageInput = document.getElementById('messageInput');
  const userStatus = document.getElementById('userStatus');

  const toggleSidebarBtn = document.getElementById('toggleSidebar');
  const sidebar = document.getElementById('sidebar');

  const logoutBtn = document.getElementById('logoutBtn');

  const contactUsernameInput = document.getElementById('contactUsername');
  const sendRequestBtn = document.getElementById('sendRequestBtn');
  const requestStatus = document.getElementById('requestStatus');

  const meNameEl = document.getElementById('meName');
  const meContactEl = document.getElementById('meContact');
  const meAvatarEl = document.getElementById('meAvatar');
  const copyContactBtn = document.getElementById('copyContactBtn');

  // AI Floating Widget Elements
  const aiWidgetBtn = document.getElementById('ai-widget-btn');
  const aiWidgetChat = document.getElementById('ai-widget-chat');
  const aiWidgetClose = document.getElementById('ai-widget-close');
  const aiWidgetHistory = document.getElementById('ai-widget-history');
  const aiWidgetInput = document.getElementById('ai-widget-input');
  const aiWidgetSend = document.getElementById('ai-widget-send');
  let aiWidgetData = [];

  // Helpers
  function safeAddListener(el, ev, fn) { if (el) el.addEventListener(ev, fn); }
  function normalize(s) { return String(s || '').trim().toLowerCase(); }

  function isMessageMine(msg) {
    if (!currentUser || !msg) return false;
    if (msg.sender && normalize(msg.sender) === normalize(currentUser.username)) return true;
    if (msg.senderId && currentUser.id && normalize(msg.senderId) === normalize(currentUser.id)) return true;
    if (msg.meta && msg.meta.from && normalize(msg.meta.from) === normalize(currentUser.username)) return true;
    return false;
  }

  function domHasMessageId(id) {
    if (!messagesEl || !id) return false;
    return !!messagesEl.querySelector(`[data-msg-id="${id}"]`);
  }

  // Find optimistic match: last '.msg.me' without data-msg-id and matching text + timestamp proximity
  function findOptimisticMatch(serverMessage) {
    if (!messagesEl || !serverMessage) return null;
    const candidates = Array.from(messagesEl.querySelectorAll('.msg.me')).filter(el => !el.getAttribute('data-msg-id'));
    for (let i = candidates.length - 1; i >= 0; i--) {
      const el = candidates[i];
      const txt = el.querySelector('.text') ? el.querySelector('.text').textContent : '';
      const tempTs = el.dataset.tempTs ? parseInt(el.dataset.tempTs, 10) : null;
      if (txt && txt.trim() === (serverMessage.text || '').trim()) {
        if (!tempTs) return el; // no timestamp recorded — assume match
        // match if within 7s
        if (Math.abs((serverMessage.timestamp || 0) - tempTs) <= 7000) return el;
      }
    }
    return null;
  }

  function upgradeOptimisticElement(el, serverMsg) {
    if (!el || !serverMsg) return;
    el.setAttribute('data-msg-id', serverMsg.id);
    el.removeAttribute('data-temp-id');
    if (el.dataset.tempTs) delete el.dataset.tempTs;
    const meta = el.querySelector('.meta');
    if (meta) meta.textContent = `${serverMsg.sender} • ${new Date(serverMsg.timestamp).toLocaleTimeString()}`;
    const text = el.querySelector('.text');
    if (text) text.textContent = serverMsg.text || '';
  }

  // Append message to DOM; for local optimistic messages set data-temp-id + data-temp-ts
  function appendMessage(msg, isLocal = false) {
    if (!messagesEl || !msg) return;
    if (msg.id && domHasMessageId(msg.id)) return; // already present

    const el = document.createElement('div');
    el.className = 'msg' + (isMessageMine(msg) ? ' me' : '');
    if (isLocal) {
      // use a predictable temp id for matching later
      const tempId = msg.id || ('temp-' + Date.now() + '-' + Math.random().toString(36).slice(2,7));
      el.setAttribute('data-temp-id', tempId);
      el.dataset.tempTs = msg.timestamp || Date.now();
    } else if (msg.id) {
      el.setAttribute('data-msg-id', msg.id);
    }

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = `${msg.sender} • ${new Date(msg.timestamp).toLocaleTimeString()}`;

    const text = document.createElement('div');
    text.className = 'text';
    text.textContent = msg.text || '';

    el.appendChild(meta);
    el.appendChild(text);

    // contact-request actions (system)
    if (msg.meta && msg.meta.type === 'contact_request' && msg.meta.requestId) {
      const actions = document.createElement('div');
      actions.className = 'actions';
      // only show to recipient
      if (currentUser && msg.meta.from && normalize(msg.meta.from) !== normalize(currentUser.username)) {
        const acceptBtn = document.createElement('button');
        acceptBtn.className = 'btn primary';
        acceptBtn.textContent = 'Accept';
        const declineBtn = document.createElement('button');
        declineBtn.className = 'btn ghost';
        declineBtn.textContent = 'Decline';
        let done = false;
        acceptBtn.addEventListener('click', async () => {
          if (done) return; done = true;
          acceptBtn.disabled = declineBtn.disabled = true;
          acceptBtn.textContent = 'Accepting...';
          try {
            const res = await API.respondContactRequest(token, msg.meta.requestId, 'accept');
            if (res.error) {
              const note = document.createElement('div'); note.className = 'small muted'; note.textContent = res.error || 'Error';
              actions.appendChild(note);
            } else {
              acceptBtn.textContent = 'Accepted';
              declineBtn.style.display = 'none';
              await refreshChats();
            }
          } catch (err) { console.error(err); }
        });

        declineBtn.addEventListener('click', async () => {
          if (done) return; done = true;
          acceptBtn.disabled = declineBtn.disabled = true;
          declineBtn.textContent = 'Declining...';
          try {
            const res = await API.respondContactRequest(token, msg.meta.requestId, 'decline');
            if (res.error) {
              const note = document.createElement('div'); note.className = 'small muted'; note.textContent = res.error || 'Error';
              actions.appendChild(note);
            } else {
              declineBtn.textContent = 'Declined';
              acceptBtn.style.display = 'none';
              await refreshChats();
            }
          } catch (err) { console.error(err); }
        });

        actions.appendChild(acceptBtn);
        actions.appendChild(declineBtn);
        el.appendChild(actions);
      }
    }

    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Handle incoming server message: update cache and upgrade optimistic or append if needed
  function handleServerMessage(chatId, message) {
    if (!message) return;
    messagesCache[chatId] = messagesCache[chatId] || [];

    // avoid adding duplicates to cache
    if (!messagesCache[chatId].some(m => m.id === message.id)) {
      messagesCache[chatId].push(message);
    }

    // If viewing the chat
    if (currentChat && currentChat.id === chatId && messagesEl) {
      // if already present in DOM by data-msg-id, skip
      if (domHasMessageId(message.id)) return;

      // try find optimistic match and upgrade
      const match = findOptimisticMatch(message);
      if (match) {
        upgradeOptimisticElement(match, message);
        // refresh chat list preview
        refreshChats().catch(() => {});
        return;
      }

      // otherwise append normally
      appendMessage(message, false);
      refreshChats().catch(() => {});
    } else {
      // Not viewing the chat: refresh lists so previews/unread counters update
      refreshChats().catch(() => {});
    }
  }

  // Tab switching (no side-effects)
  document.querySelectorAll('.tab').forEach(btn => {
    safeAddListener(btn, 'click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.getAttribute('data-tab');
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      const panel = document.getElementById('panel-' + tab);
      if (panel) panel.classList.add('active');
    });
  });

  // Sidebar toggle
  if (toggleSidebarBtn && sidebar) {
    toggleSidebarBtn.addEventListener('click', () => {
      sidebar.classList.toggle('collapsed');
      toggleSidebarBtn.textContent = sidebar.classList.contains('collapsed') ? '☰' : '≡';
    });
  }

  // Auth mode toggle
  let mode = 'login';
  safeAddListener(toggleAuthModeBtn, 'click', () => {
    mode = mode === 'login' ? 'register' : 'login';
    if (authTitle) authTitle.textContent = mode === 'login' ? 'Sign in' : 'Create account';
    const submit = document.getElementById('authSubmit');
    if (submit) submit.textContent = mode === 'login' ? 'Sign in' : 'Create';
    if (authError) authError.textContent = '';
  });

  // Auth submit
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (authError) authError.textContent = '';
      const u = (usernameInput && usernameInput.value || '').trim();
      const p = (passwordInput && passwordInput.value || '').trim();
      if (!u || !p) { if (authError) authError.textContent = 'Please fill fields'; return; }
      try {
        const res = mode === 'login' ? await API.login(u, p) : await API.register(u, p);
        if (res.error) {
          if (authError) authError.textContent = res.error;
          return;
        }
        token = res.token;
        localStorage.setItem('token', token);

        // reset state
        messagesCache = {};
        currentChat = null;
        await boot();

        if (authModal) authModal.style.display = 'none';
        if (mode === 'register' && res.user && res.user.contactNumber) {
          alert(`Welcome ${res.user.username}!\nYour contact number: ${res.user.contactNumber}`);
        }
      } catch (err) {
        console.error(err);
        if (authError) authError.textContent = 'Network error';
      }
    });
  }

  // Logout
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      localStorage.removeItem('token');
      token = null;
      currentUser = null;
      messagesCache = {};
      chats = [];
      currentChat = null;
      if (chatListEl) chatListEl.innerHTML = '';
      if (contactListEl) contactListEl.innerHTML = '';
      if (inboxListEl) inboxListEl.innerHTML = '';
      if (messagesEl) messagesEl.innerHTML = '<div class="placeholder">Select a chat to start messaging.</div>';
      if (messageForm) messageForm.style.display = 'none';
      if (authModal) authModal.style.display = 'flex';
      if (socket) { try { socket.disconnect(); } catch (e) {} socket = null; }
    });
  }

  // Message send (optimistic + upgrade flow)
  if (messageForm) {
    messageForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = (messageInput && messageInput.value || '').trim();
      if (!text || !currentChat || !currentUser) return;

      // create temp id and optimistic message
      const tempId = 'temp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
      const tempTs = Date.now();
      const tempMsg = { id: tempId, sender: currentUser.username, text, timestamp: tempTs };
      messagesCache[currentChat.id] = messagesCache[currentChat.id] || [];
      messagesCache[currentChat.id].push(tempMsg);
      appendMessage(tempMsg, true);

      messageInput.value = '';

      // Try socket first; server will emit 'new_message' which will upgrade the optimistic node
      if (socket && socket.connected) {
        socket.emit('send_message', { chatId: currentChat.id, text });
        return;
      }

      // REST fallback: receive created message and handle upgrade
      try {
        const res = await API.postMessage(token, currentChat.id, text);
        if (res && res.id) {
          handleServerMessage(currentChat.id, res);
        }
      } catch (err) {
        console.error('postMessage error', err);
      }
    });
  }

  // Send contact request
  if (sendRequestBtn && contactUsernameInput) {
    sendRequestBtn.addEventListener('click', async () => {
      const to = (contactUsernameInput.value || '').trim();
      if (!to) {
        if (requestStatus) requestStatus.textContent = 'Enter a username';
        return;
      }
      if (currentUser && (normalize(to) === normalize(currentUser.username) || normalize(to) === normalize(currentUser.contactNumber))) {
        if (requestStatus) requestStatus.textContent = "You can't request yourself.";
        return;
      }
      sendRequestBtn.disabled = true;
      sendRequestBtn.textContent = 'Sending...';
      try {
        const res = await API.sendContactRequest(token, to);
        if (res.error) {
          if (requestStatus) requestStatus.textContent = res.error;
        } else {
          if (requestStatus) requestStatus.textContent = 'Request sent!';
          contactUsernameInput.value = '';
          await refreshChats();
        }
      } catch (err) {
        console.error(err);
        if (requestStatus) requestStatus.textContent = 'Network error';
      } finally {
        sendRequestBtn.disabled = false;
        sendRequestBtn.textContent = 'Send Request';
        setTimeout(() => { if (requestStatus) requestStatus.textContent = ''; }, 3000);
      }
    });
  }

  // Copy contact
  if (copyContactBtn) {
    copyContactBtn.addEventListener('click', async () => {
      if (!currentUser || !currentUser.contactNumber) return;
      try {
        await navigator.clipboard.writeText(currentUser.contactNumber);
        copyContactBtn.textContent = 'Copied!';
        setTimeout(() => { copyContactBtn.textContent = 'Copy my contact'; }, 1500);
      } catch (err) { console.error(err); }
    });
  }

  // Render lists
  function renderChats() {
    if (!chatListEl) return;
    chatListEl.innerHTML = '';
    chats.filter(c => c.type === 'direct').forEach(c => {
      const li = document.createElement('li');
      const avatar = document.createElement('div'); avatar.className = 'avatar';
      const other = (c.participants || []).find(p => normalize(p) !== normalize(currentUser && currentUser.username)) || c.participants[0];
      avatar.textContent = (other || '?').slice(0, 2).toUpperCase();
      const meta = document.createElement('div'); meta.className = 'meta';
      const title = document.createElement('div'); title.textContent = other || 'Chat';
      const sub = document.createElement('div'); sub.className = 'small muted';
      sub.textContent = c.lastMessage ? `${c.lastMessage.sender}: ${String(c.lastMessage.text || '').slice(0, 40)}` : 'No messages';
      meta.appendChild(title); meta.appendChild(sub);
      li.appendChild(avatar); li.appendChild(meta);
      li.addEventListener('click', () => openChat(c));
      chatListEl.appendChild(li);
    });
  }

  function renderInbox() {
    if (!inboxListEl) return;
    inboxListEl.innerHTML = '';
    chats.filter(c => c.type === 'inbox').forEach(c => {
      const li = document.createElement('li');
      const avatar = document.createElement('div'); avatar.className = 'avatar';
      avatar.textContent = 'I';
      const meta = document.createElement('div'); meta.className = 'meta';
      const title = document.createElement('div'); title.textContent = 'Inbox';
      const sub = document.createElement('div'); sub.className = 'small muted';
      sub.textContent = c.lastMessage ? String(c.lastMessage.text || '').slice(0, 60) : 'No notifications';
      meta.appendChild(title); meta.appendChild(sub);
      li.appendChild(avatar); li.appendChild(meta);
      li.addEventListener('click', () => openChat(c));
      inboxListEl.appendChild(li);
    });
  }

  async function renderContacts() {
    if (!contactListEl) return;
    contactListEl.innerHTML = '';
    try {
      // Use the new contacts endpoint (only shows your true contacts)
      const contacts = await API.contacts(token);
      // If the endpoint returned an error (e.g. unauthorized), fall back to empty list
      if (!contacts || contacts.error) {
        const errEl = document.createElement('div');
        errEl.className = 'muted small';
        errEl.textContent = 'No contacts found';
        contactListEl.appendChild(errEl);
        return;
      }

      contacts.forEach(u => {
        // u: { id?, username, contactNumber? }
        const li = document.createElement('li');
        const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = (u.username || '?').slice(0, 2).toUpperCase();
        const meta = document.createElement('div'); meta.className = 'meta';
        const title = document.createElement('div'); title.textContent = u.username || 'Unknown';
        const sub = document.createElement('div'); sub.className = 'small muted'; sub.textContent = u.contactNumber ? `Contact: ${u.contactNumber}` : '';
        meta.appendChild(title); meta.appendChild(sub);
        li.appendChild(avatar); li.appendChild(meta);

        li.addEventListener('click', async () => {
          try {
            const chat = await API.createDirect(token, u.username);
            await refreshChats();
            const c = chats.find(x => x.id === chat.id);
            if (c) openChat(c);
          } catch (err) {
            console.error('Could not create/open chat', err);
          }
        });

        contactListEl.appendChild(li);
      });

      if (!contacts || contacts.length === 0) {
        const hint = document.createElement('div');
        hint.className = 'muted small';
        hint.style.padding = '10px';
        hint.textContent = 'No contacts yet. Send a contact request to connect with others.';
        contactListEl.appendChild(hint);
      }
    } catch (err) {
      console.error('Failed to load contacts', err);
      const errEl = document.createElement('div');
      errEl.className = 'muted small';
      errEl.textContent = 'Error loading contacts';
      contactListEl.appendChild(errEl);
    }
  }

  // Open chat - clears and loads messages for the selected chat
  async function openChat(chat) {
    if (!chat) return;
    currentChat = chat;
    if (currentChatTitle) currentChatTitle.textContent = (chat.type === 'inbox') ? 'Inbox' : (chat.participants.find(p => normalize(p) !== normalize(currentUser.username)) || 'Chat');
    if (messageForm) messageForm.style.display = chat.type === 'direct' ? 'flex' : 'none';
    clearMessages();

    try {
      const msgs = await API.getMessages(token, chat.id, 200);
      msgs.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      messagesCache[chat.id] = msgs.slice();
      if (!msgs.length) {
        if (messagesEl) messagesEl.innerHTML = '<div class="placeholder muted">No messages yet — say hi 👋</div>';
      } else {
        msgs.forEach(m => appendMessage(m));
      }
    } catch (err) {
      console.error('Failed to load messages', err);
      if (messagesEl) messagesEl.innerHTML = '<div class="placeholder muted">Could not load messages</div>';
    }
  }

  function clearMessages() {
    if (!messagesEl) return;
    messagesEl.innerHTML = '';
    messagesEl.classList.remove('empty');
  }

  // Refresh chat list only (does not clear or re-open the current chat).
  async function refreshChats() {
    if (!token) return;
    try {
      chats = await API.getChats(token);
      renderChats();
      renderInbox();
    } catch (err) {
      console.error('Failed to refresh chats', err);
    }
  }

  // Boot sequence
  async function boot() {
    try {
      const me = await API.me(token);
      if (me && me.username) {
        currentUser = me;
        if (userStatus) userStatus.textContent = currentUser.username;
        if (meNameEl) meNameEl.textContent = currentUser.username;
        if (meAvatarEl) meAvatarEl.textContent = currentUser.username.slice(0, 2).toUpperCase();
        if (meContactEl && currentUser.contactNumber) meContactEl.textContent = 'Contact: ' + currentUser.contactNumber;

        // connect sockets if available
        if (window.io) {
          try {
            if (socket) { socket.disconnect(); socket = null; }
            socket = io({ auth: { token } });
            socket.on('connect', () => { /* connected */ });
            socket.on('new_message', ({ chatId, message }) => {
              // central handler upgrades optimistic nodes if needed
              handleServerMessage(chatId, message);
            });
            socket.on('chat_created', ({ chat }) => {
              refreshChats();
            });
            socket.on('typing', ({ chatId, username, typing }) => {
              // optional typing UI
            });
          } catch (e) {
            console.error('socket error', e);
            socket = null;
          }
        }

        // initial load
        await refreshChats();
        await renderContacts();

        if (authModal) authModal.style.display = 'none';
      } else {
        localStorage.removeItem('token');
        token = null;
        if (authModal) authModal.style.display = 'flex';
      }
    } catch (err) {
      console.error('Boot error', err);
      if (authModal) authModal.style.display = 'flex';
    }
  }

  // Initial start
  if (!token) {
    if (authModal) authModal.style.display = 'flex';
  } else {
    await boot();
  }

  // AI Floating Widget Logic
  if (aiWidgetBtn && aiWidgetChat && aiWidgetClose) {
    aiWidgetBtn.addEventListener('click', () => {
      aiWidgetChat.style.display = 'flex';
      aiWidgetBtn.style.display = 'none';
    });
    aiWidgetClose.addEventListener('click', () => {
      aiWidgetChat.style.display = 'none';
      aiWidgetBtn.style.display = 'block';
    });
  }

  function renderAiWidgetHistory(history) {
    aiWidgetHistory.innerHTML = '';
    history.forEach(msg => {
      const div = document.createElement('div');
      if (msg.role === 'thinking') {
        div.className = 'ai-widget-bubble thinking';
        div.textContent = msg.content;
      } else if (msg.role === 'user') {
        div.className = 'ai-widget-bubble user';
        div.textContent = msg.content;
      } else {
        div.className = 'ai-widget-bubble ai';
        div.textContent = msg.content;
      }
      aiWidgetHistory.appendChild(div);
    });
    aiWidgetHistory.scrollTop = aiWidgetHistory.scrollHeight;
  }

  if (aiWidgetSend) {
    aiWidgetSend.addEventListener('click', async function() {
      const prompt = aiWidgetInput.value.trim();
      if (!prompt) return;
      aiWidgetInput.value = '';
      aiWidgetData.push({ role: 'user', content: prompt });
      renderAiWidgetHistory(aiWidgetData);
      // Show thinking bubble
      aiWidgetData.push({ role: 'thinking', content: 'Thinking...' });
      renderAiWidgetHistory(aiWidgetData);
      try {
        const res = await fetch('/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: aiWidgetData.filter(m => m.role !== 'thinking') })
        });
        if (!res.ok) throw new Error('Server error: ' + res.status);
        const data = await res.json();
        // Remove thinking bubble
        aiWidgetData = aiWidgetData.filter(m => m.role !== 'thinking');
        // Parse <think>...</think> if present
        const thinkMatch = data.response.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkMatch) {
          aiWidgetData.push({ role: 'thinking', content: thinkMatch[1].trim() });
          renderAiWidgetHistory(aiWidgetData);
          const finalResponse = data.response.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
          if (finalResponse) {
            setTimeout(() => {
              aiWidgetData = aiWidgetData.filter(m => m.role !== 'thinking');
              aiWidgetData.push({ role: 'ai', content: finalResponse });
              renderAiWidgetHistory(aiWidgetData);
            }, 1200);
          }
        } else {
          aiWidgetData.push({ role: 'ai', content: data.response });
          renderAiWidgetHistory(aiWidgetData);
        }
      } catch (e) {
        aiWidgetData = aiWidgetData.filter(m => m.role !== 'thinking');
        aiWidgetData.push({ role: 'ai', content: 'Error: ' + e.message });
        renderAiWidgetHistory(aiWidgetData);
      }
    });
    aiWidgetInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        aiWidgetSend.click();
      }
    });
  }

})();