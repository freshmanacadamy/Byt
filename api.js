const TelegramBot = require('node-telegram-bot-api');
const fetch = require('node-fetch');
const cheerio = require('cheerio');

// =====================
// ENVIRONMENT VARIABLES
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');

// =====================
// CREATE BOT INSTANCE
// =====================
const bot = new TelegramBot(BOT_TOKEN);

// =====================
// IN-MEMORY STORAGE
// =====================
const users = new Map();
const userStates = new Map();

// =====================
// MAIN MENU
// =====================
const showMainMenu = async (chatId) => {
  const options = {
    reply_markup: {
      keyboard: [
        [{ text: '📊 Show Grades' }, { text: 'ℹ️ Help' }]
      ],
      resize_keyboard: true
    }
  };

  await bot.sendMessage(chatId,
    `🎓 *Jimma University Grade Viewer*\n\n` +
    `Welcome! Choose an option below:`,
    { parse_mode: 'Markdown', ...options }
  );
};

// =====================
// START COMMAND
// =====================
const handleStart = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (!users.has(userId)) {
    users.set(userId, {
      telegramId: userId,
      firstName: msg.from.first_name,
      portalUsername: null,
      portalPassword: null
    });
  }

  await bot.sendMessage(chatId,
    `🎓 Welcome to JU Grade Viewer Bot!\n\n` +
    `Click "📊 Show Grades" to check your grades securely.`
  );

  await showMainMenu(chatId);
};

// =====================
// HELP COMMAND
// =====================
const handleHelp = async (msg) => {
  await bot.sendMessage(msg.chat.id,
    `ℹ️ *Help*\n\n` +
    `• Click "📊 Show Grades" to view your grades\n` +
    `• Enter your JU portal username and password when prompted\n` +
    `• Contact admin if you have login issues`,
    { parse_mode: 'Markdown' }
  );
};

// =====================
// HANDLE GRADES
// =====================
const handleGrades = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const user = users.get(userId);

  // Step-by-step flow
  if (!user.portalUsername) {
    userStates.set(userId, { state: 'awaiting_username' });
    await bot.sendMessage(chatId, `📌 Please enter your JU portal *username*:`, { parse_mode: 'Markdown' });
    return;
  }

  if (!user.portalPassword) {
    userStates.set(userId, { state: 'awaiting_password' });
    await bot.sendMessage(chatId, `📌 Now enter your JU portal *password*:`, { parse_mode: 'Markdown' });
    return;
  }

  // Fetch grades
  try {
    const grades = await fetchGradesFromPortal(user.portalUsername, user.portalPassword);

    if (!grades || grades.length === 0) {
      await bot.sendMessage(chatId, `⚠️ No grades found for your account.`);
      return;
    }

    let message = `📊 *Your Grades*\n\n`;
    grades.forEach(g => {
      message += `• ${g.course} | ${g.grade} | ${g.semester}\n`;
    });

    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });

  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, `❌ Failed to fetch grades. Check your credentials or try later.`);
  }
};

// =====================
// HANDLE MESSAGES
// =====================
const handleMessage = async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;
  const state = userStates.get(userId);

  // Handle step-by-step credentials
  if (state) {
    if (state.state === 'awaiting_username') {
      const user = users.get(userId);
      user.portalUsername = text.trim();
      users.set(userId, user);
      userStates.set(userId, { state: 'awaiting_password' });
      await bot.sendMessage(chatId, `✅ Username saved! Now enter your *password*:`, { parse_mode: 'Markdown' });
      return;
    }

    if (state.state === 'awaiting_password') {
      const user = users.get(userId);
      user.portalPassword = text.trim();
      users.set(userId, user);
      userStates.delete(userId);

      await bot.sendMessage(chatId, `✅ Password saved! Fetching your grades...`);
      await handleGrades(msg);
      return;
    }
  }

  // Commands & buttons
  switch (text) {
    case '/start':
      await handleStart(msg);
      break;
    case '/help':
    case 'ℹ️ Help':
      await handleHelp(msg);
      break;
    case '📊 Show Grades':
      await handleGrades(msg);
      break;
    default:
      await showMainMenu(chatId);
  }
};

// =====================
// SCRAPER: fetch grades
// =====================
async function fetchGradesFromPortal(username, password) {
  // 1️⃣ Login page GET to get tokens
  const loginPage = await fetch('https://portal.ju.edu.et/', { method: 'GET' });
  const loginHtml = await loginPage.text();
  const $ = cheerio.load(loginHtml);
  const csrfToken = $('input[name="__RequestVerificationToken"]').attr('value');

  // 2️⃣ Login POST
  const loginResp = await fetch('https://portal.ju.edu.et/Account/Login', {
    method: 'POST',
    body: new URLSearchParams({
      Username: username,
      Password: password,
      __RequestVerificationToken: csrfToken || ''
    }),
    redirect: 'manual'
  });

  const cookies = loginResp.headers.get('set-cookie');
  if (!cookies) throw new Error('Login failed: Invalid credentials or portal blocked bot');

  // 3️⃣ Fetch grades page
  const gradesPage = await fetch('https://portal.ju.edu.et/Student/Results', {
    headers: { Cookie: cookies }
  });
  const gradesHtml = await gradesPage.text();

  // 4️⃣ Scrape grades table
  const $$ = cheerio.load(gradesHtml);
  const grades = [];
  $$('table#grades tr').each((i, row) => {
    const tds = $$(row).find('td');
    if (tds.length) {
      grades.push({
        course: $$(tds[0]).text().trim(),
        grade: $$(tds[1]).text().trim(),
        semester: $$(tds[2]).text().trim()
      });
    }
  });

  return grades;
}

// =====================
// VERCEL SERVERLESS HANDLER
// =====================
module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'online', users: users.size });
  }

  if (req.method === 'POST') {
    try {
      const update = req.body;
      if (update.message) await handleMessage(update.message);
      return res.status(200).json({ ok: true });
    } catch (err) {
      console.error('Error processing update:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
