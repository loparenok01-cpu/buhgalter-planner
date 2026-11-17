'use strict';

// Восстановление после недоступной или повреждённой базы (FR-51, AC-51).
//
// Сервер при старте пытается открыть базу. Если файл повреждён, приложение
// не завершается: оно показывает экран восстановления и предлагает два
// способа — загрузить копию JSON (FR-53, FR-54) или начать с нуля.
// Повреждённый файл не удаляется: он переименовывается рядом с базой,
// чтобы данные можно было передать специалисту.

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const auth = require('./auth');
const backup = require('./backup');
const { openDatabase } = require('./db');

// Отодвигает текущие файлы базы в сторону. Возвращает список новых имён.
function quarantine(dbFile) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const moved = [];

  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${dbFile}${suffix}`;
    if (!fs.existsSync(file)) continue;

    const target = `${dbFile}.corrupt-${stamp}${suffix}`;
    fs.renameSync(file, target);
    moved.push(path.basename(target));
  }

  return moved;
}

function accountOptions(input) {
  const login = typeof input.login === 'string' ? input.login.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';

  if (login.length === 0) return { error: 'Укажите логин' };
  if (password.length < 6) return { error: 'Пароль слишком короткий: нужно не меньше 6 символов' };

  return { login, password };
}

// Начать с нуля: пустая база со всеми таблицами и новой учётной записью.
// closeCurrent закрывает рабочее соединение перед перемещением файла.
function startEmpty(input, closeCurrent) {
  const account = accountOptions(input || {});
  if (account.error) return { errors: [account.error] };

  if (closeCurrent) closeCurrent();
  const previous = quarantine(config.dbFile);
  const db = openDatabase();
  const info = auth.ensureAccount(db, { login: account.login, password: account.password });

  return { db, account: info.account, previous };
}

// Восстановить из копии JSON. Файл проверяется до того, как прежняя база
// будет отодвинута в сторону: неподходящий файл ничего не меняет.
function restoreFromFile(file, input, closeCurrent) {
  if (!file || typeof file !== 'object') {
    return { errors: ['Файл копии не передан'] };
  }

  const errors = backup.validateFile(file);
  if (errors.length > 0) return { errors };

  const account = accountOptions(input || {});
  if (account.error) return { errors: [account.error] };

  if (closeCurrent) closeCurrent();
  const previous = quarantine(config.dbFile);
  const db = openDatabase();

  try {
    backup.importData(db, file);
    const info = auth.ensureAccount(db, { login: account.login, password: account.password });
    return {
      db,
      account: info.account,
      counts: backup.countData(file),
      previous,
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

module.exports = { quarantine, startEmpty, restoreFromFile };
