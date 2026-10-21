/* Push-Nachrichten für die Droste Team-App (Firebase Cloud Functions, Node 20).
   1. Neue Zuweisung einer Aufgabe: Nachricht an die zuständige Person
   2. Morgennachricht 07:00 (Berlin): offene Aufgaben und Termine des Tages
   3. Erinnerungen vor Terminen (Feld "remind": 1h oder 1d), alle 10 Minuten geprüft
   Tokens liegen in users/{uid}.fcmTokens, Sprache in users/{uid}.lang (de oder ro). */
const { onDocumentWritten, onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
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
  newUser: { de: n => `Neue Freigabe nötig: ${n} hat sich registriert.`, ro: n => `Aprobare necesară: ${n} s-a înregistrat.` },
  question: { de: (b, t) => `Neue Frage zur App von ${b}: ${t}`, ro: (b, t) => `Întrebare nouă despre aplicație de la ${b}: ${t}` },
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

/* Rollen und Freigabe als Anmelde-Claims, damit die Storage-Regeln ohne Firestore-Zugriff prüfen können */
exports.syncClaims = onDocumentWritten('users/{uid}', async event => {
  const uid = event.params.uid;
  const after = event.data.after.exists ? event.data.after.data() : null;
  try {
    await admin.auth().setCustomUserClaims(uid, after ? { approved: after.approved === true, role: after.role || 'team' } : null);
  } catch (e) { console.error('Claims fehlgeschlagen', uid, e.code || e.message); }
});

/* 1c. Meldungen: neue Meldung an Admin und Chef, Statuswechsel an den Melder */
const RCAT = { fahrzeug: ['Fahrzeug', 'Vehicul'], maschine: ['Maschine', 'Utilaj'], hof: ['Hof', 'Fermă'], stand: ['Stand', 'Stand'], nachschub: ['Nachschub', 'Aprovizionare'], lieferung: ['Lieferung', 'Livrare'], strich: ['Strichliste', 'Listă liniuțe'], feld: ['Feld', 'Câmp'] };
async function repObjName(r) {
  if ((r.cat !== 'stand' && r.cat !== 'nachschub' && r.cat !== 'strich') || !r.obj) return r.obj || '';
  const d = await db.collection('stands').doc(r.obj).get();
  return d.exists ? d.data().name : r.obj;
}
async function canDoAll(key) {
  const cfgDoc = await db.doc('settings/roles').get(), cfg = cfgDoc.exists ? cfgDoc.data() : {};
  return u => {
    if (u.role === 'admin') return true;
    const ov = u.perms || {};
    if (ov[key] !== undefined) return !!ov[key];
    const rc = cfg[u.role];
    if (rc && rc[key] !== undefined) return !!rc[key];
    return u.role === 'chef';
  };
}
exports.reportCreated = onDocumentCreated('reports/{id}', async event => {
  const r = event.data.data();
  const obj = await repObjName(r);
  const can = await canDoAll('reportsAll');
  const users = (await approvedUsers()).filter(u => can(u) && u.id !== r.byUid);
  for (const u of users) {
    const li = u.lang === 'ro' ? 1 : 0;
    await pushTo(u, lang => T.report[lang](!!r.urgent, RCAT[r.cat] ? RCAT[r.cat][lang === 'ro' ? 1 : 0] : r.cat, obj, r.text || ''));
  }
});
exports.reportUpdated = onDocumentUpdated('reports/{id}', async event => {
  const b = event.data.before.data(), a = event.data.after.data();
  if (b.status === a.status || !a.byUid || a.status !== 'erledigt') return;
  const users = await approvedUsers();
  const u = users.find(x => x.id === a.byUid);
  if (!u) return;
  await pushTo(u, lang => T.repDone[lang](a.text || ''));
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

/* Rangliste erledigter Aufgaben: gesamt und 7 Tage, für alle sichtbar (Aufgaben selbst sieht nicht jeder) */
exports.taskStats = onDocumentWritten('tasks/{id}', async event => {
  const a = event.data.after.exists ? event.data.after.data() : null;
  const b = event.data.before.exists ? event.data.before.data() : null;
  if (!!(a && a.done) === !!(b && b.done) && (a && a.doneBy) === (b && b.doneBy)) return;
  const snap = await db.collection('tasks').where('done', '==', true).get();
  const all = {}, week = {}, since = Date.now() - 7 * 864e5;
  snap.forEach(d => { const t = d.data(); if (t.deleted || !t.doneBy) return; all[t.doneBy] = (all[t.doneBy] || 0) + 1; if ((t.doneAt || 0) > since) week[t.doneBy] = (week[t.doneBy] || 0) + 1; });
  await db.collection('stats').doc('ranking').set({ all, week, at: Date.now() });
});

/* OpenRouteService (HeiGIT): Schlüssel in secrets/ors, sonst Rückfall auf Google (secrets/maps) */
const ORS = 'https://api.openrouteservice.org';
async function orsKey() { const k = await db.doc('secrets/ors').get(); return k.exists && k.data().key ? k.data().key : null; }
async function orsGeocode(key, a) {
  const r = await fetch(`${ORS}/geocode/search?api_key=${encodeURIComponent(key)}&text=${encodeURIComponent(a)}&boundary.country=DE&size=1&layers=address,street,venue`, { headers: { Accept: 'application/json' } });
  if (r.status === 401 || r.status === 403) throw new HttpsError('failed-precondition', 'OpenRouteService lehnt den Schlüssel ab (Daten, Einstellungen).');
  if (r.status === 429) throw new HttpsError('resource-exhausted', 'OpenRouteService: Limit erreicht, bitte eine Minute warten.');
  const j = await r.json();
  const f = j.features && j.features[0];
  if (!f) return null;
  return { lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], partial: (f.properties.confidence || 0) < 0.8 };
}
async function orsGeocodeMany(key, addrs) {
  const out = [];
  for (let i = 0; i < addrs.length; i += 8) out.push(...await Promise.all(addrs.slice(i, i + 8).map(a => orsGeocode(key, a))));
  return out;
}
async function orsLegs(key, pts) {
  const r = await fetch(`${ORS}/v2/directions/driving-car`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key }, body: JSON.stringify({ coordinates: pts.map(p => [p.lng, p.lat]) }) });
  const j = await r.json();
  if (!r.ok || !j.routes || !j.routes[0]) throw new HttpsError('unavailable', String((j.error && (j.error.message || j.error)) || 'Keine Route gefunden'));
  return j.routes[0].segments.map(s => Math.round(s.duration || 0));
}
async function orsRoute(key, origin, stops, optimize, roundTrip) {
  const pts = await orsGeocodeMany(key, [origin, ...stops]);
  const bad = pts.findIndex(p => !p);
  if (bad >= 0) throw new HttpsError('not-found', 'Adresse nicht gefunden: ' + (bad ? stops[bad - 1] : origin));
  const o = pts[0], sp = pts.slice(1);
  if (!optimize) return { legs: await orsLegs(key, roundTrip ? [o, ...sp, o] : [o, ...sp]) };
  const r = await fetch(`${ORS}/optimization`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key }, body: JSON.stringify({ jobs: sp.map((p, i) => ({ id: i + 1, location: [p.lng, p.lat] })), vehicles: [{ id: 1, profile: 'driving-car', start: [o.lng, o.lat], end: [o.lng, o.lat] }] }) });
  const j = await r.json();
  if (!r.ok || !j.routes || !j.routes[0]) throw new HttpsError('unavailable', String((j.error && (j.error.message || j.error)) || 'Optimierung fehlgeschlagen'));
  const order = j.routes[0].steps.filter(s => s.type === 'job').map(s => s.id - 1);
  return { legs: await orsLegs(key, [o, ...order.map(i => sp[i]), o]), order };
}

/* Fahrzeiten entlang einer Tour (OpenRouteService oder Google Routes API, Schlüssel liegt nur in secrets/maps) */
exports.routeLegs = onCall(async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Bitte anmelden');
  const u = await db.collection('users').doc(req.auth.uid).get();
  if (!u.exists || u.data().approved !== true) throw new HttpsError('permission-denied', 'Nicht freigegeben');
  const ok = await orsKey();
  const k = await db.doc('secrets/maps').get();
  if (!ok && (!k.exists || !k.data().key)) throw new HttpsError('failed-precondition', 'Der Routing-Schlüssel ist noch nicht hinterlegt (Daten, Einstellungen).');
  const { origin, stops, depart } = req.data || {};
  if (!origin || !Array.isArray(stops) || !stops.length || stops.length > 25) throw new HttpsError('invalid-argument', 'Start und 1 bis 25 Adressen nötig');
  const optimize = req.data && req.data.optimize === true;
  const roundTrip = req.data && req.data.roundTrip === true;
  if (ok) return orsRoute(ok, origin, stops, optimize, roundTrip);
  const body = { origin: { address: origin }, destination: { address: (optimize || roundTrip) ? origin : stops[stops.length - 1] }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_AWARE', languageCode: 'de-DE', regionCode: 'DE' };
  if (optimize) { body.intermediates = stops.map(a => ({ address: a })); body.optimizeWaypointOrder = true; }
  else if (roundTrip) body.intermediates = stops.map(a => ({ address: a }));
  else if (stops.length > 1) body.intermediates = stops.slice(0, -1).map(a => ({ address: a }));
  if (depart && new Date(depart) > new Date()) body.departureTime = depart;
  const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': k.data().key, 'X-Goog-FieldMask': 'routes.legs.duration,routes.legs.distanceMeters,routes.optimizedIntermediateWaypointIndex' },
    body: JSON.stringify(body)
  });
  const j = await res.json();
  if (!res.ok || !j.routes || !j.routes[0]) throw new HttpsError('unavailable', (j.error && j.error.message) || 'Keine Route gefunden');
  const legs = j.routes[0].legs.map(l => parseInt(String(l.duration || '0s').replace('s', ''), 10) || 0);
  if (optimize) return { legs, order: j.routes[0].optimizedIntermediateWaypointIndex || stops.map((_, i) => i) };
  return { legs };
});


/* Entfernungsmatrix (Fahrzeit in Sekunden zwischen allen Punkten) fuer die Tourenplanung.
   Bevorzugt OpenRouteService (kostenlos, Schluessel in secrets/orsMatrix), sonst Google Routes API (secrets/maps, Essentials, ohne Verkehr). */
exports.routeMatrix = onCall({ timeoutSeconds: 120 }, async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Bitte anmelden');
  const u = await db.collection('users').doc(req.auth.uid).get();
  if (!u.exists || u.data().approved !== true) throw new HttpsError('permission-denied', 'Nicht freigegeben');
  const pts = (req.data && req.data.points) || [];
  const n = pts.length;
  if (!Array.isArray(pts) || n < 2 || n > 60 || pts.some(p => typeof p.lat !== 'number' || typeof p.lng !== 'number')) throw new HttpsError('invalid-argument', '2 bis 60 Punkte mit Koordinaten nötig');
  const mk = await db.doc('secrets/orsMatrix').get();
  if (mk.exists && mk.data().key) {
    const key = mk.data().key, per = Math.max(1, Math.floor(2500 / n)), out = [];
    for (let s = 0; s < n; s += per) {
      const src = []; for (let i = s; i < Math.min(n, s + per); i++) src.push(i);
      const r = await fetch(`${ORS}/v2/matrix/driving-car`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key }, body: JSON.stringify({ locations: pts.map(p => [p.lng, p.lat]), sources: src, metrics: ['duration'] }) });
      const j = await r.json();
      if (r.status === 401 || r.status === 403) throw new HttpsError('failed-precondition', 'OpenRouteService lehnt den Schlüssel ab (Daten, Einstellungen).');
      if (r.status === 429) throw new HttpsError('resource-exhausted', 'OpenRouteService: Limit erreicht, bitte kurz warten.');
      if (!r.ok || !j.durations) throw new HttpsError('unavailable', String((j.error && (j.error.message || j.error)) || 'Matrix nicht verfügbar'));
      j.durations.forEach(row => out.push(row.map(v => (v == null ? null : Math.round(v)))));
    }
    return { durations: out, source: 'ors' };
  }
  const k = await db.doc('secrets/maps').get();
  if (!k.exists || !k.data().key) throw new HttpsError('failed-precondition', 'Kein Schlüssel für die Entfernungsmatrix hinterlegt (Daten, Einstellungen).');
  const D = Array.from({ length: n }, () => Array(n).fill(null));
  for (let i = 0; i < n; i++) D[i][i] = 0;
  const CH = 25, blocks = Math.ceil(n / CH);
  for (let a = 0; a < blocks; a++) for (let b = a; b < blocks; b++) {
    const oi = [], di = [];
    for (let i = a * CH; i < Math.min(n, (a + 1) * CH); i++) oi.push(i);
    for (let j = b * CH; j < Math.min(n, (b + 1) * CH); j++) di.push(j);
    const wp = i => ({ waypoint: { location: { latLng: { latitude: pts[i].lat, longitude: pts[i].lng } } } });
    const res = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': k.data().key, 'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,status,condition' },
      body: JSON.stringify({ origins: oi.map(wp), destinations: di.map(wp), travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE' })
    });
    const j = await res.json();
    if (!res.ok || !Array.isArray(j)) throw new HttpsError('unavailable', (j.error && j.error.message) || (Array.isArray(j) && j[0] && j[0].error && j[0].error.message) || 'Matrix nicht verfügbar');
    j.forEach(e => {
      if (e.condition && e.condition !== 'ROUTE_EXISTS') return;
      const sec = parseInt(String(e.duration || '').replace('s', ''), 10);
      if (isNaN(sec)) return;
      const I = oi[e.originIndex], J = di[e.destinationIndex];
      D[I][J] = sec; if (D[J][I] == null) D[J][I] = sec;
    });
  }
  return { durations: D, source: 'google' };
});

/* Adressen in Koordinaten umwandeln (Geocoding API, Schlüssel aus secrets/maps) */
exports.geocode = onCall(async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Bitte anmelden');
  const u = await db.collection('users').doc(req.auth.uid).get();
  if (!u.exists || u.data().approved !== true) throw new HttpsError('permission-denied', 'Nicht freigegeben');
  const ok = await orsKey();
  const k = await db.doc('secrets/maps').get();
  if (!ok && (!k.exists || !k.data().key)) throw new HttpsError('failed-precondition', 'Der Routing-Schlüssel ist noch nicht hinterlegt (Daten, Einstellungen).');
  const addrs = (req.data && req.data.addresses) || [];
  if (!Array.isArray(addrs) || addrs.length > 60) throw new HttpsError('invalid-argument', 'Höchstens 60 Adressen');
  if (ok) return { coords: await orsGeocodeMany(ok, addrs) };
  const out = [];
  for (let i = 0; i < addrs.length; i += 8) {
    const part = await Promise.all(addrs.slice(i, i + 8).map(async a => {
      const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(a)}&region=de&language=de&key=${k.data().key}`);
      const j = await r.json();
      if (j.status === 'OK' && j.results[0]) return { lat: j.results[0].geometry.location.lat, lng: j.results[0].geometry.location.lng, partial: !!j.results[0].partial_match };
      if (j.status === 'REQUEST_DENIED') throw new HttpsError('failed-precondition', 'Geocoding API nicht aktiviert oder für den Schlüssel nicht erlaubt: ' + (j.error_message || ''));
      return null;
    }));
    out.push(...part);
  }
  return { coords: out };
});

/* Strecke vom Hof zu einer Adresse in Kilometern (gefahren, einfache Fahrt) fuer den Lieferrechner */
exports.driveKm = onCall(async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Bitte anmelden');
  const u = await db.collection('users').doc(req.auth.uid).get();
  if (!u.exists || u.data().approved !== true) throw new HttpsError('permission-denied', 'Nicht freigegeben');
  const address = String((req.data && req.data.address) || '').trim().slice(0, 200);
  if (!address) throw new HttpsError('invalid-argument', 'Bitte eine Adresse eingeben');
  const hof = await db.doc('settings/hof').get();
  const origin = (hof.exists && hof.data().depot) || 'Im Gattberg 19, 49191 Belm';
  const ok = await orsKey();
  if (ok) {
    const pts = await orsGeocodeMany(ok, [origin, address]);
    if (!pts[0] || !pts[1]) throw new HttpsError('not-found', 'Adresse nicht gefunden');
    const r = await fetch(`${ORS}/v2/directions/driving-car`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: ok }, body: JSON.stringify({ coordinates: pts.map(p => [p.lng, p.lat]), preference: 'shortest' }) });
    const j = await r.json();
    if (!r.ok || !j.routes || !j.routes[0]) throw new HttpsError('unavailable', 'Keine Route gefunden');
    return { km: Math.round(j.routes[0].summary.distance / 100) / 10, min: Math.round(j.routes[0].summary.duration / 60) };
  }
  const k = await db.doc('secrets/maps').get();
  if (!k.exists || !k.data().key) throw new HttpsError('failed-precondition', 'Der Routing-Schlüssel ist noch nicht hinterlegt (Daten, Einstellungen).');
  // Adresse eindeutig machen: entweder aus dem Vorschlag der App oder per Suche (bevorzugt Umgebung des Hof)
  const pl = req.data && req.data.place;
  let dest, plz, ort = '', partial = false, addrTxt;
  if (pl && typeof pl.lat === 'number' && typeof pl.lng === 'number') {
    dest = { location: { latLng: { latitude: pl.lat, longitude: pl.lng } } }; plz = String(pl.plz || ''); addrTxt = String(pl.addr || address);
  } else {
    const gr = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&components=country:DE&region=de&language=de&bounds=${encodeURIComponent('52.10,7.90|52.50,8.40')}&key=${k.data().key}`)).json();
    if (gr.status === 'REQUEST_DENIED') throw new HttpsError('failed-precondition', 'Geocoding API nicht erlaubt: ' + (gr.error_message || ''));
    const g0 = gr.results && gr.results[0];
    if (!g0) throw new HttpsError('not-found', 'Adresse nicht gefunden');
    const comp = t => ((g0.address_components || []).find(c => c.types.includes(t)) || {}).long_name || '';
    plz = comp('postal_code'); ort = comp('locality'); partial = !!g0.partial_match; addrTxt = g0.formatted_address;
    dest = { location: { latLng: { latitude: g0.geometry.location.lat, longitude: g0.geometry.location.lng } } };
  }
  // Kürzeste Strecke: normale Routen und Routen ohne Autobahn mit Alternativen, davon die kleinste Strecke
  const ask = async mods => {
    const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': k.data().key, 'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration' },
      body: JSON.stringify({ origin: { address: origin }, destination: dest, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', computeAlternativeRoutes: true, routeModifiers: mods, languageCode: 'de-DE', regionCode: 'DE' })
    });
    const jj = await r.json();
    if (!r.ok) throw new HttpsError('unavailable', (jj.error && jj.error.message) || 'Keine Route gefunden');
    return jj.routes || [];
  };
  const all = (await Promise.all([ask({}), ask({ avoidHighways: true }).catch(() => [])])).flat().filter(r => r.distanceMeters);
  if (!all.length) throw new HttpsError('unavailable', 'Keine Route gefunden');
  const best = all.sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
  return { km: Math.round(best.distanceMeters / 100) / 10, min: Math.round((parseInt(String(best.duration || '0s').replace('s', ''), 10) || 0) / 60), addr: addrTxt, plz, ort, belm: plz === '49191', partial };
});

/* Adressvorschläge für den Lieferrechner (Geocoding, bevorzugt Umgebung des Hofs) */
exports.addrSuggest = onCall(async req => {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Bitte anmelden');
  const u = await db.collection('users').doc(req.auth.uid).get();
  if (!u.exists || u.data().approved !== true) throw new HttpsError('permission-denied', 'Nicht freigegeben');
  const input = String((req.data && req.data.input) || '').trim().slice(0, 150);
  if (input.length < 5) return { items: [] };
  const k = await db.doc('secrets/maps').get();
  if (!k.exists || !k.data().key) return { items: [] };
  const gr = await (await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(input)}&components=country:DE&region=de&language=de&bounds=${encodeURIComponent('52.10,7.90|52.50,8.40')}&key=${k.data().key}`)).json();
  const items = (gr.results || []).slice(0, 5).map(g => ({ addr: g.formatted_address.replace(/, Deutschland$/, ''), lat: g.geometry.location.lat, lng: g.geometry.location.lng, plz: ((g.address_components || []).find(c => c.types.includes('postal_code')) || {}).long_name || '', partial: !!g.partial_match }));
  return { items };
});


/* Fragen zur App: Nachricht an den Admin */
exports.userRegistered = onDocumentCreated('users/{uid}', async event => {
  const d = event.data.data();
  if (!d || d.approved !== false) return;
  const admins = (await approvedUsers()).filter(u => u.role === 'admin' && u.id !== event.params.uid);
  for (const u of admins) await pushTo(u, lang => T.newUser[lang](d.name || d.email || '?'));
});
exports.questionCreated = onDocumentCreated('questions/{id}', async event => {
  const q = event.data.data();
  const users = (await approvedUsers()).filter(u => u.role === 'admin' && u.id !== q.byUid);
  for (const u of users) await pushTo(u, lang => T.question[lang](q.by || '?', q.text || ''));
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
