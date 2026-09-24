'use strict';
const $ = (id) => document.getElementById(id);
let key = '',
  userPage = 1,
  transactionPage = 1,
  selectedUser = null,
  eventPage = 1,
  inspectedPayment = '';
const now = new Date();
$('from').value = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  .toISOString()
  .slice(0, 16);
$('to').value = new Date(now.getTime() + 60000).toISOString().slice(0, 16);
const amount = (value) => BigInt(value).toLocaleString('en-US');
function reportQuery() {
  return new URLSearchParams({
    period: $('period').value,
    from: new Date($('from').value + 'Z').toISOString(),
    to: new Date($('to').value + 'Z').toISOString(),
  });
}
async function api(path) {
  const response = await fetch('/api/' + path, { headers: { 'X-API-Key': key } });
  const body = await response.json();
  if (!response.ok)
    throw new Error(
      Array.isArray(body.message) ? body.message.join('; ') : body.message || 'Request failed',
    );
  return body;
}
function row(cells) {
  const tr = document.createElement('tr');
  cells.forEach((value) => {
    const td = document.createElement('td');
    if (value instanceof Node) td.append(value);
    else td.textContent = value;
    tr.append(td);
  });
  return tr;
}
function rows(id, values, emptyColumns) {
  $(id).replaceChildren(...values);
  if (!values.length) {
    const tr = row(['No activity in this range.']);
    tr.firstChild.colSpan = emptyColumns;
    $(id).append(tr);
  }
}
async function run(action) {
  $('notice').textContent = '';
  try {
    await action();
  } catch (error) {
    $('notice').textContent = error.message;
  }
}
async function reports() {
  const data = await api('admin/reports?' + reportQuery());
  $('totalCredits').textContent = amount(data.totals.credits);
  $('totalDebits').textContent = amount(data.totals.debits);
  $('netMovement').textContent = amount(BigInt(data.totals.credits) - BigInt(data.totals.debits));
  rows(
    'reportRows',
    data.buckets.map((item) =>
      row([item.period.slice(0, 10), amount(item.credits), amount(item.debits)]),
    ),
    3,
  );
}
async function users() {
  const data = await api(`users?page=${userPage}&limit=10`);
  $('userCount').textContent = `${data.total} accounts`;
  rows(
    'userRows',
    data.items.map((user) => {
      const button = document.createElement('button');
      button.textContent = 'View';
      button.addEventListener('click', () =>
        run(async () => {
          selectedUser = user.id;
          transactionPage = 1;
          await details();
        }),
      );
      return row([user.name, amount(user.balance), button]);
    }),
    3,
  );
  $('userPage').textContent = `Page ${userPage}`;
  $('prevUsers').disabled = userPage <= 1;
  $('nextUsers').disabled = userPage * 10 >= data.total;
}
async function details() {
  if (!selectedUser) return;
  const [usage, entries] = await Promise.all([
    api(`admin/users/${selectedUser}/usage?` + reportQuery()),
    api(`users/${selectedUser}/transactions?page=${transactionPage}&limit=10`),
  ]);
  $('selectedUser').textContent = `${usage.user.name} · ${selectedUser}`;
  $('usage').textContent =
    `Current balance: ${amount(usage.user.balance)} · Period credits: ${amount(usage.credits)} · Period usage: ${amount(usage.debits)} · Payments: ${usage.successfulPayments}. Transactions below show all dates.`;
  rows(
    'transactionRows',
    entries.items.map((entry) =>
      row([
        entry.createdAt.replace('T', ' ').slice(0, 19),
        entry.type,
        amount(entry.amount),
        entry.reference,
      ]),
    ),
    4,
  );
  $('transactionPage').textContent = `Page ${transactionPage}`;
  $('prevTransactions').disabled = transactionPage <= 1;
  $('nextTransactions').disabled = transactionPage * 10 >= entries.total;
}
async function payment() {
  if (!inspectedPayment) return;
  const [data, events] = await Promise.all([
    api(`payments/${encodeURIComponent(inspectedPayment)}`),
    api(`payments/${encodeURIComponent(inspectedPayment)}/events?page=${eventPage}&limit=20`),
  ]);
  $('paymentResult').textContent = JSON.stringify({ payment: data, events: events.items }, null, 2);
  $('eventPage').textContent = `Page ${eventPage}`;
  $('prevEvents').disabled = eventPage <= 1;
  $('nextEvents').disabled = eventPage * 20 >= events.total;
}
$('connect').addEventListener('click', () =>
  run(async () => {
    key = $('apiKey').value;
    $('connectionState').textContent = 'Connecting…';
    try {
      await Promise.all([reports(), users()]);
      $('connectionState').textContent = 'Connected';
    } catch (error) {
      $('connectionState').textContent = 'Connection failed';
      throw error;
    }
  }),
);
$('reportForm').addEventListener('submit', (event) => {
  event.preventDefault();
  void run(() => Promise.all([reports(), details()]));
});
$('paymentForm').addEventListener('submit', (event) => {
  event.preventDefault();
  inspectedPayment = $('paymentId').value.trim();
  eventPage = 1;
  void run(payment);
});
[
  ['prevUsers', () => --userPage, users],
  ['nextUsers', () => ++userPage, users],
  ['prevTransactions', () => --transactionPage, details],
  ['nextTransactions', () => ++transactionPage, details],
  ['prevEvents', () => --eventPage, payment],
  ['nextEvents', () => ++eventPage, payment],
].forEach(([id, change, load]) =>
  $(id).addEventListener('click', () =>
    run(async () => {
      change();
      await load();
    }),
  ),
);
[
  'prevUsers',
  'nextUsers',
  'prevTransactions',
  'nextTransactions',
  'prevEvents',
  'nextEvents',
].forEach((id) => {
  $(id).disabled = true;
});
