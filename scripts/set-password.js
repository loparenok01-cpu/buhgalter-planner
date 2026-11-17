'use strict';

// Смена пароля учётной записи. Выполняется при настройке сервера (FR-69):
// в интерфейсе кнопки смены пароля нет, восстановление пароля не предусмотрено.
//
// Запуск:  npm run password -- <новый пароль>
// или      npm run password            — программа спросит пароль сама.
//
// Все открытые сессии при этом закрываются: вход потребуется заново.

const readline = require('node:readline');

const auth = require('../server/auth');
const { openDatabase } = require('../server/db');

function askPassword() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Новый пароль: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

(async () => {
  const password = (process.argv[2] || (await askPassword())).trim();

  if (password.length < 6) {
    process.stderr.write('Пароль слишком короткий: нужно не меньше 6 символов.\n');
    process.exit(1);
  }

  const db = openDatabase();
  const row = db.prepare('SELECT login FROM accounts LIMIT 1').get();

  if (!row) {
    process.stderr.write('Учётная записи ещё нет: запустите сервер один раз, чтобы она создалась.\n');
    process.exit(1);
  }

  auth.setPassword(db, row.login, password);
  db.close();

  process.stdout.write(`Пароль учётной записи «${row.login}» изменён. Все сессии закрыты.\n`);
})();
