const express = require('express');
const axios = require('axios');
const session = require('express-session');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');

// ============================================================
// CONFIGURATION — change these to match your wuzapi setup
// ============================================================
const WUZAPI_URL = 'http://localhost:8082';
const ADMIN_TOKEN = 'my-admin-token-123';
const USER_TOKEN = 'dashboard-token-456';
const WUZAPI_DIR = path.resolve(__dirname, '..', 'wuzapi-build');
const WUZAPI_EXE = path.join(WUZAPI_DIR, 'wuzapi.exe');

// DeepSeek AI configuration
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEEPSEEK_JID = 'deepseek@ai';
const DEEPSEEK_NAME = 'DeepSeek AI';

// Qwen AI (DashScope) configuration — multimodal vision analysis
const QWEN_API_KEY = process.env.QWEN_API_KEY;
const QWEN_API_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';
const QWEN_VL_MODEL = 'qwen3-vl-flash-2026-01-22';

// ============================================================
// EXPRESS SETUP
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(session({
  secret: 'whatsapp-qr-test-secret-' + crypto.randomBytes(8).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 30 * 60 * 1000 } // 30 minutes
}));

// ============================================================
// HELPERS — wuzapi HTTP wrappers (auto-detect auth format)
// ============================================================

// Cache the winning auth format for admin endpoints (discovered on first call).
let _adminAuthHeaders = null;

const ADMIN_AUTH_CANDIDATES = [
  { label: 'Authorization (raw)',   headers: (t) => ({ 'Authorization': t }) },
  { label: 'Authorization (Bearer)', headers: (t) => ({ 'Authorization': 'Bearer ' + t }) },
  { label: 'Token header',          headers: (t) => ({ 'Token': t }) },
];

/**
 * Probe the admin endpoint to find which auth format wuzapi accepts.
 * Runs once — the winning headers are cached for the lifetime of the process.
 */
async function discoverAdminAuth() {
  if (_adminAuthHeaders) return; // already discovered

  for (const candidate of ADMIN_AUTH_CANDIDATES) {
    try {
      const res = await axios({
        method: 'GET',
        url: `${WUZAPI_URL}/admin/users`,
        headers: {
          ...candidate.headers(ADMIN_TOKEN),
          'Content-Type': 'application/json'
        },
        timeout: 10000
      });
      if (res.status === 200) {
        _adminAuthHeaders = candidate.headers(ADMIN_TOKEN);
        console.log(`[auth] admin auth OK via "${candidate.label}"`);
        return;
      }
    } catch (err) {
      console.log(`[auth] admin auth FAIL via "${candidate.label}" — ${err.response?.status || err.message}`);
    }
  }

  // None worked — store a sentinel so we don't probe again, but requests will 401
  _adminAuthHeaders = { 'Authorization': ADMIN_TOKEN };
  console.log('[auth] WARNING: no admin auth format succeeded. Check ADMIN_TOKEN and wuzapi.');
}

/**
 * Call a wuzapi admin endpoint.
 * Auto-discovers the correct auth header format on the first call.
 */
async function adminRequest(method, path, data = null) {
  await discoverAdminAuth();

  const opts = {
    method,
    url: `${WUZAPI_URL}${path}`,
    headers: {
      ..._adminAuthHeaders,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  };
  if (data) opts.data = data;
  const res = await axios(opts);
  return res.data;
}

/**
 * Call a wuzapi user endpoint.
 * Sends both Token and Authorization headers — wuzapi versions differ on which they accept.
 */
async function userRequest(method, path, userToken, data = null) {
  const opts = {
    method,
    url: `${WUZAPI_URL}${path}`,
    headers: {
      'Token': userToken,
      'Authorization': userToken,
      'Content-Type': 'application/json'
    },
    timeout: 15000
  };
  if (data) opts.data = data;
  const res = await axios(opts);
  return res.data;
}

/**
 * Extract a phone number from a WhatsApp JID.
 * JID formats: "5491155554444@s.whatsapp.net" or "5491155554444.0:52@s.whatsapp.net"
 */
function extractPhoneFromJID(jid) {
  if (!jid) return null;
  const local = jid.split('@')[0];
  return local.split(':')[0].split('.')[0];
}

// ============================================================
// ROUTES
// ============================================================

// ── GET / — Main page: shows QR code ────────────────────────
app.get('/', async (req, res) => {
  try {
    // If we already have a user in this session, check its status first
    if (req.session.userToken && req.session.userId) {
      try {
        const status = await userRequest('GET', '/session/status', req.session.userToken);
        const loggedIn = (status.data && (status.data.loggedIn || status.data.LoggedIn));
        if (status.success && loggedIn) {
          return res.redirect('/success');
        }
      } catch (_) {
        // User may have been deleted — fall through to create a new one
        req.session.userToken = null;
        req.session.userId = null;
      }
    }

    // Find or create a user with the fixed token
    const userName = 'web-user-' + crypto.randomBytes(4).toString('hex');
    const userToken = USER_TOKEN;

    let userId;
    try {
      // First, check if a user with this token already exists
      const usersResp = await adminRequest('GET', '/admin/users');
      const allUsers = (usersResp && usersResp.data) ? usersResp.data : usersResp;
      const existingUser = Array.isArray(allUsers) ? allUsers.find(u => u.token === userToken) : null;

      if (existingUser) {
        userId = existingUser.id;
        console.log('[user] reusing existing user id=' + userId + ' with token ' + userToken);
      } else {
        const createResult = await adminRequest('POST', '/admin/users', {
          name: userName,
          token: userToken,
          webhook: WUZAPI_URL + '/webhook',
          events: 'Message,ReadReceipt'
        });
        userId = createResult.id;
        console.log('[user] created new user id=' + userId + ' with token ' + userToken);
      }
    } catch (err) {
      const status = err.response?.status;
      const body = err.response?.data;
      const detail = status === 401
        ? `All 3 auth formats failed against ${WUZAPI_URL}/admin/users\n\n` +
          `Tried: Authorization (raw), Authorization (Bearer), Token header\n` +
          `Token used: "${ADMIN_TOKEN}"\n\n` +
          `→ This token likely does NOT match your wuzapi instance.\n` +
          `→ Check the WUZAPI_ADMIN_TOKEN env var / container setting where wuzapi runs.\n` +
          `→ Response: ${JSON.stringify(body)}`
        : `POST ${WUZAPI_URL}/admin/users\nResponse: ${JSON.stringify(body)}`;
      return res.status(500).send(renderErrorPage('Failed to create wuzapi user (admin endpoint)', detail));
    }

    // Store in session
    req.session.userToken = userToken;
    req.session.userId = userId;
    req.session.userName = userName;

    // Connect the session to get a QR code
    let connectJID = null;
    try {
      const connectResult = await userRequest('POST', '/session/connect', userToken, {
        Subscribe: ['Message'],
        Immediate: true
      });
      console.log('[connect] result:', JSON.stringify(connectResult));
      // Capture the JID from the connect response
      if (connectResult && connectResult.data) {
        connectJID = connectResult.data.jid;
      }
      if (connectResult && connectResult.jid) {
        connectJID = connectResult.jid;
      }
      if (connectJID) {
        req.session.jid = connectJID;
        req.session.phone = extractPhoneFromJID(connectJID);
        console.log('[connect] stored JID: ' + connectJID + ' phone: ' + req.session.phone);
      }
    } catch (err) {
      // "already connected" is not an error — the session is already live
      const errBody = err.response?.data;
      const errMsg = errBody?.error || errBody?.message || '';
      if (err.response?.status === 500 && errMsg && errMsg.toLowerCase().includes('already connected')) {
        console.log('[connect] session already connected (normal for existing users)');
      } else {
        const detail = err.response
          ? `POST ${WUZAPI_URL}/session/connect\nResponse: ${JSON.stringify(err.response.data)}`
          : err.message;
        return res.status(500).send(renderErrorPage('Failed to connect WhatsApp session (user endpoint)', detail));
      }
    }

    // Poll status until connected AND we have a QR code.
    console.log('[qr] waiting for session to connect + QR...');
    let qrCode = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const st = await userRequest('GET', '/session/status', userToken);
        const d = st.data || {};
        const connected = d.connected || d.Connected;
        const loggedIn  = d.loggedIn  || d.LoggedIn;
        const qr        = d.qrcode    || d.QRCode;
        console.log(`[qr] poll ${i + 1}: connected=${connected}, loggedIn=${loggedIn}, hasQR=${!!qr}`);

        // Try to capture JID from status if we don't have it yet
        if (!req.session.jid && (d.jid || d.JID)) {
          const statusJid = d.jid || d.JID;
          req.session.jid = statusJid;
          req.session.phone = extractPhoneFromJID(statusJid);
          console.log('[qr] captured JID from status: ' + statusJid);
        }

        if (loggedIn) {
          console.log('[qr] already logged in — redirecting to success');
          return res.redirect('/success');
        }
        if (connected && qr) {
          qrCode = qr;
          console.log('[qr] got QR code! (length=' + qrCode.length + ')');
          break;
        }
      } catch (_) { /* retry */ }
    }

    if (!qrCode) {
      console.log('[qr] QR not available after retries — page will poll via /api/qr');
    }

    // Render the main page
    res.send(renderMainPage(qrCode, userName));

  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).send(renderErrorPage('Unexpected error', err.message));
  }
});

// ── GET /api/qr — Returns the QR code as JSON ───────────────
app.get('/api/qr', async (req, res) => {
  if (!req.session.userToken) {
    return res.json({ success: false, error: 'No session' });
  }

  try {
    // QR code is embedded in the status response (field: "qrcode", lowercase)
    const st = await userRequest('GET', '/session/status', req.session.userToken);
    const d = (st && st.data) || {};
    const qr = d.qrcode || d.QRCode;
    if (qr) {
      return res.json({ success: true, qrCode: qr });
    }
    return res.json({ success: false, error: 'QR not available yet' });
  } catch (err) {
    return res.json({ success: false, error: err.message });
  }
});

// ── GET /api/status — Returns session status ────────────────
app.get('/api/status', async (req, res) => {
  if (!req.session.userToken) {
    return res.json({ connected: false, loggedIn: false, error: 'No session' });
  }

  try {
    const status = await userRequest('GET', '/session/status', req.session.userToken);
    if (status.success && status.data) {
      const d = status.data;
      return res.json({
        connected: d.connected || d.Connected || false,
        loggedIn:  d.loggedIn  || d.LoggedIn  || false
      });
    }
    return res.json({ connected: false, loggedIn: false, error: 'Status unavailable' });
  } catch (err) {
    // Session might not be created yet — that's okay
    return res.json({ connected: false, loggedIn: false, error: err.message });
  }
});

// ── GET /success — Success page with user info, avatar, and contacts ──
app.get('/success', async (req, res) => {
  if (!req.session.userToken) {
    return res.redirect('/');
  }

  const userToken = req.session.userToken;
  let userJid = req.session.jid;        // full JID e.g. "85264689772:46@s.whatsapp.net"
  let phone = req.session.phone;
  let userInfo = null;
  let avatar = null;
  let contacts = null;
  let fetchError = null;

  // If we don't have the JID yet (status returns empty jid), fetch it from admin users list
  if (!userJid || !phone) {
    try {
      const usersResp = await adminRequest('GET', '/admin/users');
      const allUsers = (usersResp && usersResp.data) ? usersResp.data : usersResp;
      const thisUser = Array.isArray(allUsers)
        ? allUsers.find(u => u.token === userToken)
        : null;
      if (thisUser && thisUser.jid) {
        userJid = thisUser.jid;
        phone = extractPhoneFromJID(thisUser.jid);
        req.session.jid = userJid;
        req.session.phone = phone;
        console.log('[success] captured JID from admin users: ' + userJid);
      }
    } catch (err) {
      console.log('[success] admin users fetch for JID failed:', err.message);
    }
  }

  // 1. Fetch the user's own verified name via /user/info
  //    IMPORTANT: /user/info requires the full JID (phone@s.whatsapp.net), not bare phone
  if (phone) {
    try {
      const queryJid = phone + '@s.whatsapp.net';
      const infoResult = await userRequest('POST', '/user/info', userToken, { Phone: [queryJid] });
      if (infoResult.success && infoResult.data && infoResult.data.Users) {
        const users = infoResult.data.Users;
        const key = Object.keys(users).find(k => k.startsWith(phone));
        if (key && users[key]) {
          userInfo = users[key];
          // Normalize casing
          userInfo.verifiedName = userInfo.verifiedName || userInfo.VerifiedName;
          userInfo.pictureID = userInfo.pictureID || userInfo.PictureID;
          userInfo.status = userInfo.status || userInfo.Status;
        }
      }
    } catch (err) {
      console.log('[success] /user/info fetch failed:', err.message);
    }
  }

  // 2. Fetch the user's avatar (POST, not GET — actual wuzapi uses POST for this)
  if (phone) {
    try {
      const avatarResult = await userRequest('POST', '/user/avatar', userToken, {
        Phone: phone,
        Preview: false
      });
      if (avatarResult && !avatarResult.error && avatarResult.URL) {
        avatar = avatarResult;
      } else if (avatarResult && !avatarResult.error) {
        // May still have URL even if no explicit success field
        avatar = avatarResult;
      }
    } catch (err) {
      console.log('[success] /user/avatar fetch failed:', err.message);
    }
  }

  // 3. Fetch all contacts
  try {
    const contactsResult = await userRequest('GET', '/user/contacts', userToken);
    if (contactsResult.success && contactsResult.data) {
      contacts = contactsResult.data;
    } else if (contactsResult.data) {
      contacts = contactsResult.data;
    }
  } catch (err) {
    console.log('[success] /user/contacts fetch failed:', err.message);
    fetchError = 'Failed to fetch contacts: ' + err.message;
  }

  // 4. Prepend DeepSeek AI as the first contact
  const allContacts = contacts || {};
  contacts = {
    [DEEPSEEK_JID]: {
      PushName: DEEPSEEK_NAME,
      FullName: DEEPSEEK_NAME,
      FirstName: 'DeepSeek',
      BusinessName: 'AI Assistant',
      Found: true,
      IsDeepSeek: true
    },
    ...allContacts
  };

  res.send(renderSuccessPage({ userInfo, avatar, contacts, phone, jid: userJid, fetchError }));
});

// ── GET /chat — Chatroom page for a specific contact ─────────
app.get('/chat', (req, res) => {
  const phone = req.query.phone || '';
  const name = req.query.name || extractPhoneInTemplate(phone);

  if (!phone) {
    return res.status(400).send(renderErrorPage('Missing contact', 'No phone/JID specified.'));
  }

  res.send(renderChatPage(phone, name));
});

// ── POST /api/chat/send — Send a text message to a contact ───
app.post('/api/chat/send', async (req, res) => {
  if (!req.session.userToken) {
    return res.json({ success: false, error: 'No session' });
  }

  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.json({ success: false, error: 'Missing phone or message' });
  }

  try {
    const result = await userRequest('POST', '/chat/send/text', req.session.userToken, {
      Phone: phone,
      Body: message
    });
    // wuzapi returns { code: 200, data: { Details: "Sent", Id: "...", Timestamp: "..." }, success: true }
    if (result && (result.success || result.code === 200)) {
      return res.json({
        success: true,
        id: (result.data && result.data.Id) || null,
        timestamp: (result.data && result.data.Timestamp) || new Date().toISOString()
      });
    }
    return res.json({ success: false, error: result?.error || 'Unknown error' });
  } catch (err) {
    console.log('[chat/send] error:', err.message);
    return res.json({ success: false, error: err.response?.data?.error || err.message });
  }
});

// ── POST /api/chat/send/image — Send an image message ─────────
app.post('/api/chat/send/image', async (req, res) => {
  if (!req.session.userToken) {
    return res.json({ success: false, error: 'No session' });
  }

  const { phone, image, caption } = req.body;
  if (!phone || !image) {
    return res.json({ success: false, error: 'Missing phone or image' });
  }

  try {
    const result = await userRequest('POST', '/chat/send/image', req.session.userToken, {
      Phone: phone,
      Image: image,
      Caption: caption || ''
    });
    if (result && (result.success || result.code === 200)) {
      return res.json({
        success: true,
        id: (result.data && result.data.Id) || null,
        timestamp: (result.data && result.data.Timestamp) || new Date().toISOString()
      });
    }
    return res.json({ success: false, error: result?.error || 'Unknown error' });
  } catch (err) {
    console.log('[chat/send/image] error:', err.message);
    return res.json({ success: false, error: err.response?.data?.error || err.message });
  }
});

// ── POST /api/chat/send/document — Send a document message ─────
app.post('/api/chat/send/document', async (req, res) => {
  if (!req.session.userToken) {
    return res.json({ success: false, error: 'No session' });
  }

  const { phone, document, fileName } = req.body;
  if (!phone || !document) {
    return res.json({ success: false, error: 'Missing phone or document' });
  }

  try {
    const result = await userRequest('POST', '/chat/send/document', req.session.userToken, {
      Phone: phone,
      Document: document,
      FileName: fileName || 'file'
    });
    if (result && (result.success || result.code === 200)) {
      return res.json({
        success: true,
        id: (result.data && result.data.Id) || null,
        timestamp: (result.data && result.data.Timestamp) || new Date().toISOString()
      });
    }
    return res.json({ success: false, error: result?.error || 'Unknown error' });
  } catch (err) {
    console.log('[chat/send/document] error:', err.message);
    return res.json({ success: false, error: err.response?.data?.error || err.message });
  }
});

// ── POST /api/chat/send/video — Send a video message ───────────
app.post('/api/chat/send/video', async (req, res) => {
  if (!req.session.userToken) {
    return res.json({ success: false, error: 'No session' });
  }

  const { phone, video, caption } = req.body;
  if (!phone || !video) {
    return res.json({ success: false, error: 'Missing phone or video' });
  }

  try {
    const result = await userRequest('POST', '/chat/send/video', req.session.userToken, {
      Phone: phone,
      Video: video,
      Caption: caption || ''
    });
    if (result && (result.success || result.code === 200)) {
      return res.json({
        success: true,
        id: (result.data && result.data.Id) || null,
        timestamp: (result.data && result.data.Timestamp) || new Date().toISOString()
      });
    }
    return res.json({ success: false, error: result?.error || 'Unknown error' });
  } catch (err) {
    console.log('[chat/send/video] error:', err.message);
    return res.json({ success: false, error: err.response?.data?.error || err.message });
  }
});

// ── POST /api/chat/deepseek — DeepSeek + Qwen-VL AI orchestrator ──
app.post('/api/chat/deepseek', async (req, res) => {
  const { message, image, fileName } = req.body;
  if (!message && !image) {
    return res.json({ success: false, error: 'Missing message or image' });
  }

  try {
    let finalReply;

    // ── MEDIA ATTACHED → route to Qwen-VL for analysis, then DeepSeek refines ──
    if (image) {
      const userPrompt = message || 'Describe this in detail.';
      const mimeMatch = image.match(/^data:([^;]+);/);
      const mimeType = mimeMatch ? mimeMatch[1] : '';

      // Determine content type for Qwen-VL
      let mediaContent;
      if (mimeType.startsWith('image/')) {
        mediaContent = { type: 'image_url', image_url: { url: image } };
      } else if (mimeType.startsWith('video/')) {
        mediaContent = { type: 'video_url', video_url: { url: image } };
      } else {
        // Generic file — send as image_url (Qwen will try to process)
        mediaContent = { type: 'image_url', image_url: { url: image } };
      }

      console.log('[deepseek] sending media to Qwen-VL for analysis... mime=' + mimeType);

      // Step 1: Qwen-VL analyzes the image/video
      const qwenResponse = await axios({
        method: 'POST',
        url: QWEN_API_URL,
        headers: {
          'Authorization': `Bearer ${QWEN_API_KEY}`,
          'Content-Type': 'application/json'
        },
        data: {
          model: QWEN_VL_MODEL,
          messages: [{
            role: 'user',
            content: [
              mediaContent,
              { type: 'text', text: userPrompt }
            ]
          }],
          max_tokens: 1000
        },
        timeout: 120000
      });

      const qwenAnalysis = qwenResponse.data.choices[0].message.content;
      console.log('[deepseek] Qwen-VL analysis done (' + qwenAnalysis.length + ' chars)');

      // Step 2: DeepSeek takes Qwen's analysis + user's prompt and crafts the final reply
      const deepseekResponse = await axios({
        method: 'POST',
        url: DEEPSEEK_API_URL,
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        data: {
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful assistant. A vision AI (Qwen) analyzed media the user shared. Use Qwen\'s analysis to give the user a natural, helpful response. If Qwen\'s analysis is detailed, summarize the key points conversationally. Always credit Qwen briefly for the visual analysis.'
            },
            {
              role: 'user',
              content: 'Qwen\'s vision analysis of the media I shared:\n"""\n' + qwenAnalysis + '\n"""\n\n' + (fileName ? '[File: ' + fileName + ']\n' : '') + 'My request: ' + userPrompt
            }
          ],
          temperature: 0.7,
          max_tokens: 2000
        },
        timeout: 60000
      });

      finalReply = deepseekResponse.data.choices[0].message.content;

      return res.json({
        success: true,
        reply: finalReply,
        qwenAnalysis: qwenAnalysis,
        id: deepseekResponse.data.id,
        timestamp: new Date().toISOString()
      });
    }

    // ── TEXT ONLY → DeepSeek directly ──
    if (fileName) {
      // File shared but no image data — acknowledge the file
      const textPrompt = `[User shared a file: ${fileName}]\n\n${message || 'Acknowledge the file and offer to help.'}`;
      const aiResponse = await axios({
        method: 'POST',
        url: DEEPSEEK_API_URL,
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        data: {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: 'You are a helpful assistant. When a user shares a file, acknowledge it, describe what the file type might be used for, and offer relevant help.' },
            { role: 'user', content: textPrompt }
          ],
          temperature: 0.7,
          max_tokens: 2000
        },
        timeout: 60000
      });
      finalReply = aiResponse.data.choices[0].message.content;
    } else {
      // Pure text message — DeepSeek directly
      const aiResponse = await axios({
        method: 'POST',
        url: DEEPSEEK_API_URL,
        headers: {
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json'
        },
        data: {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: message }
          ],
          temperature: 0.7,
          max_tokens: 2000
        },
        timeout: 60000
      });
      finalReply = aiResponse.data.choices[0].message.content;
    }

    return res.json({
      success: true,
      reply: finalReply,
      id: 'ds-' + Date.now(),
      timestamp: new Date().toISOString()
    });

  } catch (err) {
    console.log('[deepseek] error:', err.message);
    // If Qwen fails but DeepSeek might still work, try fallback
    if (image && err.response?.data?.error) {
      try {
        const fallbackResp = await axios({
          method: 'POST',
          url: DEEPSEEK_API_URL,
          headers: {
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
            'Content-Type': 'application/json'
          },
          data: {
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: 'You are a helpful assistant.' },
              { role: 'user', content: `[User shared media: ${fileName || 'file'}]\n\n${message || 'The vision AI is temporarily unavailable. Acknowledge the shared file and offer help based on the filename and context.'}` }
            ],
            temperature: 0.7,
            max_tokens: 2000
          },
          timeout: 60000
        });
        return res.json({
          success: true,
          reply: fallbackResp.data.choices[0].message.content + '\n\n⚠️ *Visual analysis unavailable — Qwen-VL did not respond. Text-only response from DeepSeek.*',
          id: fallbackResp.data.id,
          timestamp: new Date().toISOString()
        });
      } catch (_) { /* both failed */ }
    }
    const errMsg = err.response?.data?.error?.message || err.message;
    return res.json({ success: false, error: 'AI error: ' + errMsg });
  }
});

// ── GET /reset — Reset the session and start over ───────────
app.get('/reset', async (req, res) => {
  // Try to clean up the old user
  if (req.session.userToken && req.session.userId) {
    try {
      await userRequest('POST', '/session/logout', req.session.userToken);
    } catch (_) { /* best effort */ }
    try {
      await adminRequest('DELETE', `/admin/users/${req.session.userId}`);
    } catch (_) { /* best effort */ }
  }

  // Destroy session and redirect to home
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// ── GET /diag — Diagnostic: test wuzapi connectivity ─────────
app.get('/diag', async (req, res) => {
  const results = [];

  // Test 1: Admin endpoint with Authorization header
  try {
    const r = await adminRequest('GET', '/admin/users');
    results.push({ test: 'GET /admin/users (admin auth)', ok: true, users: r.length });
  } catch (err) {
    results.push({
      test: 'GET /admin/users (admin auth)',
      ok: false,
      status: err.response?.status,
      body: err.response?.data
    });
  }

  // Test 2: Try admin with Bearer prefix
  try {
    const r = await axios({
      method: 'GET',
      url: `${WUZAPI_URL}/admin/users`,
      headers: { 'Authorization': 'Bearer ' + ADMIN_TOKEN },
      timeout: 10000
    });
    results.push({ test: 'GET /admin/users (Bearer prefix)', ok: true, users: r.data.length });
  } catch (err) {
    results.push({
      test: 'GET /admin/users (Bearer prefix)',
      ok: false,
      status: err.response?.status,
      body: err.response?.data
    });
  }

  // Test 3: Try admin with Token header
  try {
    const r = await axios({
      method: 'GET',
      url: `${WUZAPI_URL}/admin/users`,
      headers: { 'Token': ADMIN_TOKEN },
      timeout: 10000
    });
    results.push({ test: 'GET /admin/users (Token header)', ok: true, users: r.data.length });
  } catch (err) {
    results.push({
      test: 'GET /admin/users (Token header)',
      ok: false,
      status: err.response?.status,
      body: err.response?.data
    });
  }

  res.json({
    wuzapi_url: WUZAPI_URL,
    admin_token: ADMIN_TOKEN,
    results
  });
});

// ============================================================
// PAGE RENDERERS (inline HTML for zero extra dependencies)
// ============================================================

function renderMainPage(qrCode, userName) {
  const qrImg = qrCode
    ? `<img id="qr-image" src="${escapeHtml(qrCode)}" alt="WhatsApp QR Code" />`
    : `<div id="qr-placeholder">
         <div class="spinner"></div>
         <p>Generating QR code...</p>
       </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>WhatsApp Web Test</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      background: #111b21;
      color: #e9edef;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: #202c33;
      border-radius: 12px;
      padding: 40px;
      max-width: 480px;
      width: 90%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    h1 {
      font-size: 1.6rem;
      font-weight: 600;
      margin-bottom: 8px;
      color: #00a884;
    }
    .subtitle {
      font-size: 0.95rem;
      color: #8696a0;
      margin-bottom: 28px;
    }
    .qr-box {
      background: #fff;
      border-radius: 12px;
      padding: 20px;
      margin: 0 auto 24px;
      display: inline-block;
    }
    .qr-box img {
      display: block;
      width: 240px;
      height: 240px;
    }
    #qr-placeholder {
      width: 240px;
      height: 240px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: #667781;
    }
    .spinner {
      width: 44px;
      height: 44px;
      border: 4px solid #2a3942;
      border-top-color: #00a884;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .status {
      font-size: 0.9rem;
      color: #8696a0;
      margin-top: 12px;
    }
    .status.success { color: #00a884; }
    .status.error { color: #f15c6d; }
    .steps {
      text-align: left;
      margin: 20px 0 0;
      padding: 16px 20px;
      background: #182229;
      border-radius: 8px;
    }
    .steps h3 {
      font-size: 0.85rem;
      color: #00a884;
      margin-bottom: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .steps ol {
      padding-left: 20px;
      font-size: 0.9rem;
      color: #8696a0;
      line-height: 1.8;
    }
    .steps ol li { margin-bottom: 4px; }
    .error-box {
      background: #2a1f1f;
      border: 1px solid #f15c6d;
      border-radius: 8px;
      padding: 16px;
      margin-top: 16px;
      text-align: left;
    }
    .error-box h3 { color: #f15c6d; font-size: 0.9rem; margin-bottom: 6px; }
    .error-box pre {
      font-size: 0.78rem;
      color: #e9edef;
      white-space: pre-wrap;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>WhatsApp Web Test</h1>
    <p class="subtitle">Scan the QR code with WhatsApp to verify your wuzapi connection works.</p>

    <div class="qr-box" id="qr-box">
      ${qrImg}
    </div>

    <p class="status" id="status-text">Waiting for scan...</p>

    <div class="steps">
      <h3>How it works</h3>
      <ol>
        <li>Open <strong>WhatsApp</strong> on your phone</li>
        <li>Tap <strong>Menu</strong> → <strong>Linked Devices</strong></li>
        <li>Tap <strong>Link a Device</strong></li>
        <li>Scan the QR code above</li>
        <li>You'll be redirected to the success page!</li>
      </ol>
    </div>
  </div>

  <script>
    const STATUS_URL = '/api/status';
    const QR_URL = '/api/qr';
    const SUCCESS_URL = '/success';

    let pollTimer = null;
    let pollCount = 0;

    function $(sel) { return document.querySelector(sel); }

    async function checkStatus() {
      pollCount++;
      try {
        const resp = await fetch(STATUS_URL);
        const data = await resp.json();

        if (data.loggedIn) {
          // Success! Redirect to success page
          $('#status-text').textContent = '✓ QR code scanned! Redirecting...';
          $('#status-text').className = 'status success';
          clearInterval(pollTimer);
          setTimeout(() => { window.location.href = SUCCESS_URL; }, 800);
          return;
        }

        if (data.connected) {
          $('#status-text').textContent = 'Connected — waiting for you to scan the QR code...';
          $('#status-text').className = 'status';
        } else {
          $('#status-text').textContent = 'Connecting to WhatsApp...';
          $('#status-text').className = 'status';
        }

        // If no QR image yet, try fetching it
        if (!$('#qr-image') && pollCount % 3 === 0) {
          try {
            const qrResp = await fetch(QR_URL);
            const qrData = await qrResp.json();
            if (qrData.success && qrData.qrCode) {
              const img = document.createElement('img');
              img.id = 'qr-image';
              img.src = qrData.qrCode;
              img.alt = 'WhatsApp QR Code';
              const box = $('#qr-box');
              box.innerHTML = '';
              box.appendChild(img);
            }
          } catch (_) { /* will retry */ }
        }

        // Stop after 5 minutes (300 polls at 1s)
        if (pollCount > 300) {
          clearInterval(pollTimer);
          $('#status-text').textContent = 'Timed out. Please refresh the page to try again.';
          $('#status-text').className = 'status error';
        }
      } catch (err) {
        $('#status-text').textContent = 'Checking status...';
        $('#status-text').className = 'status';
      }
    }

    // Start polling every second
    pollTimer = setInterval(checkStatus, 1500);
    // Also check immediately
    checkStatus();
  </script>
</body>
</html>`;
}

function renderSuccessPage(data) {
  const { userInfo, avatar, contacts, phone, jid, fetchError } = data || {};

  // Build the user's own info section
  let userSection = '';
  if (userInfo) {
    const vn = userInfo.verifiedName;
    const verifiedName = (vn && vn.Details && vn.Details.verifiedName)
      ? vn.Details.verifiedName
      : (typeof vn === 'string' ? vn : null);
    const status = userInfo.status || userInfo.Status || '';
    const pictureID = userInfo.pictureID || userInfo.PictureID || '';

    userSection = `
    <div class="section">
      <h2>Your Profile</h2>
      <div class="profile-card">
        ${avatar && avatar.URL ? `<img class="profile-avatar" src="${escapeHtml(avatar.URL)}" alt="Avatar" onerror="this.style.display='none'" />` : '<div class="profile-avatar placeholder">?</div>'}
        <div class="profile-details">
          <div class="profile-name">${escapeHtml(verifiedName || phone || jid || 'Unknown')}</div>
          <div class="profile-phone">${escapeHtml(phone || (jid ? extractPhoneInTemplate(jid) : 'N/A'))}</div>
          ${status ? `<div class="profile-status">"${escapeHtml(status)}"</div>` : ''}
          ${pictureID ? `<div class="profile-pic-id">Picture ID: ${escapeHtml(pictureID)}</div>` : ''}
        </div>
      </div>
      <div class="info-rows">
        <div class="info-row"><span class="lbl">JID</span><span class="val">${escapeHtml(jid || 'N/A')}</span></div>
        <div class="info-row"><span class="lbl">Name</span><span class="val">${escapeHtml(verifiedName || phone || '(none)')}</span></div>
        <div class="info-row"><span class="lbl">Status</span><span class="val">${escapeHtml(status || '(none)')}</span></div>
        <div class="info-row"><span class="lbl">Avatar</span><span class="val">${avatar && avatar.URL ? '<a href="' + escapeHtml(avatar.URL) + '" target="_blank" class="link">View full image →</a>' : '(not available)'}</span></div>
      </div>
    </div>`;
  } else {
    userSection = `
    <div class="section">
      <h2>Your Profile</h2>
      <p class="muted">Unable to fetch your profile info. Phone: ${escapeHtml(phone || 'unknown')}</p>
    </div>`;
  }

  // Build the contacts table
  let contactsSection = '';
  if (fetchError) {
    contactsSection = `<div class="section"><h2>Contacts</h2><p class="error-msg">${escapeHtml(fetchError)}</p></div>`;
  } else if (contacts && typeof contacts === 'object' && Object.keys(contacts).length > 0) {
    const contactRows = Object.entries(contacts).map(([contactJid, info]) => {
      const pushName = info.PushName || '';
      const fullName = info.FullName || '';
      const firstName = info.FirstName || '';
      const businessName = info.BusinessName || '';
      const found = info.Found !== undefined ? info.Found : true;
      const isDeepSeek = info.IsDeepSeek === true;

      // Determine the best display name
      const displayName = fullName || pushName || firstName || extractPhoneInTemplate(contactJid);
      const encodedJid = encodeURIComponent(contactJid);
      const encodedName = encodeURIComponent(displayName);

      // Special row for DeepSeek
      if (isDeepSeek) {
        return `
          <tr class="deepseek-row">
            <td class="td-name">
              <span class="contact-name deepseek-name">
                <span class="ai-badge">🤖 AI</span> ${escapeHtml(displayName)}
              </span>
            </td>
            <td class="td-jid">${escapeHtml(contactJid)}</td>
            <td class="td-business">${escapeHtml(businessName || '-')}</td>
            <td class="td-first">${escapeHtml(firstName || '-')}</td>
            <td class="td-full">${escapeHtml(fullName || '-')}</td>
            <td class="td-found"><span class="badge badge-ai">AI</span></td>
            <td class="td-action"><a href="/chat?phone=${encodedJid}&name=${encodedName}" class="btn-chat btn-chat-ai">Chat</a></td>
          </tr>`;
      }

      return `
        <tr>
          <td class="td-name">
            <span class="contact-name">${escapeHtml(displayName)}</span>
            ${pushName && displayName !== pushName ? `<span class="contact-push">aka ${escapeHtml(pushName)}</span>` : ''}
          </td>
          <td class="td-jid">${escapeHtml(contactJid)}</td>
          <td class="td-business">${escapeHtml(businessName || '-')}</td>
          <td class="td-first">${escapeHtml(firstName || '-')}</td>
          <td class="td-full">${escapeHtml(fullName || '-')}</td>
          <td class="td-found"><span class="badge ${found ? 'badge-yes' : 'badge-no'}">${found ? 'Yes' : 'No'}</span></td>
          <td class="td-action"><a href="/chat?phone=${encodedJid}&name=${encodedName}" class="btn-chat">Chat</a></td>
        </tr>`;
    }).join('');

    contactsSection = `
    <div class="section">
      <h2>All Contacts <span class="count">(${Object.keys(contacts).length} total)</span></h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>JID</th>
              <th>Business</th>
              <th>First Name</th>
              <th>Full Name</th>
              <th>Found</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${contactRows}
          </tbody>
        </table>
      </div>
    </div>`;
  } else {
    contactsSection = `<div class="section"><h2>Contacts</h2><p class="muted">No contacts found.</p></div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Success — WhatsApp Linked!</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      background: #111b21;
      color: #e9edef;
      min-height: 100vh;
    }
    .header {
      background: #1f2c33;
      border-bottom: 1px solid #2a3942;
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .header-left { display: flex; align-items: center; gap: 14px; }
    .header-check {
      width: 36px; height: 36px; border-radius: 50%;
      background: #00a884;
      display: flex; align-items: center; justify-content: center;
    }
    .header-check svg { width: 22px; height: 22px; stroke: #fff; stroke-width: 4; fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .header h1 { font-size: 1.2rem; font-weight: 600; color: #e9edef; }
    .header-sub { font-size: 0.78rem; color: #00a884; }
    .btn {
      display: inline-block;
      padding: 10px 22px;
      background: #00a884;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 500;
      font-size: 0.9rem;
      transition: background 0.2s;
    }
    .btn:hover { background: #008f6f; }
    .btn-outline {
      background: transparent;
      border: 1px solid #2a3942;
      color: #8696a0;
    }
    .btn-outline:hover { background: #182229; color: #e9edef; }

    .main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 24px;
    }

    .section {
      background: #202c33;
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.25);
    }
    .section h2 {
      font-size: 1.1rem;
      font-weight: 600;
      color: #00a884;
      margin-bottom: 18px;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .section h2 .count {
      color: #8696a0;
      font-weight: 400;
      font-size: 0.85rem;
      text-transform: none;
    }

    /* Profile card */
    .profile-card {
      display: flex;
      align-items: center;
      gap: 18px;
      margin-bottom: 18px;
      padding: 16px;
      background: #182229;
      border-radius: 10px;
    }
    .profile-avatar {
      width: 72px; height: 72px; border-radius: 50%;
      object-fit: cover;
      border: 3px solid #00a884;
      flex-shrink: 0;
    }
    .profile-avatar.placeholder {
      background: #2a3942;
      display: flex; align-items: center; justify-content: center;
      font-size: 2rem; color: #8696a0; font-weight: 600;
    }
    .profile-details { flex: 1; min-width: 0; }
    .profile-name { font-size: 1.2rem; font-weight: 600; color: #e9edef; word-break: break-word; }
    .profile-phone { font-size: 0.85rem; color: #8696a0; margin-top: 2px; }
    .profile-status { font-size: 0.88rem; color: #8696a0; font-style: italic; margin-top: 4px; }
    .profile-pic-id { font-size: 0.75rem; color: #667781; margin-top: 2px; }

    /* Info rows */
    .info-rows { background: #182229; border-radius: 10px; padding: 4px 0; }
    .info-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 16px;
      border-bottom: 1px solid #2a3942;
      font-size: 0.9rem;
    }
    .info-row:last-child { border-bottom: none; }
    .info-row .lbl { color: #8696a0; flex-shrink: 0; margin-right: 16px; }
    .info-row .val { color: #e9edef; font-weight: 500; text-align: right; word-break: break-all; }
    .info-row .val .link { color: #00a884; text-decoration: none; }
    .info-row .val .link:hover { text-decoration: underline; }

    /* Contacts table */
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; }
    thead th {
      text-align: left;
      padding: 12px 14px;
      background: #182229;
      color: #00a884;
      font-weight: 600;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      border-bottom: 2px solid #2a3942;
      white-space: nowrap;
      position: sticky;
      top: 0;
    }
    tbody td {
      padding: 12px 14px;
      border-bottom: 1px solid #2a3942;
      vertical-align: top;
    }
    tbody tr:hover { background: #182229; }
    .td-name { min-width: 160px; }
    .contact-name { font-weight: 600; color: #e9edef; display: block; }
    .contact-push { font-size: 0.78rem; color: #667781; display: block; margin-top: 1px; }
    .td-jid { font-size: 0.78rem; color: #8696a0; word-break: break-all; max-width: 260px; }
    .td-business, .td-first, .td-full { color: #8696a0; }
    .badge {
      display: inline-block; padding: 3px 10px; border-radius: 12px;
      font-size: 0.75rem; font-weight: 600;
    }
    .badge-yes { background: #004d3a; color: #00a884; }
    .badge-no { background: #3a1f1f; color: #f15c6d; }

    .td-action { text-align: center; }
    .btn-chat {
      display: inline-block;
      padding: 6px 16px;
      background: #00a884;
      color: #fff;
      text-decoration: none;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 600;
      transition: background 0.2s;
    }
    .btn-chat:hover { background: #008f6f; }

    /* DeepSeek AI row */
    .deepseek-row {
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%) !important;
      border-bottom: 2px solid #6c5ce7 !important;
    }
    .deepseek-row:hover { background: linear-gradient(135deg, #1f1f3a 0%, #1c2748 50%, #154078 100%) !important; }
    .deepseek-name { color: #a78bfa !important; font-weight: 700 !important; }
    .ai-badge {
      display: inline-block;
      padding: 2px 8px;
      background: linear-gradient(135deg, #6c5ce7, #a78bfa);
      color: #fff;
      border-radius: 10px;
      font-size: 0.75rem;
      font-weight: 700;
      margin-right: 4px;
      animation: ai-pulse 2s ease-in-out infinite;
    }
    @keyframes ai-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }
    .badge-ai {
      background: linear-gradient(135deg, #6c5ce7, #a78bfa) !important;
      color: #fff !important;
      font-weight: 700;
    }
    .btn-chat-ai {
      background: linear-gradient(135deg, #6c5ce7, #a78bfa) !important;
      font-weight: 700 !important;
    }
    .btn-chat-ai:hover { background: linear-gradient(135deg, #5b4bd5, #9680ea) !important; }
    .td-jid.ai-jid { color: #a78bfa; font-size: 0.78rem; word-break: break-all; max-width: 260px; }

    /* Search bar */
    .search-bar {
      background: #202c33;
      border-radius: 12px;
      padding: 16px 24px;
      margin-bottom: 20px;
      display: flex;
      gap: 10px;
      align-items: center;
      box-shadow: 0 2px 12px rgba(0,0,0,0.25);
    }
    .search-bar input {
      flex: 1;
      padding: 10px 16px;
      background: #2a3942;
      border: 1px solid #2a3942;
      border-radius: 8px;
      color: #e9edef;
      font-size: 0.95rem;
      outline: none;
      transition: border 0.2s;
    }
    .search-bar input:focus { border-color: #00a884; }
    .search-bar input::placeholder { color: #667781; }
    .search-bar button {
      padding: 10px 24px;
      border: none;
      border-radius: 8px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    #search-btn { background: #00a884; color: #fff; }
    #search-btn:hover { background: #008f6f; }
    #search-clear { background: transparent; border: 1px solid #2a3942; color: #8696a0; }
    #search-clear:hover { background: #182229; color: #e9edef; }
    .search-result-count {
      font-size: 0.8rem;
      color: #00a884;
      margin-left: 8px;
      display: none;
    }

    .muted { color: #8696a0; font-size: 0.9rem; }
    .error-msg { color: #f15c6d; font-size: 0.9rem; }

    footer { text-align: center; padding: 24px; color: #667781; font-size: 0.8rem; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <div class="header-check">
        <svg viewBox="0 0 24 24"><polyline points="4 12 10 18 20 6"></polyline></svg>
      </div>
      <div>
        <h1>WhatsApp Linked!</h1>
        <div class="header-sub">Connected via wuzapi @ ${escapeHtml(WUZAPI_URL)}</div>
      </div>
    </div>
    <div style="display:flex;gap:10px;">
      <a href="/reset" class="btn btn-outline">Run Another Test</a>
      <a href="/reset" class="btn">Disconnect</a>
    </div>
  </div>

  <div class="main">
    ${userSection}
    <div class="search-bar">
      <input type="text" id="search-input" placeholder="Search contact by name..." />
      <button id="search-btn" onclick="searchContacts()">Search</button>
      <button id="search-clear" onclick="clearSearch()">Clear</button>
    </div>
    ${contactsSection}
  </div>

  <footer>WhatsApp QR Test — wuzapi integration</footer>

  <script>
    const allRows = document.querySelectorAll('tbody tr');
    const searchInput = document.getElementById('search-input');
    const contactsSection = document.querySelector('.section:last-of-type');

    function searchContacts() {
      const query = searchInput.value.trim().toLowerCase();
      if (!query) return clearSearch();

      let visibleCount = 0;
      allRows.forEach(row => {
        const nameCell = row.querySelector('.contact-name');
        const name = nameCell ? nameCell.textContent.toLowerCase() : '';
        const pushCell = row.querySelector('.contact-push');
        const pushName = pushCell ? pushCell.textContent.toLowerCase() : '';

        if (name.includes(query) || pushName.includes(query)) {
          row.style.display = '';
          visibleCount++;
        } else {
          row.style.display = 'none';
        }
      });

      // Show count
      let countEl = document.getElementById('search-count');
      if (!countEl) {
        countEl = document.createElement('span');
        countEl.id = 'search-count';
        countEl.className = 'search-result-count';
        document.getElementById('search-btn').after(countEl);
      }
      countEl.style.display = 'inline';
      countEl.textContent = visibleCount + ' found';
    }

    function clearSearch() {
      searchInput.value = '';
      allRows.forEach(row => { row.style.display = ''; });
      const countEl = document.getElementById('search-count');
      if (countEl) countEl.style.display = 'none';
      searchInput.focus();
    }

    // Allow Enter key in search input
    searchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') searchContacts();
    });
  </script>
</body>
</html>`;
}

// Helper used inside the template to extract phone from JID
function extractPhoneInTemplate(jid) {
  if (!jid) return '';
  const local = jid.split('@')[0];
  return local.split(':')[0].split('.')[0];
}

function renderChatPage(phone, name) {
  const safePhone = escapeHtml(phone);
  const safeName = escapeHtml(name);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Chat — ${safeName}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      background: #111b21;
      color: #e9edef;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    .chat-header {
      background: #202c33;
      border-bottom: 1px solid #2a3942;
      padding: 12px 20px;
      display: flex;
      align-items: center;
      gap: 14px;
      flex-shrink: 0;
    }
    .chat-header .back-btn {
      color: #8696a0;
      text-decoration: none;
      font-size: 1.4rem;
      padding: 4px 8px;
      border-radius: 6px;
      transition: background 0.2s;
    }
    .chat-header .back-btn:hover { background: #182229; }
    .chat-header .contact-name {
      font-size: 1.1rem;
      font-weight: 600;
      color: #e9edef;
    }
    .chat-header .contact-jid {
      font-size: 0.75rem;
      color: #8696a0;
    }

    /* Messages area */
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .chat-messages .empty-state {
      text-align: center;
      color: #8696a0;
      margin-top: 80px;
      font-size: 0.9rem;
    }
    .msg-row {
      display: flex;
      margin-bottom: 4px;
      max-width: 70%;
    }
    .msg-row.sent {
      align-self: flex-end;
      justify-content: flex-end;
    }
    .msg-row.sent .msg-bubble {
      background: #005c4b;
      color: #e9edef;
      border-radius: 12px 12px 2px 12px;
    }
    .msg-row .msg-bubble {
      background: #202c33;
      color: #e9edef;
      padding: 8px 14px;
      border-radius: 12px 12px 12px 2px;
      font-size: 0.92rem;
      line-height: 1.4;
      word-break: break-word;
      position: relative;
    }
    .msg-row .msg-time {
      font-size: 0.7rem;
      color: #8696a0;
      margin-top: 2px;
      text-align: right;
    }
    .msg-row .msg-status {
      font-size: 0.7rem;
      color: #8696a0;
      margin-left: 6px;
    }
    .msg-row .msg-status.ok { color: #00a884; }
    .msg-row .msg-status.fail { color: #f15c6d; }

    /* Input area */
    .chat-input-wrap {
      background: #202c33;
      border-top: 1px solid #2a3942;
      padding: 12px 20px;
      display: flex;
      gap: 10px;
      align-items: center;
      flex-shrink: 0;
    }
    .chat-input-wrap input {
      flex: 1;
      padding: 10px 16px;
      background: #2a3942;
      border: 1px solid #2a3942;
      border-radius: 24px;
      color: #e9edef;
      font-size: 0.95rem;
      outline: none;
      transition: border 0.2s;
    }
    .chat-input-wrap input:focus { border-color: #00a884; }
    .chat-input-wrap input::placeholder { color: #667781; }
    .chat-input-wrap .send-btn {
      width: 44px; height: 44px;
      border-radius: 50%;
      border: none;
      background: #00a884;
      color: #fff;
      font-size: 1.2rem;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.2s;
      flex-shrink: 0;
    }
    .chat-input-wrap .send-btn:hover { background: #008f6f; }
    .chat-input-wrap .send-btn:disabled {
      background: #2a3942;
      color: #667781;
      cursor: not-allowed;
    }

    /* Attach button */
    .attach-btn {
      width: 40px; height: 40px;
      border-radius: 50%;
      border: none;
      background: #2a3942;
      color: #8696a0;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s;
      flex-shrink: 0;
    }
    .attach-btn:hover { background: #374248; color: #00a884; }
    .attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    body.deepseek-chat .attach-btn { background: #2a2a4a; }
    body.deepseek-chat .attach-btn:hover { background: #3a3a6a; color: #a78bfa; }

    /* Pending attachment preview bar */
    .pending-bar {
      display: none;
      align-items: center;
      gap: 10px;
      padding: 8px 16px;
      background: #1a2a1a;
      border-top: 1px solid #2a3942;
      flex-shrink: 0;
    }
    .pending-bar.show { display: flex; }
    .pending-bar .pending-preview {
      width: 48px; height: 48px;
      border-radius: 6px;
      object-fit: cover;
      flex-shrink: 0;
      background: #2a3942;
    }
    .pending-bar .pending-info {
      flex: 1; min-width: 0;
    }
    .pending-bar .pending-name {
      font-size: 0.82rem; color: #e9edef;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pending-bar .pending-hint {
      font-size: 0.7rem; color: #8696a0; margin-top: 1px;
    }
    .pending-bar .pending-cancel {
      width: 28px; height: 28px;
      border-radius: 50%; border: none;
      background: #3a2a2a; color: #f15c6d;
      font-size: 1rem; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; line-height: 1;
    }
    .pending-bar .pending-cancel:hover { background: #5a2a2a; }
    body.deepseek-chat .pending-bar { background: #12122a; border-top-color: #2a2a4a; }
    body.deepseek-chat .pending-bar .pending-preview { background: #2a2a4a; }

    /* Media in messages */
    .msg-media {
      max-width: 260px;
      max-height: 260px;
      border-radius: 8px;
      margin-bottom: 6px;
      display: block;
      cursor: pointer;
      object-fit: cover;
    }
    .msg-media.video-thumb {
      position: relative;
    }
    .msg-file {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      background: rgba(255,255,255,0.06);
      border-radius: 8px;
      margin-bottom: 6px;
      min-width: 180px;
    }
    .msg-file .file-icon {
      font-size: 1.6rem;
      flex-shrink: 0;
    }
    .msg-file .file-info {
      min-width: 0;
    }
    .msg-file .file-name {
      font-size: 0.85rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
    }
    .msg-file .file-size {
      font-size: 0.72rem;
      color: #8696a0;
      margin-top: 2px;
    }
    .msg-caption {
      font-size: 0.88rem;
      line-height: 1.4;
      word-break: break-word;
    }

    /* DeepSeek chat theme */
    body.deepseek-chat { background: #0a0a1a; }
    body.deepseek-chat .chat-header { background: #12122a; border-bottom-color: #2a2a4a; }
    body.deepseek-chat .send-btn { background: linear-gradient(135deg, #6c5ce7, #a78bfa); }
    body.deepseek-chat .send-btn:hover { background: linear-gradient(135deg, #5b4bd5, #9680ea); }
    body.deepseek-chat .chat-input-wrap { background: #12122a; border-top-color: #2a2a4a; }
    body.deepseek-chat .msg-row.sent .msg-bubble { background: #2d1b69; }
    body.deepseek-chat .msg-row .msg-bubble { background: #1a1a3e; }
    body.deepseek-chat .chat-input-wrap input:focus { border-color: #6c5ce7; }
    body.deepseek-chat .contact-name { color: #a78bfa; }

    /* Typing indicator */
    .typing-indicator {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 8px 14px;
    }
    .typing-indicator span {
      width: 8px; height: 8px;
      background: #a78bfa;
      border-radius: 50%;
      animation: typing-bounce 1.4s ease-in-out infinite;
    }
    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes typing-bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-8px); }
    }
  </style>
</head>
<body data-phone="${safePhone}" class="${safePhone === DEEPSEEK_JID ? 'deepseek-chat' : ''}">
  <div class="chat-header">
    <a href="/success" class="back-btn">←</a>
    <div>
      <div class="contact-name">${safeName}</div>
      <div class="contact-jid">${safePhone}</div>
    </div>
  </div>

  <div class="chat-messages" id="messages">
    <div class="empty-state">No messages yet. Say hello! 👋</div>
  </div>

  <div class="pending-bar" id="pending-bar">
    <img class="pending-preview" id="pending-preview" src="" alt="" />
    <div class="pending-info">
      <div class="pending-name" id="pending-name"></div>
      <div class="pending-hint">Type a prompt and send together</div>
    </div>
    <button class="pending-cancel" id="pending-cancel" title="Remove attachment">✕</button>
  </div>

  <div class="chat-input-wrap">
    <input type="file" id="file-input" style="display:none" accept="image/*,video/*,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain,application/zip" />
    <button class="attach-btn" id="attach-btn" title="Attach image, video, or document">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path>
      </svg>
    </button>
    <input
      type="text"
      id="message-input"
      placeholder="Type a message..."
      autocomplete="off"
      onkeydown="if(event.key==='Enter') sendMessage()"
    />
    <button class="send-btn" id="send-btn" onclick="sendMessage()">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="2" x2="11" y2="13"></line>
        <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
      </svg>
    </button>
  </div>

  <script>
    const PHONE = document.body.dataset.phone;
    const IS_DEEPSEEK = PHONE === '${escapeHtml(DEEPSEEK_JID)}';
    const SEND_URL = IS_DEEPSEEK ? '/api/chat/deepseek' : '/api/chat/send';

    const msgContainer = document.getElementById('messages');
    const msgInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const fileInput = document.getElementById('file-input');
    const attachBtn = document.getElementById('attach-btn');

    // Update placeholder for DeepSeek
    if (IS_DEEPSEEK) {
      msgInput.placeholder = 'Ask DeepSeek anything...';
    }

    function escapeHtml(text) {
      const d = document.createElement('div');
      d.textContent = text;
      return d.innerHTML;
    }

    function nowTime() {
      return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatFileSize(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1048576).toFixed(1) + ' MB';
    }

    function getFileIcon(mimeType) {
      if (mimeType.startsWith('image/')) return '🖼️';
      if (mimeType.startsWith('video/')) return '🎬';
      if (mimeType.includes('pdf')) return '📕';
      if (mimeType.includes('word') || mimeType.includes('document')) return '📝';
      if (mimeType.includes('sheet') || mimeType.includes('excel')) return '📊';
      if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('compress')) return '📦';
      if (mimeType.startsWith('text/')) return '📄';
      return '📎';
    }

    function addMediaMessage(dataUrl, caption, sent, fileInfo) {
      const empty = msgContainer.querySelector('.empty-state');
      if (empty) empty.remove();

      const row = document.createElement('div');
      row.className = 'msg-row ' + (sent ? 'sent' : 'received');

      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';

      const mimeType = dataUrl.match(/^data:([^;]+);/) || [];
      const mime = (fileInfo && fileInfo.type) ? fileInfo.type : (mimeType[1] || '');

      if (mime.startsWith('image/')) {
        // Show image inline
        const img = document.createElement('img');
        img.src = dataUrl;
        img.className = 'msg-media';
        img.title = 'Click to view full size';
        img.onclick = function() { window.open(dataUrl, '_blank'); };
        bubble.appendChild(img);
      } else if (mime.startsWith('video/')) {
        // Show video element
        const vid = document.createElement('video');
        vid.src = dataUrl;
        vid.className = 'msg-media';
        vid.controls = true;
        vid.preload = 'metadata';
        bubble.appendChild(vid);
      } else {
        // Show file card with icon
        const fileCard = document.createElement('div');
        fileCard.className = 'msg-file';
        const icon = document.createElement('span');
        icon.className = 'file-icon';
        icon.textContent = getFileIcon(mime);
        const info = document.createElement('div');
        info.className = 'file-info';
        const name = document.createElement('div');
        name.className = 'file-name';
        name.textContent = (fileInfo && fileInfo.name) ? fileInfo.name : 'File';
        const size = document.createElement('div');
        size.className = 'file-size';
        size.textContent = (fileInfo && fileInfo.size) ? formatFileSize(fileInfo.size) : '';
        info.appendChild(name);
        info.appendChild(size);
        fileCard.appendChild(icon);
        fileCard.appendChild(info);
        bubble.appendChild(fileCard);
      }

      if (caption) {
        const cap = document.createElement('div');
        cap.className = 'msg-caption';
        cap.textContent = caption;
        bubble.appendChild(cap);
      }

      const timeDiv = document.createElement('div');
      timeDiv.className = 'msg-time';
      timeDiv.textContent = nowTime();

      bubble.appendChild(timeDiv);
      row.appendChild(bubble);
      msgContainer.appendChild(row);
      msgContainer.scrollTop = msgContainer.scrollHeight;
      return row;
    }

    function addMessage(text, sent, status) {
      // Remove empty state if present
      const empty = msgContainer.querySelector('.empty-state');
      if (empty) empty.remove();

      const row = document.createElement('div');
      row.className = 'msg-row ' + (sent ? 'sent' : 'received');

      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';

      const content = document.createElement('div');
      content.textContent = text;

      const timeDiv = document.createElement('div');
      timeDiv.className = 'msg-time';
      timeDiv.textContent = nowTime();
      if (status) {
        const s = document.createElement('span');
        s.className = 'msg-status ' + (status === 'ok' ? 'ok' : 'fail');
        s.textContent = status === 'ok' ? '✓' : '✗';
        timeDiv.appendChild(s);
      }

      bubble.appendChild(content);
      bubble.appendChild(timeDiv);
      row.appendChild(bubble);
      msgContainer.appendChild(row);
      msgContainer.scrollTop = msgContainer.scrollHeight;
      return row;
    }

    function showTyping() {
      const row = document.createElement('div');
      row.className = 'msg-row received';
      row.id = 'typing-row';
      const bubble = document.createElement('div');
      bubble.className = 'msg-bubble';
      const dots = document.createElement('div');
      dots.className = 'typing-indicator';
      dots.innerHTML = '<span></span><span></span><span></span>';
      bubble.appendChild(dots);
      row.appendChild(bubble);
      msgContainer.appendChild(row);
      msgContainer.scrollTop = msgContainer.scrollHeight;
    }

    function hideTyping() {
      const typingRow = document.getElementById('typing-row');
      if (typingRow) typingRow.remove();
    }

    // ── Pending attachment state ─────────────────────────────
    let pendingFile = null; // { dataUrl, name, size, type }

    const pendingBar = document.getElementById('pending-bar');
    const pendingPreview = document.getElementById('pending-preview');
    const pendingName = document.getElementById('pending-name');
    const pendingCancel = document.getElementById('pending-cancel');

    function showPendingBar(file, dataUrl) {
      pendingFile = { dataUrl, name: file.name, size: file.size, type: file.type };
      pendingName.textContent = file.name + ' (' + formatFileSize(file.size) + ')';
      if (file.type.startsWith('image/')) {
        pendingPreview.src = dataUrl;
        pendingPreview.style.display = '';
      } else if (file.type.startsWith('video/')) {
        pendingPreview.src = '';
        pendingPreview.style.display = 'none';
        pendingName.textContent = '🎬 ' + pendingName.textContent;
      } else {
        pendingPreview.src = '';
        pendingPreview.style.display = 'none';
        pendingName.textContent = getFileIcon(file.type) + ' ' + pendingName.textContent;
      }
      pendingBar.classList.add('show');
      msgInput.focus();
    }

    function clearPendingBar() {
      pendingFile = null;
      pendingPreview.src = '';
      pendingBar.classList.remove('show');
      fileInput.value = '';
    }

    pendingCancel.addEventListener('click', clearPendingBar);

    // ── File attachment handling — hold, don't send ──────────

    attachBtn.addEventListener('click', function() {
      fileInput.click();
    });

    fileInput.addEventListener('change', function() {
      const file = fileInput.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = function(e) {
        showPendingBar(file, e.target.result);
      };
      reader.readAsDataURL(file);
    });

    // ── Send message (text + optional pending media) ─────────

    async function sendMessage() {
      const text = msgInput.value.trim();
      const hasMedia = !!pendingFile;

      if (!text && !hasMedia) return;

      // Disable UI
      msgInput.value = '';
      sendBtn.disabled = true;
      attachBtn.disabled = true;

      // Capture pending file and clear the bar
      const media = pendingFile;
      clearPendingBar();

      // Show message + media preview immediately (optimistic)
      let row;
      if (media) {
        row = addMediaMessage(media.dataUrl, text || null, true, { name: media.name, size: media.size, type: media.type });
      } else {
        row = addMessage(text, true, null);
      }

      // For DeepSeek, show typing indicator
      if (IS_DEEPSEEK) {
        showTyping();
      }

      try {
        let resp, data;

        if (media) {
          // Media message — determine endpoint based on chat type
          if (IS_DEEPSEEK) {
            const body = { image: media.dataUrl, message: text || '' };
            if (!media.type.startsWith('image/')) {
              body.fileName = media.name;
            }
            resp = await fetch('/api/chat/deepseek', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            data = await resp.json();

            if (data.success && data.reply) {
              hideTyping();
              showTyping();
              setTimeout(() => {
                hideTyping();
                addMessage(data.reply, false, null);
              }, 400);
            }
          } else {
            // WhatsApp: determine endpoint
            let endpoint, payloadKey;
            if (media.type.startsWith('image/')) {
              endpoint = '/api/chat/send/image';
              payloadKey = 'image';
            } else if (media.type.startsWith('video/')) {
              endpoint = '/api/chat/send/video';
              payloadKey = 'video';
            } else {
              endpoint = '/api/chat/send/document';
              payloadKey = 'document';
            }

            const body = { phone: PHONE };
            body[payloadKey] = media.dataUrl;
            if (text) body.caption = text;
            if (payloadKey === 'document') body.fileName = media.name;

            resp = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });
            data = await resp.json();
          }
        } else {
          // Text-only message
          const body = IS_DEEPSEEK
            ? JSON.stringify({ message: text })
            : JSON.stringify({ phone: PHONE, message: text });
          resp = await fetch(SEND_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body
          });
          data = await resp.json();

          if (IS_DEEPSEEK && data.success && data.reply) {
            hideTyping();
            addMessage(data.reply, false, null);
          }
        }

        // Update status on the sent bubble
        const timeDiv = row.querySelector('.msg-time');
        if (timeDiv) {
          const s = document.createElement('span');
          s.className = 'msg-status ' + (data.success ? 'ok' : 'fail');
          s.textContent = data.success ? '✓' : '✗';
          timeDiv.appendChild(s);
        }
      } catch (err) {
        hideTyping();
        const timeDiv = row.querySelector('.msg-time');
        if (timeDiv) {
          const s = document.createElement('span');
          s.className = 'msg-status fail';
          s.textContent = '✗';
          timeDiv.appendChild(s);
        }
        console.error('Send error:', err);
      } finally {
        sendBtn.disabled = false;
        attachBtn.disabled = false;
        msgInput.focus();
      }
    }
  </script>
</body>
</html>`;
}

function renderErrorPage(title, detail) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Error — WhatsApp Test</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      background: #111b21;
      color: #e9edef;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      background: #202c33;
      border-radius: 12px;
      padding: 40px;
      max-width: 520px;
      width: 90%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    }
    .icon {
      font-size: 3rem;
      margin-bottom: 16px;
    }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 8px; color: #f15c6d; }
    p { color: #8696a0; font-size: 0.95rem; margin-bottom: 20px; }
    .detail {
      background: #2a1f1f;
      border: 1px solid #f15c6d;
      border-radius: 8px;
      padding: 16px;
      text-align: left;
      margin-bottom: 20px;
    }
    .detail h3 { color: #f15c6d; font-size: 0.85rem; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .detail pre { font-size: 0.78rem; color: #e9edef; white-space: pre-wrap; word-break: break-all; line-height: 1.5; }
    .btn {
      display: inline-block;
      padding: 12px 28px;
      background: #00a884;
      color: #fff;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 500;
    }
    .btn:hover { background: #008f6f; }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⚠️</div>
    <h1>${escapeHtml(title)}</h1>
    <p>Something went wrong while communicating with wuzapi. Make sure it's running at <code>${escapeHtml(WUZAPI_URL)}</code>.</p>
    <div class="detail">
      <h3>Error Details</h3>
      <pre>${escapeHtml(detail)}</pre>
    </div>
    <a href="/reset" class="btn">Try Again</a>
  </div>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================
// AUTO-START WUZAPI + START SERVER
// ============================================================

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function startWuzapi() {
  console.log('[wuzapi] Starting wuzapi.exe from ' + WUZAPI_DIR + ' ...');

  const wuzapiProcess = spawn(WUZAPI_EXE, [], {
    cwd: WUZAPI_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });

  wuzapiProcess.stdout.on('data', (data) => {
    console.log('[wuzapi] ' + data.toString().trim());
  });
  wuzapiProcess.stderr.on('data', (data) => {
    console.log('[wuzapi] ' + data.toString().trim());
  });
  wuzapiProcess.on('error', (err) => {
    console.error('[wuzapi] Failed to start:', err.message);
  });
  wuzapiProcess.on('exit', (code) => {
    console.log('[wuzapi] Process exited with code ' + code);
  });

  // Wait for wuzapi to be healthy
  console.log('[wuzapi] Waiting for health check...');
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    try {
      const resp = await axios.get(WUZAPI_URL + '/health', { timeout: 3000 });
      if (resp.data && resp.data.status === 'ok') {
        console.log('[wuzapi] ✓ Healthy — port 8082 ready (v' + resp.data.version + ')');
        return wuzapiProcess;
      }
    } catch (_) { /* still starting */ }
    if (i % 5 === 4) console.log('[wuzapi] Still waiting... (' + (i + 1) + 's)');
  }
  console.error('[wuzapi] ✗ Failed to start within 30 seconds');
  return null;
}

async function ensureUserLoggedIn() {
  console.log('[wuzapi] Discovering admin auth format...');
  await discoverAdminAuth();

  // Find or create the user with USER_TOKEN
  let userId;
  try {
    const usersResp = await adminRequest('GET', '/admin/users');
    const allUsers = usersResp && usersResp.data ? usersResp.data : usersResp;
    const existingUser = Array.isArray(allUsers) ? allUsers.find(u => u.token === USER_TOKEN) : null;

    if (existingUser) {
      userId = existingUser.id;
      console.log('[wuzapi] ✓ User exists: id=' + userId + ' token=' + USER_TOKEN);
    } else {
      const createResult = await adminRequest('POST', '/admin/users', {
        name: 'MyPhone',
        token: USER_TOKEN,
        webhook: '',
        events: 'Message,ReadReceipt'
      });
      userId = createResult.id;
      console.log('[wuzapi] ✓ User created: id=' + userId + ' token=' + USER_TOKEN);
    }
  } catch (err) {
    console.error('[wuzapi] ✗ Failed to manage user:', err.message);
    return;
  }

  // Check connection status and connect if needed
  try {
    const statusResp = await userRequest('GET', '/session/status', USER_TOKEN);
    const d = (statusResp && statusResp.data) || {};
    const loggedIn = d.loggedIn || d.LoggedIn;
    const connected = d.connected || d.Connected;

    if (loggedIn) {
      console.log('[wuzapi] ✓ Session already logged in — WhatsApp ready');
    } else if (connected) {
      console.log('[wuzapi] Session connected but not logged in — QR scan needed');
    } else {
      // Try to connect
      console.log('[wuzapi] Connecting session...');
      await userRequest('POST', '/session/connect', USER_TOKEN, {
        Subscribe: ['Message'],
        Immediate: true
      });
      console.log('[wuzapi] ✓ Session connect requested — QR may be needed');
    }
  } catch (err) {
    console.error('[wuzapi] Session status/connect error:', err.message);
  }
}

// ── Main startup sequence ──────────────────────────────────
(async () => {
  // 1. Start wuzapi
  const wuzapiProcess = await startWuzapi();
  if (!wuzapiProcess) {
    console.error('[startup] Wuzapi failed to start. Server will run but WhatsApp features will be unavailable.');
  }

  // 2. Ensure user exists and is connected
  if (wuzapiProcess) {
    await ensureUserLoggedIn();
  }

  // 3. Start Express server
  app.listen(PORT, () => {
    console.log('');
    console.log(`✓ Server running at http://localhost:${PORT}`);
    console.log(`  → Wuzapi:  ${WUZAPI_URL} ${wuzapiProcess ? '✅' : '❌'}`);
    console.log(`  → Admin:   ${ADMIN_TOKEN}`);
    console.log(`  → User:    ${USER_TOKEN}`);
    console.log('');
  });

  // 4. Cleanup on exit
  function cleanup() {
    console.log('[shutdown] Stopping wuzapi...');
    if (wuzapiProcess) {
      wuzapiProcess.kill('SIGTERM');
      setTimeout(() => { try { wuzapiProcess.kill('SIGKILL'); } catch (_) {} }, 3000);
    }
    process.exit(0);
  }
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', () => { try { wuzapiProcess.kill(); } catch (_) {} });
})();
