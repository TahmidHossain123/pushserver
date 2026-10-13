const express = require('express');
const admin = require('firebase-admin');

// ১. পরিবেশ ভেরিয়েবল যাচাই (Environment Variables Validation)
const API_KEY = process.env.API_KEY;
const SERVICE_ACCOUNT_RAW = process.env.FIREBASE_SERVICE_ACCOUNT;
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

if (!API_KEY) {
  console.error('[CRITICAL] API_KEY environment variable is not set. Exiting process.');
  process.exit(1);
}

if (!SERVICE_ACCOUNT_RAW) {
  console.error('[CRITICAL] FIREBASE_SERVICE_ACCOUNT environment variable is not set. Exiting process.');
  process.exit(1);
}

// ২. Firebase Admin SDK ইনিশিয়ালাইজেশন (HTTP v1)
try {
  const serviceAccount = JSON.parse(SERVICE_ACCOUNT_RAW);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  console.log('[INFO] Firebase Admin SDK successfully initialized.');
} catch (error) {
  console.error('[CRITICAL] Failed to parse FIREBASE_SERVICE_ACCOUNT or initialize Firebase Admin SDK:', error.message);
  process.exit(1);
}

const app = express();

// ৩. পেলোড সাইজ লিমিট সহ মিডলওয়্যার সেটআপ
app.use(express.json({ limit: '10kb' }));

// ৪. অথেনটিকেশন মিডলওয়্যার (Shared Secret Validation)
const authenticateApiKey = (req, res, next) => {
  const clientKey = req.headers['x-api-key'];

  if (!clientKey || clientKey !== API_KEY) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Invalid or missing x-api-key header.'
    });
  }

  next();
};

// ৫. বেসিক সার্ভার ইনফরমেশন রাউট
app.get('/', (req, res) => {
  res.status(200).json({
    service: 'DIN Host Push Notification Server',
    status: 'running',
    runtime: 'Node.js 22'
  });
});

// ৬. হেলথ চেক রাউট
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// ৭. পুশ নোটিফিকেশন পাঠানোর রাউট
app.post('/send', authenticateApiKey, async (req, res) => {
  const { token, title, body, data } = req.body;

  // ইনপুট ভ্যালিডেশন
  if (!token || typeof token !== 'string' || token.trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'Bad Request: "token" field is required and must be a non-empty string.'
    });
  }

  if (!title || typeof title !== 'string' || title.trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'Bad Request: "title" field is required and must be a non-empty string.'
    });
  }

  if (!body || typeof body !== 'string' || body.trim() === '') {
    return res.status(400).json({
      success: false,
      error: 'Bad Request: "body" field is required and must be a non-empty string.'
    });
  }

  // ডেটা ফিল্ড ভ্যালিডেশন (যদি থাকে, তাহলে সব value স্ট্রিং হতে হবে - FCM নিয়ম অনুযায়ী)
  if (data !== undefined) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request: "data" must be a valid key-value object.'
      });
    }

    const hasInvalidValue = Object.values(data).some(val => typeof val !== 'string');
    if (hasInvalidValue) {
      return res.status(400).json({
        success: false,
        error: 'Bad Request: All values inside the "data" object must be strings.'
      });
    }
  }

  // FCM মেসেজ পেলোড তৈরি
  const message = {
    token: token.trim(),
    notification: {
      title: title.trim(),
      body: body.trim()
    },
    ...(data && Object.keys(data).length > 0 ? { data } : {})
  };

  try {
    const messageId = await admin.messaging().send(message);

    console.log(`[INFO] Notification successfully sent. Message ID: ${messageId}`);

    return res.status(200).json({
      success: true,
      messageId: messageId
    });
  } catch (error) {
    console.error(`[ERROR] FCM Delivery Failed. Code: ${error.code || 'UNKNOWN'} | Message: ${error.message}`);

    // FCM টোকেন সম্পর্কিত স্পেসিফিক হ্যান্ডলিং
    if (
      error.code === 'messaging/registration-token-not-registered' ||
      error.code === 'messaging/invalid-registration-token'
    ) {
      return res.status(404).json({
        success: false,
        error: 'The provided registration token is invalid, expired, or unregistered.'
      });
    }

    if (error.code === 'messaging/invalid-argument') {
      return res.status(400).json({
        success: false,
        error: 'Invalid notification payload structure.'
      });
    }

    // ইন্টারনাল ক্রেডেনশিয়াল বা সেনসিটিভ ডেটা ক্লায়েন্টকে না দেখানো
    return res.status(500).json({
      success: false,
      error: 'Failed to send push notification due to an internal server error.'
    });
  }
});

// গ্লোবাল এরর হ্যান্ডলার (ভুল JSON ফরম্যাট হ্যান্ডল করার জন্য)
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: 'Malformed JSON payload.'
    });
  }
  return res.status(500).json({
    success: false,
    error: 'Internal server error.'
  });
 Chrome});

// সার্ভার স্টার্ট
app.listen(PORT, HOST, () => {
  console.log(`[INFO] DIN Host Push Notification Server is running on http://${HOST}:${PORT}`);
});
