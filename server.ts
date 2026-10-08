import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';
import { initialPIBArticles } from './src/data/pibArticles.ts';
import { initialMockQuestions, initialMockTests } from './src/data/mockQuestions.ts';
import { PIBArticle, MockQuestion, MockTest, TestAttempt, User, RevisionItem } from './src/types/index.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.use(express.json({ limit: '10mb' }));

// Initialize GoogleGenAI server-side with required 'User-Agent': 'aistudio-build'
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

// =============================================================
// Prisma-Aligned In-Memory Store & State Management
// =============================================================
// Stores user states, subscription tiers, revision queues, and tests.
const articlesStore: PIBArticle[] = [...initialPIBArticles];
const testsStore: MockTest[] = [...initialMockTests];
const attemptsStore: TestAttempt[] = [];

// Revision queue: userId -> Record<articleId, RevisionItem>
const revisionQueueStore: Record<string, Record<string, RevisionItem>> = {
  'user-demo': {
    'pib-2025-01': { articleId: 'pib-2025-01', status: 'pending', addedAt: new Date().toISOString() },
    'pib-2025-02': { articleId: 'pib-2025-02', status: 'mastered', addedAt: new Date().toISOString() },
  },
};

// Users repository matching Prisma schema defaults
const usersStore: User[] = [
  {
    id: 'user-demo',
    name: 'Aspirant Shreyansh',
    email: 'shreyanshkumar1403@gmail.com',
    targetYear: '2025',
    optionalSubject: 'Public Administration',
    isGuest: false,
    freeTestsRemaining: 5,
    isSubscribed: false,
    planType: 'free',
    createdAt: new Date().toISOString(),
  },
];

function isAiConfigured(): boolean {
  return !!ai && !!process.env.GEMINI_API_KEY;
}

// -------------------------------------------------------------
// PUBLIC API ROUTES
// -------------------------------------------------------------

app.get('/api/health', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    aiEnabled: isAiConfigured(),
    articlesCount: articlesStore.length,
    testsCount: testsStore.length,
  });
});

// GET /api/pib/articles - Public feed with filtering
app.get('/api/pib/articles', (req: Request, res: Response) => {
  const { search, gsPaper, ministry, tag, pyqOnly } = req.query;
  let filtered = [...articlesStore];

  if (pyqOnly === 'true') {
    filtered = filtered.filter((a) => !!a.pyqYear);
  }

  if (typeof search === 'string' && search.trim() !== '') {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (a) =>
        a.title.toLowerCase().includes(q) ||
        a.ministry.toLowerCase().includes(q) ||
        a.topic.toLowerCase().includes(q) ||
        a.pibId.toLowerCase().includes(q) ||
        (a.pyqYear && a.pyqYear.toLowerCase().includes(q)) ||
        (a.pyqContext && a.pyqContext.toLowerCase().includes(q)) ||
        a.tags.some((t) => t.toLowerCase().includes(q)) ||
        a.prelimsTrapAlert.toLowerCase().includes(q)
    );
  }

  if (typeof gsPaper === 'string' && gsPaper !== 'ALL') {
    filtered = filtered.filter((a) => a.gsPaper === gsPaper);
  }

  if (typeof ministry === 'string' && ministry !== 'ALL') {
    filtered = filtered.filter((a) => a.ministry.toLowerCase() === ministry.toLowerCase());
  }

  if (typeof tag === 'string' && tag !== 'ALL') {
    filtered = filtered.filter((a) => a.tags.some((t) => t.toLowerCase() === tag.toLowerCase()));
  }

  res.json({ success: true, articles: filtered });
});

// -------------------------------------------------------------
// AUTHENTICATION & USER MANAGEMENT ROUTES
// -------------------------------------------------------------

app.post('/api/auth/register', (req: Request, res: Response) => {
  const { name, email, targetYear, optionalSubject } = req.body;
  if (!name || !email) {
    return res.status(400).json({ success: false, error: 'Name and email are required.' });
  }

  const existing = usersStore.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (existing) {
    return res.json({ success: true, user: existing, message: 'Existing profile loaded.' });
  }

  const newUser: User = {
    id: `user-${Date.now()}`,
    name,
    email,
    targetYear: targetYear || '2025',
    optionalSubject: optionalSubject || 'General Studies',
    isGuest: false,
    freeTestsRemaining: 5,
    isSubscribed: false,
    planType: 'free',
    createdAt: new Date().toISOString(),
  };

  usersStore.push(newUser);
  revisionQueueStore[newUser.id] = {};
  res.json({ success: true, user: newUser });
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const { email } = req.body;
  const user = usersStore.find((u) => u.email.toLowerCase() === (email || '').toLowerCase());
  if (user) {
    return res.json({ success: true, user });
  }

  // Create guest demo user with 5 free tests
  const guestUser: User = {
    id: `user-guest-${Date.now()}`,
    name: 'UPSC Aspirant',
    email: email || 'aspirant@civilservices.gov.in',
    targetYear: '2025',
    optionalSubject: 'Public Administration',
    isGuest: true,
    freeTestsRemaining: 5,
    isSubscribed: false,
    planType: 'free',
    createdAt: new Date().toISOString(),
  };

  usersStore.push(guestUser);
  revisionQueueStore[guestUser.id] = {};
  res.json({ success: true, user: guestUser });
});

// GET /api/user/:userId - Fetch current candidate status & subscription
app.get('/api/user/:userId', (req: Request, res: Response) => {
  const { userId } = req.params;
  const user = usersStore.find((u) => u.id === userId);
  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }
  const revisionItems = Object.values(revisionQueueStore[userId] || {});
  res.json({ success: true, user, revisionItems });
});

// -------------------------------------------------------------
// SUBSCRIPTION & FREEMIUM UPGRADE ROUTE
// -------------------------------------------------------------

// POST /api/user/subscribe - Upgrades user to Prelims 2027 Comprehensive Pass (₹299)
app.post('/api/user/subscribe', (req: Request, res: Response) => {
  const { userId, planType = 'prelims_2027' } = req.body;
  const user = usersStore.find((u) => u.id === userId) || usersStore[0];

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' });
  }

  user.isSubscribed = true;
  user.planType = planType;
  user.subscriptionExpiresAt = '2027-05-31T23:59:59Z';
  user.freeTestsRemaining = 9999; // Unlimited test generations

  res.json({
    success: true,
    message: 'Subscription successfully activated! Prelims 2027 Pro Pass is now active.',
    user,
  });
});

// -------------------------------------------------------------
// SIMPLIFIED REVISION QUEUE ROUTES
// -------------------------------------------------------------

// GET /api/user/revision/:userId - Get all revision items
app.get('/api/user/revision/:userId', (req: Request, res: Response) => {
  const { userId } = req.params;
  const items = Object.values(revisionQueueStore[userId] || {});
  res.json({ success: true, items });
});

// POST /api/user/revision/toggle - Add, remove, or toggle pending/mastered status
app.post('/api/user/revision/toggle', (req: Request, res: Response) => {
  const { userId, articleId, action, status } = req.body;
  const uid = userId || 'user-demo';

  if (!revisionQueueStore[uid]) {
    revisionQueueStore[uid] = {};
  }

  if (action === 'remove') {
    delete revisionQueueStore[uid][articleId];
    return res.json({ success: true, items: Object.values(revisionQueueStore[uid]) });
  }

  if (action === 'set_status') {
    if (revisionQueueStore[uid][articleId]) {
      revisionQueueStore[uid][articleId].status = status === 'mastered' ? 'mastered' : 'pending';
    }
    return res.json({ success: true, items: Object.values(revisionQueueStore[uid]) });
  }

  // Toggle bookmark add/remove
  if (revisionQueueStore[uid][articleId]) {
    delete revisionQueueStore[uid][articleId];
  } else {
    revisionQueueStore[uid][articleId] = {
      articleId,
      status: 'pending',
      addedAt: new Date().toISOString(),
    };
  }

  res.json({ success: true, items: Object.values(revisionQueueStore[uid]) });
});

// -------------------------------------------------------------
// DYNAMIC MOCK TEST GENERATION WITH PAYWALL LOGIC
// -------------------------------------------------------------

const handleGenerateTest = async (req: Request, res: Response) => {
  const { userId, articleIds, questionCount = 5, testTitle, category } = req.body;
  const user = usersStore.find((u) => u.id === userId) || usersStore[0];

  // Paywall Enforcement:
  if (!user.isSubscribed) {
    if (user.freeTestsRemaining <= 0) {
      return res.status(403).json({
        success: false,
        error: 'paywall_limit_reached',
        message: 'You have used all 5 free mock tests. Upgrade to the Prelims 2027 Pro Pass for unlimited AI mock tests.',
        freeTestsRemaining: 0,
      });
    }
    // Deduct 1 free mock test
    user.freeTestsRemaining = Math.max(0, user.freeTestsRemaining - 1);
  }

  const sourceArticles = articlesStore
    .filter((a) => (Array.isArray(articleIds) && articleIds.length > 0 ? articleIds.includes(a.id) : true))
    .slice(0, 5);

  if (!isAiConfigured() || !ai) {
    const fallbackTest: MockTest = {
      id: `test-curated-${Date.now()}`,
      title: testTitle || 'PIB High-Yield Prelims Test Series (Standard Format)',
      description: 'Handcrafted UPSC standard questions with statement elimination and negative marking based on official PIB releases.',
      sourceArticleIds: sourceArticles.map((a) => a.id),
      questions: initialMockQuestions.slice(0, Math.min(questionCount, initialMockQuestions.length)),
      durationMinutes: Math.min(questionCount * 2.5, 30),
      totalMarks: Math.min(questionCount, initialMockQuestions.length) * 2,
      createdAt: new Date().toISOString().split('T')[0],
    };
    testsStore.unshift(fallbackTest);
    return res.json({
      success: true,
      test: fallbackTest,
      freeTestsRemaining: user.freeTestsRemaining,
      isSubscribed: user.isSubscribed,
      generatedBy: 'curated_standard',
    });
  }

  try {
    const articlesContext = sourceArticles.map((a) => ({
      title: a.title,
      ministry: a.ministry,
      pibId: a.pibId,
      gsPaper: a.gsPaper,
      pyqYear: a.pyqYear,
      takeaways: a.keyTakeaways,
      trap: a.prelimsTrapAlert,
      static: a.staticStudyBox,
    }));

    const prompt = `You are the UPSC Civil Services Examination Paper Setter for General Studies Paper I (Prelims).
Create exactly ${questionCount} UPSC Prelims standard multiple-choice questions based on the following PIB Government of India releases:
Context: ${JSON.stringify(articlesContext)}

Focus GS category: ${category || 'Mixed GS-1, GS-2, GS-3'}

STRICT UPSC QUESTION REQUIREMENTS:
1. Question formats MUST reflect UPSC standards:
   - Statement-based: "Consider the following statements... Which of the statements given above is/are correct? (a) 1 only (b) 2 only (c) Both 1 and 2 (d) Neither 1 nor 2"
   - Pair-matching / Count-based: "Consider the following pairs/statements... How many of the above pairs/statements are correct? (a) Only one (b) Only two (c) All three (d) None"
2. Every question must test deep conceptual understanding, statutory vs constitutional differences, nodal agencies, funding nuances, and eliminate superficial reading.
3. Every question must have 4 options: A, B, C, D.
4. Detailed explanation must explicitly explain why EACH statement is correct or incorrect.
5. Provide a sharp "prelimsTip" (Elimination technique or UPSC exam trap).
6. Difficulty: "Moderate", "UPSC Standard", or "Tricky".

Output strictly valid JSON array of questions matching this schema:
[
  {
    "id": "q-1",
    "articleTitle": "string",
    "gsPaper": "GS-1" | "GS-2" | "GS-3" | "Current Events",
    "topic": "string",
    "questionType": "statement_based" | "pair_matching" | "single_choice",
    "questionText": "Full question text with numbered statements (1., 2., 3.)",
    "statements": ["1. ...", "2. ...", "3. ..."],
    "options": [
      { "id": "A", "text": "1 and 2 only" },
      { "id": "B", "text": "2 and 3 only" },
      { "id": "C", "text": "3 only" },
      { "id": "D", "text": "1, 2 and 3" }
    ],
    "correctAnswer": "B",
    "explanation": "Statement 1 is incorrect because... Statement 2 is correct...",
    "prelimsTip": "How an aspirant should eliminate wrong options under time pressure",
    "difficulty": "UPSC Standard"
  }
]`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const parsedQuestions: MockQuestion[] = JSON.parse(response.text?.trim() || '[]');
    const formattedQuestions: MockQuestion[] = parsedQuestions.map((q, idx) => ({
      ...q,
      id: `gen-q-${Date.now()}-${idx + 1}`,
      articleId: sourceArticles[idx % sourceArticles.length]?.id,
      options: q.options || [
        { id: 'A', text: '1 and 2 only' },
        { id: 'B', text: '2 and 3 only' },
        { id: 'C', text: '3 only' },
        { id: 'D', text: '1, 2 and 3' },
      ],
    }));

    const newTest: MockTest = {
      id: `test-gen-${Date.now()}`,
      title: testTitle || `PIB Mock Test: ${sourceArticles[0]?.topic || 'Current Affairs'} & Allied Topics`,
      description: `Targeted UPSC Prelims test based on latest PIB releases from ${sourceArticles.map((a) => a.ministry).slice(0, 3).join(', ')}.`,
      sourceArticleIds: sourceArticles.map((a) => a.id),
      questions: formattedQuestions,
      durationMinutes: Math.max(10, formattedQuestions.length * 2),
      totalMarks: formattedQuestions.length * 2,
      createdAt: new Date().toISOString().split('T')[0],
    };

    testsStore.unshift(newTest);
    res.json({
      success: true,
      test: newTest,
      freeTestsRemaining: user.freeTestsRemaining,
      isSubscribed: user.isSubscribed,
      generatedBy: 'gemini-3.8-flash',
    });
  } catch (err: any) {
    console.error('Error generating mock test with AI, falling back to UPSC standard bank:', err);
    const fallbackTest: MockTest = {
      id: `test-curated-${Date.now()}`,
      title: testTitle || `PIB High-Yield Prelims Test Series (${sourceArticles[0]?.topic || 'Current Affairs'})`,
      description: 'Handcrafted UPSC standard questions with statement elimination and negative marking based on official PIB releases.',
      sourceArticleIds: sourceArticles.map((a) => a.id),
      questions: initialMockQuestions.slice(0, Math.min(questionCount, initialMockQuestions.length)),
      durationMinutes: Math.min(questionCount * 2.5, 30),
      totalMarks: Math.min(questionCount, initialMockQuestions.length) * 2,
      createdAt: new Date().toISOString().split('T')[0],
    };
    testsStore.unshift(fallbackTest);
    res.json({
      success: true,
      test: fallbackTest,
      freeTestsRemaining: user.freeTestsRemaining,
      isSubscribed: user.isSubscribed,
      generatedBy: 'curated_standard_fallback',
    });
  }
};

// Handlers for both route conventions
app.post('/api/tests/generate', handleGenerateTest);
app.post('/api/mock-test/generate', handleGenerateTest);

// GET /api/mock-tests - List all mock tests
app.get('/api/mock-tests', (req: Request, res: Response) => {
  res.json({ success: true, tests: testsStore });
});

// POST /api/mock-tests/:id/submit - Submit test attempt
app.post('/api/mock-tests/:id/submit', (req: Request, res: Response) => {
  const { testId, testTitle, userAnswers, timeTakenSeconds } = req.body;
  const test = testsStore.find((t) => t.id === testId);

  if (!test) {
    return res.status(404).json({ success: false, error: 'Test not found' });
  }

  let correctCount = 0;
  let incorrectCount = 0;
  let unattemptedCount = 0;
  const subjectBreakdown: Record<string, { total: number; correct: number; incorrect: number }> = {};

  test.questions.forEach((q) => {
    const paper = q.gsPaper || 'General';
    if (!subjectBreakdown[paper]) {
      subjectBreakdown[paper] = { total: 0, correct: 0, incorrect: 0 };
    }
    subjectBreakdown[paper].total += 1;

    const chosen = userAnswers[q.id];
    if (!chosen) {
      unattemptedCount += 1;
    } else if (chosen === q.correctAnswer) {
      correctCount += 1;
      subjectBreakdown[paper].correct += 1;
    } else {
      incorrectCount += 1;
      subjectBreakdown[paper].incorrect += 1;
    }
  });

  const rawScore = correctCount * 2.0 - incorrectCount * 0.666;
  const score = Math.max(0, Number(rawScore.toFixed(2)));
  const maxScore = test.questions.length * 2.0;
  const attemptedTotal = correctCount + incorrectCount;
  const accuracy = attemptedTotal > 0 ? Number(((correctCount / attemptedTotal) * 100).toFixed(1)) : 0;

  const attempt: TestAttempt = {
    id: `attempt-${Date.now()}`,
    testId,
    testTitle: testTitle || test.title,
    timestamp: new Date().toISOString(),
    timeTakenSeconds: timeTakenSeconds || 0,
    userAnswers,
    score,
    maxScore,
    correctCount,
    incorrectCount,
    unattemptedCount,
    accuracy,
    subjectBreakdown,
  };

  attemptsStore.unshift(attempt);
  res.json({ success: true, attempt });
});

// GET /api/user/attempts - List test history
app.get('/api/user/attempts', (req: Request, res: Response) => {
  res.json({ success: true, attempts: attemptsStore });
});

// POST /api/ai/deep-dive - Prelims + PYQ Mentor breakdown
app.post('/api/ai/deep-dive', async (req: Request, res: Response) => {
  const { articleId } = req.body;
  const article = articlesStore.find((a) => a.id === articleId) || articlesStore[0];

  if (!isAiConfigured() || !ai) {
    return res.json({
      success: true,
      analysis: {
        prelimsHighYieldPoints: [
          `Constitutional / Statutory Authority: ${article.keyTakeaways?.statutoryOrConstitutional || 'Executive policy'}`,
          `Nodal Administrative Body: ${article.keyTakeaways?.nodalMinistryOrAgency || article.ministry}`,
          `Financial Architecture: ${article.keyTakeaways?.fundingPattern || 'Central Outlay'}`,
          `Key Target Metric: Note quantitative thresholds and exemption clauses.`,
        ],
        pyqLinkages: [
          article.pyqContext || 'UPSC Prelims: Related policy asked in earlier GS Paper 1.',
          'UPSC Prelims 2020: Question on Statutory Powers under Environmental Protection regimes',
        ],
        probablePrelimsQuestionDraft: `Consider statements regarding ${article.title}. Which of the statements is/are correct?`,
        mainsValueAddition: `Direct case study for GS Paper 2 (Governance) or GS Paper 3 (Resource mobilization & inclusive growth).`,
      },
    });
  }

  try {
    const prompt = `As a UPSC Civil Services Exam Mentor, provide an authoritative, deep-dive academic analysis of this PIB release for an aspirant:
Title: ${article.title}
Ministry: ${article.ministry}
Summary: ${article.summaryBullets?.join(' ')}
Key takeaways: ${JSON.stringify(article.keyTakeaways)}
Static Box: ${JSON.stringify(article.staticStudyBox)}

Return JSON with:
{
  "prelimsHighYieldPoints": ["Point 1", "Point 2", "Point 3", "Point 4"],
  "pyqLinkages": ["Exact past year UPSC Prelims/Mains question context 1", "Context 2"],
  "probablePrelimsQuestionDraft": "A draft question idea testing tricky provisions",
  "mainsValueAddition": "2-3 sentences on how to quote this in GS Mains answers (arguments, facts, quotes)",
  "eliminationHeuristic": "How to spot common misdirections by UPSC on this topic"
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const parsed = JSON.parse(response.text?.trim() || '{}');
    res.json({ success: true, analysis: parsed });
  } catch (err: any) {
    console.error('Error generating deep dive:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to generate deep dive' });
  }
});

// -------------------------------------------------------------
// Production / Dev Vite Middlewares
// -------------------------------------------------------------

async function startServer() {
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req: Request, res: Response) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[PIB Prelims Edge Server] listening on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
