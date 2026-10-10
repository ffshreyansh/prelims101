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

function inferGSPaper(title: string, ministry: string, content = ''): PIBArticle['gsPaper'] {
  const text = `${title} ${ministry} ${content}`.toLowerCase();
  if (/defen[cs]|military|army|navy|space|isro|technology|innovation|science|economy|finance|mines|environment|climate|agriculture|fertilizer|energy|रक्षा|सैन्य|विज्ञान|तकनीक|अंतरिक्ष|ऊर्जा|पर्यावरण|जलवायु|कृषि|खान|आर्थिक|अर्थव्यवस्था|नवाचार/.test(text)) {
    return 'GS-3';
  }
  if (/minister|cabinet|government|parliament|president|vice-president|police|law|act|rights|international|summit|diplomatic|मंत्री|प्रधानमंत्री|राष्ट्रपति|उपराष्ट्रपति|संसद|कानून|अधिनियम|अधिकार|राजनयिक|सम्मेलन/.test(text)) {
    return 'GS-2';
  }
  return 'Current Events';
}

/**
 * Convert a Prisma Article DB record to the PIBArticle shape used by the frontend.
 */
function dbArticleToPIBArticle(dbArticle: any): PIBArticle {
  const staticStudyBox = (
    dbArticle.staticBookReference ||
    dbArticle.staticChapterTopic ||
    dbArticle.staticWhatToRead ||
    dbArticle.staticCoreArticlesOrActs?.length
  ) ? {
    standardBook: dbArticle.staticBookReference || '',
    chapterTopic: dbArticle.staticChapterTopic || '',
    whatToRead: dbArticle.staticWhatToRead || '',
    coreArticlesOrActs: dbArticle.staticCoreArticlesOrActs || [],
  } : undefined;

  return {
    id: dbArticle.id,
    title: dbArticle.title,
    ministry: dbArticle.ministry,
    date: dbArticle.date,
    pibId: dbArticle.pibId,
    gsPaper: dbArticle.topic === 'General Studies' && dbArticle.gsPaper === 'GS-1'
      ? inferGSPaper(dbArticle.title, dbArticle.ministry, dbArticle.fullContent || '')
      : (['GS-1', 'GS-2', 'GS-3', 'Current Events'].includes(dbArticle.gsPaper)
        ? dbArticle.gsPaper
        : 'Current Events') as PIBArticle['gsPaper'],
    topic: dbArticle.topic || 'General Studies',
    prelimsImportance: (dbArticle.prelimsImportance as PIBArticle['prelimsImportance']) || 3,
    tags: dbArticle.tags || [],
    summaryBullets: dbArticle.summaryBullets || [],
    keyTakeaways: {
      statutoryOrConstitutional: dbArticle.statutoryOrConstitutional || undefined,
      nodalMinistryOrAgency: dbArticle.nodalMinistryOrAgency || dbArticle.ministry,
      fundingPattern: dbArticle.fundingPattern || undefined,
      objectives: dbArticle.objectives || [],
      eligibleBeneficiaries: dbArticle.eligibleBeneficiaries || undefined,
      keyPointers: dbArticle.keyPointers || [],
    },
    prelimsTrapAlert: dbArticle.prelimsTrapAlert || 'No specific traps identified',
    pyqYear: dbArticle.pyqYear || undefined,
    pyqContext: dbArticle.pyqTopic || undefined,
    staticStudyBox,
    staticSyllabusLinkage: {
      subject: dbArticle.syllabusSubject || dbArticle.gsPaper || 'General Studies',
      articleOrAct: dbArticle.syllabusArticleOrAct || undefined,
      relatedConcepts: dbArticle.syllabusRelatedConcepts || [],
    },
    fullContent: dbArticle.fullContent || undefined,
    officialUrl: dbArticle.officialUrl || undefined,
  };
}

function sortArticlesByDate(articles: PIBArticle[]): PIBArticle[] {
  return [...articles].sort((a, b) => {
    const dateDifference = Date.parse(b.date) - Date.parse(a.date);
    if (Number.isFinite(dateDifference) && dateDifference !== 0) return dateDifference;
    return b.pibId.localeCompare(a.pibId, undefined, { numeric: true });
  });
}

// Load articles from MongoDB and use it as the source of truth when available.
async function loadArticlesFromDB(): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const dbArticles = await prisma.article.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    await prisma.$disconnect();

    if (dbArticles.length > 0) {
      const dbArticlesForFeed = dbArticles.map(dbArticleToPIBArticle);
      articlesStore.splice(0, articlesStore.length, ...sortArticlesByDate(dbArticlesForFeed));
      console.log(`[DB] Loaded ${dbArticles.length} persisted articles into the feed`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn('[DB] Could not load articles from MongoDB (non-fatal):', err instanceof Error ? err.message : err);
    return false;
  }
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

// GET /api/pib/articles - Public feed with filtering (merges in-memory + DB)
app.get('/api/pib/articles', async (req: Request, res: Response) => {
  await loadArticlesFromDB();
  const { search, gsPaper, ministry, tag, pyqOnly } = req.query;
  let filtered = sortArticlesByDate(articlesStore);

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

// -------------------------------------------------------------
// ARTICLE FETCHING SERVICE ROUTES
// -------------------------------------------------------------

// POST /api/articles/fetch - Scrape PIB, process with Gemini, save to MongoDB, update in-memory store
app.post('/api/articles/fetch', async (req: Request, res: Response) => {
  try {
    console.log('[PIB Fetch] Manual article fetch triggered');

    if (!isAiConfigured()) {
      return res.status(400).json({
        success: false,
        message: 'Gemini AI not configured. Please set GEMINI_API_KEY environment variable.',
      });
    }

    const { PIBScraper } = await import('./src/services/pibScraper.ts');
    const { ArticleProcessor } = await import('./src/services/articleProcessor.ts');
    
    let dbService: any = null;
    let canUseDB = false;
    try {
      const { DatabaseService } = await import('./src/services/databaseService.ts');
      dbService = new DatabaseService();
      canUseDB = true;
    } catch (dbError) {
      console.log('[PIB Fetch] Database service not available (Prisma client issue). Will scrape and process articles without saving to DB.');
      canUseDB = false;
    }

    const scraper = new PIBScraper();
    const processor = new ArticleProcessor(process.env.GEMINI_API_KEY);

    // Step 1: Scrape PIB homepage
    console.log('[PIB Fetch] Step 1: Scraping PIB homepage...');
    const scrapedArticles = await scraper.scrapeHomepage();
    console.log(`[PIB Fetch] Scraped ${scrapedArticles.length} articles`);

    if (scrapedArticles.length === 0) {
      if (dbService?.disconnect) await dbService.disconnect();
      return res.json({
        success: false,
        message: 'No articles found on PIB homepage. The site structure may have changed.',
        stats: { scraped: 0, new: 0, processed: 0, saved: 0, updated: 0, skipped: 0 },
      });
    }

    let newScraped = scrapedArticles;
    
    // Step 2: Filter out already-saved articles (only if DB is available)
    if (canUseDB && dbService) {
      console.log('[PIB Fetch] Step 2: Filtering already-saved articles...');
      newScraped = await dbService.filterNewArticles(scrapedArticles);
      console.log(`[PIB Fetch] ${newScraped.length} new articles (${scrapedArticles.length - newScraped.length} already in DB)`);

      if (newScraped.length === 0) {
        if (dbService?.disconnect) await dbService.disconnect();
        return res.json({
          success: true,
          message: 'All scraped articles are already in the database. Feed is up to date.',
          stats: { scraped: scrapedArticles.length, new: 0, processed: 0, saved: 0, updated: 0, skipped: scrapedArticles.length },
        });
      }
    } else {
      console.log(`[PIB Fetch] Skipping DB filtering (${scrapedArticles.length} articles total)`);
    }

    // Step 3: Fetch full content for new articles (rate-limited)
    console.log('[PIB Fetch] Step 3: Fetching full article content...');
    for (let i = 0; i < newScraped.length; i++) {
      const article = newScraped[i] as any;
      try {
        article.fullContent = await scraper.fetchArticleContent(article.url);
        console.log(`[PIB Fetch] Content fetched for ${i + 1}/${newScraped.length}: ${article.title.substring(0, 60)}`);
      } catch {
        article.fullContent = '';
      }
      if (i < newScraped.length - 1) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }

    // Step 4: Process with Gemini AI
    console.log('[PIB Fetch] Step 4: Processing with Gemini AI...');
    const processedResults = await processor.processArticles(newScraped as any);
    console.log(`[PIB Fetch] AI processed ${processedResults.length} articles`);

    // Step 5: Save to MongoDB (only if DB is available)
    let saveResult = { saved: 0, updated: 0, skipped: 0 };
    if (canUseDB && dbService) {
      console.log('[PIB Fetch] Step 5: Saving to MongoDB...');
      const articlesToSave = processedResults.map((r) => r.processedArticle);
      saveResult = await dbService.saveArticles(articlesToSave);
      console.log(`[PIB Fetch] Saved: ${saveResult.saved}, Updated: ${saveResult.updated}, Skipped: ${saveResult.skipped}`);
    } else {
      console.log('[PIB Fetch] Step 5: Skipping MongoDB save (DB not available)');
    }

    // Step 6: Refresh from MongoDB so the response and next page load use persisted data.
    if (canUseDB && dbService) {
      await dbService.disconnect();
      await loadArticlesFromDB();
      dbService = null;
    }

    // Fall back to adding processed articles in memory when MongoDB is unavailable.
    const newPIBArticles: PIBArticle[] = processedResults.map((r, idx) => {
      const p = r.processedArticle;
      const scraped = newScraped[idx] as any;
      return {
        id: `pib-live-${Date.now()}-${idx}`,
        title: p.title || scraped.title,
        ministry: p.ministry || scraped.ministry,
        date: p.date || scraped.date,
        pibId: p.pibId || scraped.pibId,
        gsPaper: (p.gsPaper as PIBArticle['gsPaper']) || 'Current Events',
        topic: p.topic || 'General Studies',
        prelimsImportance: (p.prelimsImportance as PIBArticle['prelimsImportance']) || 3,
        tags: p.tags || ['pib-live'],
        summaryBullets: p.summaryBullets || [scraped.summary],
        keyTakeaways: p.keyTakeaways || {
          keyPointers: [],
          nodalMinistryOrAgency: scraped.ministry,
        },
        prelimsTrapAlert: p.prelimsTrapAlert || 'No specific traps identified',
        pyqYear: p.pyqYear,
        pyqContext: p.pyqContext,
        staticStudyBox: p.staticStudyBox,
        staticSyllabusLinkage: p.staticSyllabusLinkage || {
          subject: 'General Studies',
          relatedConcepts: [],
        },
        fullContent: scraped.fullContent,
        officialUrl: scraped.url,
      } as PIBArticle;
    });

    // Prepend to in-memory store (avoid duplicates by pibId)
    const existingPibIds = new Set(articlesStore.map((a) => a.pibId));
    const toAdd = newPIBArticles.filter((a) => !existingPibIds.has(a.pibId));
    articlesStore.unshift(...toAdd);
    articlesStore.splice(0, articlesStore.length, ...sortArticlesByDate(articlesStore));

    if (dbService?.disconnect) await dbService.disconnect();

    const dbStatus = canUseDB ? `saved ${saveResult.saved} to MongoDB` : 'added to feed (database not available)';
    
    res.json({
      success: true,
      message: `Fetched ${scrapedArticles.length} articles, processed ${processedResults.length} new ones with Gemini AI, ${dbStatus}.`,
      articles: toAdd.map((a) => ({
        id: a.id,
        title: a.title,
        ministry: a.ministry,
        date: a.date,
        gsPaper: a.gsPaper,
        topic: a.topic,
        prelimsImportance: a.prelimsImportance,
      })),
      stats: {
        scraped: scrapedArticles.length,
        new: newScraped.length,
        added: saveResult.saved + toAdd.length,
        processed: processedResults.length,
        saved: saveResult.saved,
        updated: saveResult.updated,
        skipped: saveResult.skipped,
        totalArticles: articlesStore.length,
        lastFetch: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[PIB Fetch] Error:', error);
    res.status(500).json({
      success: false,
      message: `Internal server error: ${error instanceof Error ? error.message : 'Unknown error'}`,
    });
  }
});

// POST /api/pib/fetch-live - Fetch a single article for a given ministry/topic (used by FetchPibModal)
app.post('/api/pib/fetch-live', async (req: Request, res: Response) => {
  const { ministry, topic } = req.body;

  if (!isAiConfigured() || !ai) {
    return res.status(400).json({
      success: false,
      error: 'Gemini AI not configured. Please set GEMINI_API_KEY.',
    });
  }

  try {
    const prompt = `You are a UPSC Prelims expert. Generate a realistic, detailed PIB (Press Information Bureau) press release analysis for UPSC aspirants.

Ministry: ${ministry || 'Government of India'}
${topic ? `Topic/Scheme: ${topic}` : 'Generate the most recent high-probability Prelims topic for this ministry.'}

Return ONLY valid JSON matching this exact schema:
{
  "title": "Full press release title",
  "ministry": "${ministry || 'Government of India'}",
  "date": "${new Date().toISOString().split('T')[0]}",
  "pibId": "PRID-${Math.floor(Math.random() * 90000) + 2000000}",
  "gsPaper": "GS-1" | "GS-2" | "GS-3" | "Current Events",
  "topic": "Main UPSC syllabus topic",
  "prelimsImportance": 4,
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "summaryBullets": ["Key point 1", "Key point 2", "Key point 3", "Key point 4"],
  "keyTakeaways": {
    "statutoryOrConstitutional": "Constitutional/statutory basis or null",
    "nodalMinistryOrAgency": "Nodal agency",
    "fundingPattern": "Funding details or null",
    "objectives": ["Objective 1", "Objective 2"],
    "eligibleBeneficiaries": "Who benefits or null",
    "keyPointers": ["Pointer 1", "Pointer 2", "Pointer 3"]
  },
  "prelimsTrapAlert": "Common misconception UPSC tests on this topic",
  "pyqYear": "2023" or null,
  "pyqContext": "Past year question context or null",
  "staticStudyBox": {
    "standardBook": "Recommended book",
    "chapterTopic": "Chapter",
    "whatToRead": "What to focus on",
    "coreArticlesOrActs": ["Act 1", "Act 2"]
  },
  "staticSyllabusLinkage": {
    "subject": "GS Paper subject",
    "articleOrAct": "Relevant article/act or null",
    "relatedConcepts": ["Concept 1", "Concept 2"]
  },
  "officialUrl": "https://www.pib.gov.in/PressReleasePage.aspx?PRID=2000000"
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });

    const raw = response.text?.trim() || '{}';
    const parsed = JSON.parse(raw.replace(/```json\s*|\s*```/g, ''));

    const article: PIBArticle = {
      id: `pib-live-${Date.now()}`,
      title: parsed.title || `${ministry} Press Release`,
      ministry: parsed.ministry || ministry || 'Government of India',
      date: parsed.date || new Date().toISOString().split('T')[0],
      pibId: parsed.pibId || `PRID-${Date.now()}`,
      gsPaper: parsed.gsPaper || 'Current Events',
      topic: parsed.topic || 'General Studies',
      prelimsImportance: parsed.prelimsImportance || 3,
      tags: parsed.tags || [],
      summaryBullets: parsed.summaryBullets || [],
      keyTakeaways: parsed.keyTakeaways || { keyPointers: [], nodalMinistryOrAgency: ministry },
      prelimsTrapAlert: parsed.prelimsTrapAlert || 'No specific traps identified',
      pyqYear: parsed.pyqYear || undefined,
      pyqContext: parsed.pyqContext || undefined,
      staticStudyBox: parsed.staticStudyBox || undefined,
      staticSyllabusLinkage: parsed.staticSyllabusLinkage || {
        subject: 'General Studies',
        relatedConcepts: [],
      },
      officialUrl: parsed.officialUrl || undefined,
    };

    // Add to in-memory store
    articlesStore.unshift(article);

    // Optionally save to DB
    try {
      const { DatabaseService } = await import('./src/services/databaseService.ts');
      const dbService = new DatabaseService();
      await dbService.saveArticles([article as any]);
      await dbService.disconnect();
    } catch (dbErr) {
      console.warn('[PIB Fetch-Live] DB save failed (non-fatal):', dbErr);
    }

    res.json({ success: true, article });
  } catch (err: any) {
    console.error('[PIB Fetch-Live] Error:', err);
    res.status(500).json({ success: false, error: err.message || 'Failed to generate article' });
  }
});

// GET /api/articles/fetch/status - Check article fetching status
app.get('/api/articles/fetch/status', (req: Request, res: Response) => {
  res.json({
    success: true,
    service: 'PIB Article Fetching Service',
    status: 'Available',
    configuration: {
      geminiConfigured: isAiConfigured(),
      totalArticles: articlesStore.length,
      lastArticleDate: articlesStore.length > 0 ? articlesStore[0].date : 'Never'
    },
    endpoints: {
      manualTrigger: 'POST /api/articles/fetch',
      status: 'GET /api/articles/fetch/status',
      stats: 'GET /api/articles/fetch/stats'
    }
  });
});

// GET /api/articles/fetch/stats - Get article fetching statistics
app.get('/api/articles/fetch/stats', (req: Request, res: Response) => {
  // Count articles by ministry
  const ministryCounts: Record<string, number> = {};
  articlesStore.forEach(article => {
    ministryCounts[article.ministry] = (ministryCounts[article.ministry] || 0) + 1;
  });

  // Count articles by GS paper
  const paperCounts: Record<string, number> = {};
  articlesStore.forEach(article => {
    paperCounts[article.gsPaper] = (paperCounts[article.gsPaper] || 0) + 1;
  });

  res.json({
    success: true,
    stats: {
      totalArticles: articlesStore.length,
      ministries: Object.keys(ministryCounts).length,
      topMinistries: Object.entries(ministryCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([ministry, count]) => ({ ministry, count })),
      paperDistribution: paperCounts,
      dateRange: {
        earliest: articlesStore.length > 0 ? 
          articlesStore.reduce((earliest, article) => 
            article.date < earliest ? article.date : earliest, articlesStore[0].date) : 
          'N/A',
        latest: articlesStore.length > 0 ? 
          articlesStore.reduce((latest, article) => 
            article.date > latest ? article.date : latest, articlesStore[0].date) : 
          'N/A'
      }
    }
  });
});

// -------------------------------------------------------------
// AI DEEP DIVE ROUTES
// -------------------------------------------------------------

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
  await loadArticlesFromDB();

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
