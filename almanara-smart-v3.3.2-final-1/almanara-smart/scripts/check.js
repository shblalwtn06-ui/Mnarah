'use strict';
const fs=require('fs');const path=require('path');const {execFileSync}=require('child_process');
const root=path.join(__dirname,'..');let files=[];
function walk(dir){for(const name of fs.readdirSync(dir)){const full=path.join(dir,name);if(name==='node_modules'||name.startsWith('.'))continue;const st=fs.statSync(full);if(st.isDirectory())walk(full);else if(full.endsWith('.js'))files.push(full);}}
walk(root);
for(const file of files){try{execFileSync(process.execPath,['--check',file],{stdio:'pipe'});}catch(err){console.error(`Syntax error: ${path.relative(root,file)}\n${err.stderr?.toString()||err.message}`);process.exit(1);}}
const required=['schema.sql','server.js','public/index.html','public/manifest.json','public/sw.js','routes/accounting.js','utils/accounting.js'];
for(const f of required)if(!fs.existsSync(path.join(root,f))){console.error(`Missing required file: ${f}`);process.exit(1);}
const schema=fs.readFileSync(path.join(root,'schema.sql'),'utf8');
for(const token of ['CREATE TABLE IF NOT EXISTS accounts','CREATE TABLE IF NOT EXISTS journal_entries','CREATE TABLE IF NOT EXISTS journal_entry_lines','CREATE TABLE IF NOT EXISTS cash_drawer_transactions','CREATE TABLE IF NOT EXISTS taxes','CREATE TABLE IF NOT EXISTS currencies','CREATE TABLE IF NOT EXISTS exchange_rates'])if(!schema.includes(token)){console.error(`Missing schema feature: ${token}`);process.exit(1);}
console.log(`JavaScript syntax check passed: ${files.length} files.`);
