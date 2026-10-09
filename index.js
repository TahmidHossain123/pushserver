const express = require('express');
const admin = require('firebase-admin');
const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// ════════════════════════════════════════════════════════════
// FIREBASE INITIALIZATION
// ════════════════════════════════════════════════════════════

function getServiceAccount() {
  const potentialPaths = [
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH,
    '/etc/secrets/serviceAccountKey.json',
    path.resolve(__dirname, 'serviceAccountKey.json')
  ].filter(Boolean);

  for (const filePath of potentialPaths) {
    const resolvedPath = path.resolve(filePath);
    if (fs.existsSync(resolvedPath)) {
      try {
        const fileContent = fs.readFileSync(resolvedPath, 'utf8');
        return JSON.parse(fileContent);
      } catch (err) {
        console.error(`Failed to parse JSON credentials at ${resolvedPath}:`, err.message);
      }
    }
  }

  // Backup check: Direct raw JSON string in environment variable
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (err) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON environment variable:', err.message);
    }
  }

  return null;
}

if (!admin.apps.length) {
  const serviceAccount = getServiceAccount();

  if (!serviceAccount) {
    console.error('FATAL ERROR: Firebase Service Account credentials not found in any specified path or environment variable.');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('Firebase Admin SDK initialized successfully.');
}

const db = admin.firestore();

// ════════════════════════════════════════════════════════════
// AUTHENTICATION & HELPERS
// ════════════════════════════════════════════════════════════

function isValidAppId(appId) {
  return typeof appId === 'string' && /^[a-zA-Z0-9._\-]{3,100}$/.test(appId);
}

function tokenDocId(token) {
  return token.replace(/[^a-zA-Z0-9]/g, '').substring(0, 20);
}

function devicesRef(appId) {
  return db.collection('push_tokens').doc(appId).collection('devices');
}

function appMetaRef(appId) {
  return db.collection('push_app_meta').doc(appId);
}

// Request Authentication Middleware
// Checks "x-api-key" or "authorization: Bearer <key>" or "req.body.password"
function authenticate(req, res, next) {
  const serverSecret = process.env.SERVER_API_KEY || process.env.APP_PASSWORD;
  
  if (!serverSecret) {
    return res.status(500).json({ 
      success: false, 
      error: 'Server authorization key is not configured on the environment.' 
    });
  }

  let clientSecret = req.headers['x-api-key'];

  if (!clientSecret && req.headers['authorization']) {
    const authHeader = req.headers['authorization'];
    if (authHeader.startsWith('Bearer ')) {
      clientSecret = authHeader.substring(7).trim();
    }
  }

  if (!clientSecret && req.body && req.body.password) {
    clientSecret = req.body.password;
  }

  if (!clientSecret || clientSecret !== serverSecret) {
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized: Invalid or missing authentication credentials.' 
    });
  }

  next();
}

// ════════════════════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.send('Wevlo Push Notification Server is Running!');
});

// App Status (Protected)
app.get('/app-status', authenticate, async (req, res) => {
  const { appId } = req.query;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    const metaDoc = await appMetaRef(appId).get();
    const tokenSnap = await devicesRef(appId).get();
    res.json({
      success: true,
      appId,
      registered: metaDoc.exists,
      registeredAt: metaDoc.exists ? metaDoc.data().registeredAt : null,
      tokenCount: tokenSnap.size
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Register App (Protected)
app.post('/register-app', authenticate, async (req, res) => {
  const { appId } = req.body;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    const ref = appMetaRef(appId);
    const doc = await ref.get();

    await ref.set({
      appId,
      registeredAt: doc.exists ? doc.data().registeredAt : Date.now(),
      updatedAt: Date.now()
    }, { merge: true });

    console.log(`[${appId}] App registered/updated`);
    res.json({ success: true, message: 'app registered' });
  } catch (e) {
    console.error('Register-app error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Register Token (Publicly accessible from client APKs)
app.post('/register-token', async (req, res) => {
  const { token, appId, userAgent } = req.body;

  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, error: 'token required' });
  }
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    await devicesRef(appId).doc(tokenDocId(token)).set({
      token,
      appId,
      userAgent: userAgent || '',
      registeredAt: Date.now(),
      updatedAt: Date.now()
    }, { merge: true });

    res.json({ success: true });
  } catch (e) {
    console.error('Register token error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Get tokens by appId (Protected)
app.get('/tokens', authenticate, async (req, res) => {
  const { appId } = req.query;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    const snap = await devicesRef(appId).get();
    const tokens = snap.docs.map(d => ({
      token: d.data().token,
      registeredAt: d.data().registeredAt,
      userAgent: d.data().userAgent || ''
    }));
    res.json({ success: true, appId, count: tokens.length, tokens });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Send notification to a single token (Protected)
app.post('/send-notification', authenticate, async (req, res) => {
  const { token, title, body, imageUrl } = req.body;
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, error: 'token required' });
  }

  try {
    const t = title || 'Notification';
    const b = body || '';

    const message = {
      token,
      data: { 
        title: String(t), 
        body: String(b), 
        ...(imageUrl ? { imageUrl: String(imageUrl) } : {}) 
      },
      android: { priority: 'high' }
    };

    const msgId = await admin.messaging().send(message);
    res.json({ success: true, messageId: msgId });
  } catch (e) {
    console.error('Send error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Send to ALL tokens of an appId (Protected)
app.post('/send-all', authenticate, async (req, res) => {
  const { appId, title, body, imageUrl } = req.body;
  if (!isValidAppId(appId)) {
    return res.status(400).json({ success: false, error: 'valid appId required' });
  }

  try {
    const snap = await devicesRef(appId).get();
    if (snap.empty) {
      return res.json({ success: false, error: 'No tokens found for this app' });
    }

    const docs = snap.docs;
    const tokens = docs.map(d => d.data().token).filter(Boolean);

    if (tokens.length === 0) {
      return res.json({ success: false, error: 'No valid tokens found for this app' });
    }

    const t = title || 'Notification';
    const b = body || '';

    const messages = tokens.map(token => ({
      token,
      data: { 
        title: String(t), 
        body: String(b), 
        ...(imageUrl ? { imageUrl: String(imageUrl) } : {}) 
      },
      android: { priority: 'high' }
    }));

    // sendEach allows sending up to 500 messages per call
    const result = await admin.messaging().sendEach(messages);
    console.log(`[${appId}] Sent: ${result.successCount} ok, ${result.failureCount} failed`);

    // Prune ONLY permanently unregistered or invalid tokens
    const permanentErrors = [
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
      'messaging/invalid-argument'
    ];

    const batch = db.batch();
    let removed = 0;

    result.responses.forEach((resp, idx) => {
      if (!resp.success && resp.error) {
        if (permanentErrors.includes(resp.error.code)) {
          batch.delete(docs[idx].ref);
          removed++;
        }
      }
    });

    if (removed > 0) {
      await batch.commit();
      console.log(`[${appId}] Pruned ${removed} invalid/unregistered token(s).`);
    }

    res.json({
      success: true,
      appId,
      total: tokens.length,
      successCount: result.successCount,
      failureCount: result.failureCount,
      prunedCount: removed
    });
  } catch (e) {
    console.error('Send-all error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Delete a specific token (Protected)
app.delete('/token', authenticate, async (req, res) => {
  const appId = req.query.appId || (req.body && req.body.appId);
  const token = req.query.token || (req.body && req.body.token);

  if (!isValidAppId(appId) || !token) {
    return res.status(400).json({ success: false, error: 'valid appId and token required' });
  }

  try {
    await devicesRef(appId).doc(tokenDocId(token)).delete();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// SERVER START
// ════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
  console.log(`Wevlo Push Server running on port ${PORT}`);
});
