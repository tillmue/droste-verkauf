/* Cloud-Schicht: Firebase Auth + Firestore.
   Verbindet den App-Zustand (window.APP) mit der gemeinsamen Datenbank.
   Prinzip: Die App ändert wie bisher ihr Objekt S und ruft save(). save() ruft cloud.sync(),
   das nur geänderte Dokumente schreibt. Snapshot-Listener schreiben Änderungen anderer zurück in S. */
const V = '10.14.1', BASE = 'https://www.gstatic.com/firebasejs/' + V + '/';

async function loadFB() {
  const [a, au, fs, ms, st, fn] = await Promise.all([
    import(BASE + 'firebase-app.js'), import(BASE + 'firebase-auth.js'), import(BASE + 'firebase-firestore.js'),
    import(BASE + 'firebase-messaging.js').catch(() => ({})), import(BASE + 'firebase-storage.js').catch(() => ({})), import(BASE + 'firebase-functions.js').catch(() => ({}))]);
  return { ...a, ...au, ...fs, ...ms, ...st, ...fn };
}

const clean = o => JSON.parse(JSON.stringify(o));
function stable(o) {
  if (o === undefined) return 'null';
  if (o && typeof o === 'object') {
    if (Array.isArray(o)) return '[' + o.map(stable).join(',') + ']';
    return '{' + Object.keys(o).sort().filter(k => o[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(o[k])).join(',') + '}';
  }
  return JSON.stringify(o);
}

function initCloud(FB) {
  const T = window.APP;
  const app = FB.initializeApp(window.FIREBASE_CONFIG);
  const auth = FB.getAuth(app);
  auth.languageCode = (() => { try { return localStorage.getItem('droste-lang') === 'ro' ? 'ro' : 'de'; } catch (e) { return 'de'; } })();
  let db;
  try {
    db = FB.initializeFirestore(app, { experimentalAutoDetectLongPolling: true, localCache: FB.persistentLocalCache({ tabManager: FB.persistentMultipleTabManager() }) });
  } catch (e) { console.warn('Offline-Cache nicht verfügbar', e); db = FB.getFirestore(app); }

  /* Sammlungen: get() liefert [id, objekt]-Paare aus S, put(map) schreibt die Dokumente zurück in S */
  const defs = {
    tasks:    { get: () => T.S.tasks.map(x => [x.id, x]),  put: m => { T.S.tasks = Object.values(m); }, del: true },
    events:   { get: () => T.S.events.map(x => [x.id, x]), put: m => { T.S.events = Object.values(m); }, del: true },
    notes:    { get: () => T.S.notes.map(x => [x.id, x]),  put: m => { T.S.notes = Object.values(m); }, del: false },
    settings: { get: () => { const h = T.S.hofInfo || {}, out = [];
                  if (h.address || h.paypal || h.orte || (h.vehicles && h.vehicles.length) || (h.trailers && h.trailers.length) || h.svcDrop || h.svcSet || h.svcTree || h.svcPct || h.attFrom || h.attTo || h.partners || h.salesStart || h.machines || h.vat || h.reserveMin || h.reserveEvery || h.depot || h.mapsSet || h.amEnd || h.pmFrom || h.pmTo || h.dayEnd || h.treeCap || h.matrixSet || h.depotLL || (h.crew && h.crew.length) || (h.schonungen && Object.keys(h.schonungen).length)) out.push(['hof', h]);
                  if (T.S.rolesCfg && Object.keys(T.S.rolesCfg).length) out.push(['roles', T.S.rolesCfg]);
                  return out; },
                put: m => { const h = m.hof || {}; T.S.hofInfo = { address: h.address || '', paypal: h.paypal || '', vehicles: h.vehicles || [], trailers: h.trailers || [], partners: h.partners || '', salesStart: h.salesStart || '', svcDrop: h.svcDrop || '', svcSet: h.svcSet || '', svcTree: h.svcTree || '', svcPct: h.svcPct || '', attFrom: h.attFrom || '', attTo: h.attTo || '', orte: h.orte || '', machines: h.machines || '', vat: h.vat || '', reserveMin: h.reserveMin || '', reserveEvery: h.reserveEvery || '', depot: h.depot || '', mapsSet: !!h.mapsSet, matrixSet: !!h.matrixSet, treeCap: h.treeCap || '', dayEnd: h.dayEnd || '', amEnd: h.amEnd || '', pmFrom: h.pmFrom || '', pmTo: h.pmTo || '', depotLL: h.depotLL || null, crew: h.crew || [], schonungen: h.schonungen || {} };
                            const rc = m.roles || {}; const changed = JSON.stringify(rc) !== JSON.stringify(T.S.rolesCfg || {}); T.S.rolesCfg = rc; if (changed && T.rolesChanged) setTimeout(() => T.rolesChanged(), 0); }, del: true },
    packs:    { get: () => T.S.packs.map(x => [x.id, x]), put: m => { T.S.packs = Object.values(m); }, del: false, maps: ['checks'] },
    feld:     { get: () => T.S.feld.map(x => [x.id, x]), put: m => { T.S.feld = Object.values(m); }, del: false, maps: ['bal'] },
    tours:    { get: () => T.S.tours.map(x => [x.id, x]), put: m => { T.S.tours = Object.values(m); }, del: false, maps: ['stops', 'loaded', 'pack'] },
    questions:{ get: () => T.S.questions.map(x => [x.id, x]), put: m => { T.S.questions = Object.values(m); }, del: false },
    stats:    { get: () => [], put: m => { T.S.stats = m.ranking || {}; T.S.attStats = (m.attendance && m.attendance.days) || {}; }, del: false },
    attendance: { get: () => (T.S.attendance || []).map(x => [x.id, x]), put: m => { T.S.attendance = Object.values(m); }, del: false, maps: ['days'] },
    meals:    { get: () => (T.S.meals || []).map(x => [x.id, x]), put: m => { T.S.meals = Object.values(m); }, del: false },
    reports:  { get: () => T.S.reports.map(x => [x.id, x]), put: m => { T.S.reports = Object.values(m); }, del: false },
    orders:   { get: () => T.S.orders.map(x => [x.id, x]), put: m => { T.S.orders = Object.values(m); }, del: true },
    bestellungen: { get: () => T.S.bestellungen.map(x => [x.id, x]), put: m => { T.S.bestellungen = Object.values(m); }, del: false },
    days:     { get: () => T.S.days.map(x => [x.id, x]), put: m => { T.S.days = Object.values(m); }, del: false },
    shopping: { get: () => T.S.shopping.map(x => [x.id, x]), put: m => { T.S.shopping = Object.values(m); }, del: false },
    penalties:{ get: () => T.S.penalties.map(x => [x.id, x]), put: m => { T.S.penalties = Object.values(m); }, del: false },
    products: { get: () => T.S.products.map(x => [x.id, x]), ordered: true, del: true,
                put: m => { T.S.products = Object.values(m).sort((a, b) => a._o - b._o).map(({ _o, ...r }) => r); } },
    stands:   { get: () => T.S.stands.map(x => [x.id, x]), ordered: true, del: true,
                put: m => { T.S.stands = Object.values(m).sort((a, b) => a._o - b._o).map(({ _o, ...r }) => r);
                            if (T.S.stands.length && !T.S.stands.some(s => s.id === T.cur.stand)) T.cur.stand = T.S.stands[0].id; } },
    moves:    { get: () => T.S.moves.map(x => [x.id, x]), put: m => { T.S.moves = Object.values(m); }, del: true, sales: true },
    sales:    { get: () => Object.entries(T.S.entries), put: m => { T.S.entries = m; }, del: false, sales: true }
  };
  const hydrated = {}, lastSynced = {}, pending = {}, unsubs = [];
  let unsubProfile = null, profile = null, uid = null, activeKey = '', registering = false, seeded = {};

  function setStatus() {
    T.status = !navigator.onLine ? 'offline' : (Object.values(pending).some(Boolean) ? 'wird übertragen' : 'synchronisiert');
    T.updateHeader();
  }
  window.addEventListener('online', setStatus);
  window.addEventListener('offline', setStatus);

  /* iOS friert die Home-Screen-App im Hintergrund ein; die Live-Verbindung bleibt dann tot.
     Beim Zurückkehren Verbindung neu aufbauen, damit Änderungen sofort ankommen. */
  async function resume() {
    if (!FB.disableNetwork || !FB.enableNetwork) return;
    try { await FB.disableNetwork(db); } catch (e) {}
    try { await FB.enableNetwork(db); } catch (e) {}
    setStatus();
  }
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (uid && hiddenAt && Date.now() - hiddenAt > 15000) resume();
  });
  window.addEventListener('pageshow', e => { if (e.persisted && uid) resume(); });
  window.addEventListener('online', () => { if (uid) resume(); });

  function permissionNote(name, id, err) {
    console.error('Schreiben fehlgeschlagen', name, id, err);
    T.toast(err && err.code === 'permission-denied' ? 'Keine Berechtigung für diese Änderung' : 'Speichern fehlgeschlagen, wird erneut versucht');
  }

  const ghosts = {}; /* auf dem Server gelöschte Dokumente, die dieses Gerät noch lokal hat: nie neu schreiben */
  function sync() {
    if (!uid || !profile || profile.approved !== true) return;
    for (const [name, d] of Object.entries(defs)) {
      if (!hydrated[name]) continue;
      const cur = {};
      d.get().forEach(([id, o], i) => { cur[id] = clean(d.ordered ? { ...o, _o: i } : o); });
      const last = lastSynced[name] || (lastSynced[name] = {});
      for (const id in cur) {
        if (ghosts[name] && ghosts[name][id]) continue;
        const j = stable(cur[id]);
        if (last[id] !== j) {
          const prev = last[id] ? JSON.parse(last[id]) : null;
          last[id] = j;
          /* Bekannte Dokumente werden nur aktualisiert (updateDoc), nie neu angelegt: ein altes Gerät kann so nichts wiederbringen, was auf dem Server gelöscht wurde. */
          const gone = e => { if (e && (e.code === 'not-found' || /not-found/.test(String(e.code || '')))) { (ghosts[name] = ghosts[name] || {})[id] = 1; return; } permissionNote(name, id, e); };
          if (prev) {
            const args = [];
            for (const key of Object.keys(cur[id])) {
              if (d.maps && d.maps.includes(key)) {
                const pm = prev[key] || {}, cm = cur[id][key] || {};
                for (const k in cm) if (stable(cm[k]) !== stable(pm[k])) args.push(new FB.FieldPath(key, k), cm[k]);
              } else if (stable(cur[id][key]) !== stable(prev[key])) args.push(new FB.FieldPath(key), cur[id][key]);
            }
            for (const key of Object.keys(prev)) if (!(key in cur[id]) && !(d.maps && d.maps.includes(key))) args.push(new FB.FieldPath(key), FB.deleteField());
            if (args.length) FB.updateDoc(FB.doc(db, name, id), ...args).catch(gone);
          } else {
            FB.setDoc(FB.doc(db, name, id), cur[id]).catch(e => permissionNote(name, id, e));
          }
        }
      }
      if (d.del) for (const id in last) if (!(id in cur)) {
        delete last[id];
        FB.deleteDoc(FB.doc(db, name, id)).catch(e => permissionNote(name, id, e));
      }
    }
  }

  function seedIfEmpty(name, snap) {
    if (!(name === 'products' || name === 'stands') || profile.role !== 'admin') return;
    if (seeded[name] || snap.size > 0 || (snap.metadata && snap.metadata.fromCache)) return;
    seeded[name] = true;
    T.S[name] = clean(T.defaults()[name]);
    sync();
  }

  function listen(name) {
    const d = defs[name];
    const base = FB.collection(db, name);
    let qs = [base];
    if (name === 'notes' && profile.role !== 'admin') qs = [FB.query(base, FB.where('ownerUid', '==', uid))];
    if (name === 'questions' && !['admin', 'demo'].includes(profile.role)) qs = [FB.query(base, FB.where('byUid', '==', uid))];
    if (name === 'tours' && !T.permFor(profile, 'toursAll') && !T.permFor(profile, 'lieferplanung'))
      qs = [FB.query(base, FB.where('driver', '==', profile.name)), FB.query(base, FB.where('codriver', '==', profile.name))];
    if (name === 'attendance' && !T.permFor(profile, 'anwSee')) qs = [FB.query(base, FB.where('name', '==', profile.name))];
    if (name === 'reports' && !T.permFor(profile, 'reportsAll')) qs = [FB.query(base, FB.where('byUid', '==', uid))];
    /* Team, Verkauf und Schonung sehen nur eigene und offene Aufgaben (die Regeln erzwingen das ebenfalls) */
    if (name === 'tasks' && !T.permFor(profile, 'tasksAll'))
      qs = [FB.query(base, FB.where('person', '==', profile.name)), FB.query(base, FB.where('person', '==', ''))];
    const parts = qs.map(() => null);
    qs.forEach((q, qi) => unsubs.push(FB.onSnapshot(q, snap => {
      const m = {};
      snap.forEach(ds => { m[ds.id] = ds.data(); });
      parts[qi] = { m, pend: !!(snap.metadata && snap.metadata.hasPendingWrites), meta: snap.metadata };
      if (parts.some(p => !p)) return;
      const all = {}; parts.forEach(p => Object.assign(all, p.m));
      const map = {}; for (const id in all) map[id] = clean(all[id]);
      ghosts[name] = {}; lastSynced[name] = {}; for (const id in map) lastSynced[name][id] = stable(map[id]);
      pending[name] = parts.some(p => p.pend);
      d.put(map);
      hydrated[name] = true;
      if (name === 'tasks' && T.rollTasks) T.rollTasks();
      seedIfEmpty(name, { size: Object.keys(map).length, metadata: parts[0].meta });
      T.ready = hydrated.stands && hydrated.products;
      setStatus();
      T.softRender();
    }, err => { console.error(name, err); T.toast('Fehler beim Laden: ' + name); })));
  }

  function deactivate() {
    unsubs.splice(0).forEach(u => { try { u(); } catch (e) {} });
    for (const k of Object.keys(hydrated)) delete hydrated[k];
    for (const k of Object.keys(lastSynced)) delete lastSynced[k];
    seeded = {}; T.ready = false; activeKey = '';
  }

  function activate(p, id) {
    const key = id + ':' + p.role + ':' + JSON.stringify(p.perms || null) + ':' + JSON.stringify(T.S.rolesCfg || {});
    if (activeKey === key) return;
    deactivate(); activeKey = key;
    T.backupLocal();
    const S = T.S;
    S.tasks = []; S.events = []; S.notes = []; S.penalties = []; S.shopping = []; S.reports = []; S.orders = []; S.bestellungen = []; S.days = []; S.questions = []; S.stats = {}; S.attendance = []; S.meals = []; S.attStats = {}; S.packs = []; S.tours = []; S.feld = []; S.hofInfo = { address: '' }; S.moves = []; S.entries = {}; S.products = []; S.stands = [];
    unsubs.push(FB.onSnapshot(FB.collection(db, 'users'), snap => {
      const arr = []; snap.forEach(ds => arr.push({ id: ds.id, ...ds.data() }));
      arr.sort((a, b) => (a.created || 0) - (b.created || 0));
      S.people = arr.map(u => u.name); S.pstand = {}; S.pbf = {}; S.traits = {}; S.roles = {}; S.approved = {}; S.userIds = {}; S.emailVerified = {}; S.perms = {};
      arr.forEach(u => { S.roles[u.name] = u.role; S.approved[u.name] = u.approved === true; S.userIds[u.name] = u.id; S.emailVerified[u.name] = u.emailVerified === true; if (u.perms) S.perms[u.name] = u.perms; if (u.stand) S.pstand[u.name] = u.stand; if (u.bfHof) S.pbf[u.name] = true; if (u.kraft || u.lizenz) S.traits[u.name] = { kraft: u.kraft || 'normal', lizenz: u.lizenz || '' }; });
      T.softRender();
    }, err => console.error('users', err)));
    ['tasks', 'events', 'notes', 'penalties', 'products', 'stands', 'settings', 'packs', 'reports', 'stats', 'questions'].forEach(listen);
    if (T.permFor(p, 'verkauf') || T.permFor(p, 'zahlen')) ['moves', 'sales'].forEach(listen);
    if (T.permFor(p, 'lieferungen') || T.permFor(p, 'lieferplanung')) { listen('tours'); listen('days'); }
    if (T.permFor(p, 'lieferplanung')) { listen('orders'); listen('bestellungen'); }
    if (T.permFor(p, 'einkauf') || T.permFor(p, 'kueche')) listen('shopping');
    listen('attendance'); listen('meals');
    if (T.permFor(p, 'feld')) listen('feld');
  }

  /* Push: Token holen und am Profil speichern (iPhone nur, wenn die App auf dem Home-Bildschirm liegt) */
  let pushChecked = false;
  const curLang = () => { try { return localStorage.getItem('droste-lang') === 'ro' ? 'ro' : 'de'; } catch (e) { return 'de'; } };
  async function saveToken() {
    if (!(FB.isSupported && FB.getMessaging && await FB.isSupported())) throw new Error('unsupported');
    const reg = await navigator.serviceWorker.ready;
    const token = await FB.getToken(FB.getMessaging(app), { vapidKey: window.FIREBASE_CONFIG.vapidKey, serviceWorkerRegistration: reg });
    if (!token) throw new Error('no-token');
    await FB.updateDoc(FB.doc(db, 'users', uid), { fcmTokens: FB.arrayUnion(token), lang: curLang() });
    try { localStorage.setItem('droste-fcm', token); } catch (e) {}
    return token;
  }

  /* Frisches Anmelde-Token holen, bis Freigabe und Rolle als Claims drin sind (für Storage) */
  let claimsOk = false;
  async function ensureClaims(user) {
    if (claimsOk || !FB.getIdTokenResult) return;
    for (let i = 0; i < 4 && !claimsOk; i++) {
      try {
        await user.getIdToken(true);
        const r = await user.getIdTokenResult();
        if (r.claims && r.claims.approved === true) { claimsOk = true; T.softRender(); return; }
      } catch (e) { return; }
      await new Promise(res => setTimeout(res, 4000));
    }
  }

  function watchProfile(user) {
    uid = user.uid;
    const ref = FB.doc(db, 'users', user.uid);
    unsubProfile = FB.onSnapshot(ref, snap => {
      if (!snap.exists()) {
        if (registering) return;
        FB.setDoc(ref, { name: (user.email || 'Neu').split('@')[0], email: (user.email || '').toLowerCase(), role: 'team', approved: false, created: Date.now() })
          .catch(e => console.error(e));
        return;
      }
      profile = snap.data();
      const S = T.S;
      S.me = profile.name; S.myUid = user.uid;
      S.roles = S.roles || {}; S.approved = S.approved || {};
      S.roles[profile.name] = profile.role; S.approved[profile.name] = profile.approved === true;
      S.perms = S.perms || {}; if (profile.perms) S.perms[profile.name] = profile.perms; else delete S.perms[profile.name];
      if (!S.people || !S.people.includes(profile.name)) S.people = [...(S.people || []), profile.name];
      if (user.emailVerified && profile.emailVerified !== true) FB.updateDoc(ref, { emailVerified: true }).catch(() => {});
      T.setCloud({ status: 'in', profile: { ...profile, uid: user.uid, email: user.email, verified: !!user.emailVerified } });
      if (profile.approved === true) activate(profile, user.uid); else { deactivate(); T.softRender(); }
      if (profile.approved === true) ensureClaims(user);
      if (profile.approved === true && !pushChecked && window.Notification && Notification.permission === 'granted') { pushChecked = true; saveToken().catch(() => {}); }
      T.render();
    }, err => { console.error(err); T.setCloud({ status: 'error', msg: 'Profil konnte nicht geladen werden (' + (err.code || err.message) + ')' }); T.render(); });
  }

  FB.onAuthStateChanged(auth, user => {
    if (unsubProfile) { unsubProfile(); unsubProfile = null; }
    if (!user) {
      deactivate(); profile = null; uid = null;
      T.wipe(); T.setCloud({ status: 'out' }); T.render(); return;
    }
    watchProfile(user);
  }, err => { T.setCloud({ status: 'error', msg: 'Anmeldung nicht möglich (' + (err.code || err.message) + ')' }); T.render(); });

  T.rolesChanged = () => { if (profile && profile.approved === true) activate(profile, uid); };
  window.cloud = {
    sync, resume,
    signIn: (email, pw) => FB.signInWithEmailAndPassword(auth, email.trim(), pw),
    reset: email => FB.sendPasswordResetEmail(auth, email.trim()),
    async register(name, email, pw) {
      registering = true;
      try {
        const cr = await FB.createUserWithEmailAndPassword(auth, email.trim(), pw);
        await FB.setDoc(FB.doc(db, 'users', cr.user.uid), { name: name.trim(), email: email.trim().toLowerCase(), role: 'team', approved: false, created: Date.now() });
        try { await FB.sendEmailVerification(cr.user); } catch (e) { console.warn('Bestätigungsmail nicht gesendet', e); }
      } finally { registering = false; }
    },
    pushSupported: async () => !!(window.Notification && 'serviceWorker' in navigator && 'PushManager' in window && FB.isSupported && await FB.isSupported()),
    async enablePush() {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('denied');
      return saveToken();
    },
    async disablePush() {
      let tok = ''; try { tok = localStorage.getItem('droste-fcm') || ''; localStorage.removeItem('droste-fcm'); } catch (e) {}
      if (tok) await FB.updateDoc(FB.doc(db, 'users', uid), { fcmTokens: FB.arrayRemove(tok) }).catch(() => {});
      try { await FB.deleteToken(FB.getMessaging(app)); } catch (e) {}
    },
    async routeMatrix(p) { const r = await FB.httpsCallable(FB.getFunctions(app, 'europe-west1'), 'routeMatrix')(p); return r.data; },
    async routeLegs(p) { const r = await FB.httpsCallable(FB.getFunctions(app, 'europe-west1'), 'routeLegs')(p); return r.data; },
    async addrSuggest(p) { const r = await FB.httpsCallable(FB.getFunctions(app, 'europe-west1'), 'addrSuggest')(p); return r.data; },
    async driveKm(p) { const r = await FB.httpsCallable(FB.getFunctions(app, 'europe-west1'), 'driveKm')(p); return r.data; },
    async geocode(p) { const r = await FB.httpsCallable(FB.getFunctions(app, 'europe-west1'), 'geocode')(p); return r.data; },
    setSecret: (name, key) => FB.setDoc(FB.doc(db, 'secrets', name), { key, at: Date.now() }),
    imageUrl: path => FB.getDownloadURL(FB.ref(FB.getStorage(app), path)),
    async uploadImage(path, blob) { await FB.uploadBytes(FB.ref(FB.getStorage(app), path), blob, { contentType: 'image/jpeg' }); return path; },
    resendVerification: () => FB.sendEmailVerification(auth.currentUser),
    async refreshVerified() {
      const u = auth.currentUser; if (!u) return;
      await u.reload();
      if (u.emailVerified) {
        FB.updateDoc(FB.doc(db, 'users', u.uid), { emailVerified: true }).catch(() => {});
        T.cur.cloud = { ...T.cur.cloud, profile: { ...T.cur.cloud.profile, verified: true } };
      }
      T.render();
    },
    signOut: () => FB.signOut(auth),
    setRole: (name, role) => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { role, perms: {} }),
    setName: (name, newName) => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { name: newName }),
    setTraits: (name, tr) => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { kraft: tr.kraft || 'normal', lizenz: tr.lizenz || '' }),
    setBf: (name, on) => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { bfHof: !!on }),
    setStand: (name, stand) => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { stand: stand || '' }),
    setPerms: (name, perms) => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { perms }),
    approve: name => FB.updateDoc(FB.doc(db, 'users', T.S.userIds[name]), { approved: true }),
    remove: name => FB.deleteDoc(FB.doc(db, 'users', T.S.userIds[name])),
    afterImport() { for (const k of Object.keys(lastSynced)) lastSynced[k] = lastSynced[k] || {}; sync(); }
  };
  return window.cloud;
}

window.cloudInit = initCloud;
if (window.FIREBASE_CONFIG && !/manualcloud/.test(location.search)) {
  loadFB().then(initCloud).catch(e => {
    console.error(e);
    window.APP.setCloud({ status: 'error', msg: 'Verbindung zu Firebase nicht möglich. Bitte Netz prüfen und neu laden.' });
    window.APP.render();
  });
}
