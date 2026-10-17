/* Push-Nachrichten für die Droste Team-App (Firebase Cloud Functions, Node 20).
   1. Neue Zuweisung einer Aufgabe: Nachricht an die zuständige Person
   2. Morgennachricht 07:00 (Berlin): offene Aufgaben und Termine des Tages
   3. Erinnerungen vor Terminen (Feld "remind": 1h oder 1d), alle 10 Minuten geprüft
   Tokens liegen in users/{uid}.fcmTokens, Sprache in users/{uid}.lang (de oder ro). */
const { onDocumentWritten, onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const admin = require('firebase-admin');

admin.initializeApp();
setGlobalOptions({ region: 'europe-west1', maxInstances: 3 });
const db = admin.firestore();
const TZ = 'Europe/Berlin';

const T = {
  newTask: { de: (t, d) => `Neue Aufgabe für dich: ${t}${d}`, ro: (t, d) => `Sarcină nouă pentru tine: ${t}${d}` },
  newTour: {
    de: (n, d, role) => `Neue Tour für dich: ${n} am ${d} (${role === 'driver' ? 'Fahrer' : 'Beifahrer'})`,
    ro: (n, d, role) => `Tur nou pentru tine: ${n} pe ${d} (${role === 'driver' ? 'șofer' : 'însoțitor'})`
  },
  report: {
    de: (u, c, o, t) => `${u ? 'DRINGEND: ' : ''}Neue Meldung (${c}${o ? ', ' + o : ''}): ${t}`,
    ro: (u, c, o, t) => `${u ? 'URGENT: ' : ''}Raportare nouă (${c}${o ? ', ' + o : ''}): ${t}`
  },
  repWork: { de: t => `Deine Meldung wird bearbeitet: ${t}`, ro: t => `Raportarea ta este în lucru: ${t}` },
  repDone: { de: t => `Deine Meldung ist erledigt: ${t}`, ro: t => `Raportarea ta este rezolvată: ${t}` },
  title: { de: 'Hof Droste', ro: 'Hof Droste' },
  morning: {
    de: (n, a, e) => `Guten Morgen ${n}: ${a} offene ${a === 1 ? 'Aufgabe' : 'Aufgaben'}${e ? `, ${e} ${e === 1 ? 'Termin' : 'Termine'} heute` : ''}.`,
    ro: (n, a, e) => `Bună dimineața ${n}: ${a} ${a === 1 ? 'sarcină deschisă' : 'sarcini deschise'}${e ? `, ${e} ${e === 1 ? 'termen' : 'termene'} astăzi` : ''}.`
  },
  remind1h: { de: (t, h) => `Erinnerung: ${t} um ${h}`, ro: (t, h) => `Memento: ${t} la ${h}` },
  remind1d: { de: (t, h) => `Erinnerung für morgen: ${t}${h ? ' um ' + h : ''}`, ro: (t, h) => `Memento pentru mâine: ${t}${h ? ' la ' + h : ''}` }
};

const berlinDate = (d = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d);
function addDays(ds, n) { const d = new Date(ds + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function berlinToUtc(ds, hm) {
  const guess = new Date(`${ds}T${hm}:00Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(guess).map(x => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return new Date(guess.getTime() - (local - guess.getTime()));
}

async function approvedUsers() {
  const snap = await db.collection('users').where('approved', '==', true).get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function pushTo(user, text) {
  const tokens = user.fcmTokens || [];
  if (!tokens.length) return 0;
  const lang = user.lang === 'ro' ? 'ro' : 'de';
  const body = typeof text === 'function' ? text(lang) : text;
  let ok = 0;
  for (const token of tokens) {
    try {
      await admin.messaging().send({
        token,
        data: { title: T.title[lang], body, url: './' },
        webpush: { headers: { Urgency: 'high', TTL: '86400' } }
      });
      ok++;
    } catch (e) {
      if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') {
        await db.collection('users').doc(user.id).update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(token) }).catch(() => {});
      } else console.error('Push fehlgeschlagen', user.id, e.code || e.message);
    }
  }
  return ok;
}

/* 1. Neue Zuweisung */
exports.taskAssigned = onDocumentWritten('tasks/{id}', async event => {
  const after = event.data.after.exists ? event.data.after.data() : null;
  const before = event.data.before.exists ? event.data.before.data() : null;
  if (!after || after.deleted || after.done || !after.person) return;
  if (before && before.person === after.person) return;
  if (after.assignedBy && after.assignedBy === after.person) return;
  const users = await approvedUsers();
  const u = users.find(x => x.name === after.person);
  if (!u) return;
  const d = after.date ? ` (${after.date.slice(8)}.${after.date.slice(5, 7)}.)` : '';
  await pushTo(u, lang => T.newTask[lang](after.title || '', d));
});

/* 1b. Neue Tour: Nachricht an Fahrer und Beifahrer */
const TCOLOR = { rot: 'Rot', blau: 'Blau', gruen: 'Grün', gelb: 'Gelb', orange: 'Orange', lila: 'Lila', tuerkis: 'Türkis' };
exports.tourAssigned = onDocumentWritten('tours/{id}', async event => {
  const after = event.data.after.exists ? event.data.after.data() : null;
  const before = event.data.before.exists ? event.data.before.data() : null;
  if (!after || after.deleted || after.type === 'abholung' || after.status === 'beendet') return;
  const users = await approvedUsers();
  const name = 'Tour' + (TCOLOR[after.color] ? ' ' + TCOLOR[after.color] : '');
  const date = after.date ? `${after.date.slice(8)}.${after.date.slice(5, 7)}.` : '';
  for (const role of ['driver', 'codriver']) {
    const who = role === 'driver' ? after.driver : after.codriver;
    if (!who || (before && (role === 'driver' ? before.driver : before.codriver) === who)) continue;
    const u = users.find(x => x.name === who);
    if (u) await pushTo(u, lang => T.newTour[lang](name, date, role));
  }
});

/* 1c. Meldungen: neue Meldung an Admin und Chef, Statuswechsel an den Melder */
const RCAT = { fahrzeug: ['Fahrzeug', 'Vehicul'], maschine: ['Maschine', 'Utilaj'], hof: ['Hof', 'Fermă'], stand: ['Stand', 'Stand'] };
async function repObjName(r) {
  if (r.cat !== 'stand' || !r.obj) return r.obj || '';
  const d = await db.collection('stands').doc(r.obj).get();
  return d.exists ? d.data().name : r.obj;
}
exports.reportCreated = onDocumentCreated('reports/{id}', async event => {
  const r = event.data.data();
  const obj = await repObjName(r);
  const users = (await approvedUsers()).filter(u => ['admin', 'chef'].includes(u.role) && u.id !== r.byUid);
  for (const u of users) {
    const li = u.lang === 'ro' ? 1 : 0;
    await pushTo(u, lang => T.report[lang](!!r.urgent, RCAT[r.cat] ? RCAT[r.cat][lang === 'ro' ? 1 : 0] : r.cat, obj, r.text || ''));
  }
});
exports.reportUpdated = onDocumentUpdated('reports/{id}', async event => {
  const b = event.data.before.data(), a = event.data.after.data();
  if (b.status === a.status || !a.byUid || !['arbeit', 'erledigt'].includes(a.status)) return;
  const users = await approvedUsers();
  const u = users.find(x => x.id === a.byUid);
  if (!u) return;
  await pushTo(u, lang => T[a.status === 'erledigt' ? 'repDone' : 'repWork'][lang](a.text || ''));
});
/* Wird die zugewiesene Aufgabe erledigt, gilt die Meldung als erledigt */
exports.reportTaskDone = onDocumentWritten('tasks/{id}', async event => {
  const a = event.data.after.exists ? event.data.after.data() : null;
  const b = event.data.before.exists ? event.data.before.data() : null;
  if (!a || !a.reportId || !!a.done === !!(b && b.done)) return;
  const ref = db.collection('reports').doc(a.reportId);
  const d = await ref.get();
  if (!d.exists) return;
  if (a.done) await ref.update({ status: 'erledigt', doneAt: Date.now(), doneBy: a.doneBy || '' });
  else if (d.data().status === 'erledigt') await ref.update({ status: 'arbeit' });
});

/* 2. Morgennachricht */
exports.morning = onSchedule({ schedule: '0 7 * * *', timeZone: TZ }, async () => {
  const today = berlinDate();
  const users = (await approvedUsers()).filter(u => (u.fcmTokens || []).length);
  if (!users.length) return;
  const tasks = (await db.collection('tasks').where('done', '==', false).get()).docs.map(d => d.data()).filter(t => !t.deleted && t.date && t.date <= today);
  const events = (await db.collection('events').where('date', '<=', today).get()).docs.map(d => d.data()).filter(e => !e.deleted && e.cal === 'saison' && today <= (e.end || e.date));
  for (const u of users) {
    const a = tasks.filter(t => t.person === u.name).length;
    const e = events.filter(x => !x.person || x.person === u.name).length;
    if (!a && !e) continue;
    await pushTo(u, lang => T.morning[lang](u.name, a, e));
  }
});

/* 3. Erinnerungen vor Terminen */
exports.reminders = onSchedule({ schedule: 'every 10 minutes', timeZone: TZ }, async () => {
  const now = new Date(), today = berlinDate(now), tomorrow = addDays(today, 1);
  const evs = (await db.collection('events').where('date', '>=', today).where('date', '<=', tomorrow).get()).docs.map(d => d.data());
  const due = [];
  for (const e of evs) {
    if (e.deleted || !e.remind || !['1h', '1d'].includes(e.remind)) continue;
    const start = berlinToUtc(e.date, e.time || '08:00');
    const fire = new Date(start.getTime() - (e.remind === '1h' ? 3600e3 : 86400e3));
    if (now >= fire && now < start) due.push({ e, key: `${e.id}_${e.remind}_${e.date}_${e.time || ''}` });
  }
  if (!due.length) return;
  const users = await approvedUsers();
  for (const { e, key } of due) {
    const ref = db.collection('reminders').doc(key);
    try { await ref.create({ at: Date.now() }); } catch (x) { continue; }   // schon verschickt
    const targets = e.person ? users.filter(u => u.name === e.person) : users;
    for (const u of targets) await pushTo(u, lang => T[e.remind === '1h' ? 'remind1h' : 'remind1d'][lang](e.title, e.time || ''));
  }
});
