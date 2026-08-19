'use strict';

const { AppError } = require('../middleware/errorHandler');

async function accountId(client, code) {
  const result = await client.query('SELECT id FROM accounts WHERE code = $1 AND is_active = true', [code]);
  if (result.rows.length === 0) throw new AppError(`الحساب المحاسبي ${code} غير موجود`, 500, 'ACCOUNT_NOT_FOUND');
  return result.rows[0].id;
}

async function postJournalEntry(client, { description, referenceId = null, referenceType = null, userId = null, lines }) {
  if (!Array.isArray(lines) || lines.length < 2) throw new AppError('القيد المحاسبي يحتاج سطرين على الأقل', 500, 'INVALID_JOURNAL');
  const normalized = lines.map((line) => ({
    code: line.code,
    debit: Number(Number(line.debit || 0).toFixed(2)),
    credit: Number(Number(line.credit || 0).toFixed(2)),
    description: line.description || null
  }));
  const debit = Number(normalized.reduce((s, l) => s + l.debit, 0).toFixed(2));
  const credit = Number(normalized.reduce((s, l) => s + l.credit, 0).toFixed(2));
  if (debit <= 0 || debit !== credit) throw new AppError(`القيد غير متوازن: مدين ${debit} / دائن ${credit}`, 500, 'UNBALANCED_JOURNAL');

  const entryResult = await client.query(
    `INSERT INTO journal_entries (description, reference_id, reference_type, user_id)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [description, referenceId, referenceType, userId]
  );
  const entry = entryResult.rows[0];
  for (const line of normalized) {
    const id = await accountId(client, line.code);
    await client.query(
      `INSERT INTO journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
       VALUES ($1,$2,$3,$4,$5)`,
      [entry.id, id, line.debit, line.credit, line.description]
    );
  }
  return entry;
}

function paymentAccountCode(paymentType) {
  return paymentType === 'cash' ? '1110' : paymentType === 'credit' ? '1130' : '1120';
}

module.exports = { postJournalEntry, accountId, paymentAccountCode };
