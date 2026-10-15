'use strict';

/**
 * Placement Practice Quiz - frontend (vanilla JavaScript)
 *
 * - All content from the server is rendered with textContent / DOM APIs
 *   (never innerHTML), so question text cannot inject markup.
 * - The browser never receives correct answers before submission; it only
 *   sends the user's selections and displays the score returned by the server.
 * - The countdown shown here is for display. The server enforces the real
 *   deadline: late answers are rejected and expired quizzes are finalized
 *   on the server with the answers saved before time ran out.
 */
(function () {
  const API = {
    categories: '/api/categories',
    quizzes: '/api/quizzes',
    quiz: (quizId) => `/api/quizzes/${encodeURIComponent(quizId)}`,
    answer: (quizId, questionId) => `/api/quizzes/${encodeURIComponent(quizId)}/answers/${encodeURIComponent(questionId)}`,
    submit: (quizId) => `/api/quizzes/${encodeURIComponent(quizId)}/submit`,
    result: (quizId) => `/api/quizzes/${encodeURIComponent(quizId)}/result`,
  };

  const ACTIVE_QUIZ_KEY = 'ppq.activeQuizId';
  const ALL_CATEGORY_ID = 'all';
  const OPTION_LETTERS = ['A', 'B', 'C', 'D'];
  const DURATION_CHOICES = [1, 2, 5, 10, 15, 20, 30, 45, 60];
  const CRITICAL_SECONDS = 10;
  const TIMER_TICK_MS = 250;

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  const state = {
    categories: [],
    totalQuestions: 0,
    config: null,
    quiz: null, // public session from the server (no answer keys)
    answers: new Map(), // questionId -> selected option index
    currentIndex: 0,
    clockOffsetMs: 0, // serverTime - clientTime, to correct a skewed PC clock
    expiresAtMs: 0,
    warningSeconds: 60,
    warningShown: false,
    timerId: null,
    lastRenderedSeconds: null,
    timeExpired: false,
    submitting: false,
    pendingSaves: new Set(),
    result: null,
    user: null,
    authMode: 'login',
    reviewFilter: 'all',
    retryHandler: null,
  };

  // -------------------------------------------------------------------------
  // DOM references
  // -------------------------------------------------------------------------

  const byId = (id) => document.getElementById(id);

  const dom = {
    main: byId('main'),
    authView: byId('view-auth'),
    authForm: byId('auth-form'),
    authNameField: byId('auth-name-field'),
    authName: byId('auth-name'),
    authEmail: byId('auth-email'),
    authPassword: byId('auth-password'),
    authSubmit: byId('auth-submit'),
    authError: byId('auth-error'),
    authFormTitle: byId('auth-form-title'),
    authSwitchCopy: byId('auth-switch-copy'),
    authSwitch: byId('auth-switch'),
    accountName: byId('account-name'),
    logoutButton: byId('logout-button'),
    brandLink: byId('brand-link'),
    globalAlert: byId('global-alert'),
    globalAlertTitle: byId('global-alert-title'),
    globalAlertText: byId('global-alert-text'),
    globalAlertRetry: byId('global-alert-retry'),
    announcer: byId('sr-announcer'),

    views: {
      home: byId('view-home'),
      quiz: byId('view-quiz'),
      results: byId('view-results'),
    },
    viewHeadings: {
      home: byId('home-title'),
      quiz: byId('quiz-title'),
      results: byId('results-title'),
    },

    // Home
    statTotalQuestions: byId('stat-total-questions'),
    statTotalCategories: byId('stat-total-categories'),
    startForm: byId('start-form'),
    categoryLoading: byId('category-loading'),
    categoryGrid: byId('category-grid'),
    questionCount: byId('question-count'),
    questionCountHint: byId('question-count-hint'),
    duration: byId('duration'),
    startButton: byId('start-button'),
    startSummary: byId('start-summary'),
    historyList: byId('history-list'),
    historyEmpty: byId('history-empty'),

    // Quiz
    quizCategoryLabel: byId('quiz-category-label'),
    quizTitle: byId('quiz-title'),
    timer: byId('timer'),
    timerValue: byId('timer-value'),
    timerWarning: byId('timer-warning'),
    timerWarningText: byId('timer-warning-text'),
    quitButton: byId('quit-button'),
    progress: byId('progress'),
    progressFill: byId('progress-fill'),
    progressText: byId('progress-text'),
    questionCategory: byId('question-category'),
    questionDifficulty: byId('question-difficulty'),
    questionText: byId('question-text'),
    optionsList: byId('options-list'),
    prevButton: byId('prev-button'),
    nextButton: byId('next-button'),
    submitButton: byId('submit-button'),
    navHint: byId('nav-hint'),

    // Results
    scoreRing: byId('score-ring'),
    resultPercentageRing: byId('result-percentage-ring'),
    resultCategory: byId('result-category'),
    resultPerformanceTitle: byId('result-performance-title'),
    resultPerformanceMessage: byId('result-performance-message'),
    resultNotice: byId('result-notice'),
    resultTotal: byId('result-total'),
    resultAttempted: byId('result-attempted'),
    resultCorrect: byId('result-correct'),
    resultIncorrect: byId('result-incorrect'),
    resultScore: byId('result-score'),
    resultPercentage: byId('result-percentage'),
    resultUnanswered: byId('result-unanswered'),
    resultTime: byId('result-time'),
    retryButton: byId('retry-button'),
    homeButton: byId('home-button'),
    reviewList: byId('review-list'),
    reviewEmpty: byId('review-empty'),
    filterButtons: Array.from(document.querySelectorAll('.filter-btn')),

    // Dialog
    dialog: byId('confirm-dialog'),
    dialogTitle: byId('dialog-title'),
    dialogMessage: byId('dialog-message'),
    dialogCancel: byId('dialog-cancel'),
    dialogConfirm: byId('dialog-confirm'),
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Safe element factory: text is always assigned with textContent. */
  function createElement(tagName, { className, text, attrs } = {}, children = []) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    if (attrs) {
      Object.entries(attrs).forEach(([name, value]) => {
        if (value !== undefined && value !== null && value !== false) element.setAttribute(name, String(value));
      });
    }
    children.forEach((child) => child && element.appendChild(child));
    return element;
  }

  function createCheckIcon() {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'option-check');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(svgNs, 'path');
    path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    return svg;
  }

  function formatClock(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }

  function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
  }

  function pluralize(count, singular, plural = `${singular}s`) {
    return `${count} ${count === 1 ? singular : plural}`;
  }

  function announce(message) {
    // Clearing first makes screen readers re-announce identical messages.
    dom.announcer.textContent = '';
    window.setTimeout(() => {
      dom.announcer.textContent = message;
    }, 50);
  }

  function rememberActiveQuiz(quizId) {
    try {
      if (quizId) sessionStorage.setItem(ACTIVE_QUIZ_KEY, quizId);
      else sessionStorage.removeItem(ACTIVE_QUIZ_KEY);
    } catch (error) {
      // sessionStorage can be unavailable (e.g. strict privacy mode); resume is optional.
    }
  }

  function readActiveQuiz() {
    try {
      return sessionStorage.getItem(ACTIVE_QUIZ_KEY);
    } catch (error) {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // API client
  // -------------------------------------------------------------------------

  class ApiError extends Error {
    constructor(status, message, data) {
      super(message);
      this.status = status;
      this.data = data;
    }
  }

  async function apiRequest(url, { method = 'GET', body } = {}) {
    const options = { method, cache: 'no-store', headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      throw new ApiError(0, 'Could not reach the quiz server. Make sure it is running (npm start) and then try again.');
    }

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }

    if (!response.ok) {
      const message = data && typeof data.error === 'string' ? data.error : `The server responded with an error (HTTP ${response.status}).`;
      throw new ApiError(response.status, message, data);
    }
    if (data === null) {
      throw new ApiError(response.status, 'The server returned an unexpected response.');
    }
    return data;
  }

  // -------------------------------------------------------------------------
  // Global alert + views
  // -------------------------------------------------------------------------

  function showGlobalError(title, message, retryHandler) {
    dom.globalAlertTitle.textContent = title;
    dom.globalAlertText.textContent = message;
    state.retryHandler = typeof retryHandler === 'function' ? retryHandler : null;
    dom.globalAlertRetry.hidden = !state.retryHandler;
    dom.globalAlert.hidden = false;
  }

  function hideGlobalError() {
    dom.globalAlert.hidden = true;
    state.retryHandler = null;
  }

  function showView(name) {
    dom.authView.hidden = true;
    Object.entries(dom.views).forEach(([viewName, element]) => {
      element.hidden = viewName !== name;
    });
    window.scrollTo(0, 0);
    dom.viewHeadings[name].focus({ preventScroll: true });
  }

  function currentViewName() {
    return Object.keys(dom.views).find((name) => !dom.views[name].hidden);
  }

  // -------------------------------------------------------------------------
  // Confirmation dialog (native <dialog>: focus trap + Escape to cancel)
  // -------------------------------------------------------------------------

  function confirmDialog({ title, message, confirmText = 'Confirm', cancelText = 'Cancel', tone = 'primary' }) {
    return new Promise((resolve) => {
      const dialog = dom.dialog;
      dom.dialogTitle.textContent = title;
      dom.dialogMessage.textContent = message;
      dom.dialogConfirm.textContent = confirmText;
      dom.dialogCancel.textContent = cancelText;
      dom.dialogConfirm.className = `btn ${tone === 'success' ? 'btn-success' : 'btn-primary'}`;

      const handleClose = () => {
        dialog.removeEventListener('close', handleClose);
        resolve(dialog.returnValue === 'confirm');
      };

      dialog.returnValue = '';
      dialog.addEventListener('close', handleClose);
      dialog.showModal();
      dom.dialogCancel.focus();
    });
  }

  function closeDialogIfOpen() {
    if (dom.dialog.open) dom.dialog.close('cancel');
  }

  // -------------------------------------------------------------------------
  // Home: categories and quiz settings
  // -------------------------------------------------------------------------

  function selectedCategoryId() {
    const checked = dom.categoryGrid.querySelector('input[name="category"]:checked');
    return checked ? checked.value : ALL_CATEGORY_ID;
  }

  function availableCount(categoryId) {
    if (categoryId === ALL_CATEGORY_ID) return state.totalQuestions;
    const category = state.categories.find((item) => item.id === categoryId);
    return category ? category.questionCount : 0;
  }

  function categoryDisplayName(categoryId) {
    if (categoryId === ALL_CATEGORY_ID) return 'All Subjects';
    const category = state.categories.find((item) => item.id === categoryId);
    return category ? category.name : categoryId;
  }

  function renderCategoryCard({ id, name, shortName, description, count }, checked) {
    const inputId = `category-${id}`;
    const descriptionId = `${inputId}-desc`;
    const input = createElement('input', {
      className: 'choice-input',
      attrs: { type: 'radio', name: 'category', id: inputId, value: id, 'aria-describedby': descriptionId },
    });
    input.checked = checked;

    const label = createElement('label', { className: 'category-option', attrs: { for: inputId } }, [
      createElement('span', { className: 'category-badge', text: shortName, attrs: { 'aria-hidden': 'true' } }),
      createElement('span', { className: 'category-info' }, [
        createElement('span', { className: 'category-name', text: name }),
        createElement('span', { className: 'category-desc', text: description, attrs: { id: descriptionId } }),
        createElement('span', { className: 'category-count', text: `${pluralize(count, 'question')} available` }),
      ]),
    ]);

    return createElement('div', { className: 'choice' }, [input, label]);
  }

  function renderCategories(previousSelection) {
    dom.categoryGrid.replaceChildren();
    const selection = previousSelection || ALL_CATEGORY_ID;

    const cards = [
      {
        id: ALL_CATEGORY_ID,
        name: 'All Subjects',
        shortName: 'ALL',
        description: 'A balanced mix of questions from every subject - ideal for a full mock test.',
        count: state.totalQuestions,
      },
      ...state.categories.map((category) => ({ ...category, count: category.questionCount })),
    ];

    cards.forEach((card) => {
      dom.categoryGrid.appendChild(renderCategoryCard(card, card.id === selection));
    });
  }

  function renderQuestionCountOptions() {
    const categoryId = selectedCategoryId();
    const maxAvailable = availableCount(categoryId);
    const previousValue = Number(dom.questionCount.value) || state.config.defaultQuestionCount;

    const counts = state.config.questionCountOptions.filter((count) => count < maxAvailable);
    counts.push(maxAvailable);

    dom.questionCount.replaceChildren(
      ...counts.map((count) =>
        createElement('option', {
          text: count === maxAvailable ? `All available (${count})` : `${count} questions`,
          attrs: { value: count },
        })
      )
    );

    const bestMatch = counts.includes(previousValue) ? previousValue : counts.reduce((best, count) => (count <= previousValue ? count : best), counts[0]);
    dom.questionCount.value = String(bestMatch);
    dom.questionCountHint.textContent = `${categoryDisplayName(categoryId)} has ${pluralize(maxAvailable, 'question')}.`;
  }

  function renderDurationOptions() {
    const { minDurationMinutes, maxDurationMinutes, defaultDurationMinutes } = state.config;
    const choices = DURATION_CHOICES.filter((minutes) => minutes >= minDurationMinutes && minutes <= maxDurationMinutes);
    if (!choices.includes(defaultDurationMinutes)) {
      choices.push(defaultDurationMinutes);
      choices.sort((a, b) => a - b);
    }
    dom.duration.replaceChildren(
      ...choices.map((minutes) => createElement('option', { text: pluralize(minutes, 'minute'), attrs: { value: minutes } }))
    );
    dom.duration.value = String(defaultDurationMinutes);
  }

  function updateStartSummary() {
    const categoryId = selectedCategoryId();
    const count = Number(dom.questionCount.value);
    const minutes = Number(dom.duration.value);
    dom.startSummary.textContent = `${categoryDisplayName(categoryId)} - ${pluralize(count, 'question')} in ${pluralize(minutes, 'minute')}.`;
  }

  async function loadCategories() {
    hideGlobalError();
    dom.categoryLoading.hidden = false;
    dom.startButton.disabled = true;
    dom.questionCount.disabled = true;
    dom.duration.disabled = true;

    try {
      const data = await apiRequest(API.categories);
      if (!Array.isArray(data.categories) || !data.config) {
        throw new ApiError(500, 'The question data from the server is incomplete.');
      }
      const previousSelection = state.categories.length ? selectedCategoryId() : null;
      state.categories = data.categories;
      state.totalQuestions = data.totalQuestions;
      state.config = data.config;

      dom.statTotalQuestions.textContent = String(data.totalQuestions);
      dom.statTotalCategories.textContent = String(data.categories.length);

      renderCategories(previousSelection);
      renderQuestionCountOptions();
      renderDurationOptions();
      updateStartSummary();

      dom.questionCount.disabled = false;
      dom.duration.disabled = false;
      dom.startButton.disabled = false;
    } catch (error) {
      showGlobalError('Could not load quiz subjects', error.message, loadCategories);
    } finally {
      dom.categoryLoading.hidden = true;
    }
  }

  async function handleStartSubmit(event) {
    event.preventDefault();
    if (dom.startButton.disabled) return;

    const settings = {
      category: selectedCategoryId(),
      questionCount: Number(dom.questionCount.value),
      durationMinutes: Number(dom.duration.value),
    };

    hideGlobalError();
    dom.startButton.disabled = true;
    dom.startButton.textContent = 'Starting...';
    try {
      // Every start creates a brand-new server session, so switching
      // categories never carries over answers from a previous quiz.
      const session = await apiRequest(API.quizzes, { method: 'POST', body: settings });
      beginQuiz(session);
    } catch (error) {
      showGlobalError('Could not start the quiz', error.message);
    } finally {
      dom.startButton.disabled = false;
      dom.startButton.textContent = 'Start Quiz';
    }
  }

  // -------------------------------------------------------------------------
  // Quiz flow
  // -------------------------------------------------------------------------

  function syncClock(session) {
    const serverNow = Date.parse(session.serverTime);
    state.clockOffsetMs = Number.isFinite(serverNow) ? serverNow - Date.now() : 0;
    state.expiresAtMs = Date.parse(session.expiresAt);
  }

  function remainingMs() {
    return state.expiresAtMs - (Date.now() + state.clockOffsetMs);
  }

  function beginQuiz(session, { resume = false } = {}) {
    stopTimer();
    closeDialogIfOpen();
    hideGlobalError();

    if (!Array.isArray(session.questions) || session.questions.length === 0) {
      showGlobalError('No questions available', 'The server returned a quiz without any questions.');
      return;
    }

    state.quiz = session;
    state.result = null;
    state.submitting = false;
    state.timeExpired = false;
    state.warningShown = false;
    state.lastRenderedSeconds = null;
    state.pendingSaves.clear();
    state.answers = new Map();

    if (session.savedAnswers && typeof session.savedAnswers === 'object') {
      Object.entries(session.savedAnswers).forEach(([questionId, index]) => {
        if (Number.isInteger(index)) state.answers.set(questionId, index);
      });
    }

    // Resume at the first unanswered question (or the last question).
    if (resume) {
      const firstUnanswered = session.questions.findIndex((question) => !state.answers.has(question.id));
      state.currentIndex = firstUnanswered === -1 ? session.questions.length - 1 : firstUnanswered;
    } else {
      state.currentIndex = 0;
    }

    state.warningSeconds = Math.min(60, Math.max(10, Math.floor(session.durationSeconds * 0.2)));
    syncClock(session);
    rememberActiveQuiz(session.quizId);

    dom.quizCategoryLabel.textContent = session.categoryName;
    dom.timerWarning.hidden = true;
    dom.timer.classList.remove('is-warning', 'is-critical');
    dom.progress.setAttribute('aria-valuemax', String(session.questions.length));
    setQuizControlsDisabled(false);

    renderQuestion();
    showView('quiz');
    startTimer();
    announce(`${session.categoryName} quiz started. ${pluralize(session.questions.length, 'question')}, ${formatDuration(session.durationSeconds)} time limit.`);
  }

  function currentQuestion() {
    return state.quiz.questions[state.currentIndex];
  }

  function renderQuestion() {
    const question = currentQuestion();
    const total = state.quiz.questions.length;
    const selectedIndex = state.answers.has(question.id) ? state.answers.get(question.id) : null;

    dom.quizTitle.textContent = `Question ${state.currentIndex + 1} of ${total}`;
    dom.questionCategory.textContent = question.categoryName;
    dom.questionDifficulty.textContent = question.difficulty;
    dom.questionText.textContent = question.question;

    const optionNodes = question.options.map((optionText, optionIndex) => {
      const inputId = `option-${state.currentIndex}-${optionIndex}`;
      const input = createElement('input', {
        className: 'choice-input',
        attrs: { type: 'radio', name: 'answer', id: inputId, value: optionIndex },
      });
      input.checked = selectedIndex === optionIndex;
      input.disabled = state.submitting || state.timeExpired;
      input.addEventListener('change', () => selectAnswer(optionIndex));

      const label = createElement('label', { className: 'option-label', attrs: { for: inputId } }, [
        createElement('span', { className: 'option-letter', text: OPTION_LETTERS[optionIndex], attrs: { 'aria-hidden': 'true' } }),
        createElement('span', { className: 'sr-only', text: `Option ${OPTION_LETTERS[optionIndex]}: ` }),
        createElement('span', { className: 'option-text', text: optionText }),
        createCheckIcon(),
      ]);

      return createElement('div', { className: 'choice' }, [input, label]);
    });

    dom.optionsList.replaceChildren(...optionNodes);
    updateNavigation();
  }

  function updateProgress() {
    const total = state.quiz.questions.length;
    const answered = state.quiz.questions.filter((question) => state.answers.has(question.id)).length;
    dom.progressFill.style.width = `${(answered / total) * 100}%`;
    dom.progress.setAttribute('aria-valuenow', String(answered));
    dom.progress.setAttribute('aria-valuetext', `${answered} of ${total} questions answered`);
    dom.progressText.textContent = `${answered} of ${total} answered`;
  }

  function updateNavigation() {
    const question = currentQuestion();
    const isFirst = state.currentIndex === 0;
    const isLast = state.currentIndex === state.quiz.questions.length - 1;
    const hasAnswer = state.answers.has(question.id);
    const locked = state.submitting || state.timeExpired;

    dom.prevButton.disabled = isFirst || locked;
    dom.nextButton.hidden = isLast;
    dom.submitButton.hidden = !isLast;
    dom.nextButton.disabled = !hasAnswer || locked;
    dom.submitButton.disabled = !hasAnswer || locked;

    if (state.submitting) {
      dom.navHint.textContent = 'Submitting your answers...';
    } else if (!hasAnswer) {
      dom.navHint.textContent = isLast ? 'Select an answer to submit the quiz.' : 'Select an answer to continue.';
    } else {
      dom.navHint.textContent = '';
    }

    updateProgress();
  }

  function setQuizControlsDisabled(disabled) {
    dom.optionsList.querySelectorAll('input').forEach((input) => {
      input.disabled = disabled;
    });
    dom.quitButton.disabled = disabled;
  }

  function selectAnswer(optionIndex) {
    if (!state.quiz || state.submitting || state.timeExpired) return;
    const question = currentQuestion();
    state.answers.set(question.id, optionIndex);
    updateNavigation();
    saveAnswer(state.quiz.quizId, question.id, optionIndex);
  }

  /**
   * Saves the selection on the server so it counts even if the browser is
   * closed or the time limit is reached before the final submission.
   */
  function saveAnswer(quizId, questionId, selectedIndex) {
    const request = apiRequest(API.answer(quizId, questionId), { method: 'PUT', body: { selectedIndex } })
      .catch((error) => {
        if (!state.quiz || state.quiz.quizId !== quizId) return;
        if (error.status === 403) {
          // Server says time is up - the server clock is authoritative.
          handleTimeExpired();
        } else if (error.status === 409) {
          loadResultAndShow(quizId);
        } else if (error.status === 0) {
          dom.navHint.textContent = 'Connection problem - your answers will be sent again when you submit.';
        }
      })
      .finally(() => state.pendingSaves.delete(request));
    state.pendingSaves.add(request);
  }

  function goToQuestion(index) {
    if (!state.quiz) return;
    state.currentIndex = Math.min(Math.max(index, 0), state.quiz.questions.length - 1);
    renderQuestion();
    dom.quizTitle.focus({ preventScroll: true });
    dom.quizTitle.scrollIntoView({ block: 'nearest' });
  }

  function handleNext() {
    if (!state.quiz || state.submitting) return;
    if (!state.answers.has(currentQuestion().id)) {
      dom.navHint.textContent = 'Please select an answer before moving to the next question.';
      announce('Please select an answer before moving to the next question.');
      return;
    }
    goToQuestion(state.currentIndex + 1);
  }

  function handlePrevious() {
    if (!state.quiz || state.submitting || state.currentIndex === 0) return;
    goToQuestion(state.currentIndex - 1);
  }

  async function handleSubmitClick() {
    if (!state.quiz || state.submitting || state.timeExpired) return;
    if (!state.answers.has(currentQuestion().id)) {
      dom.navHint.textContent = 'Please select an answer before submitting.';
      return;
    }
    const total = state.quiz.questions.length;
    const answered = state.quiz.questions.filter((question) => state.answers.has(question.id)).length;
    const unanswered = total - answered;

    const confirmed = await confirmDialog({
      title: 'Submit your quiz?',
      message: `You have answered ${answered} of ${total} questions${unanswered ? ` (${unanswered} unanswered)` : ''}. Once submitted, you cannot change your answers.`,
      confirmText: 'Submit Quiz',
      cancelText: 'Keep reviewing',
      tone: 'success',
    });

    // The timer may have expired while the dialog was open.
    if (confirmed && state.quiz && !state.submitting && !state.timeExpired) {
      submitQuiz('manual');
    }
  }

  async function handleQuit() {
    if (!state.quiz || state.submitting) return;
    const confirmed = await confirmDialog({
      title: 'Quit this quiz?',
      message: 'Your progress in this quiz will be discarded and it will not be scored.',
      confirmText: 'Quit quiz',
      cancelText: 'Continue quiz',
    });
    if (confirmed && state.quiz && !state.submitting) {
      leaveQuiz();
    }
  }

  function leaveQuiz() {
    stopTimer();
    state.quiz = null;
    state.answers = new Map();
    rememberActiveQuiz(null);
    showView('home');
  }

  function buildAnswerPayload() {
    return Array.from(state.answers, ([questionId, selectedIndex]) => ({ questionId, selectedIndex }));
  }

  async function submitQuiz(reason) {
    if (!state.quiz || state.submitting) return;
    const quizId = state.quiz.quizId;

    state.submitting = true;
    closeDialogIfOpen();
    stopTimer();
    setQuizControlsDisabled(true);
    updateNavigation();

    // Make sure in-flight answer saves land first.
    await Promise.allSettled(Array.from(state.pendingSaves));

    try {
      const result = await apiRequest(API.submit(quizId), {
        method: 'POST',
        body: { answers: buildAnswerPayload(), reason },
      });
      showResults(result);
    } catch (error) {
      if (error.status === 409) {
        // Already submitted or finalized by the server after the deadline.
        await loadResultAndShow(quizId);
        return;
      }
      if (reason === 'timeout') {
        // The server finalizes expired quizzes itself; poll for that result.
        await pollForServerResult(quizId, error.message);
        return;
      }
      state.submitting = false;
      setQuizControlsDisabled(false);
      updateNavigation();
      startTimer();
      showGlobalError('Could not submit the quiz', `${error.message} Your answers are still selected - please try again.`);
    }
  }

  async function loadResultAndShow(quizId) {
    try {
      const result = await apiRequest(API.result(quizId));
      showResults(result);
    } catch (error) {
      showGlobalError('Could not load your results', error.message, () => loadResultAndShow(quizId));
    }
  }

  async function pollForServerResult(quizId, firstErrorMessage) {
    showGlobalError('Time is up - finishing your quiz', `${firstErrorMessage} Retrying automatically...`);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 5000));
      try {
        const result = await apiRequest(API.result(quizId));
        showResults(result);
        return;
      } catch (error) {
        if (error.status === 404) break;
      }
    }
    showGlobalError(
      'Could not retrieve your results',
      'The quiz server did not respond. Check that it is still running, then try again.',
      () => loadResultAndShow(quizId)
    );
  }

  // -------------------------------------------------------------------------
  // Timer
  // -------------------------------------------------------------------------

  function startTimer() {
    stopTimer();
    tickTimer();
    if (!state.timeExpired) state.timerId = window.setInterval(tickTimer, TIMER_TICK_MS);
  }

  function stopTimer() {
    if (state.timerId !== null) {
      window.clearInterval(state.timerId);
      state.timerId = null;
    }
  }

  function tickTimer() {
    if (!state.quiz) return;
    const msLeft = remainingMs();
    const secondsLeft = Math.max(0, Math.ceil(msLeft / 1000));

    if (secondsLeft !== state.lastRenderedSeconds) {
      state.lastRenderedSeconds = secondsLeft;
      dom.timerValue.textContent = formatClock(secondsLeft);
      dom.timer.setAttribute('aria-label', `Time remaining: ${formatDuration(secondsLeft)}`);
      dom.timer.classList.toggle('is-warning', secondsLeft <= state.warningSeconds && secondsLeft > CRITICAL_SECONDS);
      dom.timer.classList.toggle('is-critical', secondsLeft <= CRITICAL_SECONDS);

      if (secondsLeft <= state.warningSeconds && secondsLeft > 0) {
        dom.timerWarningText.textContent = `Less than ${formatDuration(Math.max(secondsLeft, 1))} remaining. Your quiz will be submitted automatically when the timer reaches zero.`;
        if (!state.warningShown) {
          state.warningShown = true;
          dom.timerWarning.hidden = false;
        }
      }
    }

    if (msLeft <= 0) handleTimeExpired();
  }

  function handleTimeExpired() {
    if (state.timeExpired || !state.quiz) return;
    state.timeExpired = true;
    stopTimer();
    dom.timerValue.textContent = formatClock(0);
    dom.timerWarning.hidden = true;
    announce('Time is up. Submitting your quiz automatically.');
    submitQuiz('timeout');
  }

  // -------------------------------------------------------------------------
  // Results
  // -------------------------------------------------------------------------

  function showResults(result) {
    stopTimer();
    closeDialogIfOpen();
    hideGlobalError();
    rememberActiveQuiz(result.quizId);

    state.result = result;
    state.quiz = null;
    state.submitting = false;
    state.timeExpired = false;
    state.reviewFilter = 'all';

    const percentage = Number(result.percentage) || 0;
    const percentLabel = `${Number.isInteger(percentage) ? percentage : percentage.toFixed(1)}%`;

    dom.resultCategory.textContent = `${result.categoryName} - results`;
    dom.resultPercentageRing.textContent = percentLabel;
    dom.scoreRing.style.setProperty('--pct', String(Math.min(100, Math.max(0, percentage))));
    dom.scoreRing.className = `score-ring level-${result.performance.level}`;
    dom.resultPerformanceTitle.textContent = result.performance.title;
    dom.resultPerformanceMessage.textContent = result.performance.message;

    if (result.autoSubmitted) {
      dom.resultNotice.textContent = 'Time ran out - your quiz was submitted automatically.';
      dom.resultNotice.hidden = false;
    } else {
      dom.resultNotice.hidden = true;
    }

    dom.resultTotal.textContent = String(result.totalQuestions);
    dom.resultAttempted.textContent = String(result.attempted);
    dom.resultCorrect.textContent = String(result.correct);
    dom.resultIncorrect.textContent = String(result.incorrect);
    dom.resultScore.textContent = `${result.score} / ${result.maxScore}`;
    dom.resultPercentage.textContent = percentLabel;
    dom.resultUnanswered.textContent = String(result.unanswered);
    dom.resultTime.textContent = formatClock(result.timeTakenSeconds);

    setReviewFilter('all');
    showView('results');
    loadHistory();
    announce(`Quiz submitted. You scored ${result.score} out of ${result.maxScore}, ${percentLabel}.`);
  }

  function renderReviewItem(item) {
    const statusLabel = { correct: 'Correct', incorrect: 'Incorrect', unanswered: 'Not answered' }[item.status];

    const optionItems = item.options.map((optionText, optionIndex) => {
      const isCorrectAnswer = optionIndex === item.correctIndex;
      const isWrongChoice = optionIndex === item.selectedIndex && !isCorrectAnswer;
      const classes = ['review-option'];
      if (isCorrectAnswer) classes.push('is-correct-answer');
      if (isWrongChoice) classes.push('is-wrong-choice');

      let flag = null;
      if (isCorrectAnswer && optionIndex === item.selectedIndex) flag = 'Your answer - correct';
      else if (isCorrectAnswer) flag = 'Correct answer';
      else if (isWrongChoice) flag = 'Your answer';

      return createElement('li', { className: classes.join(' ') }, [
        createElement('span', { className: 'option-letter', text: OPTION_LETTERS[optionIndex], attrs: { 'aria-hidden': 'true' } }),
        createElement('span', { className: 'review-option-text', text: optionText }),
        flag ? createElement('span', { className: 'answer-flag', text: flag }) : null,
      ]);
    });

    const yourAnswerText =
      item.selectedIndex === null
        ? 'Not answered'
        : `${OPTION_LETTERS[item.selectedIndex]}. ${item.options[item.selectedIndex]}`;
    const correctAnswerText = `${OPTION_LETTERS[item.correctIndex]}. ${item.options[item.correctIndex]}`;

    return createElement('li', { className: `card review-item is-${item.status}`, attrs: { 'data-status': item.status } }, [
      createElement('div', { className: 'review-top' }, [
        createElement('span', { className: 'review-number', text: `Question ${item.number} - ${item.categoryName}` }),
        createElement('span', { className: `status-pill status-${item.status}`, text: statusLabel }),
      ]),
      createElement('p', { className: 'review-question', text: item.question }),
      createElement('ul', { className: 'review-options', attrs: { 'aria-label': 'Options' } }, optionItems),
      createElement('p', { className: 'answer-summary' }, [
        createElement('strong', { text: 'Your answer: ' }),
        document.createTextNode(yourAnswerText),
      ]),
      createElement('p', { className: 'answer-summary' }, [
        createElement('strong', { text: 'Correct answer: ' }),
        document.createTextNode(correctAnswerText),
      ]),
      createElement('div', { className: 'explanation' }, [
        createElement('span', { className: 'explanation-label', text: 'Explanation' }),
        document.createTextNode(item.explanation),
      ]),
    ]);
  }

  function setReviewFilter(filter) {
    if (!state.result) return;
    state.reviewFilter = filter;
    dom.filterButtons.forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
    });

    const items = state.result.review.filter((item) => filter === 'all' || item.status === filter);
    dom.reviewList.replaceChildren(...items.map(renderReviewItem));
    dom.reviewEmpty.hidden = items.length > 0;
  }

  async function handleRetry() {
    if (!state.result) return;
    const previous = state.result;
    dom.retryButton.disabled = true;
    hideGlobalError();
    try {
      const session = await apiRequest(API.quizzes, { method: 'POST', body: { retryOf: previous.quizId } });
      beginQuiz(session);
    } catch (error) {
      if (error.status === 404) {
        // The original session is gone (e.g. server restarted): start a fresh
        // quiz with the same subject, size and time limit instead.
        try {
          const session = await apiRequest(API.quizzes, {
            method: 'POST',
            body: {
              category: previous.category,
              questionCount: previous.totalQuestions,
              durationMinutes: Math.max(1, Math.round(previous.durationSeconds / 60)),
            },
          });
          beginQuiz(session);
          return;
        } catch (fallbackError) {
          showGlobalError('Could not restart the quiz', fallbackError.message);
          return;
        }
      }
      showGlobalError('Could not restart the quiz', error.message);
    } finally {
      dom.retryButton.disabled = false;
    }
  }

  function handleReturnHome() {
    state.result = null;
    rememberActiveQuiz(null);
    hideGlobalError();
    showView('home');
    if (state.categories.length === 0) loadCategories();
  }

  // -------------------------------------------------------------------------
  // Keyboard shortcuts (1-4 / A-D select an option during the quiz)
  // -------------------------------------------------------------------------

  function handleKeydown(event) {
    if (currentViewName() !== 'quiz' || !state.quiz || dom.dialog.open) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    if (target && (target.tagName === 'SELECT' || target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type !== 'radio'))) return;

    const key = event.key.toLowerCase();
    const index = ['1', '2', '3', '4'].indexOf(key) !== -1 ? Number(key) - 1 : ['a', 'b', 'c', 'd'].indexOf(key);
    if (index < 0 || index >= currentQuestion().options.length) return;

    const input = dom.optionsList.querySelectorAll('input[type="radio"]')[index];
    if (!input || input.disabled) return;
    event.preventDefault();
    input.checked = true;
    input.focus();
    selectAnswer(index);
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------

  async function resumeActiveQuiz() {
    const quizId = readActiveQuiz();
    if (!quizId) return;
    try {
      const session = await apiRequest(API.quiz(quizId));
      if (session.status === 'submitted') {
        await loadResultAndShow(quizId);
      } else {
        beginQuiz(session, { resume: true });
      }
    } catch (error) {
      rememberActiveQuiz(null);
    }
  }

  function setAuthMode(mode) {
    state.authMode = mode;
    const registering = mode === 'register';
    dom.authFormTitle.textContent = registering ? 'Create your account' : 'Sign in';
    dom.authSubmit.textContent = registering ? 'Create account' : 'Sign in';
    dom.authNameField.hidden = !registering;
    dom.authName.required = registering;
    dom.authPassword.autocomplete = registering ? 'new-password' : 'current-password';
    dom.authSwitchCopy.textContent = registering ? 'Already have an account?' : 'New here?';
    dom.authSwitch.textContent = registering ? 'Sign in' : 'Create an account';
    dom.authError.hidden = true;
  }

  async function loadHistory() {
    try {
      const data = await apiRequest('/api/history');
      dom.historyList.replaceChildren();
      dom.historyEmpty.hidden = data.results.length > 0;
      data.results.forEach((row) => {
        const item = createElement('li', { className: 'history-item' });
        const title = createElement('strong', { text: row.result.categoryName });
        const detail = createElement('span', { text: row.score + ' / ' + row.total + ' correct · ' + row.percentage + '%' });
        const date = createElement('time', { text: new Date(row.submittedAt).toLocaleDateString(), attrs: { datetime: row.submittedAt } });
        item.append(title, detail, date); dom.historyList.appendChild(item);
      });
    } catch (error) { dom.historyEmpty.textContent = 'Could not load saved results right now.'; }
  }

  async function finishSignIn(user) {
    state.user = user;
    dom.accountName.textContent = user.name;
    dom.accountName.hidden = false;
    dom.logoutButton.hidden = false;
    dom.authView.hidden = true;
    showView('home');
    await loadCategories();
    await loadHistory();
    await resumeActiveQuiz();
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    dom.authSubmit.disabled = true;
    dom.authError.hidden = true;
    const registering = state.authMode === 'register';
    try {
      const payload = { email: dom.authEmail.value.trim(), password: dom.authPassword.value };
      if (registering) payload.name = dom.authName.value.trim();
      const response = await apiRequest(registering ? '/api/auth/register' : '/api/auth/login', { method: 'POST', body: payload });
      await finishSignIn(response.user);
    } catch (error) {
      dom.authError.textContent = error.message;
      dom.authError.hidden = false;
    } finally { dom.authSubmit.disabled = false; }
  }

  async function handleLogout() {
    try { await apiRequest('/api/auth/logout', { method: 'POST', body: {} }); } catch (error) { /* local sign-out still clears this browser */ }
    localStorage.removeItem(ACTIVE_QUIZ_KEY);
    window.location.reload();
  }

  function bindEvents() {
    dom.authForm.addEventListener('submit', handleAuthSubmit);
    dom.authSwitch.addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'register' : 'login'));
    dom.logoutButton.addEventListener('click', handleLogout);
    dom.startForm.addEventListener('submit', handleStartSubmit);
    dom.categoryGrid.addEventListener('change', () => {
      renderQuestionCountOptions();
      updateStartSummary();
    });
    dom.questionCount.addEventListener('change', updateStartSummary);
    dom.duration.addEventListener('change', updateStartSummary);

    dom.prevButton.addEventListener('click', handlePrevious);
    dom.nextButton.addEventListener('click', handleNext);
    dom.submitButton.addEventListener('click', handleSubmitClick);
    dom.quitButton.addEventListener('click', handleQuit);

    dom.retryButton.addEventListener('click', handleRetry);
    dom.homeButton.addEventListener('click', handleReturnHome);
    dom.filterButtons.forEach((button) => {
      button.addEventListener('click', () => setReviewFilter(button.dataset.filter));
    });

    dom.globalAlertRetry.addEventListener('click', () => {
      if (state.retryHandler) state.retryHandler();
    });

    dom.brandLink.addEventListener('click', (event) => {
      event.preventDefault();
      if (!state.user) return;
      if (currentViewName() === 'quiz' && state.quiz) handleQuit();
      else if (currentViewName() === 'results') handleReturnHome();
      else showView('home');
    });

    document.addEventListener('keydown', handleKeydown);

    // Re-sync the countdown when a backgrounded tab becomes visible again
    // (browsers throttle timers in hidden tabs).
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.quiz && !state.submitting) tickTimer();
    });
  }

  async function init() {
    bindEvents();
    setAuthMode('login');
    try {
      const response = await apiRequest('/api/auth/me');
      await finishSignIn(response.user);
    } catch (error) {
      dom.authView.hidden = false;
      dom.authEmail.focus();
    }
  }

  init();
})();
