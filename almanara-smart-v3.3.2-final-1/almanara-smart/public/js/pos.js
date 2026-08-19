'use strict';

/**
 * pos.js - منطق شاشة نقطة البيع (بند 4.3): السلة، البحث، المدفوعات المتعددة،
 * قارئ الباركود بالكاميرا (بند 3.1)، دعم إنشاء الفاتورة أثناء انقطاع خادم الفرع (بند 2.2)
 */

const POS = (() => {
  let cart = []; // { productId, unitId, name, unitName, quantity, unitPrice, discountAmount }
  let payments = []; // { paymentMethodId, name, type, amount, referenceNumber }
  let paymentMethods = [];
  let customers = [];
  let selectedPaymentMethod = null;
  let currentShift = null;
  let localSequenceCounter = parseInt(localStorage.getItem('local_sequence_counter') || '0', 10);
  const TERMINAL_ID = getOrCreateTerminalId();

  function getOrCreateTerminalId() {
    let id = localStorage.getItem('terminal_id');
    if (!id) {
      id = 'term-' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem('terminal_id', id);
    }
    return id;
  }

  function nextLocalSequence() {
    localSequenceCounter += 1;
    localStorage.setItem('local_sequence_counter', String(localSequenceCounter));
    return localSequenceCounter;
  }

  async function init() {
    document.getElementById('posSearchInput').addEventListener('input', debounce(handleSearchInput, 250));
    document.getElementById('clearCartBtn').addEventListener('click', clearCart);
    document.getElementById('completeSaleBtn').addEventListener('click', completeSale);
    document.getElementById('addPaymentBtn').addEventListener('click', addPayment);
    document.getElementById('cameraScanBtn').addEventListener('click', openCameraScanner);

    await Promise.all([loadPaymentMethods(), loadCustomers(), refreshTopProducts(), loadCurrentShift()]);
  }

  async function loadCurrentShift() {
    try {
      const { shift } = await apiFetch('/shifts/current');
      currentShift = shift;
      document.getElementById('shiftBadge').textContent = shift ? `وردية مفتوحة #${shift.id.slice(0, 8)}` : 'لا توجد وردية مفتوحة';
      if (!shift) showToast('يجب فتح وردية قبل البدء بالبيع - راجع تبويب الورديات', 'warning');
    } catch (e) { /* المستخدم قد لا يكون مسجلاً بعد */ }
  }

  async function loadPaymentMethods() {
    try {
      const { paymentMethods: methods } = await apiFetch('/payment-methods');
      paymentMethods = methods;
      const grid = document.getElementById('paymentMethodsGrid');
      grid.innerHTML = methods.map((m) => `
        <button class="payment-method-btn" data-id="${m.id}">
          <span style="font-size:24px">${m.icon || '💳'}</span>
          <span>${m.name}</span>
        </button>`).join('');
      grid.querySelectorAll('.payment-method-btn').forEach((btn) => {
        btn.addEventListener('click', () => selectPaymentMethod(btn.dataset.id));
      });
    } catch (e) { console.error(e); }
  }

  async function loadCustomers() {
    try {
      const { customers: list } = await apiFetch('/customers?limit=100');
      customers = list;
      const select = document.getElementById('customerSelect');
      select.innerHTML = '<option value="">— بيع نقدي عام —</option>' +
        list.map((c) => `<option value="${c.id}">${c.name} (رصيد: ${parseFloat(c.balance).toFixed(2)})</option>`).join('');
    } catch (e) { console.error(e); }
  }

  async function refreshTopProducts() {
    try {
      const { products } = await apiFetch('/products/reports/top-selling?limit=10');
      const grid = document.getElementById('topProductsGrid');
      if (products.length === 0) {
        grid.innerHTML = '<p style="color:var(--color-text-muted)">لا توجد بيانات مبيعات كافية بعد</p>';
        return;
      }
      grid.innerHTML = products.map((p) => `
        <button class="product-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}">
          <span class="emoji">📦</span>
          <span>${escapeHtml(p.name)}</span>
        </button>`).join('');
      grid.querySelectorAll('.product-btn').forEach((btn) => {
        btn.addEventListener('click', () => addProductToCartById(btn.dataset.id, btn.dataset.name));
      });
    } catch (e) { console.error(e); }
  }

  function debounce(fn, ms) {
    let timer;
    return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
  }

  async function handleSearchInput(e) {
    const term = e.target.value.trim();
    const panel = document.getElementById('searchResultsPanel');
    if (term.length < 1) { panel.classList.add('hidden'); return; }
    try {
      const { products } = await apiFetch('/products/search-advanced', {
        method: 'POST',
        body: JSON.stringify({ term, limit: 12 })
      });
      panel.classList.remove('hidden');
      if (products.length === 0) {
        panel.innerHTML = '<p style="padding:10px">لا توجد نتائج</p>';
        return;
      }
      panel.innerHTML = `<div class="products-grid">${products.map((p) => `
        <button class="product-btn" data-id="${p.id}" data-name="${escapeHtml(p.name)}">
          <span class="emoji">📦</span>
          <span>${escapeHtml(p.name)}</span>
          <span class="price">${parseFloat(p.base_cost || 0).toFixed(2)}</span>
        </button>`).join('')}</div>`;
      panel.querySelectorAll('.product-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          addProductToCartById(btn.dataset.id, btn.dataset.name);
          panel.classList.add('hidden');
          document.getElementById('posSearchInput').value = '';
        });
      });
    } catch (e) { console.error(e); }
  }

  async function handleBarcodeScan(barcode) {
    try {
      const { product } = await apiFetch(`/products/barcode/${encodeURIComponent(barcode)}`);
      addProductToCart({
        productId: product.id,
        unitId: product.unit_id || null,
        name: product.name,
        unitName: product.unit_name || product.base_unit,
        unitPrice: parseFloat(product.retail_price || product.base_cost || 0)
      });
      AudioFeedback.scanSuccess();
    } catch (err) {
      showToast('لم يتم العثور على منتج بهذا الباركود', 'error');
    }
  }

  async function addProductToCartById(productId, name) {
    try {
      const { product, units } = await apiFetch(`/products/${productId}`);
      const defaultUnit = units.find((u) => u.is_default_sale) || units[0];
      addProductToCart({
        productId: product.id,
        unitId: defaultUnit ? defaultUnit.id : null,
        name: product.name,
        unitName: defaultUnit ? defaultUnit.unit_name : product.base_unit,
        unitPrice: defaultUnit ? parseFloat(defaultUnit.retail_price) : parseFloat(product.base_cost)
      });
    } catch (e) {
      showToast('تعذّر إضافة المنتج', 'error');
    }
  }

  function addProductToCart({ productId, unitId, name, unitName, unitPrice }) {
    const existing = cart.find((item) => item.productId === productId && item.unitId === unitId);
    if (existing) {
      existing.quantity += 1;
    } else {
      cart.push({ productId, unitId, name, unitName, quantity: 1, unitPrice, discountAmount: 0 });
    }
    renderCart();
    AudioFeedback.success();
  }

  function changeQuantity(index, delta) {
    cart[index].quantity += delta;
    if (cart[index].quantity <= 0) cart.splice(index, 1);
    renderCart();
  }

  function removeItem(index) {
    cart.splice(index, 1);
    renderCart();
  }

  function clearCart() {
    cart = [];
    payments = [];
    renderCart();
    renderPayments();
  }

  function renderCart() {
    const container = document.getElementById('cartItems');
    if (cart.length === 0) {
      container.innerHTML = '<p style="color:var(--color-text-muted);text-align:center;padding:20px">السلة فارغة</p>';
    } else {
      container.innerHTML = cart.map((item, idx) => `
        <div class="cart-item">
          <div>
            <div class="cart-item__name">${escapeHtml(item.name)}</div>
            <div style="font-size:13px;color:var(--color-text-muted)">${item.unitPrice.toFixed(2)} × ${item.quantity} ${escapeHtml(item.unitName)}</div>
          </div>
          <div class="cart-item__qty-controls">
            <button class="qty-btn" data-action="dec" data-idx="${idx}">−</button>
            <span>${item.quantity}</span>
            <button class="qty-btn" data-action="inc" data-idx="${idx}">+</button>
          </div>
          <div class="cart-item__total">${(item.unitPrice * item.quantity - item.discountAmount).toFixed(2)}</div>
          <button class="remove-item-btn" data-action="remove" data-idx="${idx}">🗑️</button>
        </div>`).join('');

      container.querySelectorAll('[data-action]').forEach((btn) => {
        const idx = parseInt(btn.dataset.idx, 10);
        btn.addEventListener('click', () => {
          if (btn.dataset.action === 'inc') changeQuantity(idx, 1);
          if (btn.dataset.action === 'dec') changeQuantity(idx, -1);
          if (btn.dataset.action === 'remove') removeItem(idx);
        });
      });
    }
    updateTotals();
  }

  function calcSubtotal() {
    return cart.reduce((sum, item) => sum + item.unitPrice * item.quantity - item.discountAmount, 0);
  }

  function updateTotals() {
    const subtotal = calcSubtotal();
    document.getElementById('cartSubtotal').textContent = subtotal.toFixed(2);
    document.getElementById('cartDiscount').textContent = '0.00';
    document.getElementById('cartTotal').textContent = subtotal.toFixed(2);
    updateRemaining();
  }

  function selectPaymentMethod(id) {
    selectedPaymentMethod = paymentMethods.find((m) => m.id === id);
    document.querySelectorAll('.payment-method-btn').forEach((b) => b.classList.toggle('selected', b.dataset.id === id));
    const entry = document.getElementById('paymentAmountEntry');
    entry.classList.remove('hidden');
    document.getElementById('paymentAmountInput').value = remainingAmount().toFixed(2);
    document.getElementById('paymentRefInput').classList.toggle('hidden', !selectedPaymentMethod.requires_reference);
  }

  function addPayment() {
    if (!selectedPaymentMethod) return;
    const amount = parseFloat(document.getElementById('paymentAmountInput').value || '0');
    if (amount <= 0) { showToast('أدخل مبلغًا صحيحًا', 'error'); return; }

    if (selectedPaymentMethod.type === 'credit' && !document.getElementById('customerSelect').value) {
      showToast('يجب اختيار عميل للبيع الآجل', 'error');
      return;
    }

    payments.push({
      paymentMethodId: selectedPaymentMethod.id,
      name: selectedPaymentMethod.name,
      type: selectedPaymentMethod.type,
      amount,
      referenceNumber: document.getElementById('paymentRefInput').value || null
    });
    document.getElementById('paymentAmountEntry').classList.add('hidden');
    document.querySelectorAll('.payment-method-btn').forEach((b) => b.classList.remove('selected'));
    selectedPaymentMethod = null;
    renderPayments();
  }

  function renderPayments() {
    const list = document.getElementById('paymentsList');
    list.innerHTML = payments.map((p, idx) => `
      <div class="payment-list-item">
        <span>${p.name}</span><span>${p.amount.toFixed(2)}</span>
        <button class="remove-item-btn" data-idx="${idx}">✕</button>
      </div>`).join('');
    list.querySelectorAll('.remove-item-btn').forEach((btn) => {
      btn.addEventListener('click', () => { payments.splice(parseInt(btn.dataset.idx, 10), 1); renderPayments(); });
    });
    updateRemaining();
  }

  function totalPaid() {
    return payments.reduce((sum, p) => sum + p.amount, 0);
  }

  function remainingAmount() {
    return Math.max(calcSubtotal() - totalPaid(), 0);
  }

  function updateRemaining() {
    const remaining = calcSubtotal() - totalPaid();
    const el = document.getElementById('remainingAmount');
    el.textContent = remaining.toFixed(2);
    el.parentElement.classList.toggle('settled', remaining <= 0);
    document.getElementById('completeSaleBtn').disabled = !(cart.length > 0 && remaining <= 0);

    const offlineBanner = document.getElementById('offlineBanner');
    offlineBanner.classList.toggle('hidden', App.state.serverOnline);
  }

  async function completeSale() {
    if (!currentShift) { showToast('يجب فتح وردية أولاً', 'error'); return; }
    if (cart.length === 0) return;

    const isOfflineCreated = !App.state.serverOnline;
    const payload = {
      terminalId: TERMINAL_ID,
      localSequence: nextLocalSequence(),
      customerId: document.getElementById('customerSelect').value || null,
      shiftId: currentShift.id,
      items: cart.map((item) => ({
        productId: item.productId,
        unitId: item.unitId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountAmount: item.discountAmount
      })),
      payments: payments.map((p) => ({
        paymentMethodId: p.paymentMethodId,
        amount: p.amount,
        referenceNumber: p.referenceNumber
      })),
      isOfflineCreated,
      idempotencyKey: `${TERMINAL_ID}-${Date.now()}`
    };

    if (isOfflineCreated) {
      // العمل offline - القسم 2.2: حفظ الفاتورة محليًا في قائمة انتظار المزامنة
      await window.OfflineSync.queueSale(payload);
      showToast('تم حفظ الفاتورة محليًا - ستُزامَن عند عودة الاتصال بخادم الفرع', 'warning');
      printReceipt(payload, { temporary: true });
      clearCart();
      return;
    }

    try {
      const { invoice } = await apiFetch('/pos/sale', { method: 'POST', body: JSON.stringify(payload) });
      showToast('تمت عملية البيع بنجاح', 'success');
      printReceipt(payload, { invoice });
      clearCart();
      refreshTopProducts();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function printReceipt(payload, { invoice, temporary }) {
    // طباعة مبسّطة عبر نافذة المتصفح - في بيئة إنتاجية تُستبدل بتكامل ESC/POS الحقيقي (بند 3.3)
    const win = window.open('', '_blank', 'width=380,height=600');
    if (!win) { showToast('اسمح بالنوافذ المنبثقة للطباعة', 'error'); return; }
    const invoiceLabel = temporary
      ? '⚠️ فاتورة مؤقتة - غير مُزامَنة'
      : `فاتورة رقم: ${invoice.invoice_number || 'قيد المعالجة'}`;
    win.document.write(`
      <html dir="rtl"><head><meta charset="utf-8"><title>فاتورة</title></head>
      <body style="font-family:sans-serif;padding:16px">
        <h2>المنارة الذكي</h2>
        <p>${invoiceLabel}</p>
        <p>${new Date().toLocaleString('ar')}</p>
        <hr>
        ${cart.map((i) => `<p>${i.name} × ${i.quantity} = ${(i.unitPrice * i.quantity).toFixed(2)}</p>`).join('')}
        <hr>
        <h3>الإجمالي: ${calcSubtotal().toFixed(2)}</h3>
      </body></html>`);
    win.document.close();
    win.print();
  }

  // ==========================================================
  // مسح الباركود بالكاميرا - بند 3.1 (يعتمد على مكتبة خارجية اختيارية)
  // ==========================================================
  function openCameraScanner() {
    if (!window.Html5Qrcode) {
      showToast('مكتبة مسح الكاميرا غير محمَّلة - راجع ملاحظة التكامل في README', 'warning');
      return;
    }
    const modal = document.getElementById('drilldownModal');
    const body = document.getElementById('drilldownBody');
    body.innerHTML = '<div id="cameraScannerRegion" style="width:100%"></div>';
    modal.classList.remove('hidden');

    const scanner = new window.Html5Qrcode('cameraScannerRegion');
    scanner.start(
      { facingMode: 'environment' },
      { fps: 10, qrbox: 250 },
      (decodedText) => {
        scanner.stop();
        modal.classList.add('hidden');
        handleBarcodeScan(decodedText);
      },
      () => { /* أخطاء إطار بمسح غير ناجح - تُتجاهل بصمت */ }
    ).catch(() => showToast('تعذّر تشغيل الكاميرا', 'error'));
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  document.addEventListener('DOMContentLoaded', init);

  return { handleBarcodeScan, refreshTopProducts, addExternalProduct(product, units=[]) { const u=units.find(x=>x.is_default_sale)||units[0]; if(!u){showToast('المنتج لا يحتوي وحدة بيع','error');return;} addProductToCart({productId:product.id,unitId:u.id,name:product.name,unitName:u.unit_name,unitPrice:Number(u.retail_price||product.base_cost||0)}); } };
})();

window.POS = POS;
