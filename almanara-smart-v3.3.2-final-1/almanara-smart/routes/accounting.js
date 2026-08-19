'use strict';

const express = require('express');
const Joi = require('joi');
const db = require('../config/db');
const validate = require('../middleware/validate');
const { authenticate, requireRole } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { asyncHandler, parsePagination } = require('../utils/helpers');
const { postJournalEntry, paymentAccountCode } = require('../utils/accounting');

const router = express.Router();
router.use(authenticate);

router.get('/accounts', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT * FROM accounts WHERE is_active=true ORDER BY code');
  res.json({ accounts: result.rows });
}));

router.get('/ledger', asyncHandler(async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const result = await db.query(
    `SELECT je.entry_number,je.entry_date,je.description,je.reference_type,je.reference_id,
            a.code,a.name,jl.debit,jl.credit,jl.description AS line_description
     FROM journal_entries je JOIN journal_entry_lines jl ON jl.journal_entry_id=je.id
     JOIN accounts a ON a.id=jl.account_id
     WHERE ($3::date IS NULL OR je.entry_date >= $3)
       AND ($4::date IS NULL OR je.entry_date <= $4)
       AND ($5::text IS NULL OR a.code=$5)
     ORDER BY je.entry_date DESC,je.entry_number DESC,jl.id LIMIT $1 OFFSET $2`,
    [limit, offset, req.query.from || null, req.query.to || null, req.query.accountCode || null]
  );
  res.json({ ledger: result.rows, pagination: { page, limit } });
}));

router.get('/trial-balance', asyncHandler(async (req, res) => {
  const result = await db.query('SELECT * FROM v_trial_balance ORDER BY code');
  const totals = result.rows.reduce((a, r) => ({ debit: a.debit + Number(r.debit), credit: a.credit + Number(r.credit) }), { debit: 0, credit: 0 });
  res.json({ accounts: result.rows, totals: { debit: totals.debit.toFixed(2), credit: totals.credit.toFixed(2) } });
}));

router.get('/income-statement', asyncHandler(async (req, res) => {
  const from = req.query.from || new Date().toISOString().slice(0,10);
  const to = req.query.to || from;
  const result = await db.query(
    `SELECT a.code,a.name,a.account_type,COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
     FROM accounts a JOIN journal_entry_lines jl ON jl.account_id=a.id JOIN journal_entries je ON je.id=jl.journal_entry_id
     WHERE je.entry_date BETWEEN $1 AND $2 AND a.account_type IN ('revenue','expense')
     GROUP BY a.id ORDER BY a.code`, [from,to]
  );
  const revenue = result.rows.filter(r=>r.account_type==='revenue').reduce((s,r)=>s+Number(r.credit)-Number(r.debit),0);
  const expenses = result.rows.filter(r=>r.account_type==='expense').reduce((s,r)=>s+Number(r.debit)-Number(r.credit),0);
  res.json({ from,to, lines: result.rows, revenue: revenue.toFixed(2), expenses: expenses.toFixed(2), netIncome: (revenue-expenses).toFixed(2) });
}));

router.get('/balance-sheet', asyncHandler(async (req, res) => {
  const to = req.query.to || new Date().toISOString().slice(0,10);
  const result = await db.query(
    `SELECT a.code,a.name,a.account_type,COALESCE(SUM(jl.debit),0) debit,COALESCE(SUM(jl.credit),0) credit
     FROM accounts a LEFT JOIN journal_entry_lines jl ON jl.account_id=a.id
     LEFT JOIN journal_entries je ON je.id=jl.journal_entry_id AND je.entry_date <= $1
     WHERE a.account_type IN ('asset','liability','equity') GROUP BY a.id ORDER BY a.code`, [to]
  );
  res.json({ to, lines: result.rows });
}));

const drawerSchema = Joi.object({
  shiftId: Joi.string().uuid().required(), type: Joi.string().valid('withdrawal','deposit').required(),
  amount: Joi.number().positive().precision(2).required(), reason: Joi.string().min(2).max(500).required(), approvedBy: Joi.string().uuid().allow(null)
});
router.post('/cash-drawer', requireRole('admin','manager','accountant'), validate(drawerSchema), asyncHandler(async (req,res)=>{
  const result = await db.withTransaction(async client=>{
    const shift = await client.query(`SELECT * FROM shifts WHERE id=$1 AND status='open' FOR UPDATE`,[req.body.shiftId]);
    if(!shift.rows.length) throw new AppError('الوردية غير موجودة أو مغلقة',400);
    const drawer = await client.query(`INSERT INTO cash_drawer_transactions(shift_id,user_id,type,amount,reason,approved_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[req.body.shiftId,req.user.id,req.body.type,req.body.amount,req.body.reason,req.body.approvedBy||null]);
    const amount=Number(req.body.amount);
    const lines=req.body.type==='withdrawal' ? [{code:req.body.reason.includes('شخص')?'6120':'6110',debit:amount},{code:'1110',credit:amount}] : [{code:'1110',debit:amount},{code:'6110',credit:amount}];
    await postJournalEntry(client,{description:`${req.body.type==='withdrawal'?'سحب':'إيداع'} نقدي: ${req.body.reason}`,referenceId:drawer.rows[0].id,referenceType:'cash_drawer',userId:req.user.id,lines});
    return drawer.rows[0];
  });
  res.status(201).json({ transaction: result });
}));
router.get('/cash-drawer', asyncHandler(async(req,res)=>{
  const result=await db.query(`SELECT c.*,u.full_name FROM cash_drawer_transactions c JOIN users u ON u.id=c.user_id WHERE ($1::uuid IS NULL OR c.shift_id=$1) ORDER BY c.created_at DESC`,[req.query.shiftId||null]);
  res.json({transactions:result.rows});
}));

const expenseSchema=Joi.object({expenseType:Joi.string().valid('operational','personal','damage','other').required(),amount:Joi.number().positive().precision(2).required(),description:Joi.string().max(500).allow('',null),expenseDate:Joi.date().allow(null),paymentMethodId:Joi.string().uuid().required(),shiftId:Joi.string().uuid().allow(null)});
router.post('/expenses',requireRole('admin','manager','accountant'),validate(expenseSchema),asyncHandler(async(req,res)=>{
  const result=await db.withTransaction(async client=>{
    const e=await client.query(`INSERT INTO expenses(expense_type,amount,description,expense_date,recorded_by) VALUES($1,$2,$3,COALESCE($4::date,CURRENT_DATE),$5) RETURNING *`,[req.body.expenseType,req.body.amount,req.body.description||null,req.body.expenseDate||null,req.user.id]);
    const pm=await client.query('SELECT type,name FROM payment_methods WHERE id=$1 AND is_active=true',[req.body.paymentMethodId]);
    if(!pm.rows.length) throw new AppError('وسيلة الدفع غير موجودة',400);
    await postJournalEntry(client,{description:req.body.description||'مصروف',referenceId:e.rows[0].id,referenceType:'expense',userId:req.user.id,lines:[{code:req.body.expenseType==='personal'?'6120':'6110',debit:req.body.amount},{code:paymentAccountCode(pm.rows[0].type),credit:req.body.amount}]});
    return e.rows[0];
  });
  res.status(201).json({expense:result});
}));
router.get('/expenses',asyncHandler(async(req,res)=>{
  const {page,limit,offset}=parsePagination(req.query); const r=await db.query(`SELECT e.*,u.full_name FROM expenses e LEFT JOIN users u ON u.id=e.recorded_by ORDER BY e.expense_date DESC,e.created_at DESC LIMIT $1 OFFSET $2`,[limit,offset]);
  res.json({expenses:r.rows,pagination:{page,limit}});
}));

const taxSchema=Joi.object({name:Joi.string().min(1).max(100).required(),rate:Joi.number().min(0).max(100).precision(2).required(),type:Joi.string().valid('percentage','fixed').default('percentage'),isActive:Joi.boolean().default(true),accountId:Joi.string().uuid().allow(null)});
router.get('/taxes',asyncHandler(async(req,res)=>{const r=await db.query('SELECT * FROM taxes ORDER BY name');res.json({taxes:r.rows});}));
router.post('/taxes',requireRole('admin','manager','accountant'),validate(taxSchema),asyncHandler(async(req,res)=>{const r=await db.query(`INSERT INTO taxes(name,rate,type,is_active,account_id) VALUES($1,$2,$3,$4,$5) RETURNING *`,[req.body.name,req.body.rate,req.body.type,req.body.isActive,req.body.accountId||null]);res.status(201).json({tax:r.rows[0]});}));
router.put('/taxes/:id',requireRole('admin','manager','accountant'),validate(taxSchema),asyncHandler(async(req,res)=>{const r=await db.query(`UPDATE taxes SET name=$1,rate=$2,type=$3,is_active=$4,account_id=$5 WHERE id=$6 RETURNING *`,[req.body.name,req.body.rate,req.body.type,req.body.isActive,req.body.accountId||null,req.params.id]);if(!r.rows.length)throw new AppError('الضريبة غير موجودة',404);res.json({tax:r.rows[0]});}));

router.get('/currencies',asyncHandler(async(req,res)=>{const [c,r]=await Promise.all([db.query('SELECT * FROM currencies WHERE is_active=true ORDER BY code'),db.query('SELECT * FROM exchange_rates ORDER BY effective_at DESC LIMIT 100')]);res.json({currencies:c.rows,rates:r.rows});}));
const rateSchema=Joi.object({fromCurrency:Joi.string().max(10).required(),toCurrency:Joi.string().max(10).required(),rate:Joi.number().positive().precision(2).required()});
router.post('/currencies/rates',requireRole('admin','manager','accountant'),validate(rateSchema),asyncHandler(async(req,res)=>{const r=await db.query(`INSERT INTO exchange_rates(from_currency,to_currency,rate,set_by) VALUES($1,$2,$3,$4) RETURNING *`,[req.body.fromCurrency,req.body.toCurrency,req.body.rate,req.user.id]);await db.query(`INSERT INTO exchange_rate_snapshots(from_currency,to_currency,rate,source,set_by) VALUES($1,$2,$3,'manual',$4)`,[req.body.fromCurrency,req.body.toCurrency,req.body.rate,req.user.id]);res.status(201).json({rate:r.rows[0]});}));


router.get('/settings',asyncHandler(async(req,res)=>{const r=await db.query('SELECT key,value FROM company_settings ORDER BY key');res.json({settings:Object.fromEntries(r.rows.map(x=>[x.key,x.value]))});}));
router.put('/settings',requireRole('admin','manager'),asyncHandler(async(req,res)=>{const allowed=['tax_registration_number','default_currency'];const entries=Object.entries(req.body||{}).filter(([k])=>allowed.includes(k));await db.withTransaction(async client=>{for(const [k,v] of entries)await client.query(`INSERT INTO company_settings(key,value,updated_by) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()`,[k,String(v??''),req.user.id]);});res.json({ok:true});}));
module.exports=router;
