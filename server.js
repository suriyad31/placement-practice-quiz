'use strict';

/**
 * Placement Practice Quiz - Express server
 *
 * Responsibilities:
 *  - Serve the static frontend from /public
 *  - Load and validate the question bank (questions.json)
 *  - Manage quiz sessions in memory and persist accounts/results in SQLite
 *  - Enforce the quiz timer on the server and score answers server-side
 *
 * Answer keys and explanations never leave the server until a quiz session
 * has been submitted (or finalized by the server after the time limit).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parsePositiveInt(process.env.PORT, 3000);
const DB_FILE = path.join(__dirname, 'data', 'placement-quiz.sqlite');
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS quiz_results (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, category TEXT NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL, percentage REAL NOT NULL, submitted_at TEXT NOT NULL, result_json TEXT NOT NULL);`);
const COOKIE_NAME = 'ppq_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const publicUser = (row) => ({ id: row.id, name: row.name, email: row.email });
function setAuthCookie(res, token, secure = false) { res.setHeader('Set-Cookie', COOKIE_NAME + '=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + Math.floor(SESSION_TTL_MS / 1000) + (secure ? '; Secure' : '')); }
function requireAuth(req, res, next) {
  const token = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(COOKIE_NAME + '='))?.slice(COOKIE_NAME.length + 1);
  if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });
  const row = db.prepare('SELECT u.id, u.name, u.email FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?').get(hashToken(decodeURIComponent(token)), Date.now());
  if (!row) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
  req.user = row; next();
}
function issueAuthSession(req, res, user) {
  db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(Date.now());
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), user.id, Date.now() + SESSION_TTL_MS);
  setAuthCookie(res, token, req.secure || process.env.NODE_ENV === 'production'); return publicUser(user);
}
function passwordHash(password, salt) { return crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex'); }

const QUESTIONS_FILE = path.join(__dirname, 'questions.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_MINUTES = 60;
const DEFAULT_DURATION_MINUTES = clamp(
  parsePositiveInt(process.env.QUIZ_DURATION_MINUTES, 10),
  MIN_DURATION_MINUTES,
  MAX_DURATION_MINUTES
);
const QUESTION_COUNT_OPTIONS = [5, 10, 15, 20];
const DEFAULT_QUESTION_COUNT = 10;
const OPTIONS_PER_QUESTION = 4;

// Network latency allowance: a submission that arrives slightly after the
// deadline (e.g. an automatic submission in flight) is still accepted.
const SUBMIT_GRACE_MS = 15 * 1000;
// Finished/expired sessions are kept for a while so results can be reviewed.
const SESSION_RETENTION_MS = 2 * 60 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 5000;

const ALL_CATEGORY_ID = 'all';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** Cryptographically random Fisher-Yates shuffle (returns a new array). */
function shuffle(items) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Custom error carrying an HTTP status code for the JSON error handler. */
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Question bank loading and validation
// ---------------------------------------------------------------------------

/**
 * Reads questions.json and validates every entry. On failure the server still
 * starts, but API routes respond with 503 and a clear message so the
 * frontend can show a helpful error instead of a blank page.
 */
function loadQuestionBank() {
  let raw;
  try {
    raw = fs.readFileSync(QUESTIONS_FILE, 'utf8');
  } catch (error) {
    return { error: `Could not read questions.json (${error.code || error.message}).` };
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    return { error: `questions.json contains invalid JSON: ${error.message}` };
  }

  if (!data || !Array.isArray(data.categories) || !Array.isArray(data.questions)) {
    return { error: 'questions.json must contain "categories" and "questions" arrays.' };
  }

  const problems = [];
  const categories = [];
  const categoryIds = new Set();

  data.categories.forEach((category, index) => {
    if (!category || typeof category.id !== 'string' || typeof category.name !== 'string') {
      problems.push(`Category #${index + 1} must have string "id" and "name".`);
      return;
    }
    if (category.id === ALL_CATEGORY_ID || categoryIds.has(category.id)) {
      problems.push(`Category id "${category.id}" is reserved or duplicated.`);
      return;
    }
    categoryIds.add(category.id);
    categories.push({
      id: category.id,
      name: category.name,
      shortName: typeof category.shortName === 'string' ? category.shortName : category.name.slice(0, 3),
      description: typeof category.description === 'string' ? category.description : '',
    });
  });

  const questionsById = new Map();
  data.questions.forEach((question, index) => {
    const label = question && question.id ? `Question "${question.id}"` : `Question #${index + 1}`;
    if (!question || typeof question.id !== 'string' || question.id.trim() === '') {
      problems.push(`${label} is missing a string "id".`);
      return;
    }
    if (questionsById.has(question.id)) {
      problems.push(`${label} has a duplicate id.`);
      return;
    }
    if (!categoryIds.has(question.category)) {
      problems.push(`${label} has unknown category "${question.category}".`);
      return;
    }
    if (typeof question.question !== 'string' || question.question.trim() === '') {
      problems.push(`${label} is missing question text.`);
      return;
    }
    if (
      !Array.isArray(question.options) ||
      question.options.length !== OPTIONS_PER_QUESTION ||
      question.options.some((option) => typeof option !== 'string' || option.trim() === '')
    ) {
      problems.push(`${label} must have exactly ${OPTIONS_PER_QUESTION} non-empty options.`);
      return;
    }
    if (new Set(question.options.map((option) => option.trim().toLowerCase())).size !== OPTIONS_PER_QUESTION) {
      problems.push(`${label} has duplicate options.`);
      return;
    }
    if (!Number.isInteger(question.correctIndex) || question.correctIndex < 0 || question.correctIndex >= OPTIONS_PER_QUESTION) {
      problems.push(`${label} has an invalid "correctIndex".`);
      return;
    }
    if (typeof question.explanation !== 'string' || question.explanation.trim() === '') {
      problems.push(`${label} is missing an explanation.`);
      return;
    }

    questionsById.set(question.id, {
      id: question.id,
      category: question.category,
      difficulty: question.difficulty === 'medium' ? 'medium' : 'easy',
      question: question.question,
      options: question.options.slice(),
      correctIndex: question.correctIndex,
      explanation: question.explanation,
    });
  });

  if (problems.length > 0) {
    return { error: `questions.json failed validation: ${problems.join(' ')}` };
  }
  if (questionsById.size === 0) {
    return { error: 'questions.json does not contain any questions.' };
  }

  const questionIdsByCategory = new Map(categories.map((category) => [category.id, []]));
  for (const question of questionsById.values()) {
    questionIdsByCategory.get(question.category).push(question.id);
  }

  return {
    categories,
    categoriesById: new Map(categories.map((category) => [category.id, category])),
    questionsById,
    questionIdsByCategory,
  };
}

const questionBank = loadQuestionBank();
if (questionBank.error) {
  console.error(`[quiz] ${questionBank.error}`);
} else {
  console.log(`[quiz] Loaded ${questionBank.questionsById.size} questions in ${questionBank.categories.length} categories.`);
}

function requireQuestionBank() {
  if (questionBank.error) {
    throw new HttpError(503, 'The question bank could not be loaded. Check questions.json on the server.', questionBank.error);
  }
  return questionBank;
}

function categoryName(categoryId) {
  if (categoryId === ALL_CATEGORY_ID) return 'All Subjects';
  const category = questionBank.categoriesById.get(categoryId);
  return category ? category.name : categoryId;
}

// ---------------------------------------------------------------------------
// Quiz sessions (in memory)
// ---------------------------------------------------------------------------

/**
 * Session shape:
 * {
 *   id, category, questionIds: string[], durationSeconds,
 *   startedAt, expiresAt (ms epoch),
 *   savedAnswers: Map<questionId, optionIndex>,
 *   result: null | object, submittedAt: null | number
 * }
 */
const sessions = new Map();

/** Picks questions for a quiz. "All Subjects" is balanced across categories. */
function pickQuestionIds(bank, categoryId, requestedCount) {
  if (categoryId !== ALL_CATEGORY_ID) {
    const pool = shuffle(bank.questionIdsByCategory.get(categoryId));
    return pool.slice(0, Math.min(requestedCount, pool.length));
  }

  // Round-robin across shuffled category pools so every subject is represented.
  const pools = bank.categories.map((category) => shuffle(bank.questionIdsByCategory.get(category.id)));
  const total = Math.min(requestedCount, bank.questionsById.size);
  const picked = [];
  let round = 0;
  while (picked.length < total) {
    for (const pool of pools) {
      if (picked.length >= total) break;
      if (round < pool.length) picked.push(pool[round]);
    }
    round += 1;
  }
  return shuffle(picked);
}

function createSession({ category, questionIds, durationSeconds, userId }) {
  if (sessions.size >= MAX_ACTIVE_SESSIONS) {
    pruneSessions();
    if (sessions.size >= MAX_ACTIVE_SESSIONS) {
      throw new HttpError(503, 'The server is handling too many quiz sessions. Please try again shortly.');
    }
  }

  const now = Date.now();
  const session = {
    id: crypto.randomUUID(),
    userId,
    category,
    questionIds,
    durationSeconds,
    startedAt: now,
    expiresAt: now + durationSeconds * 1000,
    savedAnswers: new Map(),
    result: null,
    submittedAt: null,
  };
  sessions.set(session.id, session);
  return session;
}

function getSessionOrThrow(quizId, userId) {
  if (typeof quizId !== 'string' || !UUID_PATTERN.test(quizId)) {
    throw new HttpError(400, 'Invalid quiz id.');
  }
  const session = sessions.get(quizId);
  if (!session || session.userId !== userId) {
    throw new HttpError(404, 'Quiz session not found. It may have expired or the server was restarted.');
  }
  // If the deadline (plus grace) has passed without a submission, the server
  // finalizes the quiz using the answers it saved before the deadline.
  finalizeIfExpired(session);
  return session;
}

function isPastDeadline(session, now = Date.now()) {
  return now > session.expiresAt;
}

function isPastGrace(session, now = Date.now()) {
  return now > session.expiresAt + SUBMIT_GRACE_MS;
}

function finalizeIfExpired(session) {
  if (!session.result && isPastGrace(session)) {
    gradeSession(session, session.savedAnswers, { autoSubmitted: true, finalizedByServer: true });
  }
}

/** Public, answer-free representation of a session's questions. */
function toPublicQuestion(question) {
  return {
    id: question.id,
    category: question.category,
    categoryName: categoryName(question.category),
    difficulty: question.difficulty,
    question: question.question,
    options: question.options.slice(),
  };
}

function toPublicSession(session) {
  const bank = requireQuestionBank();
  const status = session.result ? 'submitted' : 'in-progress';
  return {
    quizId: session.id,
    category: session.category,
    categoryName: categoryName(session.category),
    status,
    totalQuestions: session.questionIds.length,
    durationSeconds: session.durationSeconds,
    startedAt: new Date(session.startedAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
    serverTime: new Date().toISOString(),
    questions: session.questionIds.map((id) => toPublicQuestion(bank.questionsById.get(id))),
    savedAnswers: Object.fromEntries(session.savedAnswers),
  };
}

function performanceFor(percentage) {
  if (percentage >= 85) {
    return { level: 'excellent', title: 'Excellent work!', message: 'You are well prepared for this section. Keep practising to stay sharp.' };
  }
  if (percentage >= 70) {
    return { level: 'good', title: 'Good job!', message: 'Solid performance. Review the questions you missed to close the remaining gaps.' };
  }
  if (percentage >= 50) {
    return { level: 'average', title: 'Fair attempt', message: 'You have the basics. Revise the explanations below and retry to improve your score.' };
  }
  return { level: 'low', title: 'Keep practising', message: 'Focus on the core concepts in the explanations below, then retry this quiz.' };
}

/**
 * Scores a session on the server. `answers` is a Map<questionId, index>.
 * The resulting object (including answer keys) is stored on the session and
 * only ever returned once the session is submitted.
 */
function gradeSession(session, answers, { autoSubmitted = false, finalizedByServer = false, lateSubmission = false } = {}) {
  const bank = requireQuestionBank();
  const now = Date.now();

  let correct = 0;
  let attempted = 0;

  const review = session.questionIds.map((questionId, position) => {
    const question = bank.questionsById.get(questionId);
    const selectedIndex = answers.has(questionId) ? answers.get(questionId) : null;
    const isAnswered = selectedIndex !== null;
    const isCorrect = isAnswered && selectedIndex === question.correctIndex;
    if (isAnswered) attempted += 1;
    if (isCorrect) correct += 1;

    return {
      number: position + 1,
      questionId,
      category: question.category,
      categoryName: categoryName(question.category),
      difficulty: question.difficulty,
      question: question.question,
      options: question.options.slice(),
      selectedIndex,
      correctIndex: question.correctIndex,
      status: !isAnswered ? 'unanswered' : isCorrect ? 'correct' : 'incorrect',
      explanation: question.explanation,
    };
  });

  const totalQuestions = session.questionIds.length;
  const incorrect = attempted - correct;
  const percentage = totalQuestions === 0 ? 0 : Math.round((correct / totalQuestions) * 1000) / 10;
  const submittedAt = finalizedByServer ? Math.min(now, session.expiresAt) : now;

  session.submittedAt = submittedAt;
  session.result = {
    quizId: session.id,
    category: session.category,
    categoryName: categoryName(session.category),
    totalQuestions,
    attempted,
    correct,
    incorrect,
    unanswered: totalQuestions - attempted,
    score: correct,
    maxScore: totalQuestions,
    percentage,
    performance: performanceFor(percentage),
    durationSeconds: session.durationSeconds,
    timeTakenSeconds: Math.min(session.durationSeconds, Math.max(0, Math.round((submittedAt - session.startedAt) / 1000))),
    autoSubmitted,
    lateSubmission,
    submittedAt: new Date(submittedAt).toISOString(),
    review,
  };
  if (session.userId) db.prepare('INSERT OR IGNORE INTO quiz_results (id, user_id, category, score, total, percentage, submitted_at, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(session.id, session.userId, session.category, correct, totalQuestions, percentage, session.result.submittedAt, JSON.stringify(session.result));
  return session.result;
}

/** Removes old sessions so memory use stays bounded. */
function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now > session.expiresAt + SESSION_RETENTION_MS) sessions.delete(id);
  }
}
setInterval(pruneSessions, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Request validation helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateOptionIndex(value, fieldName) {
  if (!Number.isInteger(value) || value < 0 || value >= OPTIONS_PER_QUESTION) {
    throw new HttpError(400, `"${fieldName}" must be an integer between 0 and ${OPTIONS_PER_QUESTION - 1}.`);
  }
  return value;
}

/**
 * Validates the answers array sent on submit:
 *  [{ questionId: string, selectedIndex: 0..3 }, ...]
 * Rejects unknown or duplicate question ids and invalid indices.
 */
function parseSubmittedAnswers(session, rawAnswers) {
  if (!Array.isArray(rawAnswers)) {
    throw new HttpError(400, '"answers" must be an array of { questionId, selectedIndex } objects.');
  }
  if (rawAnswers.length > session.questionIds.length) {
    throw new HttpError(400, 'More answers were submitted than there are questions in this quiz.');
  }

  const allowedIds = new Set(session.questionIds);
  const answers = new Map();

  rawAnswers.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new HttpError(400, `Answer #${index + 1} must be an object.`);
    }
    const { questionId, selectedIndex } = entry;
    if (typeof questionId !== 'string' || !allowedIds.has(questionId)) {
      throw new HttpError(400, `Answer #${index + 1} refers to a question that is not part of this quiz.`);
    }
    if (answers.has(questionId)) {
      throw new HttpError(400, `Question "${questionId}" was answered more than once in the submission.`);
    }
    answers.set(questionId, validateOptionIndex(selectedIndex, `answers[${index}].selectedIndex`));
  });

  return answers;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');

// Baseline security headers. All assets are same-origin, so a strict CSP works.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'"
  );
  next();
});

app.use(express.json({ limit: '32kb' }));
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/** Health check - useful for troubleshooting. */
app.get('/api/health', (req, res) => {
  res.json({
    status: questionBank.error ? 'degraded' : 'ok',
    questionsLoaded: questionBank.error ? 0 : questionBank.questionsById.size,
  });
});

app.post('/api/auth/register', (req, res) => {
  const body = isPlainObject(req.body) ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (name.length < 2 || name.length > 80) throw new HttpError(400, 'Name must be between 2 and 80 characters.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
  if (password.length < 8 || password.length > 128) throw new HttpError(400, 'Password must be between 8 and 128 characters.');
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw new HttpError(409, 'An account with that email already exists.');
  const id = crypto.randomUUID(); const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users (id, name, email, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, email, passwordHash(password, salt), salt, new Date().toISOString());
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(id);
  res.status(201).json({ user: issueAuthSession(req, res, user) });
});
app.post('/api/auth/login', (req, res) => {
  const body = isPlainObject(req.body) ? req.body : {}; const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''; const password = typeof body.password === 'string' ? body.password : '';
  const user = db.prepare('SELECT id, name, email, password_hash, password_salt FROM users WHERE email = ?').get(email);
  const candidate = user && password.length <= 128 ? passwordHash(password, user.password_salt) : passwordHash(password.slice(0, 128), 'invalid-account-salt');
  if (!user || !crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.password_hash, 'hex'))) throw new HttpError(401, 'Email or password is incorrect.');
  res.json({ user: issueAuthSession(req, res, user) });
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
app.post('/api/auth/logout', (req, res) => {
  const token = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(COOKIE_NAME + '='))?.slice(COOKIE_NAME.length + 1);
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(hashToken(decodeURIComponent(token)));
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '')); res.json({ ok: true });
});
app.use('/api/quizzes', requireAuth);
app.get('/api/history', requireAuth, (req, res) => {
  const results = db.prepare('SELECT id, category, score, total, percentage, submitted_at AS submittedAt, result_json FROM quiz_results WHERE user_id = ? ORDER BY submitted_at DESC LIMIT 50').all(req.user.id).map((row) => ({ ...row, result: JSON.parse(row.result_json) }));
  res.json({ results });
});

/** Categories, question counts and quiz configuration for the home page. */
app.get('/api/categories', (req, res) => {
  const bank = requireQuestionBank();
  res.json({
    categories: bank.categories.map((category) => ({
      ...category,
      questionCount: bank.questionIdsByCategory.get(category.id).length,
    })),
    totalQuestions: bank.questionsById.size,
    config: {
      defaultDurationMinutes: DEFAULT_DURATION_MINUTES,
      minDurationMinutes: MIN_DURATION_MINUTES,
      maxDurationMinutes: MAX_DURATION_MINUTES,
      questionCountOptions: QUESTION_COUNT_OPTIONS,
      defaultQuestionCount: DEFAULT_QUESTION_COUNT,
    },
  });
});

/**
 * Start a new quiz session.
 * Body: { category: "all" | categoryId, questionCount?: number, durationMinutes?: number }
 *   or: { retryOf: quizId, durationMinutes?: number }  -> same questions, new session
 */
app.post('/api/quizzes', (req, res) => {
  const bank = requireQuestionBank();
  const body = isPlainObject(req.body) ? req.body : {};

  let durationMinutes = DEFAULT_DURATION_MINUTES;
  if (body.durationMinutes !== undefined) {
    if (!Number.isInteger(body.durationMinutes) || body.durationMinutes < MIN_DURATION_MINUTES || body.durationMinutes > MAX_DURATION_MINUTES) {
      throw new HttpError(400, `"durationMinutes" must be a whole number between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}.`);
    }
    durationMinutes = body.durationMinutes;
  }

  let category;
  let questionIds;

  if (body.retryOf !== undefined) {
    const original = getSessionOrThrow(body.retryOf, req.user.id);
    category = original.category;
    questionIds = original.questionIds.slice();
    if (body.durationMinutes === undefined) durationMinutes = original.durationSeconds / 60;
  } else {
    category = body.category;
    if (typeof category !== 'string' || (category !== ALL_CATEGORY_ID && !bank.categoriesById.has(category))) {
      throw new HttpError(400, `"category" must be "${ALL_CATEGORY_ID}" or one of: ${bank.categories.map((c) => c.id).join(', ')}.`);
    }

    let questionCount = DEFAULT_QUESTION_COUNT;
    if (body.questionCount !== undefined) {
      if (!Number.isInteger(body.questionCount) || body.questionCount < 1 || body.questionCount > bank.questionsById.size) {
        throw new HttpError(400, `"questionCount" must be a whole number between 1 and ${bank.questionsById.size}.`);
      }
      questionCount = body.questionCount;
    }
    questionIds = pickQuestionIds(bank, category, questionCount);
  }

  if (questionIds.length === 0) {
    throw new HttpError(422, 'No questions are available for the selected category.');
  }

  const session = createSession({ category, questionIds, durationSeconds: Math.round(durationMinutes * 60), userId: req.user.id });
  res.status(201).json(toPublicSession(session));
});

/** Retrieve a quiz session (questions without answer keys, saved answers, timer). */
app.get('/api/quizzes/:quizId', (req, res) => {
  const session = getSessionOrThrow(req.params.quizId, req.user.id);
  res.json(toPublicSession(session));
});

/**
 * Save (or change) one answer during the quiz. Saved answers are what the
 * server grades if the timer runs out before a submission arrives.
 * Body: { selectedIndex: 0..3 }
 */
app.put('/api/quizzes/:quizId/answers/:questionId', (req, res) => {
  const session = getSessionOrThrow(req.params.quizId, req.user.id);
  if (session.result) {
    throw new HttpError(409, 'This quiz has already been submitted.');
  }
  if (isPastDeadline(session)) {
    throw new HttpError(403, 'Time is up for this quiz. Answers can no longer be changed.');
  }
  const { questionId } = req.params;
  if (!session.questionIds.includes(questionId)) {
    throw new HttpError(400, 'This question is not part of the quiz.');
  }
  const body = isPlainObject(req.body) ? req.body : {};
  const selectedIndex = validateOptionIndex(body.selectedIndex, 'selectedIndex');

  session.savedAnswers.set(questionId, selectedIndex);
  res.json({ questionId, selectedIndex, savedAnswers: session.savedAnswers.size });
});

/**
 * Submit the quiz for server-side scoring.
 * Body: { answers: [{ questionId, selectedIndex }], reason?: "manual" | "timeout" }
 */
app.post('/api/quizzes/:quizId/submit', (req, res) => {
  const session = getSessionOrThrow(req.params.quizId, req.user.id);
  if (session.result) {
    // Includes the case where the server already finalized an expired quiz.
    throw new HttpError(409, 'This quiz has already been submitted. Fetch the result instead.', { resultAvailable: true });
  }

  const body = isPlainObject(req.body) ? req.body : {};
  const submitted = parseSubmittedAnswers(session, body.answers === undefined ? [] : body.answers);
  const pastDeadline = isPastDeadline(session);
  const autoSubmitted = body.reason === 'timeout' || pastDeadline;

  // Before the deadline: saved answers are merged with the submitted set and
  // the submitted values win (they are the most recent selections).
  // After the deadline (within the grace window): only answers the server
  // saved BEFORE the deadline count, so a modified client cannot keep
  // answering after time is up.
  const finalAnswers = pastDeadline
    ? new Map(session.savedAnswers)
    : new Map([...session.savedAnswers, ...submitted]);
  const result = gradeSession(session, finalAnswers, { autoSubmitted, lateSubmission: pastDeadline });
  res.json(result);
});

/** Results and explanations - only available after submission. */
app.get('/api/quizzes/:quizId/result', (req, res) => {
  const session = getSessionOrThrow(req.params.quizId, req.user.id);
  if (!session.result) {
    throw new HttpError(409, 'Results are only available after the quiz has been submitted.');
  }
  res.json(session.result);
});

// Unknown API routes -> JSON 404 (instead of the HTML fallback).
app.use('/api', (req, res) => {
  res.status(404).json({ error: `No API route matches ${req.method} ${req.originalUrl}.` });
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html', maxAge: 0 }));

// Central JSON error handler (Express 5 forwards thrown errors automatically).
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON.' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
  if (status >= 500 && !(err instanceof HttpError)) {
    console.error('[quiz] Unexpected error:', err);
  }
  const payload = { error: status >= 500 && !(err instanceof HttpError) ? 'Unexpected server error.' : err.message };
  if (isPlainObject(err.details)) Object.assign(payload, err.details);
  return res.status(status).json(payload);
});

// Note: the late-submission rule. If a submission arrives after the deadline
// AND after the grace period, getSessionOrThrow() has already finalized the
// session with the answers saved before the deadline, so the submit route
// returns 409 and the client fetches that server-graded result instead.

const server = app.listen(PORT, () => {
  console.log(`[quiz] Placement Practice Quiz running at http://localhost:${PORT}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[quiz] Port ${PORT} is already in use. Close the other program or run with a different port, e.g.:`);
    console.error('       PowerShell:  $env:PORT=3001; npm start');
    console.error('       CMD:         set PORT=3001 && npm start');
  } else {
    console.error('[quiz] Server failed to start:', error);
  }
  process.exit(1);
});
