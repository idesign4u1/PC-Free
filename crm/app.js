/* מערכת ניהול לקוחות והרצאות - אחסון מקומי בדפדפן, ללא שרת */

const STORE_KEY = 'crm.lectures.v1';
const DAY_MS = 86400000;

const STATUS = {
  lead:      { label: 'ליד' },
  proposal:  { label: 'הצעה נשלחה' },
  confirmed: { label: 'מאושר' },
  done:      { label: 'בוצע' },
  invoiced:  { label: 'חויב' },
  paid:      { label: 'שולם' },
  cancelled: { label: 'בוטל' },
};
const STATUS_KEYS = Object.keys(STATUS);
/* שלבים שבהם ההרצאה עדיין לפנינו ותופסת מקום ביומן */
const OPEN_STATUSES = ['lead', 'proposal', 'confirmed'];
/* שלבים שבהם ההכנסה כבר נחשבת מובטחת */
const EARNED_STATUSES = ['confirmed', 'done', 'invoiced', 'paid'];

const CLIENT_TYPES = ['חברה', 'מכללה / אקדמיה', 'בית ספר', 'מתנ"ס / רשות', 'עמותה', 'לקוח פרטי'];
const EQUIPMENT = ['מקרן', 'מסך', 'מיקרופון', 'רמקולים', 'שולחן', 'לוח', 'חיבור למחשב'];

const TABS = [
  { id: 'dashboard', label: 'לוח בקרה' },
  { id: 'bookings',  label: 'הרצאות' },
  { id: 'clients',   label: 'לקוחות' },
  { id: 'catalog',   label: 'קטלוג' },
  { id: 'money',     label: 'כספים' },
];

/* ============================ נתונים ============================ */

const uid = () => Math.random().toString(36).slice(2, 10);

const EMPTY_DB = { clients: [], contacts: [], catalog: [], bookings: [] };

let db = load();
let ui = { tab: 'dashboard', search: '', statusFilter: 'all', clientId: null };

function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return Object.assign({}, EMPTY_DB, JSON.parse(raw));
  } catch (err) {
    console.warn('טעינת הנתונים נכשלה, מתחילים מנתוני הדגמה', err);
  }
  return seed();
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  } catch (err) {
    alert('שמירת הנתונים נכשלה. ייתכן שאחסון הדפדפן מלא או חסום.');
  }
}

function seed() {
  const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY_MS).toISOString().slice(0, 10);
  const c1 = uid(), c2 = uid(), c3 = uid();
  const k1 = uid(), k2 = uid();
  return {
    clients: [
      { id: c1, name: 'מכללת רופין', type: 'מכללה / אקדמיה', taxId: '500123456', phone: '09-8983000',
        email: 'hadracha@ruppin.ac.il', address: 'עמק חפר', paymentTerms: 60, requiresPO: true, notes: '' },
      { id: c2, name: 'טכנולוגיות אלפא בע"מ', type: 'חברה', taxId: '514887221', phone: '03-7100200',
        email: 'hr@alpha.co.il', address: 'הרצליה פיתוח', paymentTerms: 30, requiresPO: false, notes: 'יום גיבוש שנתי בקיץ' },
      { id: c3, name: 'מתנ"ס כפר סבא', type: 'מתנ"ס / רשות', taxId: '580334412', phone: '09-7649100',
        email: 'tarbut@ksaba.co.il', address: 'כפר סבא', paymentTerms: 45, requiresPO: true, notes: '' },
    ],
    contacts: [
      { id: uid(), clientId: c1, name: 'נועה בר אל', role: 'רכזת הדרכה', phone: '052-3311447', email: 'noa@ruppin.ac.il', decisionMaker: true },
      { id: uid(), clientId: c2, name: 'עידו לוינסקי', role: 'מנהל משאבי אנוש', phone: '054-8820013', email: 'ido@alpha.co.il', decisionMaker: true },
      { id: uid(), clientId: c3, name: 'שירה כהן', role: 'מנהלת תרבות', phone: '050-6647120', email: 'shira@ksaba.co.il', decisionMaker: false },
    ],
    catalog: [
      { id: k1, title: 'בינה מלאכותית בעבודה היומיומית', summary: 'כלים מעשיים לשיפור פרודוקטיביות',
        audience: 'עובדי מטה', durationMin: 90, basePrice: 3200 },
      { id: k2, title: 'ניהול זמן לעצמאים', summary: 'שיטות עבודה לעומס משתנה',
        audience: 'בעלי עסקים', durationMin: 60, basePrice: 2400 },
    ],
    bookings: [
      { id: uid(), clientId: c1, catalogId: k1, title: 'בינה מלאכותית בעבודה היומיומית',
        date: iso(6), time: '10:00', durationMin: 90, location: 'אולם ההרצאות, בניין 5', address: 'מכללת רופין, עמק חפר',
        audienceSize: 120, price: 3400, travelFee: 250, status: 'confirmed', poNumber: '',
        equipment: ['מקרן', 'מיקרופון'], contactOnSite: 'נועה בר אל', notes: 'להגיע 30 דקות לפני' },
      { id: uid(), clientId: c2, catalogId: k2, title: 'ניהול זמן לעצמאים',
        date: iso(-21), time: '14:00', durationMin: 60, location: 'חדר ישיבות מרכזי', address: 'הרצליה פיתוח',
        audienceSize: 40, price: 2600, travelFee: 0, status: 'invoiced', poNumber: '', invoicedOn: iso(-19),
        equipment: ['מקרן'], contactOnSite: 'עידו לוינסקי', notes: '' },
      { id: uid(), clientId: c3, catalogId: k1, title: 'בינה מלאכותית בעבודה היומיומית',
        date: iso(34), time: '19:30', durationMin: 90, location: 'אולם הספרייה', address: 'כפר סבא',
        audienceSize: 80, price: 3000, travelFee: 150, status: 'proposal', poNumber: '',
        equipment: ['מקרן', 'מיקרופון', 'רמקולים'], contactOnSite: '', notes: 'ממתינים לאישור ועדת תרבות' },
    ],
  };
}

/* ============================ עזרים ============================ */

const byId = (list, id) => list.find((item) => item.id === id) || null;
const clientOf  = (booking) => byId(db.clients, booking.clientId);
const contactsOf = (clientId) => db.contacts.filter((c) => c.clientId === clientId);
const bookingsOf = (clientId) => db.bookings.filter((b) => b.clientId === clientId);

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const todayISO = () => new Date().toISOString().slice(0, 10);

/** מספר הימים מהיום ועד תאריך ISO. שלילי = בעבר. */
function daysUntil(isoDate) {
  if (!isoDate) return null;
  const start = new Date(todayISO()).getTime();
  return Math.round((new Date(isoDate).getTime() - start) / DAY_MS);
}

function fmtDate(isoDate) {
  if (!isoDate) return '—';
  const [y, m, d] = isoDate.split('-');
  return `${d}/${m}/${y}`;
}

/* Intl מסדר את סימן המטבע נכון בתוך משפט בעברית, בניגוד לשרשור ידני */
const shekels = new Intl.NumberFormat('he-IL', {
  style: 'currency', currency: 'ILS', maximumFractionDigits: 0,
});
const fmtMoney = (amount) => shekels.format(Math.round(Number(amount) || 0));

/** סך החיוב להרצאה: מחיר ההרצאה בתוספת החזר נסיעות. */
const bookingTotal = (booking) => (Number(booking.price) || 0) + (Number(booking.travelFee) || 0);

/** תאריך היעד לתשלום, נגזר מתנאי התשלום של הלקוח ומיום החיוב. */
function dueDate(booking) {
  const client = clientOf(booking);
  if (!booking.invoicedOn || !client) return null;
  return new Date(new Date(booking.invoicedOn).getTime() + (client.paymentTerms || 30) * DAY_MS)
    .toISOString().slice(0, 10);
}

const statusPill = (status) =>
  `<span class="pill ${status}">${esc((STATUS[status] || {}).label || status)}</span>`;

const sortByDate = (a, b) => (a.date || '').localeCompare(b.date || '');

/* ============================ מנוע התראות ============================ */

/**
 * מייצר את רשימת ההתראות. כל התראה נגזרת מהנתונים הקיימים,
 * כך שאיש אינו נדרש להזין אותה ידנית.
 */
function buildAlerts() {
  const alerts = [];
  const today = todayISO();

  db.bookings.forEach((booking) => {
    if (booking.status === 'cancelled') return;
    const client = clientOf(booking);
    const name = client ? client.name : 'לקוח שנמחק';
    const days = daysUntil(booking.date);

    if (booking.status === 'confirmed' && days !== null && days >= 0 && days <= 10
        && client && client.requiresPO && !booking.poNumber) {
      alerts.push({ level: 'danger', bookingId: booking.id,
        text: `${name} דורש מספר הזמנת רכש, וההרצאה בעוד ${days} ימים. בלי המספר לא ניתן לחייב.` });
    }

    if (OPEN_STATUSES.includes(booking.status) && days !== null && days < 0) {
      alerts.push({ level: 'warn', bookingId: booking.id,
        text: `"${booking.title}" אצל ${name} התקיימה ב-${fmtDate(booking.date)} וטרם עודכנה כבוצעה.` });
    }

    if (booking.status === 'done') {
      alerts.push({ level: 'warn', bookingId: booking.id,
        text: `ההרצאה אצל ${name} מ-${fmtDate(booking.date)} בוצעה אך טרם חויבה. ${fmtMoney(bookingTotal(booking))} ממתינים.` });
    }

    if (booking.status === 'invoiced') {
      const due = dueDate(booking);
      if (due && due < today) {
        alerts.push({ level: 'danger', bookingId: booking.id,
          text: `תשלום בפיגור מ-${name}: ${fmtMoney(bookingTotal(booking))}, תאריך יעד ${fmtDate(due)}.` });
      }
    }

    if (booking.status === 'proposal' && days !== null && days >= 0 && days <= 21) {
      alerts.push({ level: 'info', bookingId: booking.id,
        text: `ההצעה ל-${name} עדיין לא אושרה וההרצאה בעוד ${days} ימים. שווה טלפון.` });
    }
  });

  alerts.push(...seasonalAlerts());
  return alerts;
}

/**
 * לקוחות שהזמינו בתקופה הזו בשנה שעברה ולא הזמינו מאז חצי שנה.
 * זהו מנוע ההכנסה החוזרת של עסק שמבוסס על הרצאות.
 */
function seasonalAlerts() {
  const now = Date.now();
  return db.clients.flatMap((client) => {
    const dates = bookingsOf(client.id)
      .filter((b) => b.status !== 'cancelled' && b.date)
      .map((b) => new Date(b.date).getTime());
    if (!dates.length) return [];

    const lastYear = dates.filter((t) => {
      const age = (now - t) / DAY_MS;
      return age > 300 && age < 430;
    });
    const recent = dates.some((t) => t > now - 180 * DAY_MS);
    if (!lastYear.length || recent) return [];

    return [{ level: 'info', clientId: client.id,
      text: `${client.name} הזמין בתקופה הזו אשתקד ולא הזמין מאז. זה הזמן לפנות.` }];
  });
}

/* ============================ מסכים ============================ */

function renderDashboard() {
  const today = todayISO();
  const upcoming = db.bookings
    .filter((b) => OPEN_STATUSES.includes(b.status) && b.date >= today)
    .sort(sortByDate);

  const confirmedAhead = upcoming.filter((b) => b.status === 'confirmed');
  const pipeline = upcoming.filter((b) => b.status !== 'confirmed');
  const outstanding = db.bookings.filter((b) => ['done', 'invoiced'].includes(b.status));
  const paidThisYear = db.bookings.filter((b) => b.status === 'paid' && b.date >= today.slice(0, 4) + '-01-01');
  const sum = (list) => list.reduce((total, b) => total + bookingTotal(b), 0);

  const alerts = buildAlerts();

  return `
    <div class="stat-grid">
      <div class="stat">
        <div class="label">הרצאות מאושרות לפנינו</div>
        <div class="value">${confirmedAhead.length}</div>
        <div class="sub">${fmtMoney(sum(confirmedAhead))} הכנסה מובטחת</div>
      </div>
      <div class="stat">
        <div class="label">בצינור</div>
        <div class="value">${pipeline.length}</div>
        <div class="sub">${fmtMoney(sum(pipeline))} לידים והצעות פתוחות</div>
      </div>
      <div class="stat">
        <div class="label">ממתין לתשלום</div>
        <div class="value">${fmtMoney(sum(outstanding))}</div>
        <div class="sub">${outstanding.length} הרצאות שבוצעו וטרם שולמו</div>
      </div>
      <div class="stat">
        <div class="label">נגבה השנה</div>
        <div class="value">${fmtMoney(sum(paidThisYear))}</div>
        <div class="sub">${paidThisYear.length} הרצאות ששולמו</div>
      </div>
    </div>

    <div class="two-col">
      <section class="card">
        <div class="card-head">
          ההרצאות הקרובות
          <div class="spacer"></div>
          <button class="btn btn-sm btn-primary" data-action="new-booking">הרצאה חדשה</button>
        </div>
        ${upcoming.length ? upcoming.slice(0, 8).map(upcomingRow).join('') :
          '<div class="empty">אין הרצאות מתוכננות. זה הזמן להרים טלפון.</div>'}
      </section>

      <section class="card">
        <div class="card-head">מה דורש טיפול <span class="muted small">(${alerts.length})</span></div>
        ${alerts.length ? alerts.map(alertRow).join('') :
          '<div class="empty">הכל מסודר. אין התראות פתוחות.</div>'}
      </section>
    </div>`;
}

function upcomingRow(booking) {
  const client = clientOf(booking);
  const days = daysUntil(booking.date);
  const when = days === 0 ? 'היום' : days === 1 ? 'מחר' : `בעוד ${days} ימים`;
  return `
    <div class="alert">
      <div class="txt">
        <div><strong>${esc(booking.title)}</strong> · ${statusPill(booking.status)}</div>
        <div class="small muted">
          ${esc(client ? client.name : 'לקוח שנמחק')} · ${fmtDate(booking.date)} ${esc(booking.time || '')} · ${when}
          ${booking.location ? ' · ' + esc(booking.location) : ''}
        </div>
      </div>
      <button class="btn btn-sm go" data-action="open-booking" data-id="${booking.id}">פתיחה</button>
    </div>`;
}

function alertRow(alert) {
  const target = alert.bookingId
    ? `data-action="open-booking" data-id="${alert.bookingId}"`
    : `data-action="open-client" data-id="${alert.clientId}"`;
  return `
    <div class="alert ${alert.level}">
      <span class="dot"></span>
      <div class="txt">${esc(alert.text)}</div>
      <button class="btn btn-sm go" ${target}>פתיחה</button>
    </div>`;
}

function renderBookings() {
  const term = ui.search.trim();
  const rows = db.bookings
    .filter((b) => ui.statusFilter === 'all' || b.status === ui.statusFilter)
    .filter((b) => {
      if (!term) return true;
      const client = clientOf(b);
      return (b.title + ' ' + (client ? client.name : '') + ' ' + (b.location || '')).includes(term);
    })
    .sort((a, b) => sortByDate(b, a));

  return `
    <div class="page-head">
      <h1>הרצאות והזמנות</h1>
      <div class="spacer"></div>
      <input class="search" id="search" placeholder="חיפוש לפי נושא, לקוח או מיקום" value="${esc(ui.search)}" />
      <select id="status-filter" style="width:auto">
        <option value="all">כל הסטטוסים</option>
        ${STATUS_KEYS.map((key) => `<option value="${key}" ${ui.statusFilter === key ? 'selected' : ''}>${esc(STATUS[key].label)}</option>`).join('')}
      </select>
      <button class="btn btn-primary" data-action="new-booking">הרצאה חדשה</button>
    </div>

    <div class="card table-wrap">
      ${rows.length ? `
      <table>
        <thead>
          <tr>
            <th>תאריך ושעה</th><th>נושא</th><th>לקוח</th><th>מיקום</th>
            <th class="num">משתתפים</th><th class="num">סכום</th><th>סטטוס</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((b) => {
            const client = clientOf(b);
            return `
            <tr>
              <td>${fmtDate(b.date)}<span class="muted small"> ${esc(b.time || '')}</span></td>
              <td><strong>${esc(b.title)}</strong></td>
              <td>${esc(client ? client.name : '—')}</td>
              <td class="small">${esc(b.location || '—')}</td>
              <td class="num">${b.audienceSize || '—'}</td>
              <td class="num">${fmtMoney(bookingTotal(b))}</td>
              <td>${statusPill(b.status)}</td>
              <td class="num"><button class="btn btn-sm" data-action="open-booking" data-id="${b.id}">פתיחה</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : '<div class="empty">לא נמצאו הרצאות התואמות את הסינון.</div>'}
    </div>`;
}

function renderClients() {
  const term = ui.search.trim();
  if (ui.clientId) return renderClientCard(ui.clientId);

  const rows = db.clients.filter((c) => !term || c.name.includes(term));
  return `
    <div class="page-head">
      <h1>לקוחות</h1>
      <div class="spacer"></div>
      <input class="search" id="search" placeholder="חיפוש לקוח" value="${esc(ui.search)}" />
      <button class="btn btn-primary" data-action="new-client">לקוח חדש</button>
    </div>

    <div class="card table-wrap">
      ${rows.length ? `
      <table>
        <thead>
          <tr><th>לקוח</th><th>סוג</th><th>תנאי תשלום</th><th class="num">הרצאות</th><th class="num">סך הכנסות</th><th></th></tr>
        </thead>
        <tbody>
          ${rows.map((client) => {
            const list = bookingsOf(client.id);
            const earned = list.filter((b) => EARNED_STATUSES.includes(b.status));
            return `
            <tr>
              <td><strong>${esc(client.name)}</strong>${client.requiresPO ? ' <span class="chip">דורש הזמנת רכש</span>' : ''}</td>
              <td class="small">${esc(client.type || '—')}</td>
              <td class="small">שוטף + ${client.paymentTerms || 30}</td>
              <td class="num">${list.length}</td>
              <td class="num">${fmtMoney(earned.reduce((t, b) => t + bookingTotal(b), 0))}</td>
              <td class="num"><button class="btn btn-sm" data-action="open-client" data-id="${client.id}">כרטיס</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : '<div class="empty">אין לקוחות עדיין.</div>'}
    </div>`;
}

function renderClientCard(clientId) {
  const client = byId(db.clients, clientId);
  if (!client) { ui.clientId = null; return renderClients(); }

  const list = bookingsOf(client.id).sort((a, b) => sortByDate(b, a));
  const earned = list.filter((b) => EARNED_STATUSES.includes(b.status));
  const contacts = contactsOf(client.id);

  return `
    <div class="page-head">
      <button class="btn" data-action="back-clients">חזרה</button>
      <h1>${esc(client.name)}</h1>
      <div class="spacer"></div>
      <button class="btn" data-action="edit-client" data-id="${client.id}">עריכה</button>
      <button class="btn btn-primary" data-action="new-booking" data-client="${client.id}">הרצאה חדשה</button>
    </div>

    <div class="two-col">
      <section class="card">
        <div class="card-head">פרטי הלקוח</div>
        <div class="card-body">
          <dl class="kv">
            <dt>סוג</dt><dd>${esc(client.type || '—')}</dd>
            <dt>ח.פ. / ע.מ.</dt><dd>${esc(client.taxId || '—')}</dd>
            <dt>טלפון</dt><dd>${esc(client.phone || '—')}</dd>
            <dt>דוא"ל</dt><dd>${esc(client.email || '—')}</dd>
            <dt>כתובת</dt><dd>${esc(client.address || '—')}</dd>
            <dt>תנאי תשלום</dt><dd>שוטף + ${client.paymentTerms || 30}</dd>
            <dt>הזמנת רכש</dt><dd>${client.requiresPO ? 'נדרשת לפני חיוב' : 'לא נדרשת'}</dd>
            <dt>סך הכנסות</dt><dd>${fmtMoney(earned.reduce((t, b) => t + bookingTotal(b), 0))} מ-${earned.length} הרצאות</dd>
          </dl>
          ${client.notes ? `<p class="small muted" style="margin-top:12px">${esc(client.notes)}</p>` : ''}
        </div>
      </section>

      <section class="card">
        <div class="card-head">
          אנשי קשר
          <div class="spacer"></div>
          <button class="btn btn-sm" data-action="new-contact" data-client="${client.id}">הוספה</button>
        </div>
        ${contacts.length ? contacts.map((contact) => `
          <div class="alert">
            <div class="txt">
              <div><strong>${esc(contact.name)}</strong>${contact.decisionMaker ? ' <span class="chip">מאשר תקציב</span>' : ''}</div>
              <div class="small muted">${esc(contact.role || '')} · ${esc(contact.phone || '')} · ${esc(contact.email || '')}</div>
            </div>
            <button class="btn btn-sm btn-danger go" data-action="delete-contact" data-id="${contact.id}">מחיקה</button>
          </div>`).join('') : '<div class="empty">לא הוגדרו אנשי קשר.</div>'}
      </section>
    </div>

    <section class="card table-wrap">
      <div class="card-head">היסטוריית הרצאות</div>
      ${list.length ? `
      <table>
        <thead><tr><th>תאריך</th><th>נושא</th><th>מיקום</th><th class="num">סכום</th><th>סטטוס</th><th></th></tr></thead>
        <tbody>
          ${list.map((b) => `
            <tr>
              <td>${fmtDate(b.date)}<span class="muted small"> ${esc(b.time || '')}</span></td>
              <td>${esc(b.title)}</td>
              <td class="small">${esc(b.location || '—')}</td>
              <td class="num">${fmtMoney(bookingTotal(b))}</td>
              <td>${statusPill(b.status)}</td>
              <td class="num"><button class="btn btn-sm" data-action="open-booking" data-id="${b.id}">פתיחה</button></td>
            </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">אין הרצאות ללקוח הזה.</div>'}
    </section>`;
}

function renderCatalog() {
  return `
    <div class="page-head">
      <h1>קטלוג ההרצאות</h1>
      <div class="spacer"></div>
      <button class="btn btn-primary" data-action="new-catalog">הרצאה לקטלוג</button>
    </div>
    <div class="card table-wrap">
      ${db.catalog.length ? `
      <table>
        <thead><tr><th>נושא</th><th>תקציר</th><th>קהל יעד</th><th class="num">אורך</th><th class="num">מחיר בסיס</th><th></th></tr></thead>
        <tbody>
          ${db.catalog.map((item) => `
            <tr>
              <td><strong>${esc(item.title)}</strong></td>
              <td class="small muted">${esc(item.summary || '—')}</td>
              <td class="small">${esc(item.audience || '—')}</td>
              <td class="num">${item.durationMin || '—'} ד'</td>
              <td class="num">${fmtMoney(item.basePrice)}</td>
              <td class="num">
                <button class="btn btn-sm" data-action="edit-catalog" data-id="${item.id}">עריכה</button>
                <button class="btn btn-sm btn-danger" data-action="delete-catalog" data-id="${item.id}">מחיקה</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>` : '<div class="empty">הקטלוג ריק. הוסיפו את ההרצאות שאתם מעבירים כדי לבנות הצעות מחיר מהר.</div>'}
    </div>`;
}

function renderMoney() {
  const today = todayISO();
  const open = db.bookings
    .filter((b) => ['done', 'invoiced'].includes(b.status))
    .sort(sortByDate);

  const buckets = { current: 0, d30: 0, d60: 0, d90: 0 };
  open.forEach((b) => {
    const due = dueDate(b);
    const late = due ? -daysUntil(due) : 0;
    const amount = bookingTotal(b);
    if (late <= 0) buckets.current += amount;
    else if (late <= 30) buckets.d30 += amount;
    else if (late <= 60) buckets.d60 += amount;
    else buckets.d90 += amount;
  });

  return `
    <div class="page-head"><h1>כספים וגבייה</h1></div>

    <div class="stat-grid">
      <div class="stat"><div class="label">בתוך תנאי התשלום</div><div class="value">${fmtMoney(buckets.current)}</div></div>
      <div class="stat"><div class="label">פיגור עד 30 יום</div><div class="value">${fmtMoney(buckets.d30)}</div></div>
      <div class="stat"><div class="label">פיגור 31 עד 60</div><div class="value">${fmtMoney(buckets.d60)}</div></div>
      <div class="stat"><div class="label">פיגור מעל 60</div><div class="value">${fmtMoney(buckets.d90)}</div></div>
    </div>

    <div class="card table-wrap">
      <div class="card-head">חובות פתוחים</div>
      ${open.length ? `
      <table>
        <thead><tr><th>לקוח</th><th>הרצאה</th><th>תאריך</th><th>יעד תשלום</th><th class="num">סכום</th><th>סטטוס</th><th></th></tr></thead>
        <tbody>
          ${open.map((b) => {
            const client = clientOf(b);
            const due = dueDate(b);
            const late = due ? -daysUntil(due) : null;
            return `
            <tr>
              <td>${esc(client ? client.name : '—')}</td>
              <td class="small">${esc(b.title)}</td>
              <td>${fmtDate(b.date)}</td>
              <td>${due ? fmtDate(due) + (late > 0 ? ` <span class="muted small">(${late} ימי פיגור)</span>` : '') : '<span class="muted">טרם חויב</span>'}</td>
              <td class="num">${fmtMoney(bookingTotal(b))}</td>
              <td>${statusPill(b.status)}</td>
              <td class="num">
                ${b.status === 'done'
                  ? `<button class="btn btn-sm" data-action="mark-invoiced" data-id="${b.id}">סימון כחויב</button>`
                  : `<button class="btn btn-sm" data-action="mark-paid" data-id="${b.id}">סימון כשולם</button>`}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : '<div class="empty">אין חובות פתוחים.</div>'}
    </div>`;
}

/* ============================ טפסים ============================ */

function field(label, name, value, opts = {}) {
  const { type = 'text', wide = false, placeholder = '', step = '' } = opts;
  return `
    <label class="${wide ? 'wide' : ''}">
      <span class="lbl">${esc(label)}</span>
      <input type="${type}" name="${name}" value="${esc(value ?? '')}"
             placeholder="${esc(placeholder)}" ${step ? `step="${step}"` : ''} />
    </label>`;
}

function selectField(label, name, value, options, opts = {}) {
  return `
    <label class="${opts.wide ? 'wide' : ''}">
      <span class="lbl">${esc(label)}</span>
      <select name="${name}">
        ${opts.blank ? `<option value="">${esc(opts.blank)}</option>` : ''}
        ${options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </label>`;
}

function openModal(title, bodyHtml, onSubmit) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="modal-backdrop" data-close-backdrop>
      <div class="modal">
        <h2>${esc(title)}</h2>
        <form id="modal-form">
          <div class="field-grid">${bodyHtml}</div>
        </form>
        <footer>
          <button class="btn btn-primary" type="submit" form="modal-form">שמירה</button>
          <button class="btn" type="button" data-close-modal>ביטול</button>
        </footer>
      </div>
    </div>`;

  root.querySelector('#modal-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target).entries());
    data.equipment = [...event.target.querySelectorAll('input[name="equipment"]:checked')].map((el) => el.value);
    onSubmit(data);
    closeModal();
    render();
  });
}

const closeModal = () => { document.getElementById('modal-root').innerHTML = ''; };

function bookingForm(booking) {
  const b = booking || { status: 'lead', date: todayISO(), time: '10:00', durationMin: 60, equipment: [] };
  const clientOptions = db.clients.map((c) => ({ value: c.id, label: c.name }));
  const catalogOptions = db.catalog.map((c) => ({ value: c.id, label: c.title }));

  openModal(booking ? 'עריכת הרצאה' : 'הרצאה חדשה', `
    <fieldset><legend>הלקוח וההרצאה</legend></fieldset>
    ${selectField('לקוח', 'clientId', b.clientId, clientOptions, { blank: 'בחרו לקוח' })}
    ${selectField('מתוך הקטלוג', 'catalogId', b.catalogId, catalogOptions, { blank: 'ללא / מותאם אישית' })}
    ${field('נושא ההרצאה', 'title', b.title, { wide: true, placeholder: 'ימולא מהקטלוג אם נבחר' })}

    <fieldset><legend>מתי</legend></fieldset>
    ${field('תאריך', 'date', b.date, { type: 'date' })}
    ${field('שעת התחלה', 'time', b.time, { type: 'time' })}
    ${field('משך בדקות', 'durationMin', b.durationMin, { type: 'number' })}
    ${selectField('סטטוס', 'status', b.status, STATUS_KEYS.map((k) => ({ value: k, label: STATUS[k].label })))}

    <fieldset><legend>איפה</legend></fieldset>
    ${field('מקום מדויק', 'location', b.location, { placeholder: 'אולם, קומה, חדר' })}
    ${field('כתובת', 'address', b.address)}
    ${field('איש קשר בשטח', 'contactOnSite', b.contactOnSite, { placeholder: 'מי מקבל אותי בכניסה' })}
    ${field('מספר משתתפים', 'audienceSize', b.audienceSize, { type: 'number' })}

    <fieldset><legend>ציוד נדרש</legend>
      <div class="chip-row">
        ${EQUIPMENT.map((item) => `
          <label class="chip check">
            <input type="checkbox" name="equipment" value="${esc(item)}" ${(b.equipment || []).includes(item) ? 'checked' : ''} />
            ${esc(item)}
          </label>`).join('')}
      </div>
    </fieldset>

    <fieldset><legend>כסף</legend></fieldset>
    ${field('מחיר ההרצאה', 'price', b.price, { type: 'number' })}
    ${field('החזר נסיעות', 'travelFee', b.travelFee, { type: 'number' })}
    ${field('מספר הזמנת רכש', 'poNumber', b.poNumber, { placeholder: 'נדרש אצל ארגונים גדולים' })}
    ${field('תאריך חיוב', 'invoicedOn', b.invoicedOn, { type: 'date' })}

    <label class="wide">
      <span class="lbl">הערות</span>
      <textarea name="notes">${esc(b.notes || '')}</textarea>
    </label>
  `, (data) => {
    if (!data.title && data.catalogId) {
      const item = byId(db.catalog, data.catalogId);
      if (item) data.title = item.title;
    }
    if (booking) {
      Object.assign(booking, data);
    } else {
      db.bookings.push(Object.assign({ id: uid() }, data));
    }
    save();
  });

  /* בחירה מהקטלוג ממלאת נושא, אורך ומחיר, כדי לא להקליד אותו דבר פעמיים */
  const form = document.getElementById('modal-form');
  form.catalogId.addEventListener('change', (event) => {
    const item = byId(db.catalog, event.target.value);
    if (!item) return;
    if (!form.title.value) form.title.value = item.title;
    if (!form.durationMin.value) form.durationMin.value = item.durationMin || '';
    if (!form.price.value) form.price.value = item.basePrice || '';
  });
}

function clientForm(client) {
  const c = client || { paymentTerms: 30 };
  openModal(client ? 'עריכת לקוח' : 'לקוח חדש', `
    ${field('שם הלקוח', 'name', c.name, { wide: true })}
    ${selectField('סוג', 'type', c.type, CLIENT_TYPES.map((t) => ({ value: t, label: t })), { blank: 'בחרו סוג' })}
    ${field('ח.פ. / ע.מ.', 'taxId', c.taxId)}
    ${field('טלפון', 'phone', c.phone)}
    ${field('דוא"ל', 'email', c.email, { type: 'email' })}
    ${field('כתובת', 'address', c.address, { wide: true })}
    ${field('תנאי תשלום (ימים)', 'paymentTerms', c.paymentTerms, { type: 'number' })}
    <label class="check" style="align-self:end">
      <input type="checkbox" name="requiresPO" ${c.requiresPO ? 'checked' : ''} />
      <span>דורש מספר הזמנת רכש לפני חיוב</span>
    </label>
    <label class="wide">
      <span class="lbl">הערות</span>
      <textarea name="notes">${esc(c.notes || '')}</textarea>
    </label>
  `, (data) => {
    data.requiresPO = data.requiresPO === 'on';
    data.paymentTerms = Number(data.paymentTerms) || 30;
    if (client) Object.assign(client, data);
    else db.clients.push(Object.assign({ id: uid() }, data));
    save();
  });
}

function contactForm(clientId) {
  openModal('איש קשר חדש', `
    ${field('שם', 'name', '')}
    ${field('תפקיד', 'role', '', { placeholder: 'רכזת הדרכה, מנהל משאבי אנוש' })}
    ${field('טלפון', 'phone', '')}
    ${field('דוא"ל', 'email', '', { type: 'email' })}
    <label class="check wide">
      <input type="checkbox" name="decisionMaker" />
      <span>מאשר את התקציב</span>
    </label>
  `, (data) => {
    data.decisionMaker = data.decisionMaker === 'on';
    db.contacts.push(Object.assign({ id: uid(), clientId }, data));
    save();
  });
}

function catalogForm(item) {
  const c = item || {};
  openModal(item ? 'עריכת הרצאה בקטלוג' : 'הרצאה חדשה לקטלוג', `
    ${field('נושא', 'title', c.title, { wide: true })}
    ${field('תקציר', 'summary', c.summary, { wide: true })}
    ${field('קהל יעד', 'audience', c.audience)}
    ${field('אורך בדקות', 'durationMin', c.durationMin, { type: 'number' })}
    ${field('מחיר בסיס', 'basePrice', c.basePrice, { type: 'number' })}
  `, (data) => {
    if (item) Object.assign(item, data);
    else db.catalog.push(Object.assign({ id: uid() }, data));
    save();
  });
}

function bookingDetail(booking) {
  const client = clientOf(booking);
  const days = daysUntil(booking.date);
  const equipment = booking.equipment || [];

  openModal(booking.title || 'הרצאה', `
    <div class="wide">
      <dl class="kv">
        <dt>לקוח</dt><dd>${esc(client ? client.name : '—')}</dd>
        <dt>מתי</dt><dd>${fmtDate(booking.date)} בשעה ${esc(booking.time || '—')} · ${booking.durationMin || '—'} דקות
          <span class="muted">${days !== null ? (days >= 0 ? `(בעוד ${days} ימים)` : `(לפני ${-days} ימים)`) : ''}</span></dd>
        <dt>איפה</dt><dd>${esc(booking.location || '—')}${booking.address ? ', ' + esc(booking.address) : ''}</dd>
        <dt>איש קשר בשטח</dt><dd>${esc(booking.contactOnSite || '—')}</dd>
        <dt>משתתפים</dt><dd>${booking.audienceSize || '—'}</dd>
        <dt>ציוד</dt><dd>${equipment.length ? equipment.map((e) => `<span class="chip">${esc(e)}</span>`).join(' ') : '—'}</dd>
        <dt>סכום</dt><dd>${fmtMoney(bookingTotal(booking))}
          <span class="muted small">(${fmtMoney(booking.price)} הרצאה + ${fmtMoney(booking.travelFee)} נסיעות)</span></dd>
        <dt>הזמנת רכש</dt><dd>${esc(booking.poNumber || (client && client.requiresPO ? 'חסר, ונדרש אצל לקוח זה' : '—'))}</dd>
        <dt>סטטוס</dt><dd>${statusPill(booking.status)}</dd>
      </dl>
      ${booking.notes ? `<p class="small muted" style="margin-top:12px">${esc(booking.notes)}</p>` : ''}
      <div class="chip-row" style="margin-top:16px">
        <button class="btn btn-sm" data-action="edit-booking" data-id="${booking.id}">עריכה</button>
        ${advanceButton(booking)}
        <button class="btn btn-sm btn-danger" data-action="delete-booking" data-id="${booking.id}">מחיקה</button>
      </div>
    </div>
  `, () => {});

  /* המסך הזה הוא תצוגה בלבד, לכן כפתור השמירה מיותר */
  document.querySelector('.modal footer').innerHTML =
    '<button class="btn" type="button" data-close-modal>סגירה</button>';
}

/** הכפתור שמקדם את ההרצאה לשלב הבא בצינור, לפי המצב הנוכחי. */
function advanceButton(booking) {
  const next = { lead: 'proposal', proposal: 'confirmed', confirmed: 'done', done: 'invoiced', invoiced: 'paid' }[booking.status];
  if (!next) return '';
  return `<button class="btn btn-sm btn-primary" data-action="advance" data-id="${booking.id}">קידום ל"${esc(STATUS[next].label)}"</button>`;
}

/* ============================ ניתוב ואירועים ============================ */

function render() {
  document.getElementById('tabs').innerHTML = TABS.map((tab) =>
    `<button class="tab ${ui.tab === tab.id ? 'active' : ''}" data-tab="${tab.id}">${esc(tab.label)}</button>`).join('');

  const views = {
    dashboard: renderDashboard,
    bookings: renderBookings,
    clients: renderClients,
    catalog: renderCatalog,
    money: renderMoney,
  };
  document.getElementById('view').innerHTML = views[ui.tab]();

  const search = document.getElementById('search');
  if (search) {
    search.addEventListener('input', (event) => {
      ui.search = event.target.value;
      render();
      const box = document.getElementById('search');
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    });
  }
  const filter = document.getElementById('status-filter');
  if (filter) filter.addEventListener('change', (event) => { ui.statusFilter = event.target.value; render(); });
}

const ACTIONS = {
  'new-booking': (el) => {
    const preset = el.dataset.client ? { status: 'lead', date: todayISO(), time: '10:00', durationMin: 60, equipment: [], clientId: el.dataset.client } : null;
    bookingForm(preset && { ...preset });
  },
  'open-booking': (el) => { const b = byId(db.bookings, el.dataset.id); if (b) bookingDetail(b); },
  'edit-booking': (el) => { const b = byId(db.bookings, el.dataset.id); if (b) bookingForm(b); },
  'delete-booking': (el) => {
    if (!confirm('למחוק את ההרצאה?')) return;
    db.bookings = db.bookings.filter((b) => b.id !== el.dataset.id);
    save(); closeModal(); render();
  },
  'advance': (el) => {
    const b = byId(db.bookings, el.dataset.id);
    const next = { lead: 'proposal', proposal: 'confirmed', confirmed: 'done', done: 'invoiced', invoiced: 'paid' }[b.status];
    if (!next) return;
    b.status = next;
    if (next === 'invoiced' && !b.invoicedOn) b.invoicedOn = todayISO();
    save(); closeModal(); render();
  },
  'mark-invoiced': (el) => {
    const b = byId(db.bookings, el.dataset.id);
    b.status = 'invoiced';
    b.invoicedOn = b.invoicedOn || todayISO();
    save(); render();
  },
  'mark-paid': (el) => { byId(db.bookings, el.dataset.id).status = 'paid'; save(); render(); },

  'new-client': () => clientForm(null),
  'edit-client': (el) => clientForm(byId(db.clients, el.dataset.id)),
  'open-client': (el) => { ui.tab = 'clients'; ui.clientId = el.dataset.id; closeModal(); render(); },
  'back-clients': () => { ui.clientId = null; render(); },

  'new-contact': (el) => contactForm(el.dataset.client),
  'delete-contact': (el) => {
    db.contacts = db.contacts.filter((c) => c.id !== el.dataset.id);
    save(); render();
  },

  'new-catalog': () => catalogForm(null),
  'edit-catalog': (el) => catalogForm(byId(db.catalog, el.dataset.id)),
  'delete-catalog': (el) => {
    if (!confirm('למחוק מהקטלוג?')) return;
    db.catalog = db.catalog.filter((c) => c.id !== el.dataset.id);
    save(); render();
  },

  'export-data': () => {
    const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `crm-backup-${todayISO()}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  },
  'import-data': () => document.getElementById('import-file').click(),
};

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action], [data-tab], [data-close-modal]');
  if (!target) return;

  if (target.hasAttribute('data-close-modal')) return closeModal();

  if (target.dataset.tab) {
    ui.tab = target.dataset.tab;
    ui.search = '';
    ui.clientId = null;
    return render();
  }

  const handler = ACTIONS[target.dataset.action];
  if (handler) handler(target);
});

document.addEventListener('click', (event) => {
  if (event.target.hasAttribute('data-close-backdrop')) closeModal();
});

document.getElementById('import-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      db = Object.assign({}, EMPTY_DB, JSON.parse(reader.result));
      save();
      render();
    } catch (err) {
      alert('הקובץ אינו קובץ גיבוי תקין.');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
});

save();
render();
