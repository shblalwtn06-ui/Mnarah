'use strict';

const Dashboard = (() => {
  let charts = {};
  const esc = v => String(v ?? '').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const money = v => Number(v||0).toLocaleString('ar-YE',{minimumFractionDigits:2,maximumFractionDigits:2});
  const destroy = id => { if (charts[id]) { charts[id].destroy(); delete charts[id]; } };
  async function load(){
    try { await Promise.all([loadKpis(),loadCharts(),loadAlerts()]); }
    catch(e){ showToast(e.message,'error'); }
  }
  async function loadKpis(){
    const [sales,profit,inv,debts,sup,invoiceCount] = await Promise.all([
      apiFetch('/reports/sales'),apiFetch('/reports/profit'),apiFetch('/reports/inventory'),
      apiFetch('/reports/customer-debts'),apiFetch('/reports/supplier-debts'),apiFetch('/pos/invoices?limit=1')
    ]);
    const today = new Date().toISOString().slice(0,10);
    const sr = sales.report.find(x=>String(x.day).slice(0,10)===today);
    const pr = profit.report.find(x=>String(x.day).slice(0,10)===today);
    const customerDebt = debts.report.reduce((s,x)=>s+Number(x.balance||0),0);
    const supplierDebt = sup.report.reduce((s,x)=>s+Number(x.balance||0),0);
    const count = invoiceCount.pagination?.total ?? invoiceCount.pagination?.limit ?? 0;
    const kpis=[
      ['today-sales','مبيعات اليوم',money(sr?.total)],['today-profit','أرباح اليوم',money(pr?.gross_profit)],
      ['customer-debts','ديون العملاء',money(customerDebt)],['supplier-debts','ديون الموردين',money(supplierDebt)],
      ['invoices-count','الفواتير',count],['inventory-value','قيمة المخزون',money(inv.report?.total_value)]
    ];
    $('#kpiGrid').innerHTML=kpis.map(([key,label,value])=>`<button class="kpi-card" data-key="${key}"><div class="kpi-card__label">${esc(label)}</div><div class="kpi-card__value">${esc(value)}</div><small>اضغط للتفاصيل</small></button>`).join('');
    $$('#kpiGrid .kpi-card').forEach(b=>b.onclick=()=>drill(b.dataset.key));
  }
  async function loadCharts(){
    const [sales,cat,top]=await Promise.all([apiFetch('/reports/sales'),apiFetch('/reports/sales-by-category'),apiFetch('/reports/top-products')]);
    if(!window.Chart){return;}
    destroy('sales');destroy('category');destroy('top');
    charts.sales=new Chart($('#salesChart'),{type:'bar',data:{labels:sales.report.slice(0,7).reverse().map(x=>new Date(x.day).toLocaleDateString('ar-YE',{weekday:'short'})),datasets:[{label:'المبيعات',data:sales.report.slice(0,7).reverse().map(x=>Number(x.total)),borderWidth:1}]},options:{responsive:true,plugins:{legend:{display:false}}}});
    charts.category=new Chart($('#categoryChart'),{type:'doughnut',data:{labels:cat.report.map(x=>x.category),datasets:[{data:cat.report.map(x=>Number(x.total))}]},options:{responsive:true}});
    charts.top=new Chart($('#topProductsChart'),{type:'bar',data:{labels:top.report.map(x=>x.name),datasets:[{label:'الإيراد',data:top.report.map(x=>Number(x.revenue)),borderWidth:1}]},options:{indexAxis:'y',responsive:true,plugins:{legend:{display:false}}}});
  }
  async function loadAlerts(){
    const [exp,low,debt]=await Promise.all([apiFetch('/inventory/expiring-soon'),apiFetch('/inventory/low-stock'),apiFetch('/reports/customer-debts')]);
    $('#expiringList').innerHTML=(exp.batches||[]).slice(0,10).map(x=>`<li>${esc(x.product_name)} — ${esc(x.expiry_date)}</li>`).join('')||'<li>لا توجد تنبيهات</li>';
    $('#lowStockList').innerHTML=(low.products||[]).slice(0,10).map(x=>`<li>${esc(x.name)} — ${money(x.base_quantity)}</li>`).join('')||'<li>لا توجد تنبيهات</li>';
    $('#creditAlertsList').innerHTML=(debt.report||[]).filter(x=>Number(x.credit_limit)>0&&Number(x.balance)>=Number(x.credit_limit)).slice(0,10).map(x=>`<li>${esc(x.name)} — ${money(x.balance)}</li>`).join('')||'<li>لا توجد تنبيهات</li>';
    const pending=await window.OfflineSync?.getPendingCount?.() ?? 0;
    $('#syncAlertsList').innerHTML=`<li>${pending?`هناك ${pending} فاتورة بانتظار المزامنة`:'لا توجد فواتير معلقة'}</li>`;
  }
  async function drill(key){
    const modal=$('#drilldownModal'),body=$('#drilldownBody');modal.classList.remove('hidden');body.innerHTML='<p>جاري التحميل...</p>';
    try{
      if(key==='customer-debts'){const d=await apiFetch('/reports/customer-debts');body.innerHTML=`<h3>ديون العملاء</h3><table class="data-table"><thead><tr><th>العميل</th><th>الرصيد</th><th>الحد</th></tr></thead><tbody>${d.report.map(x=>`<tr><td>${esc(x.name)}</td><td>${money(x.balance)}</td><td>${money(x.credit_limit)}</td></tr>`).join('')}</tbody></table>`}
      else if(key==='supplier-debts'){const d=await apiFetch('/reports/supplier-debts');body.innerHTML=`<h3>ديون الموردين</h3><table class="data-table"><thead><tr><th>المورد</th><th>الرصيد</th></tr></thead><tbody>${d.report.map(x=>`<tr><td>${esc(x.name)}</td><td>${money(x.balance)}</td></tr>`).join('')}</tbody></table>`}
      else if(key==='inventory-value'){const d=await apiFetch('/inventory');body.innerHTML=`<h3>تفاصيل المخزون</h3><table class="data-table"><thead><tr><th>المنتج</th><th>الكمية</th><th>القيمة</th></tr></thead><tbody>${d.inventory.map(x=>`<tr><td>${esc(x.name)}</td><td>${money(x.base_quantity)}</td><td>${money(x.inventory_value)}</td></tr>`).join('')}</tbody></table>`}
      else if(key==='invoices-count'||key==='today-sales'){const d=await apiFetch('/pos/invoices?limit=50');body.innerHTML=`<h3>الفواتير الحديثة</h3><table class="data-table"><thead><tr><th>الرقم</th><th>التاريخ</th><th>الإجمالي</th><th>الحالة</th></tr></thead><tbody>${d.invoices.map(x=>`<tr><td>${esc(x.invoice_number||'مؤقت')}</td><td>${esc(x.created_at)}</td><td>${money(x.total_amount)}</td><td>${esc(x.status)}</td></tr>`).join('')}</tbody></table>`}
      else if(key==='today-profit'){const d=await apiFetch('/reports/profit');body.innerHTML=`<h3>تفاصيل الأرباح</h3><table class="data-table"><thead><tr><th>اليوم</th><th>الإيراد</th><th>التكلفة</th><th>الربح</th></tr></thead><tbody>${d.report.map(x=>`<tr><td>${esc(x.day)}</td><td>${money(x.revenue)}</td><td>${money(x.cogs)}</td><td>${money(x.gross_profit)}</td></tr>`).join('')}</tbody></table>`}
      else {body.innerHTML='<p>لا توجد تفاصيل.</p>'}
    }catch(e){body.innerHTML=`<p class="danger-text">${esc(e.message)}</p>`}
  }
  return {load};
})();
window.Dashboard=Dashboard;
