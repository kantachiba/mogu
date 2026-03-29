require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Firebase Admin Init ────────────────────────────────
function getServiceAccount() {
  // 1. 環境変数からの直接読み込み (Vercel用)
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (e) {
      console.warn("Invalid FIREBASE_SERVICE_ACCOUNT definition.");
    }
  }

  // 2. ローカルファイルからの読み込み (Vercelでは実行されないことが多い)
  try {
    const explicit = path.join(__dirname, 'serviceAccountKey.json');
    if (fs.existsSync(explicit)) return require(explicit);
    
    // Auto-detect firebase admin sdk key file
    const files = fs.readdirSync(__dirname).filter(f => f.match(/-firebase-adminsdk-.*\.json$/));
    if (files.length > 0) return require(path.join(__dirname, files[0]));
  } catch (err) {
    console.warn("Failed to load local service account file (Ignored on Vercel)");
  }
  
  return null;
}

const serviceAccount = getServiceAccount();
if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
} else {
  // Fallback: use application default credentials or env var
  admin.initializeApp();
}
const db = admin.firestore();

// ─── Local Fallback Config ──────────────────────────────
const FormData = require('form-data');
const isVercel = process.env.VERCEL === '1';
const UPLOADS_DIR = isVercel ? path.join('/tmp', 'uploads') : path.join(__dirname, 'public', 'uploads');
try {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
} catch (e) {
  console.warn("Failed to create uploads directory:", e.message);
}
// ─── API Keys ───────────────────────────────────────────
const SAKURA_API_KEY = process.env.SAKURA_API_KEY || '';

// ─── Auth Middleware ────────────────────────────────────
async function verifyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'ログインが必要です' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    req.userEmail = decoded.email;
    next();
  } catch (e) {
    console.error('Auth error:', e.message);
    return res.status(401).json({ error: '認証に失敗しました' });
  }
}

// ─── Firestore Helpers ──────────────────────────────────
function userDoc(uid) {
  return db.collection('users').doc(uid);
}

async function getUserConfig(uid) {
  const doc = await userDoc(uid).collection('data').doc('config').get();
  return doc.exists ? doc.data() : {
    sakuraApiUrl: 'https://api.ai.sakura.ad.jp/v1',
    model: 'gpt-oss-120b',
    ttsVoice: 'zundamon',
    allergies: [],
    dislikes: [],
    householdSize: 1,
    budget: 800,
    cookingLevel: 'beginner'
  };
}

async function setUserConfig(uid, config) {
  await userDoc(uid).collection('data').doc('config').set(config, { merge: true });
}

async function getUserHistory(uid) {
  const snapshot = await userDoc(uid).collection('history')
    .orderBy('cookedAt', 'desc')
    .limit(100)
    .get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function addUserHistory(uid, item) {
  const ref = await userDoc(uid).collection('history').add(item);
  return ref.id;
}

async function clearUserHistory(uid) {
  const snapshot = await userDoc(uid).collection('history').get();
  const batch = db.batch();
  snapshot.docs.forEach(doc => batch.delete(doc.ref));
  await batch.commit();
}

async function getUserPreferences(uid) {
  const doc = await userDoc(uid).collection('data').doc('preferences').get();
  return doc.exists ? doc.data() : {
    likedCategories: {},
    dislikedCategories: {},
    recentMeals: [],
    ratings: []
  };
}

async function setUserPreferences(uid, prefs) {
  await userDoc(uid).collection('data').doc('preferences').set(prefs, { merge: true });
}

async function getRagDoc(uid) {
  const doc = await userDoc(uid).collection('data').doc('rag').get();
  return doc.exists ? doc.data() : {};
}

async function setRagDoc(uid, data) {
  await userDoc(uid).collection('data').doc('rag').set(data);
}

// ─── Middleware ──────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── Routes ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.render('index');
});

// ─── API: Get Config ────────────────────────────────────
app.get('/api/config', verifyAuth, async (req, res) => {
  const config = await getUserConfig(req.uid);
  res.json(config);
});

// ─── API: Save Config ───────────────────────────────────
app.post('/api/config', verifyAuth, async (req, res) => {
  const current = await getUserConfig(req.uid);
  const updated = { ...current, ...req.body };
  await setUserConfig(req.uid, updated);

  // Re-sync RAG document automatically on setting changes
  await uploadPreferencesToRAG(req.uid, updated);

  res.json({ success: true });
});

// ─── API: Get History ───────────────────────────────────
app.get('/api/history', verifyAuth, async (req, res) => {
  const history = await getUserHistory(req.uid);
  res.json(history);
});

// ─── API: Clear History ─────────────────────────────────
app.delete('/api/history', verifyAuth, async (req, res) => {
  await clearUserHistory(req.uid);
  res.json({ success: true });
});

// ─── Sakura AI Helper ───────────────────────────────────
async function callSakuraChat(messages, config) {
  const apiKey = SAKURA_API_KEY;
  const apiUrl = config.sakuraApiUrl || 'https://api.ai.sakura.ad.jp/v1';
  const model = config.model || 'gpt-oss-120b';

  if (!apiKey) {
    throw new Error('APIキーがコード内で設定されていません。');
  }

  const response = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.8,
      max_tokens: 4000,
      stream: false
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Sakura AI API Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// ─── RAG: Upload User Preferences Document ──────────────
async function uploadPreferencesToRAG(uid, config) {
  const preferences = await getUserPreferences(uid);
  const history = await getUserHistory(uid);
  const apiKey = SAKURA_API_KEY;
  const apiUrl = config.sakuraApiUrl || 'https://api.ai.sakura.ad.jp/v1';

  if (!apiKey) return;

  // Build document content from preferences and history
  const recentMeals = history.slice(0, 20).map(h => h.title).join(', ');
  const likedStr = Object.entries(preferences.likedCategories || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}(${v}回)`)
    .join(', ');
  const dislikedStr = Object.entries(preferences.dislikedCategories || {})
    .map(([k, v]) => `${k}(${v}回)`)
    .join(', ');
  const ratingsStr = (preferences.ratings || []).slice(-10)
    .map(r => `${r.title}: ${r.score}点`)
    .join(', ');

  const docContent = `
## ユーザー傾向データ（最終更新: ${new Date().toISOString()}）

### 最近食べたメニュー（避けるべき）
${recentMeals || 'なし'}

### 好みのカテゴリ
${likedStr || 'まだデータなし'}

### 苦手なカテゴリ
${dislikedStr || 'まだデータなし'}

### 最近の評価
${ratingsStr || 'まだデータなし'}

### アレルギー
${(config.allergies || []).join(', ') || 'なし'}

### 苦手な食材
${(config.dislikes || []).join(', ') || 'なし'}

### 予算
${config.budget || 800}円以内

### 料理レベル
${config.cookingLevel || 'beginner'}
`;

  try {
    const tmpPath = path.join(UPLOADS_DIR, `preferences_${uid}.md`);
    fs.writeFileSync(tmpPath, docContent);
    
    // Cleanup old RAG doc if it exists
    const oldDoc = await getRagDoc(uid);
    if (oldDoc.id) {
      try {
        await fetch(`${apiUrl}/documents/${oldDoc.id}/`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
      } catch (e) {
        console.error('Failed to cleanup old RAG doc', e.message);
      }
    }

    const form = new FormData();
    form.append('file', fs.createReadStream(tmpPath));
    form.append('name', `mogu_preferences_${uid}`);
    form.append('tags', 'mogu_prefs');
    form.append('model', 'multilingual-e5-large');

    const res = await fetch(`${apiUrl}/documents/upload/`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        ...form.getHeaders()
      },
      body: form
    });

    const data = await res.json();
    if (data.id) {
      await setRagDoc(uid, { id: data.id });
      console.log('RAG doc updated:', data.id);
    }
    return docContent;
  } catch (e) {
    console.error('RAG upload error:', e);
    return null;
  }
}

// ─── Build Preferences Context ──────────────────────────
async function buildPreferencesContext(uid, config) {
  const preferences = await getUserPreferences(uid);
  const history = await getUserHistory(uid);

  const recentMeals = history.slice(0, 14).map(h => h.title);
  const likedCategories = Object.entries(preferences.likedCategories || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k]) => k);

  let context = '';

  if (recentMeals.length > 0) {
    context += `\n【最近食べたメニュー（これらは避けること）】\n${recentMeals.join('、')}\n`;
  }

  if (likedCategories.length > 0) {
    context += `\n【ユーザーの好みの傾向】\n${likedCategories.join('、')}\n`;
  }

  if (config.allergies && config.allergies.length > 0) {
    context += `\n【アレルギー（絶対に使わないこと）】\n${config.allergies.join('、')}\n`;
  }

  if (config.dislikes && config.dislikes.length > 0) {
    context += `\n【苦手な食材】\n${config.dislikes.join('、')}\n`;
  }

  if (config.budget) {
    context += `\n【一食の予算】\n${config.budget}円以内\n`;
  }

  const levelMap = {
    'beginner': '初心者（簡単な料理のみ）',
    'intermediate': '中級者',
    'advanced': '上級者'
  };
  context += `\n【料理レベル】\n${levelMap[config.cookingLevel] || '初心者'}\n`;

  return context;
}

// ─── API: Generate Menu Proposals ───────────────────────
app.post('/api/generate', verifyAuth, async (req, res) => {
  const config = await getUserConfig(req.uid);
  const { mealType, mood, customRequest } = req.body;

  const preferencesContext = await buildPreferencesContext(req.uid, config);

  const mealTypeText = {
    'breakfast': '朝食',
    'lunch': '昼食',
    'dinner': '夕食',
    'snack': '軽食・おやつ'
  }[mealType] || '夕食';

  const systemPrompt = `あなたは一人暮らしの料理アシスタント「mogu」です。
栄養バランスが良く、簡単に作れて、コスパの良い一人前の献立を提案します。

★重要ルール★
- 1つ目の提案（id:1）は「手作り献立」：自炊で作る通常の献立を提案してください。
- 2つ目の提案（id:2）は「レトルト・時短献立」：レトルト食品・インスタント食品・冷凍食品・市販の惣菜のみで構成してください。調理は「温める」「盛り付ける」「お湯を注ぐ」程度で済むものにしてください。具体的な商品名（例: ボンカレー、サトウのごはん、マルちゃんの味噌汁など）を使ってリアルに提案してください。

${preferencesContext}

以下の厳密なJSON形式で2つの献立案を出力してください。JSON以外のテキストは一切出力しないでください。

{
  "proposals": [
    {
      "id": 1,
      "title": "献立のタイトル",
      "time": "所要時間（例: 20分）",
      "calories": "総カロリー（例: 550kcal）",
      "cost": "概算費用（例: 450円）",
      "menu": {
        "main_staple": "主食（例: ご飯）",
        "main_dish": "主菜（例: 鶏の照り焼き）",
        "side_dish": "副菜（例: ほうれん草のお浸し）"
      },
      "ingredients": [
        {"name": "材料名", "amount": "量"}
      ],
      "tags": ["和食", "簡単", "節約"],
      "description": "この献立の簡単な説明（30文字程度）"
    }
  ]
}`;

  const userMessage = `${mealTypeText}の献立を2案提案してください。1案目は手作り、2案目はレトルト食品のみで構成してください。${mood ? `気分: ${mood}。` : ''}${customRequest ? `リクエスト: ${customRequest}` : ''}`;

  try {
    const ragDoc = await getRagDoc(req.uid);
    const apiUrl = config.sakuraApiUrl || 'https://api.ai.sakura.ad.jp/v1';
    let result = '';

    if (ragDoc.id) {
      // Use the true RAG Chat endpoint
      const ragRes = await fetch(`${apiUrl}/documents/chat/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SAKURA_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          distance_type: 'cosine',
          model: 'multilingual-e5-large',
          chat_model: config.model || 'gpt-oss-120b',
          query: userMessage,
          prompt: systemPrompt,
          tags: ['mogu_prefs'],
          use_full_content: true
        })
      });

      if (!ragRes.ok) {
        throw new Error(`RAG API Error: ${await ragRes.text()}`);
      }
      const data = await ragRes.json();
      result = data.answer;
    } else {
      // Fallback
      result = await callSakuraChat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ], config);
    }

    // Parse JSON from response (handle potential markdown code blocks)
    let jsonStr = result;
    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }
    // Also try to find JSON object directly
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) {
      jsonStr = objMatch[0];
    }

    const parsed = JSON.parse(jsonStr);
    res.json(parsed);
  } catch (e) {
    console.error('Generation error:', e);
    // Fallback with mock data if API fails
    res.json({
      proposals: [
        {
          id: 1,
          title: '鮭のバター醤油焼き定食',
          time: '20分',
          calories: '520kcal',
          cost: '480円',
          menu: {
            main_staple: 'ご飯',
            main_dish: '鮭のバター醤油焼き',
            side_dish: '小松菜のお浸し'
          },
          ingredients: [
            { name: '鮭切り身', amount: '1切れ' },
            { name: 'バター', amount: '10g' },
            { name: '醤油', amount: '大さじ1' },
            { name: '小松菜', amount: '1/2束' },
            { name: 'ご飯', amount: '1膳分' },
            { name: 'かつお節', amount: '適量' }
          ],
          tags: ['和食', '簡単', '魚料理', '手作り'],
          description: 'バター醤油の香ばしさが食欲をそそる定番おかず'
        },
        {
          id: 2,
          title: 'レトルトカレー＆サラダセット',
          time: '5分',
          calories: '650kcal',
          cost: '400円',
          menu: {
            main_staple: 'サトウのごはん',
            main_dish: 'ボンカレーゴールド（中辛）',
            side_dish: 'カット野菜サラダ'
          },
          ingredients: [
            { name: 'ボンカレーゴールド', amount: '1箱' },
            { name: 'サトウのごはん', amount: '1パック' },
            { name: 'カット野菜ミックス', amount: '1袋' },
            { name: 'ドレッシング', amount: '適量' }
          ],
          tags: ['レトルト', '時短', '節約', '洋食'],
          description: '温めるだけ5分！サラダを添えて栄養バランスもOK'
        }
      ],
      _mock: true,
      _error: e.message
    });
  }
});

// ─── API: Get Recipe Steps ──────────────────────────────
app.post('/api/recipe', verifyAuth, async (req, res) => {
  const config = await getUserConfig(req.uid);
  const { proposal } = req.body;

  const systemPrompt = `あなたは一人暮らしの料理アシスタント「mogu」です。
選択された献立の詳細な作り方を、わかりやすいステップ形式で出力してください。
各ステップは簡潔に、初心者でもわかるように記述してください。

以下の厳密なJSON形式で出力してください。JSON以外のテキストは一切出力しないでください。

{
  "steps": [
    {
      "step": 1,
      "title": "ステップのタイトル",
      "instruction": "詳しい説明（100文字程度）",
      "tip": "コツやポイント（省略可）",
      "time": "目安時間（例: 3分）"
    }
  ],
  "totalTime": "合計所要時間",
  "tips": ["全体のコツ1", "全体のコツ2"]
}`;

  const userMessage = `以下の献立の詳細な作り方をステップ形式で教えてください。

タイトル: ${proposal.title}
主食: ${proposal.menu.main_staple}
主菜: ${proposal.menu.main_dish}
副菜: ${proposal.menu.side_dish}
材料: ${proposal.ingredients.map(i => `${i.name} ${i.amount}`).join('、')}`;

  try {
    const result = await callSakuraChat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ], config);

    let jsonStr = result;
    const jsonMatch = result.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    const objMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objMatch) jsonStr = objMatch[0];

    const parsed = JSON.parse(jsonStr);
    res.json(parsed);
  } catch (e) {
    console.error('Recipe generation error:', e);
    // Fallback mock recipe
    res.json({
      steps: [
        { step: 1, title: '材料の準備', instruction: '材料を全て用意し、計量します。野菜は洗って水気を切っておきます。', tip: '先に全て準備しておくとスムーズです', time: '5分' },
        { step: 2, title: '下ごしらえ', instruction: '野菜を食べやすい大きさに切ります。肉や魚は必要に応じて下味をつけます。', tip: '包丁は手前に引くように切ると綺麗に切れます', time: '5分' },
        { step: 3, title: '加熱調理', instruction: 'フライパンに油を熱し、メインの食材を焼きます。中火で両面に焼き色がつくまで焼きましょう。', tip: '焼いている間は触りすぎないのがコツ', time: '8分' },
        { step: 4, title: '味付け', instruction: '調味料を加えて味を整えます。全体に絡めるように軽く炒め合わせます。', time: '2分' },
        { step: 5, title: '盛り付け', instruction: 'お皿にご飯を盛り、おかずを添えて完成です。副菜も一緒に盛り付けましょう。', tip: '彩りよく盛ると食欲アップ！', time: '2分' }
      ],
      totalTime: '約22分',
      tips: ['調味料は事前に合わせておくと楽です', '洗い物は料理の合間にやると効率的'],
      _mock: true,
      _error: e.message
    });
  }
});

// ─── API: Text-to-Speech (Sakura AI TTS) ────────────────
app.post('/api/tts', verifyAuth, async (req, res) => {
  const config = await getUserConfig(req.uid);
  const { text } = req.body;
  const apiKey = SAKURA_API_KEY;
  const apiUrl = config.sakuraApiUrl || 'https://api.ai.sakura.ad.jp/v1';

  if (!apiKey) {
    return res.status(400).json({ error: 'APIキーがコード内で設定されていません' });
  }

  const ttsModel = config.ttsVoice || 'zundamon';

  try {
    const response = await fetch(`${apiUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: ttsModel,
        input: text,
        voice: 'normal',
        response_format: 'wav'
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`TTS API Error (${response.status}): model=${ttsModel}`, errText);
      throw new Error(`TTS API Error (${response.status}): ${errText}`);
    }

    const audioBuffer = await response.buffer();
    res.set('Content-Type', 'audio/wav');
    res.send(audioBuffer);
  } catch (e) {
    console.error('TTS error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── API: Rate a meal ───────────────────────────────────
app.post('/api/rate', verifyAuth, async (req, res) => {
  const { historyId, title, score, tags, photoBase64 } = req.body;
  const preferences = await getUserPreferences(req.uid);

  // Handle Photo Upload
  let photoUrl = null;
  if (photoBase64) {
    try {
      const base64Data = photoBase64.replace(/^data:image\/\w+;base64,/, "");
      const buffer = Buffer.from(base64Data, 'base64');
      const filename = `photo_${historyId || Date.now()}.jpg`;
      fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
      photoUrl = `/uploads/${filename}`;
    } catch (e) {
      console.error('Photo save error:', e);
    }
  }

  // Update history item in Firestore
  if (historyId) {
    try {
      const histRef = userDoc(req.uid).collection('history').doc(historyId);
      const updateData = { rating: score };
      if (photoUrl) updateData.photo = photoUrl;
      await histRef.update(updateData);
    } catch (e) {
      console.error('History update error:', e);
    }
  }

  // Add to ratings
  if (!preferences.ratings) preferences.ratings = [];
  preferences.ratings.push({
    title,
    score,
    tags,
    photo: photoUrl,
    date: new Date().toISOString()
  });

  // Update liked/disliked categories
  if (tags && Array.isArray(tags)) {
    if (!preferences.likedCategories) preferences.likedCategories = {};
    if (!preferences.dislikedCategories) preferences.dislikedCategories = {};

    tags.forEach(t => {
      if (score >= 4) {
        preferences.likedCategories[t] = (preferences.likedCategories[t] || 0) + 1;
      } else if (score <= 2) {
        preferences.dislikedCategories[t] = (preferences.dislikedCategories[t] || 0) + 1;
      }
    });
  }

  await setUserPreferences(req.uid, preferences);

  // Try to upload preferences to RAG
  const config = await getUserConfig(req.uid);
  await uploadPreferencesToRAG(req.uid, config);

  res.json({ success: true });
});

// ─── API: Save to History ───────────────────────────────
app.post('/api/history', verifyAuth, async (req, res) => {
  const { proposal } = req.body;

  const item = {
    ...proposal,
    cookedAt: new Date().toISOString()
  };

  const id = await addUserHistory(req.uid, item);
  res.json({ success: true, id });
});

// ─── API: Get Preferences ──────────────────────────────
app.get('/api/preferences', verifyAuth, async (req, res) => {
  const preferences = await getUserPreferences(req.uid);
  res.json(preferences);
});

// ─── Start Server ───────────────────────────────────────
if (process.env.NODE_ENV !== 'production' || process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`\n🍽️  mogu - 献立提案アプリ`);
    console.log(`   http://localhost:${PORT}`);
    console.log(`   Press Ctrl+C to stop\n`);
  });
}

module.exports = app;
